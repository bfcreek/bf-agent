"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

/** Public CDN base for halo-agent release feed. */
const UPDATES_BASE_URL = "https://halo-agent-releases.halosoftworks.com";

/** Production object key prefix (bucket root). */
const UPDATE_KEY_PREFIX = "";

/** Staging prefix for pre-promotion verification. */
const UPDATE_KEY_PREFIX_STAGING = "staging/";

/** Archived production builds. */
const UPDATE_KEY_PREFIX_ARCHIVE = "archive/";

/** Archived staging builds. */
const UPDATE_KEY_PREFIX_STAGING_ARCHIVE = "archive/staging/";

/** Staging feed URL (pre-promotion). */
const UPDATES_BASE_URL_STAGING = "https://halo-agent-releases.halosoftworks.com/staging";

/** How many staging zip versions to keep active (plus staging/latest.yml). */
const STAGING_RETAIN_COUNT = 5;

/** Default Cloudflare R2 bucket (override via R2_BUCKET env). */
const DEFAULT_R2_BUCKET = "halo-agent-releases";

/** Zip filename prefix — must match halo-site setupFilename (`bf-agent-<version>.zip`). */
const UPDATE_ARTIFACT_PREFIX = "bf-agent-";

/** Pre-rename zip prefix still present in R2 (`halo-agent-<version>.zip`). */
const LEGACY_ARTIFACT_PREFIXES = ["halo-agent-"];

/** @type {Record<string, { keyPrefix: string, updatesBaseUrl: string }>} */
const RELEASE_TARGETS = {
    staging: {
        keyPrefix: UPDATE_KEY_PREFIX_STAGING,
        updatesBaseUrl: UPDATES_BASE_URL_STAGING,
    },
};

/** Paths included in the release zip (relative to repo root). */
const RELEASE_INCLUDE_PATHS = [
    "package.json",
    "src",
    "bin/bf-agent.cmd",
    "bin/bf-agent.ps1",
    "bin/bf-agent.sh",
    "README.md",
    "LIMITATIONS.md",
    "LICENSE",
];

/** @param {string} text */
function parseSimpleYaml(text) {
    const out = {};
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const colon = trimmed.indexOf(":");
        if (colon <= 0) continue;
        out[trimmed.slice(0, colon).trim()] = trimmed.slice(colon + 1).trim();
    }
    return out;
}

/** @param {string} version */
function zipFilename(version) {
    return `${UPDATE_ARTIFACT_PREFIX}${version}.zip`;
}

/**
 * Build electron-updater-shaped latest.yml for the zip release feed.
 * @param {{ version: string, zipName: string, sha512: string, size: number, releaseDate?: string }} options
 */
function buildReleaseLatestYml(options) {
    const releaseDate = options.releaseDate || new Date().toISOString();
    return [
        `version: ${options.version}`,
        "files:",
        `  - url: ${options.zipName}`,
        `    sha512: ${options.sha512}`,
        `    size: ${options.size}`,
        `path: ${options.zipName}`,
        `sha512: ${options.sha512}`,
        `size: ${options.size}`,
        `releaseDate: '${releaseDate}'`,
        "",
    ].join("\n");
}

/**
 * @param {string} filePath
 * @returns {{ sha512: string, size: number }}
 */
function sha512Base64ForFile(filePath) {
    const body = fs.readFileSync(filePath);
    const sha512 = crypto.createHash("sha512").update(body).digest("base64");
    return { sha512, size: body.length };
}

/**
 * Write latest.yml into artifacts/ for R2 upload.
 * @param {{ zipPath: string, artifactsDir: string, version: string }} options
 */
function stageReleaseArtifacts(options) {
    const { zipPath, artifactsDir, version } = options;
    if (!fs.existsSync(zipPath)) {
        throw new Error(`Release zip not found: ${zipPath}`);
    }

    const zipName = zipFilename(version);
    const stagedZip = path.join(artifactsDir, zipName);
    const latestYmlPath = path.join(artifactsDir, "latest.yml");
    const { sha512, size } = sha512Base64ForFile(zipPath);

    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.copyFileSync(zipPath, stagedZip);
    fs.writeFileSync(
        latestYmlPath,
        buildReleaseLatestYml({ version, zipName, sha512, size }),
        "utf8",
    );

    return { zipName, latestYmlPath, stagedZip, sha512, size };
}

/**
 * @param {string} artifactsDir
 */
function listReleaseArtifactNames(artifactsDir) {
    if (!fs.existsSync(artifactsDir)) return [];
    return fs
        .readdirSync(artifactsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .filter((name) => {
            if (name === "latest.yml") return true;
            if (name.startsWith(UPDATE_ARTIFACT_PREFIX) && name.endsWith(".zip")) return true;
            return false;
        })
        .sort();
}

/** @param {string} filename */
function contentTypeForReleaseArtifact(filename) {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".yml") || lower.endsWith(".yaml")) return "application/x-yaml";
    if (lower.endsWith(".zip")) return "application/zip";
    return "application/octet-stream";
}

/** @param {string} filename */
function cacheControlForReleaseArtifact(filename) {
    if (filename === "latest.yml") return "public, max-age=60";
    return "public, max-age=31536000, immutable";
}

/**
 * @param {string} [targetName]
 * @returns {{ name: string, keyPrefix: string, updatesBaseUrl: string }}
 */
