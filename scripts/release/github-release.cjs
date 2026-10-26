"use strict";

const { execFileSync } = require("child_process");
const {
    buildReleaseNotes,
    githubReleaseCreateArgs,
    isPrereleaseVersion,
    parseCommitLog,
    githubAccountForRepo,
    parseGithubRepoSlug,
    parseRemoteTagShas,
    releaseTagName,
    selectPreviousReleaseTag,
    selectPreviousVersionCommit,
} = require("./github-release-logic.cjs");

/**
 * @param {string} repoRoot
 * @param {string[]} args
 */
function git(repoRoot, args) {
    return execFileSync("git", args, {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });
}

/**
 * Drop inherited GitHub tokens so a user-level GH_TOKEN cannot select another account.
 * @param {NodeJS.ProcessEnv} baseEnv
 * @param {string} [token]
 * @returns {NodeJS.ProcessEnv}
 */
function githubCliEnv(baseEnv, token) {
    const env = { ...baseEnv };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    if (token) env.GH_TOKEN = token;
    return env;
}

/**
 * @param {string} account
 * @returns {NodeJS.ProcessEnv}
 */
function githubEnvForAccount(account) {
    const lookupEnv = githubCliEnv(process.env);
    let token = "";
    try {
        token = execFileSync(
            "gh",
            ["auth", "token", "--hostname", "github.com", "--user", account],
            {
                env: lookupEnv,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
            },
        ).trim();
    } catch (error) {
        const stderr = error && error.stderr ? String(error.stderr).trim() : "";
        const detail = stderr && !/gh[pousr]_/i.test(stderr) ? ` ${stderr}` : "";
        throw new Error(
            `GitHub CLI is not logged in as ${account}. `
                + `Run \`gh auth login\` in a shell without GH_TOKEN and sign in as ${account}.`
                + detail,
        );
    }
    if (!token) {
        throw new Error(`GitHub CLI returned an empty token for ${account}.`);
    }
    return githubCliEnv(process.env, token);
}

function runGh(args, options = {}) {
    try {
        return execFileSync("gh", args, {
            cwd: options.cwd,
            input: options.input,
            env: options.env,
            encoding: "utf8",
            stdio: options.input ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
        });
    } catch (error) {
        if (error && error.code === "ENOENT") {
            throw new Error(
                "GitHub CLI (gh) was not found on PATH. Install https://cli.github.com/ and authenticate with access to the repository.",
            );
        }
        const stderr = error && error.stderr ? String(error.stderr).trim() : "";
        const stdout = error && error.stdout ? String(error.stdout).trim() : "";
        const detail = stderr || stdout || (error && error.message) || "gh failed";
        const repoFlag = args.indexOf("--repo");
        const repoSlug = repoFlag >= 0 ? args[repoFlag + 1] : "";
        const missingRepo = repoSlug
            && /HTTP 404|Could not resolve to a Repository/i.test(detail)
            && !/release not found/i.test(detail);
        const message = missingRepo
            ? `GitHub CLI cannot access ${repoSlug}. Authenticate gh as an account that can create releases there (gh auth login).`
            : `GitHub release failed: ${detail}`;
        const wrapped = new Error(message);
        wrapped.cause = error;
        wrapped.stderr = stderr;
        throw wrapped;
    }
}

/**
 * @param {string} repoSlug
 * @param {string} tag
 */
function githubReleaseExists(repoSlug, tag, env) {
    try {
        runGh(["release", "view", tag, "--repo", repoSlug, "--json", "tagName"], { env });
        return true;
    } catch (error) {
        const detail = String(error && error.message ? error.message : error);
        if (/release not found/i.test(detail)) return false;
        throw error;
    }
}

/**
 * @param {string} repoRoot
 * @returns {Map<string, string>}
 */
function readRemoteTagShas(repoRoot) {
    try {
        return parseRemoteTagShas(git(repoRoot, ["ls-remote", "--tags", "origin"]));
    } catch (error) {
        const detail = error && error.stderr ? String(error.stderr).trim() : error.message;
        throw new Error(`Could not list tags on origin: ${detail}`);
    }
}

/**
 * `logBase` is the exclusive git range start. `notesRef` is the compare link
 * (tag name when a previous release tag exists, otherwise the commit sha).
 * @param {string} repoRoot
 * @param {string | null} previousTag
 * @param {Map<string, string>} remoteTagShas
 * @param {string} version
 * @returns {{ logBase: string | null, notesRef: string | null }}
 */
