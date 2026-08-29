/**
 * Acceptance contracts: machine-checkable success criteria extracted from
 * the plan or goal heuristics, verified before the agent loop accepts done.
 */

import { stat } from "node:fs/promises";
import path from "node:path";

import {
  commandExitCode,
  countConsecutiveFailedWorkCommands,
  extractInstructionVerifyCommands,
  extractNamedDeliverables,
  extractNamedNodeCommands,
  extractNamedVerifyFiles,
  flattenToolCalls,
  isCreatedFileDeliverable,
  isDiagnosticCommand,
  isExistenceCheckCommand,
  isWorkspaceInputPath,
  goalNeedsSubstantiveTools,
  missingInstructionNamedVerification,
  missingRequiredVerification,
  MUTATING_TOOL_NAMES,
  ranNamedCommand,
  runCommandText,
  substantiveToolsUsed,
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

    // Models often wrap labels in **Deliverable** / **Command** despite the
    // planning prompt asking for `deliverable:` / `command:`.
    const unlabeled = trimmed.replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim();

    const outputMatch = unlabeled.match(/^(?:output|final answer)\s*:\s*(.+)$/i);
    if (outputMatch) {
      outputShape = outputMatch[1].trim();
      continue;
    }

    const deliverableMatch = unlabeled.match(
      /^(?:deliverable|file|artifact)\s*:\s*[`'"]?(\/?[\w./-]+)/i,
    );
    if (deliverableMatch) {
      checks.push({ kind: "deliverable", target: deliverableMatch[1] });
      continue;
    }

    const commandBacktick = unlabeled.match(/^(?:command|verify|run)\s*:\s*`([^`]+)`/i);
    const commandPlain = unlabeled.match(
      /^(?:command|verify|run)\s*:\s*(.+?)(?:\s+must\b.*)?$/i,
    );
    if (commandBacktick || commandPlain) {
      const target = (commandBacktick?.[1] ?? commandPlain[1]).trim().replace(/^`+|`+$/g, "");
      if (target) checks.push({ kind: "command", target });
      continue;
    }

    const backtickCmd = unlabeled.match(/^`([^`]+)`\s*(?:exits?\s*0|passes?)?\.?$/i);
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

  // Prefer the instruction's own sanity-check / "you can run" commands over a
  // model-authored Acceptance block that invents always-true probes.
  for (const cmd of extractInstructionVerifyCommands(text)) {
    if (checks.some((c) => c.kind === "command" && c.target === cmd)) continue;
    checks.push({
      kind: "command",
      target: cmd,
      description: `Instruction verify command: ${cmd}`,
    });
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

/** Mid-run: cheaper than escalating when checks are stuck unmet. */
export const CONTRACT_PROGRESS_CRITIQUE = [
  "Acceptance checks are still unmet. Critique the remaining work against the contract,",
  "then make the single next tool call that satisfies an unmet check",
  "(run the named verify command, or create/fill a missing non-empty deliverable).",
  "Do not answer with another plan-only revision.",
].join(" ");

async function deliverableExists(workspaceRoot, relPath) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relPath.replace(/^\.\//, ""));
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { passed: false, detail: "path escapes workspace" };
  }
  try {
    const info = await stat(target);
    if (info.size === 0) {
      return { passed: false, detail: "file exists but is empty" };
    }
    return { passed: true, detail: "file exists" };
  } catch {
    return { passed: false, detail: "file not found" };
  }
}

/**
 * A successful mutating tool call on the same path is accepted as evidence.
 * The tool resolves paths against its own root, which is not always the root
 * the loop probes, so a disk miss alone would produce false negatives.
 * Empty writes are not evidence — an empty artifact is not a deliverable.
 */
function wroteDeliverable(calls, relPath) {
  const wanted = relPath.replace(/^\.\//, "").replace(/\\/g, "/").toLowerCase();
  return (calls ?? []).some((call) => {
    if (!call?.ok || !MUTATING_TOOL_NAMES.has(call.name)) return false;
    const written = String(call.result?.path ?? call.args?.path ?? "")
      .replace(/\\/g, "/")
      .toLowerCase();
    if (!written) return false;
    if (!(written === wanted || written.endsWith(`/${wanted}`))) return false;
    const content = call.args?.content ?? call.args?.text;
    if (content !== undefined && String(content).trim().length === 0) return false;
    return true;
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

function isVacuousAcceptanceCommand(target, goal = "") {
  const normalized = String(target ?? "").replace(/^run\s+/i, "").trim();
  return (
    isDiagnosticCommand(normalized, goal) ||
    isExistenceCheckCommand(normalized) ||
    /^(true|:|exit\s+0)$/i.test(normalized)
  );
}

function isVacuousDeliverable(target) {
  return isWorkspaceInputPath(target);
}

function commandCheckPassed(calls, target, goal = "") {
  const normalized = String(target ?? "").replace(/^run\s+/i, "").trim();
  if (isVacuousAcceptanceCommand(normalized, goal)) {
    return {
      passed: false,
      detail: "trivial/diagnostic command is not an acceptance check",
    };
  }

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
      if (isVacuousDeliverable(check.target)) {
        results.push({
          kind: "deliverable",
          target: check.target,
          passed: false,
          detail: "input/vendor path is not an acceptance deliverable",
        });
        continue;
      }
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
      const result = commandCheckPassed(calls, check.target, goal);
      results.push({
        kind: "command",
        target: check.target,
        passed: result.passed,
        detail: result.detail,
      });
      if (!result.passed && !isVacuousAcceptanceCommand(check.target, goal)) {
        missing.push(`run ${check.target}`);
      }
    }
  }

  // The instruction's own named verify/run commands are gated. Broader
  // heuristics (test-suite phrasing, merge, pytorch) stay advisory so they
  // do not stall answers the loop is meant to accept.
  for (const item of missingInstructionNamedVerification(goal, calls)) {
    if (!missing.includes(item)) missing.push(item);
  }

  const advisory = missingRequiredVerification(goal, calls).filter(
    (item) => !missing.includes(item),
  );

  const workGoal = goalNeedsSubstantiveTools(goal);
  const onlyVacuousChecks =
    results.length > 0 &&
    results.every(
      (r) =>
        (r.kind === "command" && isVacuousAcceptanceCommand(r.target, goal)) ||
        (r.kind === "deliverable" && isVacuousDeliverable(r.target)),
    );

  // An empty or always-true contract that always "passes" teaches the loop
  // nothing. On work goals that is a defect, not a skip; Q&A / explain goals
  // may still complete without checks.
  if (workGoal && (results.length === 0 || onlyVacuousChecks)) {
    missing.push(
      results.length === 0
        ? "empty acceptance contract is not a pass — derive deliverable or verify checks from the goal"
        : "always-true acceptance contract is not a pass — derive deliverable or verify checks from the goal",
    );
  }

  if (workGoal && countConsecutiveFailedWorkCommands(calls, goal) >= 1) {
    const item = "last command exited non-zero — fix and re-run before finishing";
    if (!missing.includes(item)) missing.push(item);
  }

  if (workGoal && !calls.some((c) => c.ok) && substantiveToolsUsed(steps).size === 0) {
    const item =
      "no deliverable work happened — run a tool that produces or verifies the result";
    if (!missing.includes(item)) missing.push(item);
  }

  return {
    passed: missing.length === 0 && (results.length === 0 || results.every((r) => r.passed)),
    checks: results,
    missing,
    advisory,
  };
}

/**
 * True when the only outstanding work is running verify/work commands — not
 * creating deliverables or fixing a hollow contract. Escalating models is the
 * wrong lever here; the acceptance nudge should force the verify step.
 * @param {VerificationResult|null|undefined} verification
 * @returns {boolean}
 */
export function isVerifyOutstandingOnly(verification) {
  if (!verification || verification.passed) return false;
  const missing = verification.missing ?? [];
  if (!missing.length) return false;
  if (
    missing.some((m) =>
      /empty acceptance contract|always-true acceptance contract|^create |no deliverable work happened/i.test(
        m,
      ),
    )
  ) {
    return false;
  }
  return missing.every(
    (m) =>
      /^run /i.test(m) ||
      /non-zero/i.test(m) ||
      /\b(node|python3?|py|dotnet|pytest|make|cargo|go)\b/i.test(m),
  );
}

/**
 * Build a consolidated nudge when verification fails.
 * @param {VerificationResult} verification
 * @returns {string|null}
 */
export function acceptanceFailureNudge(verification) {
  if (!verification || verification.passed) return null;
  const missing = verification.missing ?? [];
  const onlyVacuous =
    missing.length > 0 &&
    missing.every((item) =>
      /empty acceptance contract|always-true acceptance contract|no deliverable work happened/i.test(
        item,
      ),
    );
  if (onlyVacuous) return null;
  const items = missing.slice(0, 6);
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
