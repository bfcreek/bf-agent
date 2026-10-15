/**
 * User-level YAML config (~/.config/halo-agent/config.yaml).
 * Keys match CLI flag names (without --). CLI flags override config values.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MAX_STEPS, DEFAULT_STREAK_NUDGE_AFTER } from "./agent-loop.mjs";
import { DEFAULT_NUM_CTX, DEFAULT_THINK } from "./ollama-client.mjs";
import { parseAutoApproveSpec } from "./tool-registry.mjs";

export const CONFIG_FILE_NAME = "config.yaml";

const CONFIG_TEMPLATE = `# Bitfield Ollama Agent user configuration
# Keys match CLI flag names (without --). Command-line flags override these values.
# Remove or comment out a line to use the built-in default.

# provider: ollama   # ollama | openai | anthropic | copilot
# model: auto
# api-key:           # for openai/anthropic (or use env OPENAI_API_KEY / ANTHROPIC_API_KEY)
# supervisor-provider: ollama   # with provider=copilot
# supervisor-model: auto
# base-url: http://127.0.0.1:11434
# max-steps: ${DEFAULT_MAX_STEPS}
# max-prompt-tokens: 0   (cumulative prompt-token budget per run; 0 = none, e.g. 400000)
# streak-nudge: false    (true, or a count: nudge after N calls in a row to one read-only tool)
# completion-guard: true # challenge "done" on create/implement goals when no mutating tools ran
# num-ctx: auto   (sized to the model and your memory; floor ${DEFAULT_NUM_CTX}, or give a number)
# cwd: .
# mode: ask
# auto-approve: off   # all, off, or a tool list: write_file,edit_file,run_command
# port: 11435
# session: my-session
# embed-model: nomic-embed-text
# think: auto
# quiet: false
# scan: true          # embed Halo Scan code tools when @bitfieldcreek/halo-scan is available
# scan-profile: auto  # auto | base | full | symbols | quality | web | config
# index: false        # build the local project vector index and register search_project
# no-checkpoints: false
# json: false
#
# mcp:
#   - "npx -y some-mcp-server"
#
# Persistent user instructions (Cursor-style user rules): create
# instructions.md in this same directory. It is prepended to every system
# prompt. Workspace AGENTS.md, CLAUDE.md, .cursorrules, and always-apply
# .cursor/rules/*.mdc are loaded from the project root; other rules are
# listed by description and fetched by the agent when relevant.
`;

/** @returns {string} */
export function getConfigDir() {
  if (process.env.HALO_AGENT_CONFIG_DIR) {
    return path.resolve(process.env.HALO_AGENT_CONFIG_DIR);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, "halo-agent");
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "halo-agent");
}

/** @returns {string} */
export function getConfigPath() {
  if (process.env.HALO_AGENT_CONFIG) {
    return path.resolve(process.env.HALO_AGENT_CONFIG);
  }
  return path.join(getConfigDir(), CONFIG_FILE_NAME);
}

/**
 * Parse a small YAML subset: comments, key/value pairs, and indented lists.
 * @param {string} text
 * @returns {Record<string, unknown>}
 */
