import assert from "node:assert/strict";
import { test } from "node:test";

import { ToolRegistry } from "../src/tool-registry.mjs";
import {
  assertFetchableUrl,
  bodyToText,
  fetchUrlContent,
  htmlToText,
  jsonApiFetchFallbackHint,
  looksLikeJsonApiUrl,
  isPrivateOrLinkLocalIp,
  lexicalScore,
  microRagPage,
  registerFetchUrlTool,
} from "../src/tools/fetch-url.mjs";

const SAMPLE_HTML = `<!DOCTYPE html>
<html><head><title>Node.js LTS Notes</title>
<style>body { color: red; }</style>
<script>alert(1)</script>
</head><body>
<h1>Node.js Long Term Support</h1>
<p>The Active LTS line receives new features and bug fixes.</p>
<p>Odd-numbered releases are never promoted to LTS.</p>
<p>Unrelated filler about cooking pasta and gardening tips for spring.</p>
<p>Current Active LTS is documented on the official download page.</p>
</body></html>`;

test("assertFetchableUrl accepts public http(s) and rejects private/local", () => {
  assert.equal(assertFetchableUrl("https://example.com/a").hostname, "example.com");
  assert.throws(() => assertFetchableUrl("file:///etc/passwd"), /http\(s\)/);
  assert.throws(() => assertFetchableUrl("http://localhost/x"), /local host/);
  assert.throws(() => assertFetchableUrl("http://127.0.0.1/"), /local host/);
  assert.throws(() => assertFetchableUrl("http://192.168.1.1/"), /private/);
  assert.throws(() => assertFetchableUrl("http://10.0.0.5/"), /private/);
  assert.ok(isPrivateOrLinkLocalIp("169.254.169.254"));
});

test("htmlToText strips scripts/styles and keeps readable prose", () => {
  const { title, text } = htmlToText(SAMPLE_HTML);
  assert.equal(title, "Node.js LTS Notes");
  assert.match(text, /Long Term Support/);
  assert.match(text, /Active LTS/);
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes("color: red"));
});

test("bodyToText treats plain text without HTML parsing", () => {
  const { text } = bodyToText("hello\nworld", "text/plain");
  assert.equal(text, "hello\nworld");
});

test("lexicalScore prefers chunks that share query tokens", () => {
  assert.ok(
    lexicalScore("active LTS features", "Active LTS receives new features") >
      lexicalScore("active LTS features", "cooking pasta and gardening"),
  );
});

test("microRagPage returns top lexical passages when no embed client", async () => {
  const { title, text } = htmlToText(SAMPLE_HTML);
  assert.ok(title);
  const { passages, method } = await microRagPage({
    text,
    query: "Active LTS features",
    topK: 2,
  });
  assert.equal(method, "lexical");
  assert.ok(passages.length >= 1);
  assert.match(passages[0].text, /LTS/i);
});

test("microRagPage uses embeddings when client.embed is available", async () => {
  const vectors = {
    query: [1, 0, 0],
    match: [0.9, 0.1, 0],
    other: [0, 1, 0],
    noise: [0, 0, 1],
  };
  const client = {
    async embed({ prompt }) {
      if (/LTS features/i.test(prompt) && !/Active LTS/.test(prompt) && !/cooking/.test(prompt)) {
        return vectors.query;
      }
      if (prompt.includes("Active LTS receives")) return vectors.match;
      if (prompt.includes("cooking")) return vectors.other;
      return vectors.noise;
    },
  };
  const text = [
    "Active LTS receives new features and bug fixes for production users.",
    "Unrelated cooking pasta and gardening tips for spring weather.",
    `${"padding ".repeat(200)}more filler to force multiple chunks.`,
  ].join("\n\n");
  const { passages, method } = await microRagPage({
    text,
    query: "LTS features",
    topK: 1,
    client,
  });
  assert.equal(method, "embedding");
  assert.equal(passages.length, 1);
  assert.match(passages[0].text, /Active LTS/);
});

test("fetchUrlContent returns truncated page without query", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: "https://example.com/lts",
    headers: { get: () => "text/html" },
    async arrayBuffer() {
      return Buffer.from(SAMPLE_HTML);
    },
  });
  const result = await fetchUrlContent({
    url: "https://example.com/lts",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /Fetched https:\/\/example.com\/lts/);
  assert.match(result.content, /Title: Node\.js LTS Notes/);
  assert.match(result.content, /Long Term Support/);
});

test("fetchUrlContent micro-RAG with query returns scored passages", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    url: "https://example.com/lts",
    headers: { get: () => "text/html" },
    async arrayBuffer() {
      return Buffer.from(SAMPLE_HTML);
    },
  });
  const result = await fetchUrlContent({
    url: "https://example.com/lts",
    query: "Active LTS",
    topK: 2,
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, "lexical");
  assert.match(result.content, /Micro-RAG \(lexical\)/);
  assert.match(result.content, /Active LTS/);
});

test("fetch_url tool refuses private URLs and reports HTTP errors", async () => {
  const registry = registerFetchUrlTool(new ToolRegistry(), {
    fetchImpl: async () => ({ ok: false, status: 404, url: "https://example.com/missing" }),
  });
  const privateHit = await registry.execute("fetch_url", { url: "http://127.0.0.1/" });
  assert.equal(privateHit.ok, false);
  assert.match(privateHit.error, /local host|private/i);

  const missing = await registry.execute("fetch_url", { url: "https://example.com/missing" });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /HTTP 404/);
});

test("fetch_url tool succeeds end to end with mocked HTML", async () => {
  const registry = registerFetchUrlTool(new ToolRegistry(), {
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://nodejs.org/en",
      headers: { get: () => "text/html; charset=utf-8" },
      async arrayBuffer() {
        return Buffer.from(SAMPLE_HTML);
      },
    }),
  });
  const outcome = await registry.execute("fetch_url", {
    url: "https://nodejs.org/en",
    query: "LTS",
    top_k: 1,
  });
  assert.equal(outcome.ok, true);
  assert.match(outcome.result, /Micro-RAG/);
});

test("fetchUrlContent suggests curl for binary archive responses", async () => {
  const tarBytes = Buffer.from([0x1f, 0x8b, 0x08, 0x00, ...Array(100).fill(0)]);
  const result = await fetchUrlContent({
    url: "https://example.com/package.tar.gz",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      url: "https://example.com/package.tar.gz",
      headers: { get: () => "application/gzip" },
      async arrayBuffer() {
        return tarBytes;
      },
    }),
  });
  assert.equal(result.ok, true);
  assert.match(result.content, /curl -L -o/);
  assert.match(result.content, /run_command/i);
});

test("jsonApiFetchFallbackHint suggests curl for API URLs", () => {
  assert.equal(looksLikeJsonApiUrl("https://huggingface.co/api/models"), true);
  assert.match(jsonApiFetchFallbackHint("https://huggingface.co/api/models") ?? "", /curl -s/i);
});

test("fetchUrlContent appends API hint on HTTP errors", async () => {
  const result = await fetchUrlContent({
    url: "https://huggingface.co/api/datasets/mteb",
    fetchImpl: async () => ({
      ok: false,
      status: 404,
      url: "https://huggingface.co/api/datasets/mteb",
      headers: { get: () => "application/json" },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /curl -s/i);
});
