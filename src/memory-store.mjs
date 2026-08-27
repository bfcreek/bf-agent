/**
 * Episodic memory: durable user-global lesson store with embeddings,
 * win-rate-weighted retrieval, gated writes, and consolidation.
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_EMBEDDING_MODEL } from "./project-index.mjs";
import { getConfigDir } from "./user-config.mjs";

export const MEMORY_VERSION = 1;
export const MEMORY_DIR = "memory";
export const LESSONS_FILE = "lessons.json";
export const MAX_LESSONS = 500;
export const MERGE_SIMILARITY = 0.92;
export const MIN_HIT_SCORE = 0.2;
export const AUTO_CONSOLIDATE_EVERY = 25;

/**
 * Decimal places kept when storing an embedding. Full float precision costs
 * ~29 bytes per dimension, which at MAX_LESSONS makes a store the loop reads
 * and rewrites several times per run. Six places is far below the precision
 * that would shift similarity ranking.
 */
export const EMBEDDING_PRECISION = 6;

/**
 * @param {number[]} embedding
 * @returns {number[]}
 */
export function quantizeEmbedding(embedding) {
  const factor = 10 ** EMBEDDING_PRECISION;
  return (embedding ?? []).map((v) => Math.round(v * factor) / factor);
}

/** @typedef {"seed"|"learned"} LessonSource */
/** @typedef {"candidate"|"validated"|"canonical"|"retired"} LessonStatus */

/**
 * @typedef {object} LessonStats
 * @property {number} retrieved
 * @property {number} presentOnPass
 * @property {number} presentOnFail
 */

/**
 * @typedef {object} Lesson
 * @property {string} id
 * @property {string} lesson
 * @property {string} trigger
 * @property {number[]} embedding
 * @property {LessonSource} source
 * @property {LessonStatus} status
 * @property {LessonStats} stats
 * @property {string[]} tags
 * @property {string} [evidence]
 * @property {string} createdAt
 * @property {string} updatedAt
 */

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

/** @returns {string} */
export function memoryStorePath() {
  return path.join(getConfigDir(), MEMORY_DIR, LESSONS_FILE);
}

/**
 * @returns {Promise<{version: number, embeddingModel: string, lessons: Lesson[]}>}
 */
export async function loadMemoryStore() {
  try {
    const raw = await readFile(memoryStorePath(), "utf8");
    const data = JSON.parse(raw);
    if (!data.lessons) data.lessons = [];
    return data;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { version: MEMORY_VERSION, embeddingModel: DEFAULT_EMBEDDING_MODEL, lessons: [] };
    }
    throw err;
  }
}

/**
 * Written compactly: pretty-printing puts every embedding dimension on its own
 * indented line, which roughly doubles a store the loop rewrites each run.
 * Use `memory list` to read it.
 * @param {object} store
 */
export async function saveMemoryStore(store) {
  const dir = path.dirname(memoryStorePath());
  await mkdir(dir, { recursive: true });
  await writeFile(memoryStorePath(), JSON.stringify(store), "utf8");
}

/**
 * Laplace-smoothed win rate for ranking.
 * @param {LessonStats} stats
 * @returns {number}
 */
export function lessonWinRate(stats) {
  const wins = stats?.presentOnPass ?? 0;
  const fails = stats?.presentOnFail ?? 0;
  return (wins + 1) / (wins + fails + 2);
}

/**
 * @param {Lesson} lesson
 * @param {number} similarity
 * @returns {number}
 */
export function lessonRankScore(lesson, similarity) {
  if (lesson.status === "retired") return 0;
  const statusBoost =
    lesson.status === "canonical" ? 1.3 : lesson.status === "validated" ? 1.15 : 1;
  return similarity * lessonWinRate(lesson.stats) * statusBoost;
}

/**
 * @param {Lesson[]} lessons
 * @param {number[]} queryVec
 * @param {number} [topK]
 * @returns {Array<{lesson: Lesson, score: number, similarity: number}>}
 */
