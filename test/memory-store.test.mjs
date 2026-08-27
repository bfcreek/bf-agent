import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import {
  clearMemory,
  consolidateMemory,
  lessonRankScore,
  lessonWinRate,
  loadMemoryStore,
  MAX_LESSONS,
  maybeWriteLesson,
  rankLessons,
  saveMemoryStore,
  shouldWriteLesson,
} from "../src/memory-store.mjs";

let configDir;
const previousConfigDir = process.env.HALO_AGENT_CONFIG_DIR;

before(async () => {
  configDir = await mkdtemp(path.join(os.tmpdir(), "halo-memory-"));
  process.env.HALO_AGENT_CONFIG_DIR = configDir;
});

after(async () => {
  if (previousConfigDir === undefined) delete process.env.HALO_AGENT_CONFIG_DIR;
  else process.env.HALO_AGENT_CONFIG_DIR = previousConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

/** Deterministic unit-length embedding so similarity is easy to reason about. */
function vec(x, y = 0) {
  return [x, y, 0];
}

function lessonFixture(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    lesson: "guidance",
    trigger: "trigger",
    embedding: vec(1),
    source: "learned",
    status: "candidate",
    stats: { retrieved: 0, presentOnPass: 0, presentOnFail: 0 },
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test("lessonWinRate uses Laplace smoothing", () => {
  assert.ok(lessonWinRate({ presentOnPass: 0, presentOnFail: 0 }) > 0);
  assert.ok(
    lessonWinRate({ presentOnPass: 10, presentOnFail: 0 }) >
      lessonWinRate({ presentOnPass: 2, presentOnFail: 8 }),
  );
});

test("rankLessons prefers higher win-rate at similar similarity", () => {
  const query = [1, 0, 0];
  const lessons = [
    {
      id: "a",
      lesson: "good",
      trigger: "test",
      embedding: [1, 0, 0],
      status: "validated",
      stats: { retrieved: 5, presentOnPass: 8, presentOnFail: 1 },
    },
    {
      id: "b",
      lesson: "bad",
      trigger: "test",
      embedding: [0.99, 0.01, 0],
      status: "validated",
      stats: { retrieved: 5, presentOnPass: 1, presentOnFail: 9 },
    },
  ];
  const ranked = rankLessons(lessons, query, 2);
  assert.equal(ranked[0].lesson.id, "a");
});

test("lessonRankScore zeroes retired lessons", () => {
  assert.equal(
    lessonRankScore(
      { status: "retired", stats: { presentOnPass: 10, presentOnFail: 0 } },
      0.9,
    ),
    0,
  );
});

test("shouldWriteLesson gates on struggle and outcome", () => {
  assert.equal(
    shouldWriteLesson({
      verificationPassed: true,
      struggleScore: 0,
      stepCount: 1,
      stopReason: "completed",
    }),
    false,
  );
  assert.equal(
    shouldWriteLesson({
      verificationPassed: true,
      struggleScore: 3,
      stepCount: 4,
      stopReason: "completed",
    }),
    true,
  );
  assert.equal(
    shouldWriteLesson({
      verificationPassed: false,
      struggleScore: 0,
      stepCount: 3,
      stopReason: "max-steps",
    }),
    true,
  );
});

test("consolidateMemory persists a store it was handed", async () => {
  await clearMemory();
  const store = await loadMemoryStore();
  store.lessons.push(lessonFixture({ id: "keep-me" }));

  await consolidateMemory({ store });

  const reloaded = await loadMemoryStore();
  assert.deepEqual(
    reloaded.lessons.map((l) => l.id),
    ["keep-me"],
  );
});

test("a lesson written over the cap survives the eviction sweep", async () => {
  await clearMemory();
  const store = await loadMemoryStore();
  for (let i = 0; i < MAX_LESSONS; i++) {
    store.lessons.push(
      lessonFixture({
        id: `filler-${i}`,
        embedding: vec(Math.cos(i), Math.sin(i)),
        stats: { retrieved: 5, presentOnPass: 5, presentOnFail: 0 },
      }),
    );
  }
  await saveMemoryStore(store);

  const client = {
    async embed() {
      return vec(0, 1);
    },
    async chat() {
      return { message: { content: "LESSON: read before editing | TRIGGER: edit tasks" } };
    },
  };
  const result = await maybeWriteLesson({
    client,
    goal: "edit a module and run the tests",
    steps: [
      { kind: "tool-calls", toolCalls: [{ name: "read_file", ok: true }] },
      { kind: "tool-calls", toolCalls: [{ name: "edit_file", ok: false, error: "no match" }] },
      { kind: "tool-calls", toolCalls: [{ name: "edit_file", ok: false, error: "no match" }] },
    ],
    verificationPassed: false,
    struggleScore: 4,
    stopReason: "max-steps",
  });

  assert.equal(result.written, true);
  const reloaded = await loadMemoryStore();
  assert.ok(
    reloaded.lessons.some((l) => l.id === result.lessonId),
    "the newly written lesson should be on disk after curation",
  );
  assert.ok(reloaded.lessons.length <= MAX_LESSONS);
});

test("consolidateMemory drops retired learned lessons but keeps retired seeds", async () => {
  await clearMemory();
  const store = await loadMemoryStore();
  store.lessons.push(
    lessonFixture({ id: "retired-learned", status: "retired", source: "learned" }),
    lessonFixture({ id: "retired-seed", status: "retired", source: "seed" }),
    lessonFixture({ id: "active", embedding: vec(0, 1) }),
  );

  const stats = await consolidateMemory({ store });

  const reloaded = await loadMemoryStore();
  const ids = reloaded.lessons.map((l) => l.id).sort();
  assert.deepEqual(ids, ["active", "retired-seed"]);
  assert.equal(stats.pruned, 1);
});
