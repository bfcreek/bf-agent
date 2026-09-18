"use strict";

/**
 * Publish @bitfieldcreek/bf-agent to npm after production CDN promotion.
 *
 * Required env: NPM_TOKEN (Automation token with publish access)
 * Optional: HALO_AGENT_UPDATES_BASE_URL
 *
 * Usage:
 *   node scripts/release/publish-npm.cjs [--dry-run]
 *
 * Run only after halo-site admin promote copies staging → production on R2.
 */

require("./load-release-env.cjs").loadReleaseEnv();

const { execFileSync } = require("child_process");
const path = require("path");
const { DEFAULT_PACKAGE_NAME, verifyReadyForNpmPublish } = require("./publish-npm-logic.cjs");

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const npmAuthEnvKey = "NPM_CONFIG_//registry.npmjs.org/:_authToken";

const repoRoot = path.join(__dirname, "..", "..");
const pkg = require(path.join(repoRoot, "package.json"));
const dryRun = process.argv.includes("--dry-run");

function requiredEnv(name) {
    const value = String(process.env[name] || "").trim();
    if (!value) {
        throw new Error(`Missing ${name}. Add an npm Automation token to scripts/release/.env.release.`);
    }
    return value;
}

/**
 * @param {string | undefined} token
 */
function npmPublishEnv(token) {
    const env = { ...process.env };
    if (token) {
        env.NPM_TOKEN = token;
        env[npmAuthEnvKey] = token;
    }
    return env;
}

/**
 * @param {string[]} publishArgs
 * @param {Record<string, string | undefined>} env
 */
function runNpmPublish(publishArgs, env) {
    execFileSync(process.execPath, [npmCli, ...publishArgs], {
        cwd: repoRoot,
        stdio: "inherit",
        env,
    });
}

async function main() {
    const packageName = String(pkg.name || "").trim();
    const packageVersion = String(pkg.version || "").trim();
    if (!packageName || !packageVersion) {
        throw new Error("package.json must include name and version.");
    }

    const status = await verifyReadyForNpmPublish({
        packageName,
        packageVersion,
        updatesBaseUrl: process.env.HALO_AGENT_UPDATES_BASE_URL,
    });

    console.log(
        `Ready to publish ${status.packageName} v${status.packageVersion} `
            + `(production CDN v${status.productionVersion}`
            + `${status.npmLatestVersion ? `, npm latest v${status.npmLatestVersion}` : ", npm: first publish"}).`,
    );

    const publishArgs = ["publish", "--access", "public"];
    if (dryRun) {
        publishArgs.push("--dry-run");
    }

    console.log(`npm ${publishArgs.join(" ")}`);
    if (dryRun) {
        runNpmPublish(publishArgs, npmPublishEnv(process.env.NPM_TOKEN || "dry-run"));
        return;
    }

    const token = requiredEnv("NPM_TOKEN");
    runNpmPublish(publishArgs, npmPublishEnv(token));

    console.log(`Published ${packageName}@${packageVersion} to npm.`);
    console.log(`Install: npm install -g ${packageName}`);
}

main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