export function rankLessons(lessons, queryVec, topK = 3) {
  return (lessons ?? [])
    .filter((l) => l.status !== "retired" && Array.isArray(l.embedding) && l.embedding.length)
    .map((lesson) => {
      const similarity = cosineSimilarity(queryVec, lesson.embedding);
      return { lesson, similarity, score: lessonRankScore(lesson, similarity) };
    })
    .filter((r) => r.similarity >= MIN_HIT_SCORE)
    .sort((a, b) => b.score - a.score || b.similarity - a.similarity)
    .slice(0, topK);
}

/**
 * Format retrieved lessons for prompt injection.
 * @param {Array<{lesson: Lesson}>} hits
 * @returns {string}
 */
export function formatMemoryHints(hits) {
  if (!hits?.length) return "";
  const lines = hits.map(
    (h, i) => `[${i + 1}] (${h.lesson.status ?? "candidate"}) ${h.lesson.lesson}`,
  );
  return ["## Learned guidance (from past runs)", ...lines.map((l) => `- ${l}`)].join("\n");
}

/**
 * @param {object} options
 * @param {string} options.goal
 * @param {{embed: Function}} options.client
 * @param {string} [options.embeddingModel]
 * @param {number} [options.topK]
 * @param {boolean} [options.readonly]
 * @returns {Promise<{text: string, lessonIds: string[], hits: Array<{lesson: Lesson, score: number}>}>}
 */
export async function retrieveMemoryHints({
  goal,
  client,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  topK = 3,
  readonly = false,
}) {
  if (!client?.embed || !goal?.trim()) {
    return { text: "", lessonIds: [], hits: [] };
  }

  const store = await loadMemoryStore();
  if (!store.lessons.length) return { text: "", lessonIds: [], hits: [] };

  const queryVec = await client.embed({ prompt: goal, model: embeddingModel });
  const hits = rankLessons(store.lessons, queryVec, topK);
  if (!hits.length) return { text: "", lessonIds: [], hits: [] };

  if (!readonly) {
    for (const hit of hits) {
      hit.lesson.stats.retrieved = (hit.lesson.stats.retrieved ?? 0) + 1;
      hit.lesson.updatedAt = new Date().toISOString();
    }
    await saveMemoryStore(store);
  }

  return {
    text: formatMemoryHints(hits),
    lessonIds: hits.map((h) => h.lesson.id),
    hits,
  };
}

/**
 * Whether a run outcome warrants writing a lesson.
 * @param {object} input
 * @param {boolean} input.verificationPassed
 * @param {number} input.struggleScore
 * @param {number} input.stepCount
 * @param {string} [input.stopReason]
 * @returns {boolean}
 */
export function shouldWriteLesson({ verificationPassed, struggleScore, stepCount, stopReason }) {
  if (verificationPassed && struggleScore >= 2 && stepCount >= 3) return true;
  if (!verificationPassed && stopReason === "failed" && stepCount >= 2) return true;
  if (!verificationPassed && stopReason === "max-steps" && stepCount >= 3) return true;
  return false;
}

const DISTILL_PROMPT = [
  "Distill one short actionable lesson (1-2 sentences) from this agent run.",
  "Format: LESSON: <guidance> | TRIGGER: <when to apply>",
  "Focus on what worked or what failed — not step-by-step transcript.",
].join(" ");

/**
 * @param {object} options
 * @param {{chat: Function}} options.client
 * @param {string} options.goal
 * @param {string} options.summary
 * @param {boolean} options.passed
 * @returns {Promise<{lesson: string, trigger: string}|null>}
 */
