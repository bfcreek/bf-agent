/**
 * Shared mutation/deletion authorization helpers.
 * Safety wins over task instructions: cleanup-style goals may only touch
 * files the user explicitly named (and not files they asked to keep).
 */

/**
 * Language in the user's request that protects a file from deletion/mutation
 * when it appears in the same sentence as the file's name.
 */
export const PROTECTIVE_PATTERN =
  /\b(?:not|never|don'?t|keep|preserve|except|leave|required|important|must\s+(?:stay|remain|survive)|do\s+not\s+(?:delete|modify|change|touch))\b/i;

/**
 * Goals that imply removing or rewriting files without necessarily naming
 * each target — shell deletes and write/edit workarounds are gated.
 */
const CLEANUP_STYLE_PATTERN =
  /\b(clean\s*up|cleanup|remove\s+unused|delete\s+unused|unused\s+files)\b/i;

/** Explicit "delete/remove the file …" or "delete path.ext" requests. */
const EXPLICIT_FILE_DELETE_PATTERN =
  /\b(delete|remove)\s+(?:the\s+)?(?:file|files)\b|\b(delete|remove)\s+[\w./\\-]+\.\w+/i;

/** Targets like `.`, `*`, or `~` that are too broad to authorize. */
export function isTooBroadTarget(target) {
  return /^[.\\/*~]+$/.test(String(target ?? ""));
}

/**
 * Normalize a model-supplied path for mention matching.
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeMutationPath(filePath) {
  return String(filePath ?? "")
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^\.[\\/]/, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
}

/**
 * How the user's request relates to one file path: did they name it, and if
 * so, did the same sentence tell us to keep / not modify it?
 *
 * @param {string} goal
 * @param {string} target
 * @returns {{mentioned: boolean, protected: boolean}}
 */
export function analyzeFileMention(goal, target) {
  const fixed = String(target ?? "").replace(/[*?]+/g, "");
  if (!fixed || isTooBroadTarget(fixed)) return { mentioned: false, protected: false };

  const escaped = fixed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Boundaries: no word char or hyphen on either side, and no dot that is
  // part of a longer name (`x.txt` inside `x.txt.bak`) — but a sentence
  // period right after the name ("Delete junk.txt.") is fine.
  const mention = new RegExp(`(?<![\\w-]|\\w\\.)${escaped}(?!\\w|-|\\.\\w)`, "gi");

  let mentioned = false;
  for (const match of goal.matchAll(mention)) {
    mentioned = true;
    const before = goal.slice(0, match.index);
    const sentenceStart = Math.max(
      before.lastIndexOf(". "),
      before.lastIndexOf("! "),
      before.lastIndexOf("? "),
      before.lastIndexOf("; "),
      before.lastIndexOf("\n"),
    );
    const after = goal.slice(match.index + match[0].length);
    const afterEnd = after.search(/[.!?;]\s|\n|$/);
    const sentence = goal.slice(sentenceStart + 1, match.index + match[0].length + afterEnd);
    if (PROTECTIVE_PATTERN.test(sentence)) return { mentioned: true, protected: true };
  }
  return { mentioned, protected: false };
}

/**
 * @param {string} [goal]
 * @returns {boolean}
 */
export function isCleanupStyleGoal(goal) {
  const text = String(goal ?? "");
  return CLEANUP_STYLE_PATTERN.test(text) || EXPLICIT_FILE_DELETE_PATTERN.test(text);
}

/**
 * Decide whether write_file / edit_file is authorized under a cleanup-style
 * goal. Non-cleanup goals return `none` (no extra gate).
 *
 * @param {string} filePath Relative path the model wants to mutate.
 * @param {string} [goal]
 * @returns {{verdict: "none"|"authorized"|"protected"|"unauthorized", target?: string}}
 */
export function classifyCleanupFileMutation(filePath, goal) {
  const goalText = String(goal ?? "");
  if (!isCleanupStyleGoal(goalText)) return { verdict: "none" };

  const rel = normalizeMutationPath(filePath);
  if (!rel || isTooBroadTarget(rel)) {
    return { verdict: "unauthorized", target: rel || null };
  }

  const candidates = [rel];
  const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  if (base && base !== rel) candidates.push(base);

  let mentioned = false;
  for (const candidate of candidates) {
    const mention = analyzeFileMention(goalText, candidate);
    if (mention.protected) return { verdict: "protected", target: candidate };
    if (mention.mentioned) mentioned = true;
  }
  if (!mentioned) return { verdict: "unauthorized", target: base || rel };
  return { verdict: "authorized", target: base || rel };
}

/**
 * Error message when a cleanup-style write/edit is refused (unattended).
 * @param {"protected"|"unauthorized"} verdict
 * @param {string|null|undefined} target
 * @param {string} toolName
 */
const EDIT_EXISTING_INTENT =
  /\b(fix|typo|edit|save it|change|update|modify|correct)\b/i;
const CREATE_FILE_INTENT =
  /\b(create|write|implement|add|build|make|scaffold|extract|refactor)\b/i;

/**
 * Block write_file from creating a missing file the user asked to edit.
 * Create/implement goals are left alone so new files can still be written.
 *
 * @param {string} [goal]
 * @param {string} filePath
 * @param {boolean} exists
 * @returns {string|null}
 */
export function missingEditTargetBlock(goal, filePath, exists) {
  if (exists) return null;
  const goalText = String(goal ?? "");
  if (!goalText) return null;
  if (!EDIT_EXISTING_INTENT.test(goalText)) return null;
  if (CREATE_FILE_INTENT.test(goalText)) return null;
  const rel = normalizeMutationPath(filePath);
  if (!rel || isTooBroadTarget(rel)) return null;
  const base = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
  const mentioned =
    analyzeFileMention(goalText, rel).mentioned || analyzeFileMention(goalText, base).mentioned;
  if (!mentioned) return null;
  return (
    `Blocked: '${base}' does not exist. The task is to edit an existing file, not create it. ` +
    "Tell the user the file is missing and stop; do not write_file that path."
  );
}

export function cleanupMutationBlockMessage(verdict, target, toolName = "write_file") {
  if (verdict === "protected") {
    return (
      `Refused ${toolName} on '${target}': the user's instructions say to keep that file. ` +
      "Do not modify it or work around this check. If you believe it must change anyway, " +
      "stop and ask the user to confirm in your final answer."
    );
  }
  return (
    `Refused ${toolName} on '${target ?? "(unknown)"}': this looks like a cleanup/delete task, ` +
    "but the user did not explicitly name that file for deletion or modification. " +
    "Do not empty, rewrite, or edit files as a workaround. Stop and ask the user in your " +
    "final answer to confirm exactly which files may be changed or removed."
  );
}
