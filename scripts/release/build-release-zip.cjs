"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { RELEASE_INCLUDE_PATHS, zipFilename } = require("./release-publish.cjs");

const repoRoot = path.join(__dirname, "..", "..");
const pkg = require(path.join(repoRoot, "package.json"));
const version = String(pkg.version || "").trim();
if (!version) {
    throw new Error("package.json is missing version.");
}

const artifactsDir = path.join(repoRoot, "artifacts");
const stageRoot = path.join(artifactsDir, `halo-agent-${version}`);
const zipPath = path.join(artifactsDir, zipFilename(version));

function copyRecursive(source, destination) {
    const stat = fs.statSync(source);
    if (stat.isDirectory()) {
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
            copyRecursive(path.join(source, entry.name), path.join(destination, entry.name));
        }
        return;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
}

function removeIfExists(target) {
    if (!fs.existsSync(target)) return;
    fs.rmSync(target, { recursive: true, force: true });
}

removeIfExists(stageRoot);
removeIfExists(zipPath);
fs.mkdirSync(stageRoot, { recursive: true });

for (const rel of RELEASE_INCLUDE_PATHS) {
    const source = path.join(repoRoot, rel);
    if (!fs.existsSync(source)) {
        throw new Error(`Release source missing: ${rel}`);
    }
    copyRecursive(source, path.join(stageRoot, rel));
}

fs.mkdirSync(artifactsDir, { recursive: true });

if (process.platform === "win32") {
    const psScript = [
        "$ErrorActionPreference = 'Stop'",
        `Compress-Archive -Path '${stageRoot.replace(/'/g, "''")}' -DestinationPath '${zipPath.replace(/'/g, "''")}' -Force`,
    ].join("; ");
    execFileSync(
        "powershell.exe",
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
        { stdio: "inherit" },
    );
} else {
    execFileSync("zip", ["-r", zipPath, path.basename(stageRoot)], {
        cwd: artifactsDir,
        stdio: "inherit",
    });
}

removeIfExists(stageRoot);

const { size } = fs.statSync(zipPath);
console.log(`Built ${zipPath} (${size} bytes)`);
