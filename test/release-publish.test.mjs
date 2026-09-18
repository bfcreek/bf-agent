import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
    buildReleaseLatestYml,
    listPromotableArtifactNames,
    releaseVersionFromObjectKey,
    selectStagingKeysToArchive,
    zipFilename,
} = require("../scripts/release/release-publish.cjs");

test("zipFilename uses bf-agent prefix", () => {
    assert.equal(zipFilename("0.1.0"), "bf-agent-0.1.0.zip");
});

test("releaseVersionFromObjectKey parses zip keys", () => {
    assert.equal(releaseVersionFromObjectKey("staging/bf-agent-1.2.3.zip"), "1.2.3");
    assert.equal(releaseVersionFromObjectKey("bf-agent-0.1.0.zip"), "0.1.0");
    assert.equal(releaseVersionFromObjectKey("staging/halo-agent-0.1.3.zip"), "0.1.3");
    assert.equal(releaseVersionFromObjectKey("latest.yml"), null);
});

test("listPromotableArtifactNames includes latest.yml and zip", () => {
    assert.deepEqual(listPromotableArtifactNames("0.2.0"), [
        "latest.yml",
        "bf-agent-0.2.0.zip",
    ]);
});

test("buildReleaseLatestYml matches electron-updater shape", () => {
    const yaml = buildReleaseLatestYml({
        version: "0.1.0",
        zipName: "bf-agent-0.1.0.zip",
        sha512: "abc123",
        size: 42,
        releaseDate: "2026-08-26T00:00:00.000Z",
    });
    assert.match(yaml, /^version: 0\.1\.0/m);
    assert.match(yaml, /path: bf-agent-0\.1\.0\.zip/);
    assert.match(yaml, /sha512: abc123/);
    assert.match(yaml, /size: 42/);
});

test("selectStagingKeysToArchive keeps newest retainCount versions", () => {
    const entries = [
        { Key: "staging/bf-agent-1.0.0.zip", LastModified: new Date("2026-01-01") },
        { Key: "staging/bf-agent-1.0.1.zip", LastModified: new Date("2026-02-01") },
        { Key: "staging/bf-agent-1.0.2.zip", LastModified: new Date("2026-03-01") },
        { Key: "staging/bf-agent-1.0.3.zip", LastModified: new Date("2026-04-01") },
        { Key: "staging/bf-agent-1.0.4.zip", LastModified: new Date("2026-05-01") },
        { Key: "staging/bf-agent-1.0.5.zip", LastModified: new Date("2026-06-01") },
        { Key: "staging/bf-agent-1.0.6.zip", LastModified: new Date("2026-07-01") },
    ];

    const moves = selectStagingKeysToArchive(entries, { retainCount: 5 });
    assert.equal(moves.length, 2);
    assert.deepEqual(
        moves.map((m) => m.sourceKey).sort(),
        ["staging/bf-agent-1.0.0.zip", "staging/bf-agent-1.0.1.zip"],
    );
    assert.equal(moves[0].destKey, "archive/staging/bf-agent-1.0.0.zip");
});
