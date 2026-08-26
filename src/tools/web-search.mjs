/**
 * Web search via DuckDuckGo's HTML results page. No API key: POST a query to
 * html.duckduckgo.com, parse organic titles/URLs/snippets. Instant Answer is
 * not used — it rarely returns useful organic listings for agent work.
 */

import { truncateOutput } from "./fs.mjs";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;
const SEARCH_TIMEOUT_MS = 15_000;
const USER_AGENT = "halo-agent/0.1 (+https://github.com/aura-dev; local agent web_search)";

/**
 * Decode common HTML entities in DDG snippets/titles.
 * @param {string} text
 * @returns {string}
 */
export function decodeHtmlEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

/**
 * Strip tags and collapse whitespace.
 * @param {string} html
 * @returns {string}
 */
export function stripTags(html) {
  return decodeHtmlEntities(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Unwrap DuckDuckGo redirect links (`/l/?uddg=...`) to the destination URL.
 * @param {string} href
 * @returns {string}
 */
export function unwrapDuckDuckGoUrl(href) {
  if (!href) return "";
  let url = href.trim();
  if (url.startsWith("//")) url = `https:${url}`;
  try {
    const parsed = new URL(url);
    if (
      parsed.hostname.endsWith("duckduckgo.com") &&
      (parsed.pathname === "/l/" || parsed.pathname === "/l")
    ) {
      const target = parsed.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    }
    return parsed.toString();
  } catch {
    return href;
  }
}

/**
 * Parse organic results from DuckDuckGo HTML search markup.
 * @param {string} html
 * @returns {Array<{title: string, url: string, snippet: string}>}
 */
export function parseDuckDuckGoHtml(html) {
  const results = [];
  const blockRe =
    /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/gi;
  let match;
  while ((match = blockRe.exec(html)) !== null) {
    const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(match[1]));
    const title = stripTags(match[2]);
    const snippet = stripTags(match[3]);
    if (!url || !title) continue;
    if (url.includes("duckduckgo.com/y.js")) continue;
    results.push({ title, url, snippet });
  }

  if (results.length > 0) return results;

  // Fallback: titles only when snippet markup differs.
  const titleRe = /class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((match = titleRe.exec(html)) !== null) {
    const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(match[1]));
    const title = stripTags(match[2]);
    if (!url || !title) continue;
    if (url.includes("duckduckgo.com/y.js")) continue;
    results.push({ title, url, snippet: "" });
  }
  return results;
}

/**
 * @param {object} options
 * @param {string} options.query
 * @param {number} [options.maxResults]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{results: Array<{title: string, url: string, snippet: string}>, error?: string}>}
 */
export async function searchDuckDuckGo({
  query,
  maxResults = DEFAULT_MAX_RESULTS,
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { results: [], error: "query must not be empty." };

  const limit = Math.min(Math.max(1, maxResults ?? DEFAULT_MAX_RESULTS), MAX_RESULTS_CAP);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(SEARCH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": USER_AGENT,
      },
      body: new URLSearchParams({ q }),
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      return {
        results: [],
        error: `DuckDuckGo search returned HTTP ${response.status}`,
      };
    }
    const html = await response.text();
    const results = parseDuckDuckGoHtml(html).slice(0, limit);
    if (results.length === 0) {
      return { results: [], error: `No web results for '${q}'.` };
    }
    return { results };
  } catch (err) {
    if (err?.name === "AbortError") {
      if (signal?.aborted) return { results: [], error: "Web search was cancelled." };
      return { results: [], error: `Web search timed out after ${SEARCH_TIMEOUT_MS}ms.` };
    }
    return { results: [], error: `Web search failed: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Format search hits for the model.
 * @param {Array<{title: string, url: string, snippet: string}>} results
 * @param {string} query
 * @returns {string}
 */
export function formatWebSearchResults(results, query) {
  if (!results?.length) {
    return [
      `0 web result(s) for '${query}'.`,
      "Empty results are a real outcome — do not retry the same query.",
      "If you were looking up an installed package or local API, inspect the",
      "environment instead, e.g. `python -c \"import mobile_sam; print(dir(mobile_sam))\"`",
      "or read local docs / installed package files with grep_search and read_file.",
    ].join("\n");
  }
  const lines = [`${results.length} web result(s) for '${query}':`, ""];
  for (let i = 0; i < results.length; i++) {
    const hit = results[i];
    lines.push(`${i + 1}. ${hit.title}`);
    lines.push(`   URL: ${hit.url}`);
    if (hit.snippet) lines.push(`   ${hit.snippet}`);
    lines.push("");
  }
  return truncateOutput(lines.join("\n").trimEnd());
}

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 */
export function registerWebSearchTool(registry, { fetchImpl } = {}) {
  registry.register({
    name: "web_search",
    description:
      "Search the public web with DuckDuckGo. Returns ranked titles, URLs, and " +
      "snippets. Use for current events, upstream docs, release notes, package " +
      "versions, and anything outside this workspace. Follow up with fetch_url on " +
      "promising result URLs (pass a query for micro-RAG). Prefer workspace tools " +
      "(read_file, grep_search, find_files) for project-local questions.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query (natural language or keywords).",
        },
        max_results: {
          type: "integer",
          description: `How many results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_RESULTS_CAP}).`,
        },
      },
      required: ["query"],
    },
    async execute({ query, max_results }) {
      if (!String(query ?? "").trim()) {
        throw new Error("query must not be empty.");
      }
      const { results, error } = await searchDuckDuckGo({
        query,
        maxResults: max_results,
        fetchImpl,
      });
      if (error && results.length === 0) {
        const empty = formatWebSearchResults([], String(query).trim());
        return `${empty}\n\nerror: ${error}`;
      }
      return formatWebSearchResults(results, String(query).trim());
    },
  });
  return registry;
}
