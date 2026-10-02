/**
 * Nested Copilot worker: the outer AgentLoop (supervisor LLM) delegates
 * implementation work via `delegate_copilot`, then verifies before accepting
 * a "done" claim. Copilot owns its native tools during the session; our
 * builtins are for supervisor verify/steer.
 */

import path from "node:path";

import { importPeerSdk, ProviderClientError } from "../provider-client.mjs";

const IMPLEMENTATION_GOAL =
  /\b(fix|implement|add|edit|refactor|create|write|delete|update|rename|migrate|build|patch)\b/i;

/**
 * Mutable tracker shared between the tool and the stop-hook guard.
 * @returns {{ calls: Array<object> }}
 */
export function createDelegationTracker() {
  return { calls: [] };
}

/**
 * Register `delegate_copilot` on the tool registry.
 *
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} options
 * @param {string} options.workspaceRoot
 * @param {{calls: Array<object>}} options.tracker
 * @param {string} [options.model] Copilot session model
 * @param {(delta: string) => void} [options.onDelta]
 * @param {(request: {name: string, args: object}) => Promise<boolean>|boolean} [options.approvalHandler]
 * @param {() => Promise<any>} [options.loadSdk] Injectable for tests
 */
export function registerDelegateCopilotTool(
  registry,
  {
    workspaceRoot = process.cwd(),
    tracker,
    model,
    onDelta,
    approvalHandler,
    loadSdk,
  } = {},
) {
  if (!tracker) throw new Error("registerDelegateCopilotTool requires a tracker.");

  registry.register({
    name: "delegate_copilot",
    description:
      "Delegate an implementation task to GitHub Copilot's agent runtime. " +
      "Copilot uses its own tools to edit files and run commands in the workspace. " +
      "Pass a clear task and acceptance criteria. After it returns, verify the " +
      "result yourself with read_file, grep_search, and/or run_command before " +
      "declaring the overall goal complete. Do not use this for simple Q&A.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Concrete task for Copilot to perform in the workspace.",
        },
        acceptance: {
          type: "string",
          description:
            "How to know the task succeeded (tests to pass, files to exist, behavior to observe).",
        },
        context_paths: {
          type: "array",
          items: { type: "string" },
          description: "Optional workspace-relative paths Copilot should prioritize.",
        },
      },
      required: ["task"],
    },
    requiresApproval: false,
    async execute({ task, acceptance, context_paths: contextPaths }) {
      const result = await runCopilotDelegation({
        workspaceRoot,
        task: String(task ?? ""),
        acceptance: acceptance != null ? String(acceptance) : "",
        contextPaths: Array.isArray(contextPaths) ? contextPaths.map(String) : [],
        model,
        onDelta,
        approvalHandler,
        loadSdk,
      });
      tracker.calls.push({
        at: Date.now(),
        task: String(task ?? ""),
        acceptance: acceptance != null ? String(acceptance) : "",
        ...result,
      });
      return result;
    },
  });

  return registry;
}

/**
 * Default stop hook that challenges false completion after Copilot work.
 * Compose with a user hook: run guard first, then user hook if guard passes.
 *
 * @param {object} options
 * @param {{calls: Array<object>}} options.tracker
 * @param {import("../agent-loop.mjs").AgentHooks["stop"]} [options.inner]
 */
export function createCompletionGuard({ tracker, inner } = {}) {
  if (!tracker) throw new Error("createCompletionGuard requires a tracker.");

  return async (ctx) => {
    const decision = await guardCompletion(tracker, ctx);
    if (decision?.followupMessage) return decision;
    if (typeof inner === "function") return inner(ctx);
    return {};
  };
}

/**
 * @param {{calls: Array<object>}} tracker
 * @param {object} ctx
 */
async function guardCompletion(tracker, { goal, text, steps, loopCount }) {
  if (loopCount >= 3) return {};

  const delegated = tracker.calls.length > 0;
  const toolName = (tc) => tc?.name ?? tc?.function?.name ?? "";
  const lastDelegateIndex = lastStepIndex(steps, (s) =>
    (s.toolCalls ?? []).some((tc) => toolName(tc) === "delegate_copilot"),
  );

  if (!delegated) {
    if (loopCount === 0 && IMPLEMENTATION_GOAL.test(String(goal ?? ""))) {
      return {
        followupMessage:
          "This looks like implementation work, but you have not called delegate_copilot. " +
          "Delegate a clear task with acceptance criteria, then verify the result with " +
          "read_file, grep_search, and/or run_command before declaring done. " +
          "If the goal is truly Q&A with no workspace changes, say so explicitly and answer.",
      };
    }
    return {};
  }

  const verifiedAfter = (steps ?? []).some(
    (s, i) =>
      i > lastDelegateIndex &&
      s.kind === "tool-calls" &&
      (s.toolCalls ?? []).some((tc) => {
        const name = toolName(tc);
        return name === "read_file" || name === "grep_search" || name === "run_command" || name === "search_project";
      }),
  );

  if (!verifiedAfter && loopCount < 2) {
    const acceptance = tracker.calls[tracker.calls.length - 1]?.acceptance;
    const acceptanceHint = acceptance
      ? ` Acceptance to check: ${acceptance}`
      : "";
    return {
      followupMessage:
        "You reported completion after delegate_copilot without verifying the workspace. " +
        "Use read_file, grep_search, and/or run_command to confirm the result matches the " +
        "acceptance criteria, then either fix via another delegation or report what you verified." +
        acceptanceHint +
        (text ? `\n\nYour previous claim was:\n${String(text).slice(0, 800)}` : ""),
    };
  }

  return {};
}

