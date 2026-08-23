/**
 * Grade halo-agent runs with the Cursor CLI agent (default model: auto).
 * Read-only ask mode — the judge inspects artifacts, it does not edit them.
 */

import { spawn } from "node:child_process";

import { captureWorkspaceSnapshot, formatSnapshotForPrompt } from "./workspace-snapshot.mjs";
import { agentAnswerText } from "./scenarios.mjs";

const DEFAULT_AGENT_BIN = "agent";

/**
 * Windows cannot spawn .cmd/.bat directly; route through cmd.exe instead.
 * @param {string} agentBin
 * @param {string[]} args
 */
export function buildAgentSpawn(agentBin, args) {
  if (process.platform === "win32") {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", agentBin, ...args],
    };
  }
  return { command: agentBin, args };
}

/**
 * @typedef {object} JudgeVerdict
 * @property {number} score 0–100
 * @property {string} grade Letter grade or short label
 * @property {string} summary One-paragraph assessment
 * @property {Array<{name: string, score: number, max: number, notes: string}>} criteria
 * @property {string[]} strengths
 * @property {string[]} weaknesses
 * @property {Array<{area: string, suggestion: string, priority: "low"|"medium"|"high"}>} agentImprovements
 * @property {string} raw Judge model text (parsed JSON when possible)
 */

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {string} input.workspaceDir
 * @param {object} [input.options]
 * @param {string} [input.options.model]
 * @param {string} [input.options.agentBin]
 * @param {number} [input.options.timeoutSeconds]
 */
export async function judgeRun({ scenario, agentResult, workspaceDir, options = {} }) {
  const snapshot = await captureWorkspaceSnapshot(workspaceDir);
  const retries = options.retries ?? 2;
  let lastRaw = "";
  let lastVerdict = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const prompt =
      attempt === 0
        ? buildJudgePrompt({ scenario, agentResult, snapshot })
        : buildJudgeRetryPrompt({ scenario, agentResult, snapshot, priorRaw: lastRaw });
    lastRaw = await runCursorAgent({
      prompt,
      workspaceDir,
      model: options.model ?? "auto",
      agentBin: options.agentBin ?? DEFAULT_AGENT_BIN,
      timeoutSeconds: options.timeoutSeconds ?? 300,
    });
    lastVerdict = parseJudgeResponse(lastRaw);
    if (isUsableVerdict(lastVerdict)) return lastVerdict;
  }

  return lastVerdict;
}

function isUsableVerdict(verdict) {
  return verdict.grade !== "?" && verdict.summary !== "Judge response was not valid JSON.";
}

const JUDGE_RESPONSE_SCHEMA = {
  score: 0,
  grade: "F",
  summary: "one paragraph",
  criteria: [{ name: "criterion name", score: 0, max: 10, notes: "why" }],
  strengths: ["..."],
  weaknesses: ["..."],
  agentImprovements: [
    {
      area: "system prompt | tools | planning | compaction | other",
      suggestion: "concrete change to halo-agent runtime",
      priority: "low|medium|high",
    },
  ],
};

/**
 * @param {import("../src/agent-loop.mjs").AgentRunResult} agentResult
 */
function formatAgentStepsForJudge(agentResult) {
  return (agentResult.steps ?? [])
    .map((step) => {
      const tools = (step.toolCalls ?? [])
        .map((c) => `${c.name}(${JSON.stringify(c.args)}) -> ${c.ok ? "ok" : c.error}`)
        .join("; ");
      return `  ${step.index}. [${step.kind}] ${step.content?.slice(0, 200) || "(no text)"}${tools ? ` | ${tools}` : ""}`;
    })
    .join("\n");
}

/**
 * Shared grading context for initial and retry judge prompts.
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 */
function buildJudgeGradingContext({ scenario, agentResult, snapshot }) {
  const steps = formatAgentStepsForJudge(agentResult);
  return [
    "## Task",
    scenario.goal,
    "",
    "## Rubric",
    scenario.rubric,
    "",
    "## Agent final answer",
    agentAnswerText(agentResult) || "(empty)",
    "",
    `## Agent stop reason: ${agentResult.stopReason}`,
    `## Agent steps (${agentResult.steps?.length ?? 0}):`,
    steps || "  (none)",
    "",
    "## Workspace snapshot",
    formatSnapshotForPrompt(snapshot),
  ].join("\n");
}

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 * @param {string} [input.priorRaw]
 */
