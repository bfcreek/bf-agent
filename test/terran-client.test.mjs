import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  assertTerranInstalled,
  assertTerranReady,
  detectTerranInstalled,
  detectTerranRunning,
  formatTerranHits,
  formatTerranWebHits,
  gatherTerranContext,
  readTerranSettings,
  TerranError,
  terranCorpusSearch,
} from "../src/terran-client.mjs";

let fakeHome;

before(async () => {
  fakeHome = await mkdtemp(path.join(os.tmpdir(), "halo-agent-terran-home-"));
});

after(async () => {
  await rm(fakeHome, { recursive: true, force: true });
});

function homedir() {
  return fakeHome;
}

test("detectTerranInstalled is false on a clean fake home", () => {
  const clean = detectTerranInstalled({
    homedir: () => path.join(fakeHome, "clean-user"),
    existsSync: () => false,
    readdirSync: () => [],
  });
  assert.equal(clean.installed, false);
});

test("detectTerranInstalled finds settings.json", async () => {
  const root = path.join(fakeHome, "with-settings");
  const settingsPath = path.join(root, ".aura-terran", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ serverPort: 41800 }), "utf8");

  const status = detectTerranInstalled({
    homedir: () => root,
    existsSync: (p) => (p.startsWith(root) || p.startsWith(path.join(root, ".aura-terran"))) && fs.existsSync(p),
    readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
  });
  assert.equal(status.installed, true);
  assert.equal(status.suggestedRestPort, 41800);
});

test("assertTerranInstalled throws TerranError when missing", () => {
  assert.throws(
    () =>
      assertTerranInstalled({
        homedir: () => path.join(fakeHome, "missing-user"),
        existsSync: () => false,
        readdirSync: () => [],
      }),
    TerranError,
  );
});

test("readTerranSettings reads web search enabled from settings.json", async () => {
  const root = path.join(fakeHome, "web-settings");
  const settingsPath = path.join(root, ".aura-terran", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ serverPort: 41800, llmPassthroughIncludeWebResults: true }),
    "utf8",
  );

  const settings = readTerranSettings(settingsPath);
  assert.equal(settings?.webSearchEnabled, true);
});

test("assertTerranReady throws when REST is not running", async () => {
  const root = path.join(fakeHome, "terran-not-running");
  const settingsPath = path.join(root, ".aura-terran", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ serverPort: 41800 }), "utf8");

  await assert.rejects(
    () =>
      assertTerranReady({
        deps: {
          homedir: () => root,
          existsSync: (p) => p.startsWith(root) && fs.existsSync(p),
          readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
        },
        fetchImpl: async () => {
          throw new Error("fetch failed");
        },
      }),
    /Aura Terran REST is not available/,
  );
});

test("assertTerranReady throws when web is requested but disabled in settings", async () => {
  const root = path.join(fakeHome, "terran-no-web");
  const settingsPath = path.join(root, ".aura-terran", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ serverPort: 41800, llmPassthroughIncludeWebResults: false }),
    "utf8",
  );

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await assert.rejects(
      () =>
        assertTerranReady({
          includeWebSearch: true,
          deps: {
            homedir: () => root,
            existsSync: (p) => p.startsWith(root) && fs.existsSync(p),
            readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
          },
          fetchImpl: async (url, init) => fetch(`http://127.0.0.1:${port}/health`, init),
        }),
      /web search is not enabled/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("assertTerranReady succeeds when REST is running and web is enabled", async () => {
  const root = path.join(fakeHome, "terran-ready");
  const settingsPath = path.join(root, ".aura-terran", "settings.json");
  await mkdir(path.dirname(settingsPath), { recursive: true });
  await writeFile(
    settingsPath,
    JSON.stringify({ serverPort: 41800, llmPassthroughIncludeWebResults: true }),
    "utf8",
  );

  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const status = await assertTerranReady({
      includeWebSearch: true,
      deps: {
        homedir: () => root,
        existsSync: (p) => p.startsWith(root) && fs.existsSync(p),
        readdirSync: (p) => fs.readdirSync(p, { withFileTypes: true }),
      },
      fetchImpl: async (url, init) => fetch(`http://127.0.0.1:${port}/health`, init),
    });
    assert.equal(status.running.running, true);
    assert.equal(status.settings?.webSearchEnabled, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("formatTerranHits renders ranked passages", () => {
  const text = formatTerranHits([
    {
      content: "Refund within 30 days.",
      score: 0.87,
      namespace: "general",
      metadata: { fileName: "policy.md" },
    },
  ]);
  assert.match(text, /policy\.md/);
  assert.match(text, /Refund within 30 days/);
});

test("formatTerranWebHits renders web snippets", () => {
  const text = formatTerranWebHits([
    { title: "Node.js", url: "https://nodejs.org/", snippet: "JavaScript runtime." },
  ]);
  assert.match(text, /\[W1\] Source: Node\.js \(https:\/\/nodejs\.org\/\)/);
  assert.match(text, /JavaScript runtime/);
});

test("terranCorpusSearch sends includeWebSearch when enabled", async () => {
  let body = null;
  const server = http.createServer(async (req, res) => {
    if (req.url?.startsWith("/admin/corpus-search")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ results: [], warnings: [], scope: { mode: "all" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await terranCorpusSearch({
      query: "latest release",
      restUrl: `http://127.0.0.1:${port}`,
      includeWebSearch: true,
    });
    assert.equal(body.includeWebSearch, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("gatherTerranContext injects web context from REST", async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    if (req.url?.startsWith("/admin/corpus-search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [],
          webResults: [
            {
              title: "Node.js releases",
              url: "https://nodejs.org/en/about/previous-releases",
              snippet: "Current LTS is Node.js 22.",
            },
          ],
          warnings: [],
          scope: { mode: "all" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const result = await gatherTerranContext({
      query: "latest node lts",
      restUrl: `http://127.0.0.1:${port}`,
      includeWebSearch: true,
    });
    assert.equal(result.webHitCount, 1);
    assert.match(result.text, /Terran web context/);
    assert.match(result.text, /Current LTS is Node\.js 22/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("detectTerranRunning recognizes the Terran health endpoint", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const status = await detectTerranRunning({ restUrl: `http://127.0.0.1:${port}` });
    assert.equal(status.running, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("gatherTerranContext returns null text when REST is not running", async () => {
  const result = await gatherTerranContext({
    query: "refund policy",
    restUrl: "http://127.0.0.1:9",
  });
  assert.equal(result.text, null);
  assert.equal(result.hitCount, 0);
  assert.equal(result.running, false);
});

test("gatherTerranContext injects corpus hits from REST", async () => {
  const server = http.createServer(async (req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "aura-context-hub-rest" }));
      return;
    }
    if (req.url?.startsWith("/admin/corpus-search")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            {
              chunkId: "c1",
              documentId: "d1",
              namespace: "general",
              content: "Enterprise refunds are allowed within 30 days.",
              score: 0.9,
              metadata: { fileName: "refund.md" },
            },
          ],
          warnings: [],
          scope: { mode: "single", namespace: "general" },
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    const result = await gatherTerranContext({
      query: "refund policy",
      namespace: "general",
      restUrl: `http://127.0.0.1:${port}`,
    });
    assert.equal(result.hitCount, 1);
    assert.match(result.text, /Terran corpus context/);
    assert.match(result.text, /Enterprise refunds/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("terranCorpusSearch treats connection refusal as unreachable", async () => {
  const result = await terranCorpusSearch({
    query: "hello",
    restUrl: "http://127.0.0.1:9",
  });
  assert.equal(result.unreachable, true);
  assert.deepEqual(result.results, []);
});
