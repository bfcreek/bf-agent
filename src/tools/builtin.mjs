/**
 * Standard tool set for the agent: diagnostics (get_time, echo), filesystem
 * access, and shell execution — the latter two scoped to a workspace root.
 * Approval gates and sandboxing arrive with roadmap item 8.
 */

import { registerFileTools } from "./fs.mjs";
import { registerShellTools } from "./shell.mjs";

/**
 * @param {import("../tool-registry.mjs").ToolRegistry} registry
 * @param {object} [options]
 * @param {string} [options.workspaceRoot] Directory file/shell tools are
 *   confined to. Defaults to the process working directory.
 */
export function registerBuiltinTools(registry, { workspaceRoot = process.cwd() } = {}) {
  registry.register({
    name: "get_time",
    description:
      "Get the current local date and time on this machine. Use when the user asks about the current time or date.",
    parameters: { type: "object", properties: {} },
    execute() {
      const now = new Date();
      return {
        iso: now.toISOString(),
        local: now.toString(),
        timezoneOffsetMinutes: now.getTimezoneOffset(),
      };
    },
  });

  registry.register({
    name: "echo",
    description:
      "Return the given text unchanged. Diagnostic tool for verifying tool calling works.",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to echo back." },
      },
      required: ["text"],
    },
    execute({ text }) {
      return String(text ?? "");
    },
  });

  registerFileTools(registry, { workspaceRoot });
  registerShellTools(registry, { workspaceRoot });

  return registry;
}
