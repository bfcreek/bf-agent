/**
 * User-level YAML config (~/.config/halo-agent/config.yaml).
 * Keys match CLI flag names (without --). CLI flags override config values.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DEFAULT_NUM_CTX, DEFAULT_THINK } from "./ollama-client.mjs";

export const CONFIG_FILE_NAME = "config.yaml";

const CONFIG_TEMPLATE = `# halo-agent user configuration
# Keys match CLI flag names (without --). Command-line flags override these values.
# Remove or comment out a line to use the built-in default.

# model: auto
# base-url: http://127.0.0.1:11434
# max-steps: 10
# num-ctx: ${DEFAULT_NUM_CTX}
# cwd: .
# mode: ask
# port: 11435
# session: my-session
# embed-model: nomic-embed-text
# think: auto
# quiet: false
# no-index: false
# no-plan: false
# no-hints: false
# terran: false
# ns: general
# web: false
# json: false
# mcp:
#   - "npx -y some-mcp-server"
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
      const list = [];
      i++;
      while (i < lines.length) {
        const child = stripComment(lines[i]);
        if (!child.trim()) {
          i++;
          continue;
        }
        const listMatch = child.match(/^\s+-\s+(.*)$/);
        if (!listMatch) break;
        list.push(parseScalar(listMatch[1].trim()));
        i++;
      }
      result[key] = list;
      continue;
    }

    result[key] = parseScalar(inlineValue);
    i++;
  }

  return result;
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
      case "ns":
        setString(key, configKeyToOption(key), value);
        break;
      case "max-steps": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) values.maxSteps = n;
        else errors.push(`config 'max-steps' needs a positive integer, got '${value}'.`);
        break;
      }
      case "num-ctx": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) values.numCtx = n;
        else errors.push(`config 'num-ctx' needs a positive integer, got '${value}'.`);
        break;
      }
      case "port": {
        const p = Number(value);
        if (Number.isFinite(p) && p >= 0 && p <= 65535) values.port = p;
        else errors.push(`config 'port' needs a number from 0 to 65535, got '${value}'.`);
        break;
      }
      case "quiet":
      case "no-index":
      case "terran":
      case "web":
      case "json":
      case "no-plan":
      case "no-hints":
        if (typeof value === "boolean") values[configKeyToOption(key)] = value;
        else errors.push(`config '${key}' must be true or false.`);
        break;
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

  if (values.terranWeb) values.terran = true;
  if (values.terranNamespace !== undefined) values.terran = true;

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
    case "num-ctx":
      return "numCtx";
    case "embed-model":
      return "embedModel";
    case "no-index":
      return "noIndex";
    case "no-plan":
      return "noPlan";
    case "no-hints":
      return "noHints";
    case "ns":
      return "terranNamespace";
    case "web":
      return "terranWeb";
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
    baseUrl: "http://127.0.0.1:11434",
    maxSteps: 10,
    numCtx: DEFAULT_NUM_CTX,
    quiet: false,
    cwd: process.cwd(),
    port: 11435,
    mode: process.stdin.isTTY && process.stderr.isTTY ? "ask" : "agent",
    mcp: [],
    embedModel: "nomic-embed-text",
    noIndex: false,
    json: false,
    terran: false,
    terranNamespace: undefined,
    terranWeb: false,
    think: DEFAULT_THINK,
    noPlan: false,
    noHints: false,
    goal: "",
    errors: [],
  };
}
