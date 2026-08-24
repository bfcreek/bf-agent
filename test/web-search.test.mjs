import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
import {
  decodeHtmlEntities,
  formatWebSearchResults,
  parseDuckDuckGoHtml,
  registerWebSearchTool,
  searchDuckDuckGo,
  stripTags,
  unwrapDuckDuckGoUrl,
} from "../src/tools/web-search.mjs";

const SAMPLE_HTML = `
<html><body>
  <div class="result results_links web-result">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://nodejs.org/en/download">Download Node.js&#xae;</a>
    </h2>
    <a class="result__snippet" href="https://nodejs.org/en/download">Get Node.js&#xae; v24 LTS for Windows</a>
  </div>
  <div class="result results_links web-result">
    <h2 class="result__title">
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fgithub.com%2Fnodejs%2FRelease&amp;rut=abc">Node.js Release WG</a>
    </h2>
    <a class="result__snippet" href="#">Active Long Term Support (LTS)</a>
  </div>
</body></html>
`;

test("decodeHtmlEntities and stripTags clean DDG markup", () => {
  assert.equal(decodeHtmlEntities("A &amp; B &#x27;C&#39;"), "A & B 'C'");
  assert.equal(stripTags("<b>Hi</b> &amp; <i>there</i>"), "Hi & there");
});

test("unwrapDuckDuckGoUrl resolves uddg redirects", () => {
  assert.equal(
    unwrapDuckDuckGoUrl("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpath&rut=x"),
    "https://example.com/path",
  );
  assert.equal(unwrapDuckDuckGoUrl("https://example.com/direct"), "https://example.com/direct");
});

test("parseDuckDuckGoHtml extracts title, url, and snippet", () => {
  const results = parseDuckDuckGoHtml(SAMPLE_HTML);
  assert.equal(results.length, 2);
  assert.equal(results[0].title, "Download Node.js®");
  assert.equal(results[0].url, "https://nodejs.org/en/download");
  assert.match(results[0].snippet, /v24 LTS/);
  assert.equal(results[1].url, "https://github.com/nodejs/Release");
  assert.equal(results[1].title, "Node.js Release WG");
});

test("formatWebSearchResults is numbered and includes URLs", () => {
  const text = formatWebSearchResults(
    [{ title: "Example", url: "https://example.com", snippet: "A site." }],
    "example",
  );
  assert.match(text, /1\. Example/);
  assert.match(text, /URL: https:\/\/example\.com/);
  assert.match(text, /A site\./);
});

test("searchDuckDuckGo posts the query and returns parsed hits", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, method: init.method, body: String(init.body), headers: init.headers };
    return {
      ok: true,
      status: 200,
      async text() {
        return SAMPLE_HTML;
      },
    };
  };

  const { results, error } = await searchDuckDuckGo({
    query: "Node.js LTS",
    maxResults: 1,
    fetchImpl,
  });
  assert.equal(error, undefined);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://nodejs.org/en/download");
  assert.equal(seen.url, "https://html.duckduckgo.com/html/");
  assert.equal(seen.method, "POST");
  assert.match(seen.body, /q=Node\.js\+LTS/);
});

test("searchDuckDuckGo reports HTTP and empty-result failures", async () => {
  const httpFail = await searchDuckDuckGo({
    query: "x",
    fetchImpl: async () => ({ ok: false, status: 503, async text() { return ""; } }),
  });
  assert.match(httpFail.error, /HTTP 503/);

  const empty = await searchDuckDuckGo({
    query: "x",
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return "<html></html>"; } }),
  });
  assert.match(empty.error, /No web results/);
});

test("web_search tool is registered and returns formatted output", async () => {
  const registry = registerWebSearchTool(new ToolRegistry(), {
    fetchImpl: async () => ({ ok: true, status: 200, async text() { return SAMPLE_HTML; } }),
  });
  const outcome = await registry.execute("web_search", { query: "Node.js LTS", max_results: 2 });
  assert.equal(outcome.ok, true);
  assert.match(outcome.result, /2 web result\(s\)/);
  assert.match(outcome.result, /nodejs\.org/);
});

test("web_search rejects an empty query", async () => {
  const registry = registerWebSearchTool(new ToolRegistry(), {
    fetchImpl: async () => {
      throw new Error("should not fetch");
    },
  });
  const outcome = await registry.execute("web_search", { query: "  " });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /empty/i);
});
