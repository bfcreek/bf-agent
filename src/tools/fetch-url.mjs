/**
 * fetch_url: load a public web page, extract readable text, and optionally
 * run micro-RAG (chunk → score → top passages) so long pages don't flood the
 * model. Embeddings are used when an Ollama embed client is available;
 * otherwise lexical overlap ranks chunks.
 */

import {
  chunkText,
  DEFAULT_EMBEDDING_MODEL,
} from "../project-index.mjs";
import { truncateOutput } from "./output.mjs";
import { decodeHtmlEntities, stripTags } from "./web-search.mjs";

const FETCH_TIMEOUT_MS = 20_000;
const MAX_DOWNLOAD_BYTES = 1_500_000;
const MAX_TEXT_CHARS = 200_000;
const DEFAULT_TOP_K = 5;
const MAX_TOP_K = 12;
const MAX_EMBED_CHUNKS = 40;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 200;
const USER_AGENT = "halo-agent/0.1 (+https://github.com/aura-dev; local agent fetch_url)";

/**
 * @param {string} url
 * @returns {boolean}
 */
export function looksLikeJsonApiUrl(url) {
  return /\/api\/|api\.|\.json(?:\?|$)|huggingface\.co\/api|leaderboard|mteb/i.test(String(url ?? ""));
}

/**
 * @param {string} url
 * @returns {string|null}
 */
export function jsonApiFetchFallbackHint(url) {
  if (!looksLikeJsonApiUrl(url)) return null;
  const safe = String(url ?? "").replace(/'/g, "'\\''");
  return (
    "Leaderboard/API URLs often return JSON, not HTML. Prefer: " +
    `curl -s '${safe}' | python -c "import sys,json; d=json.load(sys.stdin); print(type(d), len(d) if hasattr(d,'__len__') else d)" ` +
    "or curl -s -o data.json 'URL' then read_file/parse."
  );
}

/**
 * Reject non-http(s) and obvious private/local targets (basic SSRF guard).
 * @param {string} raw
 * @returns {URL}
 */
export function assertFetchableUrl(raw) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("url must not be empty.");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`Invalid URL '${text}'.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed, got '${parsed.protocol}'.`);
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error(`Refusing to fetch local host '${host}'.`);
  }
  if (isPrivateOrLinkLocalIp(host)) {
    throw new Error(`Refusing to fetch private or link-local address '${host}'.`);
  }
  return parsed;
}

/**
 * @param {string} host
 * @returns {boolean}
 */
export function isPrivateOrLinkLocalIp(host) {
  // IPv4 dotted form only; hostnames are allowed through (DNS rebinding is
  // out of scope for this basic guard).
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = m.slice(1).map((p) => Number(p));
  if (parts.some((n) => n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

function isBinaryContentType(contentType) {
  const type = String(contentType ?? "").toLowerCase();
  return (
    /octet-stream|\/(?:gzip|x-tar|x-bzip|zip|x-compress)/.test(type) ||
    type.includes("application/tar")
  );
}

/**
 * @param {Buffer} buf
 * @returns {boolean}
 */
function looksLikeBinaryBody(buf) {
  if (!buf?.length) return false;
  const sample = buf.subarray(0, Math.min(buf.length, 512));
  let nonText = 0;
  for (const byte of sample) {
    if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) nonText++;
  }
  return nonText / sample.length > 0.05;
}

/**
 * HTML → plain text: drop scripts/styles, keep block breaks, strip tags.
 * @param {string} html
 * @returns {{ title: string, text: string }}
 */
export function htmlToText(html) {
  let s = String(html ?? "");
  const titleMatch = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripTags(titleMatch[1]) : "";

  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<svg\b[\s\S]*?<\/svg>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/?(br|p|div|h[1-6]|li|tr|section|article|header|footer|main|blockquote|pre|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/td>/gi, "\t");

  let text = stripTags(s)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n[page text truncated at ${MAX_TEXT_CHARS} characters]`;
  }
  return { title, text };
}

/**
 * Plain-text body when Content-Type is not HTML.
 * @param {string} body
 * @param {string} [contentType]
 * @returns {{ title: string, text: string }}
 */
export function bodyToText(body, contentType = "") {
  const type = String(contentType).toLowerCase();
  if (type.includes("html") || /^\s*</.test(body)) {
    return htmlToText(body);
  }
  let text = decodeHtmlEntities(String(body ?? "")).replace(/\r\n/g, "\n").trim();
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n[page text truncated at ${MAX_TEXT_CHARS} characters]`;
  }
  return { title: "", text };
}

/**
 * Lexical overlap score: fraction of query tokens found in the chunk.
 * @param {string} query
 * @param {string} chunk
 * @returns {number}
 */
export function lexicalScore(query, chunk) {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const hay = tokenize(chunk);
  if (hay.length === 0) return 0;
  const set = new Set(hay);
  let hits = 0;
  for (const t of qTokens) if (set.has(t)) hits++;
  return hits / qTokens.length;
}

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 1);
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Rank page chunks for a query (embeddings when possible, else lexical).
 * @param {object} options
 * @param {string} options.text
 * @param {string} options.query
 * @param {number} [options.topK]
 * @param {{embed: Function}} [options.client]
 * @param {string} [options.embeddingModel]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{passages: Array<{index: number, score: number, text: string}>, method: "embedding"|"lexical"}>}
 */