function resolveReleaseTarget(targetName) {
    const name = String(targetName || process.env.R2_RELEASE_TARGET || "staging")
        .trim()
        .toLowerCase();
    const target = RELEASE_TARGETS[name];
    if (!target) {
        throw new Error(`Invalid release target "${targetName}". Use staging only.`);
    }
    return { name, ...target };
}

/** @param {string} filename */
function objectKeyForReleaseArtifact(filename, targetName) {
    const { keyPrefix } = resolveReleaseTarget(targetName);
    return `${keyPrefix}${filename}`;
}

/**
 * @param {string} keyOrName
 * @returns {string | null}
 */
function releaseVersionFromObjectKey(keyOrName) {
    const base = String(keyOrName || "").split("/").pop() || "";
    if (!base.endsWith(".zip")) return null;
    const prefix = [UPDATE_ARTIFACT_PREFIX, ...LEGACY_ARTIFACT_PREFIXES].find((candidate) =>
        base.startsWith(candidate),
    );
    if (!prefix) return null;
    const rest = base.slice(prefix.length, -".zip".length);
    return rest || null;
}

/**
 * @param {string} key
 */
function isActiveStagingReleaseKey(key) {
    const k = String(key || "").trim();
    if (!k.startsWith(UPDATE_KEY_PREFIX_STAGING)) return false;
    if (k.startsWith(UPDATE_KEY_PREFIX_STAGING_ARCHIVE)) return false;
    if (k.endsWith("latest.yml")) return false;
    return releaseVersionFromObjectKey(k) != null;
}

/** @param {string} sourceKey */
function stagingArchiveObjectKey(sourceKey) {
    const key = String(sourceKey || "").trim();
    const base = key.startsWith(UPDATE_KEY_PREFIX_STAGING)
        ? key.slice(UPDATE_KEY_PREFIX_STAGING.length)
        : key.split("/").pop() || key;
    return `${UPDATE_KEY_PREFIX_STAGING_ARCHIVE}${base}`;
}

/**
 * @param {Array<{ Key?: string, key?: string, LastModified?: Date | string, lastModified?: Date | string }>} entries
 * @param {{ retainCount?: number, includeKey?: (key: string) => boolean }} options
 */
function selectKeysBeyondRetain(entries, options) {
    const retainCount = Number.isFinite(options.retainCount) ? options.retainCount : STAGING_RETAIN_COUNT;
    const includeKey = options.includeKey || (() => true);
    /** @type {Map<string, { maxMs: number, keys: string[] }>} */
    const byVersion = new Map();

    for (const entry of entries || []) {
        const key = String(entry.Key || entry.key || "").trim();
        if (!key || key.endsWith("latest.yml")) continue;
        if (!includeKey(key)) continue;
        const version = releaseVersionFromObjectKey(key);
        if (!version) continue;
        const modified = entry.LastModified || entry.lastModified || 0;
        const ms = modified instanceof Date ? modified.getTime() : Date.parse(String(modified)) || 0;
        const group = byVersion.get(version) || { maxMs: 0, keys: [] };
        group.keys.push(key);
        group.maxMs = Math.max(group.maxMs, ms);
        byVersion.set(version, group);
    }

    const ranked = [...byVersion.entries()].sort((a, b) => {
        if (b[1].maxMs !== a[1].maxMs) return b[1].maxMs - a[1].maxMs;
        return b[0].localeCompare(a[0]);
    });

    if (ranked.length <= retainCount) return [];

    /** @type {string[]} */
    const overflow = [];
    for (const [, group] of ranked.slice(retainCount)) {
        overflow.push(...group.keys);
    }
    return overflow.sort();
}

/**
 * @param {Array<{ Key?: string, key?: string, LastModified?: Date | string, lastModified?: Date | string }>} entries
 * @param {{ retainCount?: number }} [options]
 */
function selectStagingKeysToArchive(entries, options = {}) {
    const retainCount = Number.isFinite(options.retainCount) ? options.retainCount : STAGING_RETAIN_COUNT;
    const sourceKeys = selectKeysBeyondRetain(entries, {
        retainCount,
        includeKey: isActiveStagingReleaseKey,
    });
    return sourceKeys.map((sourceKey) => ({
        sourceKey,
        destKey: stagingArchiveObjectKey(sourceKey),
    }));
}

/** Artifact names promoted from staging/ to bucket root for a release version. */
function listPromotableArtifactNames(version) {
    return ["latest.yml", zipFilename(version)];
}

module.exports = {
    UPDATES_BASE_URL,
    UPDATES_BASE_URL_STAGING,
    UPDATE_KEY_PREFIX,
    UPDATE_KEY_PREFIX_STAGING,
    UPDATE_KEY_PREFIX_ARCHIVE,
    UPDATE_KEY_PREFIX_STAGING_ARCHIVE,
    DEFAULT_R2_BUCKET,
    UPDATE_ARTIFACT_PREFIX,
    STAGING_RETAIN_COUNT,
    RELEASE_INCLUDE_PATHS,
    parseSimpleYaml,
    zipFilename,
    buildReleaseLatestYml,
    sha512Base64ForFile,
    stageReleaseArtifacts,
    listReleaseArtifactNames,
    contentTypeForReleaseArtifact,
    cacheControlForReleaseArtifact,
    resolveReleaseTarget,
    objectKeyForReleaseArtifact,
    releaseVersionFromObjectKey,
    isActiveStagingReleaseKey,
    stagingArchiveObjectKey,
    selectStagingKeysToArchive,
    listPromotableArtifactNames,
};
