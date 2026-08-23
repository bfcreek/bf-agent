/**
 * Aura Terran Direct RAG REST client: detect install/runtime, search corpora,
 * and format hits for injection into user messages.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TERRAN_APP_FOLDER = ".aura-terran";
export const DEFAULT_TERRAN_REST_PORT = 41800;
const HEALTH_TIMEOUT_MS = 3_000;
const SEARCH_TIMEOUT_MS = 30_000;
const DEFAULT_SEARCH_LIMIT = 10;

/** @typedef {import("node:fs")} FsLike */

/**
 * Thrown when `--terran` is set but Aura Terran does not appear installed.
 */
export class TerranError extends Error {
  constructor(message) {
    super(message);
    this.name = "TerranError";
  }
}

/**
 * @typedef {object} TerranInstallStatus
 * @property {boolean} installed
 * @property {string[]} reasons
 * @property {string|null} settingsPath
 * @property {number} suggestedRestPort
 */

/**
 * @typedef {object} TerranRunningStatus
 * @property {boolean} running
 * @property {boolean} reachable
 * @property {string} restUrl
 * @property {number} port
 * @property {string|null} error
 */

/**
 * Determine whether Aura Terran appears installed on this machine.
 *
 * @param {{ homedir?: () => string, existsSync?: FsLike["existsSync"], readdirSync?: FsLike["readdirSync"] }} [deps]
 * @returns {TerranInstallStatus}
 */
export function detectTerranInstalled({
  homedir = os.homedir,
  existsSync = fs.existsSync,
  readdirSync = fs.readdirSync,
} = {}) {
  const appRoot = path.join(homedir(), TERRAN_APP_FOLDER);
  const settingsPath = path.join(appRoot, "settings.json");
  const dataRoot = path.join(appRoot, "data");
  const reasons = [];

  const hasSettings = existsSync(settingsPath);
  const hasCorpus = namespaceHasCorpus(dataRoot, existsSync, readdirSync);

  const legacyRoots = [
    path.join(homedir(), ".aura-context-hub"),
    path.join(homedir(), "aura-context-hub"),
    path.join(homedir(), "froggy-rag-mcp"),
    path.join(homedir(), "fraggy-mcp-rag"),
  ];
  const legacyDataRoot = legacyRoots.find((r) => existsSync(r)) ?? null;
  const executablePath = findInstalledExecutable(existsSync);

  if (hasSettings) reasons.push("settings.json present");
  if (hasCorpus) reasons.push("indexed corpus found under data/");
  if (legacyDataRoot) reasons.push(`legacy data root: ${legacyDataRoot}`);
  if (executablePath) reasons.push(`executable found: ${executablePath}`);

  const installed = hasSettings || hasCorpus || legacyDataRoot !== null || executablePath !== null;
  const suggestedRestPort = hasSettings ? readSettingsPort(settingsPath) : DEFAULT_TERRAN_REST_PORT;

  return {
    installed,
    reasons,
    settingsPath: hasSettings ? settingsPath : null,
    suggestedRestPort,
  };
}

/**
 * Fail fast when Terran integration was requested but the app is not installed.
 *
 * @param {{ homedir?: () => string, existsSync?: FsLike["existsSync"], readdirSync?: FsLike["readdirSync"] }} [deps]
 */
export function assertTerranInstalled(deps) {
  const install = detectTerranInstalled(deps);
  if (!install.installed) {
    throw new TerranError(
      "Aura Terran is not installed. Install Terran and index a corpus, or omit --terran.",
    );
  }
  return install;
}

/**
 * Read Terran settings from disk when present.
 *
 * @param {string} [settingsPath]
 * @returns {{ port: number, authEnabled: boolean, token: string, webSearchEnabled: boolean }|null}
 */