export async function microRagPage({
  text,
  query,
  topK = DEFAULT_TOP_K,
  client,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  signal,
} = {}) {
  const limit = Math.min(Math.max(1, topK ?? DEFAULT_TOP_K), MAX_TOP_K);
  const chunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
  if (chunks.length === 0) return { passages: [], method: "lexical" };

  const q = String(query ?? "").trim();
  if (!q) {
    return {
      passages: chunks.slice(0, limit).map((c, i) => ({ index: i, score: 1, text: c })),
      method: "lexical",
    };
  }

  if (client?.embed) {
    try {
      const queryVec = await client.embed({ prompt: q, model: embeddingModel, signal });
      const toScore = chunks.slice(0, MAX_EMBED_CHUNKS);
      const scored = [];
      for (let i = 0; i < toScore.length; i++) {
        const embedding = await client.embed({
          prompt: toScore[i],
          model: embeddingModel,
          signal,
        });
        scored.push({
          index: i,
          score: cosineSimilarity(queryVec, embedding),
          text: toScore[i],
        });
      }
      scored.sort((a, b) => b.score - a.score);
      return { passages: scored.slice(0, limit), method: "embedding" };
    } catch {
      // Fall through to lexical when Ollama embeddings are unavailable.
    }
  }

  const scored = chunks.map((c, i) => ({
    index: i,
    score: lexicalScore(q, c),
    text: c,
  }));
  scored.sort((a, b) => b.score - a.score);
  return { passages: scored.slice(0, limit), method: "lexical" };
}

/**
 * @param {object} options
 * @param {string} options.url
 * @param {string} [options.query]
 * @param {number} [options.topK]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{embed: Function}} [options.client]
 * @param {string} [options.embeddingModel]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ok: true, url: string, title: string, content: string, method?: string}|{ok: false, error: string}>}
 */
