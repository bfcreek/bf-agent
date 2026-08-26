"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_ENV_FILE = path.join(__dirname, ".env.release");

/** @param {string} line */
function parseEnvLine(line) {
    const trimmed = String(line).trim();
    if (!trimmed || trimmed.startsWith("#")) {
        return null;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex <= 0) {
        return null;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    let value = trimmed.slice(equalsIndex + 1).trim();
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    if (!key) {
        return null;
    }

    return { key, value };
}

/**
 * Load local release credentials from scripts/release/.env.release.
 * Existing process.env values are preserved unless override is true.
 *
 * @param {{ path?: string, override?: boolean }} [options]
 */
function loadReleaseEnv(options = {}) {
    const envPath = options.path || DEFAULT_ENV_FILE;
    if (!fs.existsSync(envPath)) {
        return { loaded: false, path: envPath, keys: [] };
    }

    const keys = [];
    const text = fs.readFileSync(envPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
        const parsed = parseEnvLine(line);
        if (!parsed) {
            continue;
        }

        const existing = String(process.env[parsed.key] || "").trim();
        if (!options.override && existing) {
            continue;
        }

        process.env[parsed.key] = parsed.value;
        keys.push(parsed.key);
    }

    return { loaded: true, path: envPath, keys };
}

module.exports = {
    DEFAULT_ENV_FILE,
    parseEnvLine,
    loadReleaseEnv,
};