export function parseSimpleYaml(text) {
  const result = {};
  const lines = text.split(/\r?\n/);
  let i = 0;

  while (i < lines.length) {
    let line = stripComment(lines[i]);
    if (!line.trim()) {
      i++;
      continue;
    }

    const keyMatch = line.match(/^([^\s:#]+):\s*(.*)$/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const key = keyMatch[1];
    const inlineValue = keyMatch[2].trim();

    if (inlineValue === "" || inlineValue === "|" || inlineValue === ">") {
      const { list, nextIndex } = parseYamlList(lines, i + 1);
      result[key] = list;
      i = nextIndex;
      continue;
    }

    result[key] = parseScalar(inlineValue);
    i++;
  }

  return result;
}

/**
 * @param {string[]} lines
 * @param {number} startIndex Index of the first list item line.
 */
function parseYamlList(lines, startIndex) {
  const list = [];
  let i = startIndex;

  while (i < lines.length) {
    const child = stripComment(lines[i]);
    if (!child.trim()) {
      i++;
      continue;
    }

    const listMatch = child.match(/^(\s+)-\s*(.*)$/);
    if (!listMatch) break;

    const itemIndent = listMatch[1].length;
    const rest = listMatch[2].trim();

    if (rest.includes(":")) {
      const obj = {};
      const firstKv = rest.match(/^([^:]+):\s*(.*)$/);
      if (firstKv) obj[firstKv[1]] = parseScalar(firstKv[2].trim());
      i++;
      while (i < lines.length) {
        const cont = stripComment(lines[i]);
        if (!cont.trim()) {
          i++;
          continue;
        }
        if (/^\s*-\s/.test(cont)) break;
        const propMatch = cont.match(/^(\s+)([^:]+):\s*(.*)$/);
        if (!propMatch || propMatch[1].length <= itemIndent) break;
        obj[propMatch[2]] = parseScalar(propMatch[3].trim());
        i++;
      }
      list.push(obj);
      continue;
    }

    list.push(parseScalar(rest));
    i++;
  }

  return { list, nextIndex: i };
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function parseScalar(raw) {
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d+\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return raw;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {{ values: Record<string, unknown>, errors: string[] }}
 */
export function normalizeConfigValues(raw) {
  const values = {};
  const errors = [];

  const setString = (key, internal, value) => {
    if (typeof value !== "string" || value === "") {
      errors.push(`config '${key}' must be a non-empty string.`);
      return;
    }
    values[internal] = value;
  };

  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;

    switch (key) {
      case "model":
      case "base-url":
      case "cwd":
      case "mode":
      case "session":
      case "embed-model":
      case "think":
        setString(key, configKeyToOption(key), value);
        break;
      case "max-steps": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) values.maxSteps = n;
        else errors.push(`config 'max-steps' needs a positive integer, got '${value}'.`);
        break;
      }
      case "max-prompt-tokens": {
        const n = Number(String(value).replace(/[_,]/g, "").replace(/k$/i, "000"));
        if (Number.isFinite(n) && n >= 0) values.maxPromptTokens = Math.floor(n);
        else errors.push(`config 'max-prompt-tokens' needs a non-negative integer (0 = none), got '${value}'.`);
        break;
      }
      case "streak-nudge": {
        if (value === true) values.streakNudge = DEFAULT_STREAK_NUDGE_AFTER;
        else if (value === false) values.streakNudge = 0;
        else {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) values.streakNudge = Math.floor(n);
          else errors.push(`config 'streak-nudge' needs true, false, or a count, got '${value}'.`);
        }
        break;
      }
      case "num-ctx": {
        if (String(value).trim().toLowerCase() === "auto") {
          values.numCtx = "auto";
          break;
        }
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) values.numCtx = n;
        else errors.push(`config 'num-ctx' needs a positive integer or 'auto', got '${value}'.`);
        break;
      }
      case "port": {
        const p = Number(value);
        if (Number.isFinite(p) && p >= 0 && p <= 65535) values.port = p;
        else errors.push(`config 'port' needs a number from 0 to 65535, got '${value}'.`);
        break;
      }
      case "quiet":
      case "index":
      case "scan":
      case "no-checkpoints":
      case "json":
      case "completion-guard":
        if (typeof value === "boolean") values[configKeyToOption(key)] = value;
        else errors.push(`config '${key}' must be true or false.`);
        break;
      case "no-completion-guard":
        if (typeof value === "boolean") values.completionGuard = !value;
        else errors.push(`config '${key}' must be true or false.`);
        break;
      case "no-index":
        // Older spelling; `index: true` is the current opt-in.
        if (typeof value === "boolean") values.index = !value;
        else errors.push(`config '${key}' must be true or false.`);
        break;
      case "scan-profile":
        if (typeof value === "string" && value.trim()) values.scanProfile = value.trim().toLowerCase();
        else errors.push(`config 'scan-profile' needs a profile name (auto, base, full, or a pack).`);
        break;
      case "auto-approve": {
        const parsed = parseAutoApproveSpec(value, "config 'auto-approve'");
        if (parsed.ok) values.autoApprove = parsed.policy;
        else errors.push(parsed.error);
        break;
      }
      case "mcp":
        if (!Array.isArray(value)) {
          errors.push(`config 'mcp' must be a list of command strings.`);
          break;
        }
        if (value.some((entry) => typeof entry !== "string" || entry === "")) {
          errors.push(`config 'mcp' entries must be non-empty strings.`);
          break;
        }
        values.mcp = value;
        break;
      default:
        errors.push(`Unknown config key '${key}'.`);
    }
  }

  if (values.mode !== undefined && values.mode !== "ask" && values.mode !== "agent") {
    errors.push(`config 'mode' must be 'ask' or 'agent', got '${values.mode}'.`);
  }

  if (values.think !== undefined) {
    const level = values.think;
    if (level === "auto" || level === "true" || level === "false" || level === "off") {
      values.think = level === "false" || level === "off" ? false : level;
    } else if (level === "low" || level === "medium" || level === "high" || level === "max") {
      values.think = level;
    } else {
      errors.push(
        `config 'think' must be auto, true, false, off, or low|medium|high|max, got '${level}'.`,
      );
    }
  }

  if (values.cwd !== undefined) values.cwd = path.resolve(values.cwd);

  return { values, errors };
}

