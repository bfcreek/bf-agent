import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  buildProjectContext,
  chunkText,
  discoverIndexFiles,
  ensureProjectIndex,
  gatherFirstTurnProjectContext,
  indexIsStale,
  indexPath,
  searchProjectIndex,
} from "../src/project-index.mjs";

let root;

class MockEmbedClient {
  calls = 0;

  async embed({ prompt }) {
    this.calls++;
    const sum = [...String(prompt)].reduce((a, c) => a + c.charCodeAt(0), 0);
    return [prompt.length, sum % 97, (sum % 53) + 1];
  }
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "halo-agent-rag-"));
  await writeFile(path.join(root, "README.md"), "# Halo Agent\n\nLocal agent runtime.\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "demo", version: "1.0.0", description: "A demo" }),
    "utf8",
  );
  await mkdir(path.join(root, "docs"));
  await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n\nHow to use it.", "utf8");
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

test("chunkText splits long text with overlap", () => {
  const text = "a".repeat(2500);
  const chunks = chunkText(text, 1000, 200);
  assert.ok(chunks.length >= 3);
  assert.equal(chunks[0].length, 1000);
});

test("discoverIndexFiles finds key root and docs markdown", async () => {
  const files = await discoverIndexFiles(root);
  assert.ok(files.includes("README.md"));
  assert.ok(files.includes("package.json"));
  assert.ok(files.includes(path.join("docs", "guide.md")));
});

test("indexIsStale detects hash and model changes", () => {
  const files = [{ path: "README.md", hash: "abc" }];
  const index = {
    version: 1,
    embeddingModel: "nomic-embed-text",
    fingerprint: "README.md:abc",
  };
  assert.equal(indexIsStale(index, files, "nomic-embed-text"), false);
  assert.equal(indexIsStale(index, files, "other-model"), true);
  assert.equal(indexIsStale(index, [{ path: "README.md", hash: "def" }], "nomic-embed-text"), true);
});

test("ensureProjectIndex builds and reuses a cached index", async () => {
  const client = new MockEmbedClient();
  const first = await ensureProjectIndex({ workspaceRoot: root, client });
  assert.ok(first.chunkCount > 0);
  assert.equal(client.calls, first.chunkCount);

  const cached = await ensureProjectIndex({ workspaceRoot: root, client });
  assert.equal(cached.builtAt, first.builtAt);
  assert.equal(client.calls, first.chunkCount);

  const onDisk = JSON.parse(await readFile(indexPath(root), "utf8"));
  assert.equal(onDisk.chunkCount, first.chunkCount);
});

test("searchProjectIndex returns ranked passages", async () => {
  const client = new MockEmbedClient();
  await ensureProjectIndex({ workspaceRoot: root, client });

  const hits = await searchProjectIndex({
    workspaceRoot: root,
    query: "How to use it",
    client,
    topK: 2,
  });
  assert.ok(hits.length > 0);
  assert.match(hits[0].text, /How to use it/);
});

test("gatherFirstTurnProjectContext forces README and RAG passages", async () => {
  const client = new MockEmbedClient();
  const gathered = await gatherFirstTurnProjectContext({
    workspaceRoot: root,
    goal: "How to use it",
    client,
  });
  assert.match(gathered.text, /## Auto-retrieved project context/);
  assert.match(gathered.text, /README\.md \(read_file\)/);
  assert.match(gathered.text, /search_project\)/);
  assert.equal(gathered.readme, true);
  assert.ok(gathered.ragHits > 0);
});

test("buildProjectContext includes package summary and index note", async () => {
  const client = new MockEmbedClient();
  const context = await buildProjectContext({ workspaceRoot: root, client });
  assert.match(context, /## Project/);
  assert.match(context, /"name": "demo"/);
  assert.match(context, /Project index:/);
  assert.doesNotMatch(context, /README\.md/);
});
