import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
    buildReleaseNotes,
    githubReleaseCreateArgs,
    parseCommitLog,
    githubAccountForRepo,
    parseGithubRepoSlug,
    parseRemoteTagShas,
    releaseTagName,
    selectPreviousReleaseTag,
    selectPreviousVersionCommit,
} = require("../scripts/release/github-release-logic.cjs");

test("releaseTagName prefixes semver with v", () => {
    assert.equal(releaseTagName("1.1.24"), "v1.1.24");
    assert.equal(releaseTagName("v1.1.24"), "v1.1.24");
    assert.throws(() => releaseTagName("nope"), /not semver/);
});

test("parseGithubRepoSlug reads package.json repository urls", () => {
    assert.equal(
        parseGithubRepoSlug({ url: "git+https://github.com/bfcreek/bf-agent.git" }),
        "bfcreek/bf-agent",
    );
    assert.equal(
        parseGithubRepoSlug("git@github.com:bfcreek/bf-agent.git"),
        "bfcreek/bf-agent",
    );
    assert.throws(() => parseGithubRepoSlug("https://example.com/bf-agent"), /not a GitHub URL/);
});

test("githubAccountForRepo is the repository owner", () => {
    assert.equal(githubAccountForRepo("bfcreek/bf-agent"), "bfcreek");
    assert.throws(() => githubAccountForRepo(""), /owner is missing/);
});

test("selectPreviousReleaseTag picks the newest older tag", () => {
    const tags = ["v1.1.9", "v1.1.10", "v1.1.24", "not-a-version", "v1.2.0"];
    assert.equal(selectPreviousReleaseTag(tags, "1.1.24"), "v1.1.10");
    assert.equal(selectPreviousReleaseTag(["v0.1.0"], "0.1.0"), null);
});

test("selectPreviousVersionCommit skips commits already on this version", () => {
    const history = [
        { sha: "aaa", version: "1.1.24" },
        { sha: "bbb", version: "1.1.24" },
        { sha: "ccc", version: "1.1.23" },
        { sha: "ddd", version: "1.1.22" },
    ];
    assert.equal(selectPreviousVersionCommit(history, "1.1.24"), "ccc");
    assert.equal(selectPreviousVersionCommit([{ sha: "aaa", version: "1.0.0" }], "1.0.0"), null);
});

test("parseRemoteTagShas prefers peeled commit shas", () => {
    const text = [
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\trefs/tags/v1.1.23",
        "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\trefs/tags/v1.1.23^{}",
        "cccccccccccccccccccccccccccccccccccccccc\trefs/tags/v1.1.22",
    ].join("\n");
    const tags = parseRemoteTagShas(text);
    assert.equal(tags.get("v1.1.23"), "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    assert.equal(tags.get("v1.1.22"), "cccccccccccccccccccccccccccccccccccccccc");
});

test("parseCommitLog reads hash and subject", () => {
    const commits = parseCommitLog("abc123\tFix the loop\n\ndef456\tBump version\n");
    assert.deepEqual(commits, [
        { sha: "abc123", subject: "Fix the loop" },
        { sha: "def456", subject: "Bump version" },
    ]);
});

test("buildReleaseNotes lists commits and the compare link", () => {
    const notes = buildReleaseNotes({
        version: "1.1.24",
        repoSlug: "bfcreek/bf-agent",
        previousRef: "v1.1.23",
        commits: [{ sha: "abc", subject: "Ship the release notes" }],
    });
    assert.match(notes, /## What's Changed/);
    assert.match(notes, /\* Ship the release notes/);
    assert.match(
        notes,
        /https:\/\/github\.com\/bfcreek\/bf-agent\/compare\/v1\.1\.23\.\.\.v1\.1\.24/,
    );
    assert.match(notes, /npx @bitfieldcreek\/bf-agent "summarize README.md"/);
    assert.match(notes, /terminal-16x9\.gif/);
    assert.match(notes, /#pinned-result/);
});

test("githubReleaseCreateArgs targets the commit and reads notes from stdin", () => {
    assert.deepEqual(
        githubReleaseCreateArgs({
            tag: "v1.1.24",
            repoSlug: "bfcreek/bf-agent",
            targetSha: "abc123",
        }),
        [
            "release",
            "create",
            "v1.1.24",
            "--repo",
            "bfcreek/bf-agent",
            "--target",
            "abc123",
            "--title",
            "v1.1.24",
            "--notes-file",
            "-",
        ],
    );
});