export function buildJudgeRetryPrompt({ scenario, agentResult, snapshot, priorRaw }) {
  return [
    "Your previous grading response was invalid or incomplete.",
    "Reply with ONLY a single JSON object matching the schema below — no markdown fences, no placeholders.",
    "Use the full agent artifacts below to grade outcome and process.",
    "",
    buildJudgeGradingContext({ scenario, agentResult, snapshot }),
    "",
    "Previous invalid response:",
    String(priorRaw ?? "").slice(0, 1500),
    "",
    "Respond with a single JSON object and no markdown fences. Schema:",
    JSON.stringify(JUDGE_RESPONSE_SCHEMA, null, 2),
  ].join("\n");
}

/**
 * @param {object} input
 * @param {import("./scenarios.mjs").BenchScenario} input.scenario
 * @param {import("../src/agent-loop.mjs").AgentRunResult} input.agentResult
 * @param {Awaited<ReturnType<typeof captureWorkspaceSnapshot>>} input.snapshot
 */
export function buildJudgePrompt({ scenario, agentResult, snapshot }) {
  return [
    "You are grading an AI coding agent (halo-agent) that ran against a task in a temp workspace.",
    "Evaluate the OUTCOME in the workspace and the agent's process, not your own ability to fix it.",
    "",
    buildJudgeGradingContext({ scenario, agentResult, snapshot }),
    "",
    "Respond with a single JSON object and no markdown fences. Schema:",
    JSON.stringify(JUDGE_RESPONSE_SCHEMA, null, 2),
  ].join("\n");
}

/**
 * @param {string} text
 * @returns {JudgeVerdict}
 */
export function parseJudgeResponse(text) {
  const parsed = extractJsonObject(String(text ?? ""));
  if (!parsed) {
    return {
      score: 0,
      grade: "?",
      summary: "Judge response was not valid JSON.",
      criteria: [],
      strengths: [],
      weaknesses: [],
      agentImprovements: [],
      raw: String(text ?? ""),
    };
  }
  return {
    score: clampScore(parsed.score),
    grade: String(parsed.grade ?? "?"),
    summary: String(parsed.summary ?? ""),
    criteria: Array.isArray(parsed.criteria)
      ? parsed.criteria.map((c) => ({
          name: String(c.name ?? ""),
          score: Number(c.score) || 0,
          max: Number(c.max) || 10,
          notes: String(c.notes ?? ""),
        }))
      : [],
    strengths: Array.isArray(parsed.strengths) ? parsed.strengths.map(String) : [],
    weaknesses: Array.isArray(parsed.weaknesses) ? parsed.weaknesses.map(String) : [],
    agentImprovements: Array.isArray(parsed.agentImprovements)
      ? parsed.agentImprovements.map((item) => ({
          area: String(item.area ?? "other"),
          suggestion: String(item.suggestion ?? ""),
          priority: ["low", "medium", "high"].includes(item.priority) ? item.priority : "medium",
        }))
      : [],
    raw: String(text ?? ""),
  };
}

/** @param {string} text */
function extractJsonObject(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // fall through
  }
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {
      // fall through
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function clampScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * @param {object} options
 * @param {string} options.prompt
 * @param {string} options.workspaceDir
 * @param {string} options.model
 * @param {string} options.agentBin
 * @param {number} options.timeoutSeconds
 */
export function runCursorAgent({ prompt, workspaceDir, model, agentBin, timeoutSeconds }) {
  const args = [
    "--print",
    "--trust",
    "--mode",
    "ask",
    "--model",
    model,
    "--output-format",
    "json",
    "--workspace",
    workspaceDir,
    prompt,
  ];

  return new Promise((resolve, reject) => {
    const { command, args: spawnArgs } = buildAgentSpawn(agentBin, args);
    const child = spawn(command, spawnArgs, {
      cwd: workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Cursor agent timed out after ${timeoutSeconds}s`));
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to run '${agentBin}': ${err.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Cursor agent exited ${code}: ${stderr || stdout}`.trim()));
        return;
      }
      try {
        const envelope = JSON.parse(stdout.trim());
        resolve(String(envelope.result ?? ""));
      } catch {
        resolve(stdout.trim());
      }
    });
  });
}