export async function distillLesson({ client, goal, summary, passed }) {
  if (!client?.chat) return null;
  try {
    const { message } = await client.chat({
      messages: [
        { role: "system", content: DISTILL_PROMPT },
        {
          role: "user",
          content: `Goal: ${goal}\nOutcome: ${passed ? "PASSED" : "FAILED"}\nSummary:\n${summary}`,
        },
      ],
    });
    const text = typeof message?.content === "string" ? message.content : "";
    const lessonMatch = text.match(/LESSON:\s*(.+?)(?:\||\n|$)/i);
    const triggerMatch = text.match(/TRIGGER:\s*(.+?)(?:\n|$)/i);
    const lesson = (lessonMatch?.[1] ?? text.split("\n")[0] ?? "").trim();
    const trigger = (triggerMatch?.[1] ?? goal.slice(0, 120)).trim();
    if (!lesson || lesson.length < 10) return null;
    return { lesson, trigger };
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {string} options.goal
 * @param {Array<{kind?: string, content?: string, toolCalls?: Array<object>}>} options.steps
 * @param {boolean} options.passed
 * @returns {string}
 */
export function summarizeRunForMemory({ goal, steps, passed }) {
  const lines = [`Goal: ${goal}`, `Outcome: ${passed ? "pass" : "fail"}`];
  for (const step of (steps ?? []).slice(-8)) {
    if (step.kind === "plan") lines.push(`Plan: ${String(step.content ?? "").slice(0, 300)}`);
    if (step.kind === "final") lines.push(`Final: ${String(step.content ?? "").slice(0, 200)}`);
    for (const call of step.toolCalls ?? []) {
      if (!call.ok && call.error) lines.push(`Tool ${call.name} failed: ${String(call.error).slice(0, 120)}`);
    }
  }
  return lines.join("\n");
}

/**
 * @param {object} options
 * @param {{embed: Function, chat?: Function}} options.client
 * @param {string} options.goal
 * @param {Array<object>} options.steps
 * @param {boolean} options.verificationPassed
 * @param {number} options.struggleScore
 * @param {string} [options.stopReason]
 * @param {string} [options.embeddingModel]
 * @param {boolean} [options.readonly]
 * @returns {Promise<{written: boolean, merged: boolean, lessonId?: string}>}
 */
export async function maybeWriteLesson({
  client,
  goal,
  steps,
  verificationPassed,
  struggleScore,
  stopReason,
  embeddingModel = DEFAULT_EMBEDDING_MODEL,
  readonly = false,
}) {
  if (readonly || !client?.embed) return { written: false, merged: false };

  const stepCount = (steps ?? []).filter((s) => s.kind === "tool-calls" || s.kind === "final").length;
  if (
    !shouldWriteLesson({
      verificationPassed,
      struggleScore,
      stepCount,
      stopReason,
    })
  ) {
    return { written: false, merged: false };
  }

  const summary = summarizeRunForMemory({ goal, steps, passed: verificationPassed });
  const distilled =
    (await distillLesson({
      client,
      goal,
      summary,
      passed: verificationPassed,
    })) ??
    (verificationPassed
      ? {
          lesson: `When facing similar tasks, follow the approach that succeeded: ${goal.slice(0, 80)}`,
          trigger: goal.slice(0, 120),
        }
      : {
          lesson:
            "Avoid repeating failed approach; verify deliverables and run named commands before finishing.",
          trigger: goal.slice(0, 120),
        });

  const store = await loadMemoryStore();
  const embedText = `${distilled.trigger}\n${distilled.lesson}`;
  const embedding = quantizeEmbedding(
    await client.embed({ prompt: embedText, model: embeddingModel }),
  );

  let merged = false;
  for (const existing of store.lessons) {
    if (!existing.embedding?.length) continue;
    if (cosineSimilarity(embedding, existing.embedding) >= MERGE_SIMILARITY) {
      existing.lesson = distilled.lesson;
      existing.trigger = distilled.trigger;
      existing.embedding = embedding;
      existing.updatedAt = new Date().toISOString();
      existing.evidence = summary.slice(0, 500);
      merged = true;
      await persistWithCuration(store, embeddingModel);
      return { written: true, merged: true, lessonId: existing.id };
    }
  }

  const now = new Date().toISOString();
  const lesson = {
    id: randomUUID(),
    lesson: distilled.lesson,
    trigger: distilled.trigger,
    embedding,
    source: "learned",
    status: "candidate",
    stats: { retrieved: 0, presentOnPass: 0, presentOnFail: 0 },
    tags: [],
    evidence: summary.slice(0, 500),
    createdAt: now,
    updatedAt: now,
  };
  store.lessons.push(lesson);
  await persistWithCuration(store, embeddingModel);

  return { written: true, merged: false, lessonId: lesson.id };
}

/**
 * Save the store, curating first when it is over cap or due for a sweep.
 * @param {object} store
 * @param {string} [embeddingModel]
 */
async function persistWithCuration(store, embeddingModel) {
  const total = store.lessons.length;
  if (total > MAX_LESSONS || total % AUTO_CONSOLIDATE_EVERY === 0) {
    await consolidateMemory({ embeddingModel, store });
    return;
  }
  await saveMemoryStore(store);
}

/**
 * Update win-rate stats for lessons injected during a run.
 * @param {string[]} lessonIds
 * @param {boolean} passed
 */
export async function recordLessonOutcomes(lessonIds, passed) {
  if (!lessonIds?.length) return;
  const store = await loadMemoryStore();
  let changed = false;
  for (const id of lessonIds) {
    const lesson = store.lessons.find((l) => l.id === id);
    if (!lesson) continue;
    if (passed) lesson.stats.presentOnPass = (lesson.stats.presentOnPass ?? 0) + 1;
    else lesson.stats.presentOnFail = (lesson.stats.presentOnFail ?? 0) + 1;
    lesson.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) await saveMemoryStore(store);
}

/**
 * Promote lessons based on win rate and retrieval count.
 * @param {Lesson} lesson
 */
export function promoteLessonIfEarned(lesson) {
  const wins = lesson.stats?.presentOnPass ?? 0;
  const fails = lesson.stats?.presentOnFail ?? 0;
  const total = wins + fails;
  const rate = lessonWinRate(lesson.stats);
  if (lesson.status === "candidate" && wins >= 3 && rate >= 0.6) {
    lesson.status = "validated";
  }
  if (lesson.status === "validated" && wins >= 8 && rate >= 0.75 && total >= 10) {
    lesson.status = "canonical";
  }
}

/**
 * Merge near-duplicate lessons, evict losers, cap store size. Always persists.
 * @param {object} [options]
 * @param {string} [options.embeddingModel]
 * @param {object} [options.store] Already-loaded store to curate in place.
 * @returns {Promise<{merged: number, evicted: number, promoted: number, pruned: number}>}
 */
export async function consolidateMemory({ embeddingModel, store: inputStore } = {}) {
  const store = inputStore ?? (await loadMemoryStore());
  let merged = 0;
  let evicted = 0;
  let promoted = 0;

  for (const lesson of store.lessons) {
    const before = lesson.status;
    promoteLessonIfEarned(lesson);
    if (lesson.status !== before) promoted += 1;
  }

  const active = store.lessons.filter((l) => l.status !== "retired");
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      // A lesson retired earlier in this sweep is already folded into a
      // survivor; merging it again would double-count its stats.
      if (a.status === "retired" || b.status === "retired") continue;
      if (!a.embedding?.length || !b.embedding?.length) continue;
      if (cosineSimilarity(a.embedding, b.embedding) < MERGE_SIMILARITY) continue;

      const keep = lessonWinRate(a.stats) >= lessonWinRate(b.stats) ? a : b;
      const drop = keep === a ? b : a;
      keep.lesson = keep.lesson.length >= drop.lesson.length ? keep.lesson : drop.lesson;
      keep.stats.retrieved = (keep.stats.retrieved ?? 0) + (drop.stats.retrieved ?? 0);
      keep.stats.presentOnPass = (keep.stats.presentOnPass ?? 0) + (drop.stats.presentOnPass ?? 0);
      keep.stats.presentOnFail = (keep.stats.presentOnFail ?? 0) + (drop.stats.presentOnFail ?? 0);
      drop.status = "retired";
      merged += 1;
    }
  }

  const surviving = store.lessons.filter((l) => l.status !== "retired");
  if (surviving.length > MAX_LESSONS) {
    const ranked = [...surviving].sort((a, b) => {
      const scoreA = lessonWinRate(a.stats) * (a.stats.retrieved ?? 0);
      const scoreB = lessonWinRate(b.stats) * (b.stats.retrieved ?? 0);
      return scoreA - scoreB;
    });
    const toEvict = ranked.slice(0, surviving.length - MAX_LESSONS);
    for (const lesson of toEvict) {
      if (lesson.source === "seed" && lesson.status === "canonical") continue;
      lesson.status = "retired";
      evicted += 1;
    }
  }

  // Retired learned lessons are inert but carry a full embedding, so drop them.
  // Retired seeds stay: their tag is what stops seedMemoryFromRules re-adding them.
  const pruned = store.lessons.length;
  store.lessons = store.lessons.filter(
    (l) => l.status !== "retired" || l.source === "seed",
  );

  store.embeddingModel = embeddingModel ?? store.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
  await saveMemoryStore(store);
  return { merged, evicted, promoted, pruned: pruned - store.lessons.length };
}

