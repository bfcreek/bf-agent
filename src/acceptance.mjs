/**
 * Acceptance contracts: machine-checkable success criteria extracted from
 * the plan or goal heuristics, verified before the agent loop accepts done.
 */

import { access } from "node:fs/promises";
import path from "node:path";

import {
  commandExitCode,
  extractNamedDeliverables,
  extractNamedNodeCommands,
  extractNamedVerifyFiles,
  flattenToolCalls,
  isCreatedFileDeliverable,
  missingRequiredVerification,
  MUTATING_TOOL_NAMES,
  ranNamedCommand,
  runCommandText,
} from "./prompt-enhancements.mjs";

/** @typedef {"deliverable"|"command"|"output"} AcceptanceCheckKind */

/**
 * @typedef {object} AcceptanceCheck
 * @property {AcceptanceCheckKind} kind
 * @property {string} target
 * @property {string} [description]
 * @property {boolean} [optional]
 */

/**
 * @typedef {object} AcceptanceContract
 * @property {AcceptanceCheck[]} checks
 * @property {string} [outputShape]
 * @property {string} source plan|heuristic|merged
 */

/**
 * @typedef {object} CheckResult
 * @property {AcceptanceCheckKind} kind
 * @property {string} target
 * @property {boolean} passed
 * @property {string} detail
 */

/**
 * @typedef {object} VerificationResult
 * @property {boolean} passed Whether every contract check passed.
 * @property {CheckResult[]} checks
 * @property {string[]} missing Contract work still outstanding.
 * @property {string[]} advisory Heuristic verification gaps, not gated on.
 */

const ACCEPTANCE_HEADER = /^##\s*Acceptance\b/im;

/**
 * Parse a structured ## Acceptance block from plan text.
 * @param {string} planText
 * @returns {Partial<AcceptanceContract>}
 */
