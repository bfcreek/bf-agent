"use strict";

/**
 * Pure helpers for the GitHub release created alongside npm publish.
 */

/**
 * @param {string} version
 * @returns {{ major: number, minor: number, patch: number, prerelease: string } | null}
 */
function parseSemver(version) {
    const match = String(version || "")
        .trim()
        .replace(/^v/, "")
        .match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match) return null;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4] || "",
    };
}

/**
 * @param {string | { major: number, minor: number, patch: number, prerelease: string }} left
 * @param {string | { major: number, minor: number, patch: number, prerelease: string }} right
 * @returns {number}
 */
function compareSemver(left, right) {
    const a = typeof left === "string" ? parseSemver(left) : left;
    const b = typeof right === "string" ? parseSemver(right) : right;
    if (!a || !b) {
        throw new Error("Invalid semver.");
    }
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.prerelease === b.prerelease) return 0;
    if (!a.prerelease) return 1;
    if (!b.prerelease) return -1;
    return a.prerelease < b.prerelease ? -1 : 1;
}

/**
 * @param {string} version
 */
function releaseTagName(version) {
    const raw = String(version || "").trim();
    if (!parseSemver(raw)) {
        throw new Error(`package.json version is not semver: ${raw || "(missing)"}`);
    }
    return raw.startsWith("v") ? raw : `v${raw}`;
}

/**
 * @param {string} version
 */
function isPrereleaseVersion(version) {
    const parsed = parseSemver(version);
    return Boolean(parsed && parsed.prerelease);
}

/**
 * @param {string | { url?: string }} repository
 * @returns {string}
 */
function parseGithubRepoSlug(repository) {
    const url = typeof repository === "string" ? repository : repository?.url;
    const text = String(url || "").trim();
    const match = text.match(/github\.com[:/]([^/]+)\/([^/#]+?)(?:\.git)?\/?$/);
    if (!match) {
        throw new Error(
            `package.json repository is not a GitHub URL: ${text || "(missing)"}`,
        );
    }
    return `${match[1]}/${match[2]}`;
}

/**
 * Releases are created as the repository owner, not whatever account a
 * machine-wide GH_TOKEN happens to select.
 * @param {string} repoSlug
 * @returns {string}
 */
function githubAccountForRepo(repoSlug) {
    const account = String(repoSlug || "").split("/")[0].trim();
    if (!account) {
        throw new Error("GitHub repository owner is missing.");
    }
    return account;
}

/**
 * Highest semver tag strictly older than `version`.
 * @param {string[]} tags
 * @param {string} version
 * @returns {string | null}
 */
function selectPreviousReleaseTag(tags, version) {
    /** @type {{ tag: string, parsed: { major: number, minor: number, patch: number, prerelease: string } } | null} */
    let best = null;
    for (const tag of tags || []) {
        const name = String(tag || "").trim();
        const parsed = parseSemver(name);
        if (!parsed) continue;
        if (compareSemver(parsed, version) >= 0) continue;
        if (!best || compareSemver(parsed, best.parsed) > 0) {
            best = { tag: name, parsed };
        }
    }
    return best ? best.tag : null;
}

/**
 * Newest commit whose package version differs from the version being published.
 * History must be newest-first.
 * @param {Array<{ sha: string, version: string }>} history
 * @param {string} version
 * @returns {string | null}
 */
function selectPreviousVersionCommit(history, version) {
    const current = String(version || "").trim().replace(/^v/, "");
    for (const entry of history || []) {
        const entryVersion = String(entry?.version || "").trim().replace(/^v/, "");
        if (entryVersion && entryVersion !== current) {
            return String(entry.sha || "").trim() || null;
        }
    }
    return null;
}

/**
 * Parse `git ls-remote --tags origin`. Peeled `^{}` lines win as the commit sha.
 * @param {string} text
 * @returns {Map<string, string>} tag name → commit sha
 */
function parseRemoteTagShas(text) {
    /** @type {Map<string, string>} */
    const tags = new Map();
    /** @type {Set<string>} */
    const peeled = new Set();
    for (const line of String(text || "").split(/\r?\n/)) {
        const match = line.match(/^([0-9a-f]{40})\s+refs\/tags\/(.+)$/i);
        if (!match) continue;
        const sha = match[1];
        const name = match[2];
        if (name.endsWith("^{}")) {
            tags.set(name.slice(0, -"^{}".length), sha);
            peeled.add(name.slice(0, -"^{}".length));
            continue;
        }
        if (!peeled.has(name)) tags.set(name, sha);
    }
    return tags;
}

/**
 * @param {string} text `git log --pretty=format:%H%x09%s`
 * @returns {Array<{ sha: string, subject: string }>}
 */
function parseCommitLog(text) {
    /** @type {Array<{ sha: string, subject: string }>} */
    const commits = [];
    for (const line of String(text || "").split(/\r?\n/)) {
        if (!line.trim()) continue;
        const tab = line.indexOf("\t");
        if (tab <= 0) continue;
        const sha = line.slice(0, tab).trim();
        const subject = line.slice(tab + 1).trim();
        if (!sha || !subject) continue;
        commits.push({ sha, subject });
    }
    return commits;
}

/**
 * @param {{
 *   version: string,
 *   repoSlug: string,
 *   previousRef?: string | null,
 *   commits: Array<{ sha?: string, subject: string }>,
 * }} options
 */
function buildReleaseNotes(options) {
    const tag = releaseTagName(options.version);
    const repoSlug = String(options.repoSlug || "").trim();
    const previousRef = String(options.previousRef || "").trim();
    const bullets = (options.commits || [])
        .map((commit) => String(commit?.subject || "").trim())
        .filter(Boolean)
        .map((subject) => `* ${subject}`);

    const lines = [
        "## What's Changed",
        "",
        bullets.length ? bullets.join("\n") : "* No commits since the previous release.",
    ];

    if (repoSlug && previousRef) {
        lines.push(
            "",
            `**Full Changelog**: https://github.com/${repoSlug}/compare/${previousRef}...${tag}`,
        );
    } else if (repoSlug) {
        lines.push("", `**Full Changelog**: https://github.com/${repoSlug}/commits/${tag}`);
    }

    lines.push(
        "",
        "## Try it",
        "",
        "```",
        'npx @bitfieldcreek/bf-agent "summarize README.md"',
        "```",
        "",
        "![Bitfield Ollama Agent running in a terminal](https://github.com/bfcreek/bf-agent/raw/main/docs/assets/ads/google/bf-agent/gifs/terminal-16x9.gif)",
        "",
        "Pinned result: https://github.com/bfcreek/bf-agent#pinned-result",
    );

    return `${lines.join("\n")}\n`;
}

/**
 * @param {{ tag: string, repoSlug: string, targetSha: string, prerelease?: boolean }} options
 * @returns {string[]}
 */
function githubReleaseCreateArgs(options) {
    const args = [
        "release",
        "create",
        options.tag,
        "--repo",
        options.repoSlug,
        "--target",
        options.targetSha,
        "--title",
        options.tag,
        "--notes-file",
        "-",
    ];
    if (options.prerelease) args.push("--prerelease");
    return args;
}

module.exports = {
    parseSemver,
    compareSemver,
    releaseTagName,
    isPrereleaseVersion,
    parseGithubRepoSlug,
    githubAccountForRepo,
    selectPreviousReleaseTag,
    selectPreviousVersionCommit,
    parseRemoteTagShas,
    parseCommitLog,
    buildReleaseNotes,
    githubReleaseCreateArgs,
};