export async function fetchUrlContent({
  url,
  query,
  topK = DEFAULT_TOP_K,
  fetchImpl = globalThis.fetch,
  client,
  embeddingModel,
  signal,
} = {}) {
  let parsed;
  try {
    parsed = assertFetchableUrl(url);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(parsed.toString(), {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.8",
      },
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      const hint = jsonApiFetchFallbackHint(parsed.toString());
      return {
        ok: false,
        error: `Fetch returned HTTP ${response.status} for ${parsed}${hint ? `. ${hint}` : ""}`,
      };
    }

    finalUrlGuard(response, parsed);

    const contentType = response.headers?.get?.("content-type") ?? "";
    const buf = await readCapped(response, MAX_DOWNLOAD_BYTES);
    const finalUrl = String(response.url || parsed.toString());

    if (isBinaryContentType(contentType) || looksLikeBinaryBody(buf)) {
      const suggested = `curl -L -o <path> '${finalUrl}'`;
      return {
        ok: true,
        url: finalUrl,
        title: "",
        content: [
          `Binary or archive content at ${finalUrl} (${contentType || "unknown type"}, ${buf.length} bytes).`,
          "fetch_url is for readable pages — persist archives with run_command instead:",
          suggested,
          "Example: curl -L -o orig.tar.gz 'URL' then tar -xzf orig.tar.gz",
        ].join("\n"),
      };
    }

    const body = buf.toString("utf8");
    const { title, text } = bodyToText(body, contentType);
    if (!text) {
      const hint = jsonApiFetchFallbackHint(finalUrl);
      return {
        ok: false,
        error: `No readable text extracted from ${parsed}${hint ? `. ${hint}` : ""}`,
      };
    }

    const q = String(query ?? "").trim();

    if (!q) {
      const header = title
        ? `Fetched ${finalUrl}\nTitle: ${title}\n\n`
        : `Fetched ${finalUrl}\n\n`;
      return {
        ok: true,
        url: finalUrl,
        title,
        content: truncateOutput(`${header}${text}`),
      };
    }

    const { passages, method } = await microRagPage({
      text,
      query: q,
      topK,
      client,
      embeddingModel,
      signal,
    });

    if (passages.length === 0) {
      return { ok: false, error: `No passages matched query '${q}' in ${finalUrl}` };
    }

    const lines = [
      `Fetched ${finalUrl}${title ? ` — ${title}` : ""}`,
      `Micro-RAG (${method}): ${passages.length} passage(s) for '${q}'`,
      "",
    ];
    for (let i = 0; i < passages.length; i++) {
      const p = passages[i];
      lines.push(`[${i + 1}] chunk ${p.index} (score ${p.score.toFixed(3)})`);
      lines.push(p.text.trim());
      lines.push("");
      lines.push("---");
      lines.push("");
    }
    return {
      ok: true,
      url: finalUrl,
      title,
      method,
      content: truncateOutput(lines.join("\n").trimEnd()),
    };
  } catch (err) {
    if (err?.name === "AbortError") {
      if (signal?.aborted) return { ok: false, error: "Fetch was cancelled." };
      return { ok: false, error: `Fetch timed out after ${FETCH_TIMEOUT_MS}ms.` };
    }
    return { ok: false, error: `Fetch failed: ${err?.message ?? err}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * If the response redirected to a private URL, refuse the body.
 * @param {Response} response
 * @param {URL} original
 */
function finalUrlGuard(response, original) {
  const final = response.url ? String(response.url) : "";
  if (!final || final === original.toString()) return;
  try {
    assertFetchableUrl(final);
  } catch (err) {
    throw new Error(`Refusing redirect target: ${err.message}`);
  }
}

/**
 * @param {Response} response
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
async function readCapped(response, maxBytes) {
  if (typeof response.arrayBuffer === "function") {
    const ab = await response.arrayBuffer();
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) {
      return buf.subarray(0, maxBytes);
    }
    return buf;
  }
  const text = await response.text();
  return Buffer.from(text.slice(0, maxBytes), "utf8");
}

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{embed: Function}} [options.client]
 * @param {string} [options.embeddingModel]
 */
export function registerFetchUrlTool(registry, { fetchImpl, client, embeddingModel } = {}) {
  registry.register({
    name: "fetch_url",
    description:
      "Fetch a public http(s) URL and return readable page text. Pass query to " +
      "run micro-RAG: the page is chunked and the most relevant passages for " +
      "that query are returned (embeddings when available, else keyword overlap). " +
      "Use after web_search on promising result URLs. Without query, returns a " +
      "truncated page extract. Local/private addresses are refused. " +
      "Do not use this to download source archives or binaries — use run_command with curl/wget instead.",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Absolute http(s) URL to fetch.",
        },
        query: {
          type: "string",
          description:
            "Optional focus query for micro-RAG. Strongly recommended for long docs.",
        },
        top_k: {
          type: "integer",
          description: `Passages to return when query is set (default ${DEFAULT_TOP_K}, max ${MAX_TOP_K}).`,
        },
      },
      required: ["url"],
    },
    async execute({ url, query, top_k }) {
      const result = await fetchUrlContent({
        url,
        query,
        topK: top_k,
        fetchImpl,
        client,
        embeddingModel,
      });
      if (!result.ok) throw new Error(result.error);
      return result.content;
    },
  });
  return registry;
}
