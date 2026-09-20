/**
 * Lightweight project RAG: index README and other key docs into
 * `.halo-agent/project-index.json`, embed with Ollama, search by cosine
 * similarity. No npm dependencies — vectors stay on disk, gitignored via
 * `.halo-agent/`. Exposed to the model only through the `search_project`
 * tool; nothing is injected into the prompt up front.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
export const INDEX_VERSION = 1;
export const INDEX_DIR = ".halo-agent";
export const INDEX_FILE = "project-index.json";

const ROOT_KEY_FILES = [
  "README.md",
  "ROADMAP.md",
  "package.json",
  "AGENTS.md",
  "CONTRIBUTING.md",
];

const SKIP_DIRS = new Set([
  ".git",
  ".halo-agent",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  "out",
]);

const DEFAULT_CHUNK_SIZE = 1200;
const DEFAULT_CHUNK_OVERLAP = 200;
const DEFAULT_TOP_K = 5;
const MAX_INDEX_FILES = 40;
const MAX_FILE_BYTES = 128_000;

/** @returns {string} Absolute path to the on-disk index file. */
export function indexPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), INDEX_DIR, INDEX_FILE);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
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
 * Split text into overlapping chunks for embedding.
 *
 * @param {string} text
 * @param {number} [chunkSize]
 * @param {number} [overlap]
 * @returns {string[]}
 */
export function chunkText(text, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_CHUNK_OVERLAP) {
  if (!text) return [];
  if (text.length <= chunkSize) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = Math.max(0, end - overlap);
  }
  return chunks;
}

async function listMarkdownInDir(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Discover project files worth indexing: key root files, root markdown, and
 * markdown under docs/.
 *
 * @param {string} workspaceRoot
 * @returns {Promise<string[]>} Relative paths, sorted, capped.
 */
export async function discoverIndexFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const relPaths = new Set();

  for (const name of ROOT_KEY_FILES) {
    try {
      await readFile(path.join(root, name));
      relPaths.add(name);
    } catch {
      // missing
    }
  }

  const rootMd = await listMarkdownInDir(root);
  for (const name of rootMd) relPaths.add(name);

  const docsDir = path.join(root, "docs");
  for (const name of await listMarkdownInDir(docsDir)) {
    relPaths.add(path.join("docs", name));
  }

  return [...relPaths].sort((a, b) => a.localeCompare(b)).slice(0, MAX_INDEX_FILES);
}

/**
 * @param {string} workspaceRoot
 * @returns {Promise<object|null>}
 */
export async function loadIndex(workspaceRoot) {
  try {
    const raw = await readFile(indexPath(workspaceRoot), "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function fileFingerprints(files) {
  return files.map((f) => `${f.path}:${f.hash}`).join("|");
}

/**
 * @param {object|null} index
 * @param {Array<{path: string, hash: string}>} files
 * @param {string} embeddingModel
 * @returns {boolean}
 */
export function indexIsStale(index, files, embeddingModel) {
  if (!index || index.version !== INDEX_VERSION) return true;
  if (index.embeddingModel !== embeddingModel) return true;
  return index.fingerprint !== fileFingerprints(files);
}

/**
 * Build or refresh the project index when files changed or the index is missing.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {{embed: Function}} options.client Ollama client with embed().
 * @param {string} [options.embeddingModel]
 * @param {AbortSignal} [options.signal]
 * @param {(message: string) => void} [options.onProgress]
 * @returns {Promise<object|null>} Index object, or null if indexing failed.
 */
export async function ensureProjectIndex({
  workspaceRoot,
  client,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  signal,
  onProgress,
} = {}) {
  if (!client?.embed) return null;

  const root = path.resolve(workspaceRoot);
  const relPaths = await discoverIndexFiles(root);
  const files = [];

  for (const rel of relPaths) {
    try {
      const abs = path.join(root, rel);
      const buf = await readFile(abs);
      if (buf.length > MAX_FILE_BYTES) continue;
      const text = buf.toString("utf8");
      files.push({ path: rel, hash: sha256(text), text });
    } catch {
      // skip unreadable
    }
  }

  const existing = await loadIndex(root);
  if (!indexIsStale(existing, files, embeddingModel)) {
    return existing;
  }

  onProgress?.(`indexing ${files.length} project file(s)…`);

  const chunks = [];
  for (const file of files) {
    const parts = chunkText(file.text);
    for (let i = 0; i < parts.length; i++) {
      chunks.push({
        path: file.path,
        index: i,
        hash: file.hash,
        text: parts[i],
      });
    }
  }

  if (chunks.length === 0) {
    const empty = {
      version: INDEX_VERSION,
      embeddingModel,
      builtAt: new Date().toISOString(),
      fingerprint: fileFingerprints(files),
      fileCount: files.length,
      chunkCount: 0,
      chunks: [],
    };
    await saveIndex(root, empty);
    return empty;
  }

  const embedded = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const chunk = chunks[i];
    onProgress?.(`embedding chunk ${i + 1}/${chunks.length} (${chunk.path})`);
    const vector = await client.embed({
      prompt: chunk.text,
      model: embeddingModel,
      signal,
    });
    embedded.push({ ...chunk, embedding: vector });
  }

  const index = {
    version: INDEX_VERSION,
    embeddingModel,
    builtAt: new Date().toISOString(),
    fingerprint: fileFingerprints(files),
    fileCount: files.length,
    chunkCount: embedded.length,
    chunks: embedded,
  };

  await saveIndex(root, index);
  return index;
}

/**
 * @param {string} workspaceRoot
 * @param {object} index
 */
export async function saveIndex(workspaceRoot, index) {
  const dir = path.join(path.resolve(workspaceRoot), INDEX_DIR);
  await mkdir(dir, { recursive: true });
  await writeFile(indexPath(workspaceRoot), JSON.stringify(index), "utf8");
}

/**
 * Search the project index by semantic similarity.
 *
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {string} options.query
 * @param {{embed: Function}} options.client
 * @param {string} [options.embeddingModel]
 * @param {number} [options.topK]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Array<{path: string, index: number, score: number, text: string}>|null>}
 */
export async function searchProjectIndex({
  workspaceRoot,
  query,
  client,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  topK = DEFAULT_TOP_K,
  signal,
} = {}) {
  if (!client?.embed || !query?.trim()) return null;

  const index = await loadIndex(workspaceRoot);
  if (!index?.chunks?.length) return [];

  const queryVec = await client.embed({ prompt: query, model: embeddingModel, signal });
  const ranked = index.chunks
    .map((chunk) => ({
      path: chunk.path,
      index: chunk.index,
      score: cosineSimilarity(queryVec, chunk.embedding),
      text: chunk.text,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return ranked;
}