/**
 * Seed memory from TASK_HINT_RULES constraints.
 * @param {object} options
 * @param {Array<{id: string, constraint: string}>} options.rules
 * @param {{embed: Function}} options.client
 * @param {string} [options.embeddingModel]
 * @returns {Promise<number>} Count of lessons seeded.
 */
export async function seedMemoryFromRules({ rules, client, embeddingModel = DEFAULT_EMBEDDING_MODEL }) {
  if (!client?.embed || !rules?.length) return 0;
  const store = await loadMemoryStore();
  const existingIds = new Set(store.lessons.filter((l) => l.source === "seed").map((l) => l.tags?.[0]));
  let seeded = 0;

  for (const rule of rules) {
    if (existingIds.has(rule.id)) continue;
    const trigger = rule.id.replace(/-/g, " ");
    const embedText = `${trigger}\n${rule.constraint}`;
    const embedding = quantizeEmbedding(
      await client.embed({ prompt: embedText, model: embeddingModel }),
    );
    const now = new Date().toISOString();
    store.lessons.push({
      id: createHash("sha256").update(rule.id).digest("hex").slice(0, 16),
      lesson: rule.constraint,
      trigger,
      embedding,
      source: "seed",
      status: "validated",
      stats: { retrieved: 0, presentOnPass: 0, presentOnFail: 0 },
      tags: [rule.id],
      createdAt: now,
      updatedAt: now,
    });
    seeded += 1;
  }

  if (seeded) await saveMemoryStore(store);
  return seeded;
}

/**
 * Return canonical lessons for system prompt injection.
 * @returns {Promise<string>}
 */
export async function formatCanonicalPrinciples() {
  const store = await loadMemoryStore();
  const canonical = store.lessons.filter((l) => l.status === "canonical").slice(0, 5);
  if (!canonical.length) return "";
  return [
    "## Earned principles (from successful runs)",
    ...canonical.map((l) => `- ${l.lesson}`),
  ].join("\n");
}

/** @returns {Promise<object>} Memory store statistics. */
export async function memoryStats() {
  const store = await loadMemoryStore();
  const byStatus = {};
  const bySource = {};
  for (const l of store.lessons) {
    byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
    bySource[l.source] = (bySource[l.source] ?? 0) + 1;
  }
  return {
    total: store.lessons.length,
    byStatus,
    bySource,
    embeddingModel: store.embeddingModel,
    path: memoryStorePath(),
  };
}

/** Clear all lessons. */
export async function clearMemory() {
  await saveMemoryStore({
    version: MEMORY_VERSION,
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    lessons: [],
  });
}
