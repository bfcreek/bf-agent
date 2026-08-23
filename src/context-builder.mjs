/**
 * Context builder: gives the model its bearings before step 1 so it does not
 * burn loop steps discovering where it is. Injected into the system prompt by
 * the CLI and server.
 */

import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_MAX_ENTRIES = 40;

/**
 * Describe the environment and workspace as a text block for the system
 * prompt: platform, shell, workspace root, and a top-level listing.
 *
 * @param {object} [options]
 * @param {string} [options.workspaceRoot]
 * @param {number} [options.maxEntries] Cap on listed top-level entries.
 * @returns {Promise<string>}
 */
export async function buildEnvironmentContext({
  workspaceRoot,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  const root = path.resolve(workspaceRoot ?? process.cwd());
  const shell = process.platform === "win32" ? "PowerShell" : "/bin/sh";

  let names = [];
  let listingNote = "";
  try {
    const entries = await readdir(root, { withFileTypes: true });
    names = entries
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort((a, b) => a.localeCompare(b));
    if (names.length > maxEntries) {
      listingNote = `(and ${names.length - maxEntries} more entries — use list_dir to see the rest)`;
      names = names.slice(0, maxEntries);
    }
  } catch (err) {
    listingNote = `(could not list workspace: ${err?.message ?? err})`;
  }

  const lines = [
    "## Environment",
    `- Workspace root: ${root} — file tool paths are relative to this directory.`,
    `- Platform: ${process.platform} (${os.type()} ${os.release()}); run_command uses ${shell}.`,
    `- Node.js: ${process.version}`,
    `- Local date: ${new Date().toString()}`,
    "",
    "## Workspace top-level contents",
    names.length > 0 ? names.map((n) => `- ${n}`).join("\n") : "(empty directory)",
  ];
  if (listingNote) lines.push(listingNote);
  return lines.join("\n");
}

/**
 * Compose a full system prompt: base behavior instructions plus environment
 * context.
 *
 * @param {object} options
 * @param {string} options.basePrompt
 * @param {string} [options.workspaceRoot]
 * @param {string} [options.projectContext] Injected project overview / index note.
 * @returns {Promise<string>}
 */
export async function buildSystemPrompt({ basePrompt, workspaceRoot, projectContext }) {
  const context = await buildEnvironmentContext({ workspaceRoot });
  const parts = [basePrompt, context];
  if (projectContext?.trim()) parts.push(projectContext.trim());
  return parts.join("\n\n");
}