function resolvePreviousRef(repoRoot, previousTag, remoteTagShas, version) {
    if (previousTag) {
        const remoteSha = remoteTagShas.get(previousTag);
        if (remoteSha) return { logBase: remoteSha, notesRef: previousTag };
        try {
            const localSha = git(repoRoot, ["rev-parse", `${previousTag}^{commit}`]).trim();
            return { logBase: localSha, notesRef: previousTag };
        } catch {
            return { logBase: previousTag, notesRef: previousTag };
        }
    }
    const previousCommit = selectPreviousVersionCommit(listPackageVersionCommits(repoRoot), version);
    return { logBase: previousCommit, notesRef: previousCommit };
}

/**
 * @param {string} repoRoot
 * @returns {Array<{ sha: string, version: string }>}
 */
function listPackageVersionCommits(repoRoot) {
    const output = git(repoRoot, ["log", "-G", '"version"', "--format=%H", "--", "package.json"]);
    const shas = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    /** @type {Array<{ sha: string, version: string }>} */
    const history = [];
    for (const sha of shas) {
        try {
            const raw = git(repoRoot, ["show", `${sha}:package.json`]);
            const version = String(JSON.parse(raw).version || "").trim();
            if (version) history.push({ sha, version });
        } catch {
            // Historical package.json may be missing or not JSON.
        }
    }
    return history;
}

/**
 * Generate release notes and create the GitHub release for this version.
 * Dry run prints the notes and does not call gh.
 *
 * @param {{
 *   version: string,
 *   repository: string | { url?: string },
 *   repoRoot: string,
 *   dryRun?: boolean,
 * }} options
 */
function createGithubRelease(options) {
    const version = String(options.version || "").trim();
    const repoRoot = options.repoRoot;
    const dryRun = Boolean(options.dryRun);
    const repoSlug = parseGithubRepoSlug(options.repository);
    const tag = releaseTagName(version);

    const headSha = git(repoRoot, ["rev-parse", "HEAD"]).trim();
    const headPkg = JSON.parse(git(repoRoot, ["show", "HEAD:package.json"]));
    const headVersion = String(headPkg.version || "").trim();
    if (headVersion !== version.replace(/^v/, "")) {
        throw new Error(
            `HEAD package.json is v${headVersion} but publishing v${version}. `
                + "Commit the version bump before creating the GitHub release.",
        );
    }

    const remoteBranches = git(repoRoot, ["branch", "-r", "--contains", headSha]);
    const onOrigin = remoteBranches
        .split(/\r?\n/)
        .some((line) => line.trim().startsWith("origin/"));
    if (!onOrigin) {
        throw new Error(
            `Commit ${headSha.slice(0, 7)} is not on origin. Push it before publishing so GitHub can tag the release.`,
        );
    }

    const localTags = git(repoRoot, ["tag", "--list"])
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    const remoteTagShas = readRemoteTagShas(repoRoot);
    const previousTag = selectPreviousReleaseTag(
        [...localTags, ...remoteTagShas.keys()],
        version,
    );
    const { logBase, notesRef } = resolvePreviousRef(repoRoot, previousTag, remoteTagShas, version);

    const logRange = logBase ? `${logBase}..HEAD` : "HEAD";
    const commits = parseCommitLog(git(repoRoot, ["log", logRange, "--pretty=format:%H%x09%s"]));
    if (commits.length === 0) {
        throw new Error(`No commits found for ${tag}. Refusing to create an empty GitHub release.`);
    }

    const notes = buildReleaseNotes({
        version,
        repoSlug,
        previousRef: notesRef,
        commits,
    });

    console.log(`GitHub release notes for ${tag} (${repoSlug}):`);
    console.log(notes.trimEnd());

    if (dryRun) {
        console.log(`Dry run: would create GitHub release ${tag} at ${headSha.slice(0, 7)}.`);
        return { tag, repoSlug, notes, targetSha: headSha, created: false };
    }

    const account = githubAccountForRepo(repoSlug);
    const ghEnv = githubEnvForAccount(account);
    console.log(`Using GitHub account ${account} for ${repoSlug}.`);

    if (githubReleaseExists(repoSlug, tag, ghEnv)) {
        console.log(`GitHub release ${tag} already exists; leaving it in place.`);
        return { tag, repoSlug, notes, targetSha: headSha, created: false, existed: true };
    }

    runGh(
        githubReleaseCreateArgs({
            tag,
            repoSlug,
            targetSha: headSha,
            prerelease: isPrereleaseVersion(version),
        }),
        { cwd: repoRoot, input: notes, env: ghEnv },
    );

    console.log(`Created GitHub release https://github.com/${repoSlug}/releases/tag/${tag}`);
    return { tag, repoSlug, notes, targetSha: headSha, created: true };
}

module.exports = {
    createGithubRelease,
};