/**
 * System-prompt overlay for the supervisor when Copilot nested mode is on.
 */
export const COPILOT_SUPERVISOR_OVERLAY = [
  "",
  "## Copilot worker",
  "GitHub Copilot is available via the delegate_copilot tool. For implementation",
  "work, delegate a focused task with acceptance criteria. Copilot edits the",
  "workspace with its own tools — do not duplicate those edits with write_file",
  "or edit_file unless you are making a small verified fix yourself. After each",
  "delegation, verify results with read tools or tests before claiming the goal",
  "is done. Keep broader project context here; pass only distilled task context",
  "into delegate_copilot.",
].join("\n");

/**
 * @param {object} options
 */
async function runCopilotDelegation({
  workspaceRoot,
  task,
  acceptance,
  contextPaths,
  model,
  onDelta,
  approvalHandler,
  loadSdk,
}) {
  if (!task.trim()) {
    return { ok: false, error: "task is required" };
  }

  const sdk = loadSdk ? await loadSdk() : await importPeerSdk("@github/copilot-sdk", "npm install @github/copilot-sdk");
  const CopilotClient = sdk.CopilotClient ?? sdk.default?.CopilotClient;
  if (typeof CopilotClient !== "function") {
    throw new ProviderClientError(
      "@github/copilot-sdk did not export CopilotClient. Check the installed package version.",
      { transient: false },
    );
  }

  const approveAll = sdk.approveAll;
  const client = new CopilotClient();
  let session;
  try {
    if (typeof client.start === "function") await client.start();

    const permissionHandler =
      typeof approvalHandler === "function"
        ? async (request) => {
            const name = request?.toolName ?? request?.name ?? "copilot_tool";
            const args = request?.toolArgs ?? request?.arguments ?? {};
            const allowed = await approvalHandler({ name: String(name), args });
            return allowed ? { kind: "approved" } : { kind: "denied-politely-to-model" };
          }
        : typeof approveAll === "function"
          ? approveAll
          : undefined;

    session = await client.createSession({
      ...(model && model !== "auto" ? { model } : {}),
      workingDirectory: path.resolve(workspaceRoot),
      ...(permissionHandler ? { onPermissionRequest: permissionHandler } : {}),
    });

    if (onDelta && typeof session.on === "function") {
      session.on("assistant.message_delta", (event) => {
        const delta = event?.data?.delta ?? event?.delta ?? event?.text;
        if (typeof delta === "string" && delta) onDelta(delta);
      });
    }

    const prompt = buildCopilotPrompt({ task, acceptance, contextPaths, workspaceRoot });
    const response = await session.sendAndWait({ prompt });
    const content =
      response?.data?.content ??
      response?.content ??
      response?.message?.content ??
      (typeof response === "string" ? response : JSON.stringify(response ?? {}));

    return {
      ok: true,
      summary: String(content ?? "").slice(0, 12_000),
      sessionId: session?.sessionId ?? session?.id ?? null,
      acceptance: acceptance || null,
      contextPaths,
    };
  } catch (err) {
    if (err instanceof ProviderClientError) throw err;
    throw new ProviderClientError(`Copilot delegation failed: ${err?.message ?? err}`, {
      cause: err,
      transient: false,
    });
  } finally {
    try {
      if (session && typeof session.destroy === "function") await session.destroy();
    } catch {
      // ignore
    }
    try {
      if (typeof client.stop === "function") await client.stop();
    } catch {
      // ignore
    }
  }
}

function buildCopilotPrompt({ task, acceptance, contextPaths, workspaceRoot }) {
  const parts = [
    `Workspace root: ${path.resolve(workspaceRoot)}`,
    "",
    "Task:",
    task.trim(),
  ];
  if (acceptance?.trim()) {
    parts.push("", "Acceptance criteria:", acceptance.trim());
  }
  if (contextPaths?.length) {
    parts.push("", "Prioritize these paths:", contextPaths.map((p) => `- ${p}`).join("\n"));
  }
  parts.push(
    "",
    "Do the work in this workspace. When finished, summarize what changed and how it meets the acceptance criteria. Do not claim success without making the changes.",
  );
  return parts.join("\n");
}

function lastStepIndex(steps, pred) {
  let idx = -1;
  for (let i = 0; i < (steps?.length ?? 0); i++) {
    if (pred(steps[i])) idx = i;
  }
  return idx;
}