function configKeyToOption(key) {
  switch (key) {
    case "base-url":
      return "baseUrl";
    case "max-steps":
      return "maxSteps";
    case "max-prompt-tokens":
      return "maxPromptTokens";
    case "streak-nudge":
      return "streakNudge";
    case "num-ctx":
      return "numCtx";
    case "embed-model":
      return "embedModel";
    case "scan-profile":
      return "scanProfile";
    case "no-checkpoints":
      return "noCheckpoints";
    case "completion-guard":
      return "completionGuard";
    case "api-key":
      return "apiKey";
    case "supervisor-provider":
      return "supervisorProvider";
    case "supervisor-model":
      return "supervisorModel";
    default:
      return key;
  }
}

/** @returns {Promise<{ values: Record<string, unknown>, errors: string[], path: string }>} */
export async function loadUserConfig() {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    return { values: {}, errors: [], path: configPath };
  }

  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (err) {
    return {
      values: {},
      errors: [`Cannot read config file ${configPath}: ${err.message}`],
      path: configPath,
    };
  }

  let raw;
  try {
    raw = parseSimpleYaml(text);
  } catch (err) {
    return {
      values: {},
      errors: [`Invalid YAML in ${configPath}: ${err.message}`],
      path: configPath,
    };
  }

  const { values, errors } = normalizeConfigValues(raw);
  return { values, errors, path: configPath };
}

/**
 * @param {Record<string, unknown>} defaults
 * @param {Record<string, unknown>} configValues
 */
export function applyConfigToDefaults(defaults, configValues) {
  const merged = { ...defaults, mcp: [...(defaults.mcp ?? [])] };
  for (const [key, value] of Object.entries(configValues)) {
    if (key === "mcp") merged.mcp = [...value];
    else merged[key] = value;
  }
  return merged;
}

/** @returns {Promise<string>} */
export async function ensureConfigFile() {
  const configPath = getConfigPath();
  const configDir = path.dirname(configPath);
  await mkdir(configDir, { recursive: true });
  if (!existsSync(configPath)) {
    await writeFile(configPath, CONFIG_TEMPLATE, "utf8");
  }
  return configPath;
}

/** @returns {number} exit code */
export function openConfigInEditor(configPath) {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (editor) {
    const quotedPath = `"${configPath.replaceAll('"', '\\"')}"`;
    const result = spawnSync(`${editor} ${quotedPath}`, { stdio: "inherit", shell: true });
    return result.status ?? 1;
  }
  if (process.platform === "win32") {
    const result = spawnSync("notepad.exe", [configPath], { stdio: "inherit" });
    return result.status ?? 1;
  }
  const result = spawnSync("vi", [configPath], { stdio: "inherit" });
  return result.status ?? 1;
}

/** Built-in CLI defaults before config and argv are applied. */
export function getBuiltinDefaults() {
  return {
    model: "auto",
    provider: "ollama",
    apiKey: undefined,
    supervisorProvider: undefined,
    supervisorModel: undefined,
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: DEFAULT_MAX_STEPS,
    maxPromptTokens: 0,
    streakNudge: 0,
    numCtx: "auto",
    quiet: false,
    cwd: process.cwd(),
    port: 11435,
    mode: process.stdin.isTTY && process.stderr.isTTY ? "ask" : "agent",
    autoApprove: "off",
    mcp: [],
    embedModel: "nomic-embed-text",
    index: false,
    scan: true,
    scanProfile: "auto",
    noCheckpoints: false,
    completionGuard: true,
    json: false,
    think: DEFAULT_THINK,
    tierPreset: null,
    taskTier: null,
    goal: "",
    errors: [],
  };
}