export function parseAcceptanceBlock(planText) {
  const text = String(planText ?? "");
  const match = text.match(/##\s*Acceptance\b([\s\S]*?)(?=\n##\s|\n#+\s|$)/i);
  if (!match) return { checks: [], outputShape: "" };

  const body = match[1].trim();
  const checks = [];
  let outputShape = "";

  for (const line of body.split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const outputMatch = trimmed.match(/^[-*]\s*(?:output|final answer)\s*:\s*(.+)$/i);
    if (outputMatch) {
      outputShape = outputMatch[1].trim();
      continue;
    }

    const deliverableMatch = trimmed.match(
      /^[-*]\s*(?:deliverable|file|artifact)\s*:\s*[`'"]?([\w./-]+\.[A-Za-z0-9]+)/i,
    );
    if (deliverableMatch) {
      checks.push({ kind: "deliverable", target: deliverableMatch[1] });
      continue;
    }

    const commandMatch = trimmed.match(/^[-*]\s*(?:command|verify|run)\s*:\s*`?([^`]+?)`?\s*$/i);
    if (commandMatch) {
      checks.push({ kind: "command", target: commandMatch[1].trim() });
      continue;
    }

    const backtickCmd = trimmed.match(/^[-*]\s*`([^`]+)`\s*(?:exits?\s*0|passes?)?\.?$/i);
    if (backtickCmd && /\b(node|python|dotnet|npm|pytest|cargo|go)\b/i.test(backtickCmd[1])) {
      checks.push({ kind: "command", target: backtickCmd[1].trim() });
    }
  }

  return { checks, outputShape };
}

/**
 * Build heuristic acceptance checks from goal text.
 * @param {string} goal
 * @returns {AcceptanceContract}
 */
export function buildHeuristicContract(goal) {
  const checks = [];
  const text = String(goal ?? "");

  for (const file of extractNamedDeliverables(text).filter(isCreatedFileDeliverable)) {
    checks.push({ kind: "deliverable", target: file, description: `Output artifact exists: ${file}` });
  }

  for (const cmd of extractNamedNodeCommands(text)) {
    if (String(cmd).startsWith("/")) continue;
    checks.push({ kind: "command", target: cmd, description: `Command exits 0: ${cmd}` });
  }

  for (const file of extractNamedVerifyFiles(text)) {
    checks.push({ kind: "command", target: `run ${file}`, description: `Verify file runs: ${file}` });
  }

  return { checks, outputShape: "", source: "heuristic" };
}

/**
 * Merge plan-parsed and heuristic contracts; plan entries win on duplicate targets.
 * @param {string} goal
 * @param {string} [planText]
 * @returns {AcceptanceContract}
 */
export function buildAcceptanceContract(goal, planText = "") {
  const fromPlan = parseAcceptanceBlock(planText);
  const fromHeuristic = buildHeuristicContract(goal);
  const seen = new Set();
  const checks = [];

  for (const check of fromPlan.checks ?? []) {
    const key = `${check.kind}:${check.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push(check);
  }

  for (const check of fromHeuristic.checks) {
    const key = `${check.kind}:${check.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    checks.push(check);
  }

  const source =
    (fromPlan.checks?.length ?? 0) > 0 && fromHeuristic.checks.length > 0
      ? "merged"
      : (fromPlan.checks?.length ?? 0) > 0
        ? "plan"
        : "heuristic";

  return {
    checks,
    outputShape: fromPlan.outputShape ?? "",
    source,
  };
}

/**
 * Format contract for injection into the user message.
 * @param {AcceptanceContract} contract
 * @returns {string}
 */
export function formatAcceptanceContract(contract) {
  if (!contract?.checks?.length && !contract?.outputShape) return "";
  const lines = ["## Acceptance (machine-checked before completion)"];
  for (const check of contract.checks ?? []) {
    if (check.kind === "deliverable") {
      lines.push(`- deliverable: \`${check.target}\` must exist on disk`);
    } else if (check.kind === "command") {
      lines.push(`- command: \`${check.target}\` must exit 0`);
    }
  }
  if (contract.outputShape) {
    lines.push(`- output: ${contract.outputShape}`);
  }
  return lines.join("\n");
}

/**
 * Prompt extension for the planning pre-pass.
 */
export const ACCEPTANCE_PLANNING_EXTENSION = [
  "After your plan, include a ## Acceptance section with bullet checks the loop will verify before accepting done:",
  "- deliverable: <workspace-relative path> for each output file",
  "- command: <exact shell command> for each verification command that must exit 0",
  "- output: <shape of the final answer> when the task defines it",
  "Name only checks you will actually run — the loop blocks completion until they pass.",
].join(" ");

export const CRITIQUE_USER_MESSAGE = [
  "Review your plan and ## Acceptance section against the task.",
  "List 2–4 concrete failure modes (wrong file read first, missing verify command, wrong path prefix, etc.)",
  "and revise the plan or acceptance checks if needed.",
  "Reply with a revised plan and ## Acceptance — still no tool calls.",
].join(" ");

async function deliverableExists(workspaceRoot, relPath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath.replace(/^\.\//, ""));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { passed: false, detail: "path escapes workspace" };
  }
  try {
    await access(target);
    return { passed: true, detail: "file exists" };
  } catch {
    return { passed: false, detail: "file not found" };
  }
}

/**
 * A successful mutating tool call on the same path is accepted as evidence.
 * The tool resolves paths against its own root, which is not always the root
 * the loop probes, so a disk miss alone would produce false negatives.
 */
function wroteDeliverable(calls, relPath) {
  const wanted = relPath.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
  return (calls ?? []).some((call) => {
    if (!call?.ok || !MUTATING_TOOL_NAMES.has(call.name)) return false;
    const written = String(call.result?.path ?? call.args?.path ?? "")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (!written) return false;
    return written === wanted || written.endsWith(`/${wanted}`);
  });
}

/**
 * A verification command that exits 0 while printing nothing is not evidence
 * of anything: a broken entry point exits 0 with empty stdout just like a
 * working one. Require it to have said something.
 */
function producedOutput(result) {
  const text = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
  return text.trim().length > 0;
}

function matchingSilentRun(calls, normalized) {
  return (calls ?? []).some((call) => {
    if (call?.name !== "run_command" || !call.ok) return false;
    if (commandExitCode(call.result) !== 0) return false;
    const cmd = runCommandText(call);
    if (!cmd.includes(normalized) && !normalized.includes(cmd)) return false;
    return !producedOutput(call.result);
  });
}

function commandCheckPassed(calls, target) {
  const normalized = String(target ?? "").replace(/^run\s+/i, "").trim();

  for (const call of calls ?? []) {
    if (call?.name !== "run_command" || !call.ok) continue;
    if (commandExitCode(call.result) !== 0) continue;
    if (!producedOutput(call.result)) continue;
    const cmd = runCommandText(call);
    if (cmd.includes(normalized) || normalized.includes(cmd)) {
      return { passed: true, detail: "matching command exited 0 with output" };
    }
  }

  if (ranNamedCommand(calls, normalized) && !matchingSilentRun(calls, normalized)) {
    return { passed: true, detail: "command ran with exit 0" };
  }

  if (matchingSilentRun(calls, normalized)) {
    return {
      passed: false,
      detail: "command exited 0 but printed nothing — confirm it actually runs",
    };
  }

  return { passed: false, detail: "command not run successfully yet" };
}

/**
 * Verify an acceptance contract against step history and workspace.
 * @param {object} options
 * @param {AcceptanceContract} options.contract
 * @param {Array<{toolCalls?: Array<object>}>} options.steps
 * @param {string} [options.goal]
 * @param {string} [options.workspaceRoot]
 * @returns {Promise<VerificationResult>}
 */
export async function verifyAcceptanceContract({
  contract,
  steps,
  goal = "",
  workspaceRoot = process.cwd(),
}) {
  const calls = flattenToolCalls(steps);
  const results = [];
  const missing = [];

  for (const check of contract?.checks ?? []) {
    if (check.kind === "deliverable") {
      let result = await deliverableExists(workspaceRoot, check.target);
      if (!result.passed && wroteDeliverable(calls, check.target)) {
        result = { passed: true, detail: "written by a successful tool call" };
      }
      results.push({
        kind: "deliverable",
        target: check.target,
        passed: result.passed,
        detail: result.detail,
      });
      if (!result.passed) missing.push(`create ${check.target}`);
    } else if (check.kind === "command") {
      const result = commandCheckPassed(calls, check.target);
      results.push({
        kind: "command",
        target: check.target,
        passed: result.passed,
        detail: result.detail,
      });
      if (!result.passed) missing.push(`run ${check.target}`);
    }
  }

  // Heuristic verification gaps stay advisory: the nudge pipeline already
  // enforces them under narrower conditions, so gating on them here would
  // block final answers the loop is meant to accept.
  const advisory = missingRequiredVerification(goal, calls).filter(
    (item) => !missing.includes(item),
  );

  return {
    passed: results.every((r) => r.passed),
    checks: results,
    missing,
    advisory,
  };
}

/**
 * Build a consolidated nudge when verification fails.
 * @param {VerificationResult} verification
 * @returns {string|null}
 */
export function acceptanceFailureNudge(verification) {
  if (!verification || verification.passed) return null;
  const items = verification.missing.slice(0, 6);
  if (!items.length) {
    const failed = verification.checks.filter((c) => !c.passed);
    if (!failed.length) return null;
    return [
      "Do not finish yet — acceptance checks are not satisfied:",
      ...failed.map((c) => `- ${c.kind} \`${c.target}\`: ${c.detail}`),
      "Complete the missing work, then give your final answer.",
    ].join(" ");
  }
  return [
    "Do not finish yet — acceptance contract not satisfied.",
    `Still required: ${items.join("; ")}.`,
    "Run the named verification command(s) or create the named deliverable(s), then reply with your final answer.",
  ].join(" ");
}

/**
 * Whether plan text includes an acceptance section.
 * @param {string} planText
 * @returns {boolean}
 */
export function planHasAcceptance(planText) {
  return ACCEPTANCE_HEADER.test(String(planText ?? ""));
}
