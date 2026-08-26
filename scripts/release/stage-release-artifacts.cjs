"use strict";

const fs = require("fs");
const path = require("path");
const { zipFilename } = require("./release-publish.cjs");

const repoRoot = path.join(__dirname, "..", "..");
const pkg = require(path.join(repoRoot, "package.json"));
const version = String(pkg.version || "").trim();
if (!version) {
    throw new Error("package.json is missing version.");
}

const artifactsDir = path.join(repoRoot, "artifacts");
const zipPath = path.join(artifactsDir, zipFilename(version));

if (!fs.existsSync(zipPath)) {
    throw new Error(`Expected release zip at ${zipPath}. Run build-release-zip first.`);
}

const { stageReleaseArtifacts } = require("./release-publish.cjs");
stageReleaseArtifacts({ zipPath, artifactsDir, version });

console.log(`Staged artifacts/latest.yml for v${version}`);