export function readTerranSettings(settingsPath) {
  if (!settingsPath) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const port = Number.parseInt(String(raw.serverPort ?? DEFAULT_TERRAN_REST_PORT), 10);
    const authEnabled = raw.serverAuthEnabled !== false;
    const token = typeof raw.serverAuthToken === "string" ? raw.serverAuthToken.trim() : "";
    return {
      port: Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_TERRAN_REST_PORT,
      authEnabled,
      token,
      webSearchEnabled: raw.llmPassthroughIncludeWebResults === true,
    };
  } catch {
    return null;
  }
}

/**
 * Fail fast when Terran integration was requested but REST is not running,
 * or when web search was requested but is disabled in Terran settings.
 *
 * @param {object} [options]
 * @param {boolean} [options.includeWebSearch]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {{ homedir?: () => string, existsSync?: FsLike["existsSync"], readdirSync?: FsLike["readdirSync"] }} [options.deps]
 * @returns {Promise<{ install: TerranInstallStatus, settings: ReturnType<typeof readTerranSettings>, running: TerranRunningStatus }>}
 */
export async function assertTerranReady({ includeWebSearch = false, fetchImpl, deps } = {}) {
  const install = assertTerranInstalled(deps);
  const settings = readTerranSettings(install.settingsPath);
  const port = settings?.port ?? install.suggestedRestPort;
  const restUrl = resolveTerranRestUrl({ port });
  const running = await detectTerranRunning({ restUrl, port, fetchImpl });

  if (!running.running) {
    const detail = running.error
      ? running.error
      : `Management API REST is not listening at ${restUrl}. Start Aura Terran and enable the Management API server (Settings → Management API).`;
    throw new TerranError(`Aura Terran REST is not available. ${detail}`);
  }

  if (includeWebSearch && !settings?.webSearchEnabled) {
    throw new TerranError(
      "Aura Terran web search is not enabled. Turn on Settings → Web Integration → Include web results in LLM Passthrough context, or omit --web.",
    );
  }

  return { install, settings, running };
}

/**
 * Resolve the Direct RAG REST base URL.
 *
 * @param {{ port?: number, restUrl?: string }} [options]
 * @returns {string}
 */
export function resolveTerranRestUrl({ port, restUrl } = {}) {
  const fromEnv = process.env.AURA_CH_REST_URL?.trim();
  if (restUrl) return restUrl.replace(/\/$/, "");
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  const resolvedPort = Number.isFinite(port) && port > 0 ? port : DEFAULT_TERRAN_REST_PORT;
  return `http://127.0.0.1:${resolvedPort}`;
}

/**
 * Test whether the Direct RAG REST server is running.
 *
 * @param {object} [options]
 * @param {string} [options.restUrl]
 * @param {number} [options.port]
 * @param {number} [options.timeoutMs]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<TerranRunningStatus>}
 */
export async function detectTerranRunning({
  restUrl,
  port,
  timeoutMs = HEALTH_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const install = detectTerranInstalled();
  const resolvedPort = port ?? install.suggestedRestPort;
  const baseUrl = resolveTerranRestUrl({ port: resolvedPort, restUrl });
  const result = {
    running: false,
    reachable: false,
    restUrl: baseUrl,
    port: resolvedPort,
    error: null,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const healthRes = await fetchImpl(`${baseUrl}/health`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    result.reachable = true;
    if (!healthRes.ok) {
      result.error = `Health check returned HTTP ${healthRes.status}`;
      return result;
    }
    const health = await healthRes.json();
    if (health?.status === "ok" && health?.service === "aura-context-hub-rest") {
      result.running = true;
    } else {
      result.error = `Unexpected health payload: ${JSON.stringify(health)}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort")) {
      result.error = `Timed out after ${timeoutMs}ms connecting to ${baseUrl}`;
    } else if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      result.error = null;
    } else {
      result.error = msg;
    }
  } finally {
    clearTimeout(timer);
  }
  return result;
}

/**
 * Search Aura Terran corpora via Direct RAG REST.
 *
 * @param {object} options
 * @param {string} options.query
 * @param {string} [options.namespace]
 * @param {string} [options.restUrl]
 * @param {string} [options.token]
 * @param {number} [options.limit]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ results: object[], warnings: string[], scope: object|null, error: string|null, unreachable: boolean }>}
 */
export async function terranCorpusSearch({
  query,
  namespace,
  restUrl,
  token,
  limit = DEFAULT_SEARCH_LIMIT,
  includeWebSearch = false,
  signal,
  fetchImpl = fetch,
}) {
  const empty = { results: [], warnings: [], scope: null, error: null, unreachable: false };
  if (!query?.trim()) return empty;

  const baseUrl = resolveTerranRestUrl({ restUrl });
  const url = new URL(`${baseUrl}/admin/corpus-search`);
  if (namespace?.trim()) url.searchParams.set("namespace", namespace.trim());

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-Api-Key"] = token;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: query.trim(),
        limit,
        algorithm: "hybrid",
        ...(namespace?.trim() ? { namespace: namespace.trim() } : {}),
        ...(includeWebSearch ? { includeWebSearch: true } : {}),
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        /* ignore */
      }
      return {
        ...empty,
        error: `Terran corpus search returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
      };
    }

    const body = await response.json();
    return {
      results: Array.isArray(body?.results) ? body.results : [],
      webResults: Array.isArray(body?.webResults) ? body.webResults : [],
      webContext: typeof body?.webContext === "string" ? body.webContext : null,
      warnings: Array.isArray(body?.warnings) ? body.warnings.filter(Boolean) : [],
      scope: body?.scope ?? null,
      error: null,
      unreachable: false,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("abort") && signal?.aborted) throw err;
    if (msg.includes("ECONNREFUSED") || msg.includes("fetch failed")) {
      return { ...empty, unreachable: true };
    }
    if (msg.includes("abort")) {
      return { ...empty, error: `Terran corpus search timed out after ${SEARCH_TIMEOUT_MS}ms` };
    }
    return { ...empty, error: msg };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * @param {Array<object>} results
 * @returns {string}
 */
export function formatTerranWebHits(results) {
  if (!results?.length) return "";
  return results
    .map((hit, i) => {
      const title = hit.title ?? hit.name ?? "Untitled result";
      const url = typeof hit.url === "string" ? hit.url.trim() : "";
      const snippet =
        typeof hit.snippet === "string"
          ? hit.snippet
          : typeof hit.content === "string"
            ? hit.content
            : "";
      const lines = [`[W${i + 1}] Source: ${title}${url ? ` (${url})` : ""}`];
      if (snippet.trim()) lines.push(snippet.trim());
      return lines.join("\n");
    })
    .join("\n\n---\n\n");
}

/**
 * @param {{ webContext?: string|null, webResults?: object[] }} search
 * @returns {string}
 */
export function formatTerranWebContext(search) {
  const context = search?.webContext?.trim();
  if (context) return context;
  return formatTerranWebHits(search?.webResults);
}

export function formatTerranHits(results) {
  if (!results?.length) return "";
  return results
    .map((hit, i) => {
      const meta = hit.metadata ?? {};
      const label =
        meta.fileName ??
        meta.file_name ??
        hit.documentId ??
        hit.chunkId ??
        "unknown source";
      const ns = hit.namespace ? `, namespace: ${hit.namespace}` : "";
      const score =
        typeof hit.score === "number"
          ? hit.score.toFixed(3)
          : typeof hit.similarity === "number"
            ? hit.similarity.toFixed(3)
            : "?";
      const content = typeof hit.content === "string" ? hit.content : "";
      return `[${i + 1}] ${label} (score ${score}${ns})\n${content}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Retrieve Terran corpus context for a user message. Returns null text when
 * REST is not running (no error) or when there are no hits.
 *
 * @param {object} options
 * @param {string} options.query User message used as the search query.
 * @param {string} [options.namespace] Optional Terran corpus namespace.
 * @param {string} [options.restUrl]
 * @param {string} [options.token]
 * @param {AbortSignal} [options.signal]
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<{ text: string|null, hitCount: number, warnings: string[], error: string|null, running: boolean }>}
 */
export async function gatherTerranContext({
  query,
  namespace,
  restUrl,
  token,
  includeWebSearch = false,
  signal,
  fetchImpl,
}) {
  const running = await detectTerranRunning({ restUrl, fetchImpl });
  if (!running.running) {
    return { text: null, hitCount: 0, webHitCount: 0, warnings: [], error: running.error, running: false };
  }

  const search = await terranCorpusSearch({
    query,
    namespace,
    restUrl: running.restUrl,
    token,
    includeWebSearch,
    signal,
    fetchImpl,
  });

  if (search.unreachable) {
    return { text: null, hitCount: 0, webHitCount: 0, warnings: [], error: null, running: false };
  }
  if (search.error) {
    return {
      text: null,
      hitCount: 0,
      webHitCount: 0,
      warnings: search.warnings,
      error: search.error,
      running: true,
    };
  }

  const hits = search.results.filter((r) => typeof r?.content === "string" && r.content.trim());
  const webText = formatTerranWebContext(search);
  const webHitCount = webText
    ? Math.max(
        search.webResults?.length ?? 0,
        (webText.match(/^\[W\d+\]/gm) ?? []).length || 1,
      )
    : 0;
  if (hits.length === 0 && !webText) {
    return {
      text: null,
      hitCount: 0,
      webHitCount: 0,
      warnings: search.warnings,
      error: null,
      running: true,
    };
  }

  const scopeNote =
    search.scope?.mode === "single" && search.scope.namespace
      ? `namespace "${search.scope.namespace}"`
      : search.scope?.mode === "all"
        ? "all corpora"
        : namespace
          ? `namespace "${namespace}"`
          : "all corpora";

  const sections = [];
  if (hits.length > 0) {
    sections.push(
      "## Terran corpus context",
      "",
      `Retrieved ${hits.length} passage(s) from ${scopeNote}.`,
      "",
      formatTerranHits(hits),
    );
  }
  if (webText) {
    if (sections.length > 0) sections.push("");
    sections.push("## Terran web context", "", webText);
  }
  const text = sections.join("\n");

  return {
    text,
    hitCount: hits.length,
    webHitCount,
    warnings: search.warnings,
    error: null,
    running: true,
  };
}

function namespaceHasCorpus(dataRoot, existsSync, readdirSync) {
  if (!existsSync(dataRoot)) return false;
  for (const entry of readdirSync(dataRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(path.join(dataRoot, entry.name, "vector_store.db"))) return true;
  }
  return false;
}

function readSettingsPort(settingsPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    const port = Number.parseInt(String(raw.serverPort ?? DEFAULT_TERRAN_REST_PORT), 10);
    return Number.isFinite(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_TERRAN_REST_PORT;
  } catch {
    return DEFAULT_TERRAN_REST_PORT;
  }
}

function findInstalledExecutable(existsSync) {
  const candidates = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA ?? "";
    candidates.push(
      path.join(local, "Programs", "Aura Terran", "Aura Terran.exe"),
      path.join("C:", "Program Files", "Aura Terran", "Aura Terran.exe"),
    );
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Aura Terran.app");
  }
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Build Terran RAG options from install detection and on-disk settings.
 *
 * @returns {{ namespace?: string, restUrl: string, token?: string }}
 */
export function makeTerranRagOptions({ namespace, includeWebSearch = false } = {}) {
  const install = detectTerranInstalled();
  const settings = readTerranSettings(install.settingsPath);
  const restUrl = resolveTerranRestUrl({ port: settings?.port ?? install.suggestedRestPort });
  const token = settings?.authEnabled && settings.token ? settings.token : undefined;
  return {
    ...(namespace ? { namespace } : {}),
    restUrl,
    ...(token ? { token } : {}),
    ...(includeWebSearch ? { includeWebSearch: true } : {}),
  };
}
