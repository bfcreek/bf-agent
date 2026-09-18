"use strict";

const { parseSimpleYaml } = require("./release-publish.cjs");

const DEFAULT_UPDATES_BASE_URL = "https://halo-agent-releases.halosoftworks.com";
const DEFAULT_PACKAGE_NAME = "@bitfieldcreek/bf-agent";

/**
 * @param {string} text
 */
function parseProductionVersionFromLatestYml(text) {
    const parsed = parseSimpleYaml(text);
    const version = String(parsed.version || "").trim();
    if (!version) {
        throw new Error("Production latest.yml is missing a version field.");
    }
    return version;
}

/**
 * @param {string} packageVersion
 * @param {string} productionVersion
 */
function assertProductionVersionMatch(packageVersion, productionVersion) {
    const pkg = String(packageVersion || "").trim();
    const prod = String(productionVersion || "").trim();
    if (!pkg || !prod) {
        throw new Error("package.json version and production CDN version are required.");
    }
    if (pkg !== prod) {
        throw new Error(
            `package.json is v${pkg} but production CDN is v${prod}. `
                + "Promote the matching staging build at https://www.halosoftworks.com/admin/releases "
                + "before publishing to npm.",
        );
    }
}

/**
 * @param {string} packageName
 * @param {string} version
 */
function assertNotAlreadyPublished(packageName, version) {
    const published = String(version || "").trim();
    if (!published) {
        throw new Error("Published npm version is required.");
    }
    throw new Error(
        `${packageName} v${published} is already on npm. `
            + "Bump package.json and run a new staging release before promoting.",
    );
}

/**
 * @param {string} packageName
 * @returns {string}
 */
function npmRegistryPackagePath(packageName) {
    return encodeURIComponent(packageName).replace(/%40/g, "@");
}

/**
 * @param {string} packageName
 * @param {(input: string | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 */
async function fetchNpmLatestVersion(packageName, fetchImpl) {
    const encoded = npmRegistryPackagePath(packageName);
    const response = await fetchImpl(`https://registry.npmjs.org/${encoded}/latest`, {
        headers: { Accept: "application/json" },
    });
    if (response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`npm registry lookup failed (${response.status}) for ${packageName}`);
    }
    const body = await response.json();
    const version = String(body?.version || "").trim();
    return version || null;
}

/**
 * @param {string} updatesBaseUrl
 * @param {(input: string | URL, init?: RequestInit) => Promise<Response>} fetchImpl
 */
async function fetchProductionVersion(updatesBaseUrl, fetchImpl) {
    const base = String(updatesBaseUrl || DEFAULT_UPDATES_BASE_URL).replace(/\/$/, "");
    const response = await fetchImpl(`${base}/latest.yml`, {
        headers: { "User-Agent": "halo-agent-release" },
    });
    if (!response.ok) {
        throw new Error(
            `Could not read production latest.yml (${response.status}) at ${base}/latest.yml. `
                + "Promote staging on halo-site first.",
        );
    }
    return parseProductionVersionFromLatestYml(await response.text());
}

/**
 * @param {{
 *   packageVersion: string,
 *   packageName?: string,
 *   updatesBaseUrl?: string,
 *   fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<Response>,
 * }} options
 */
async function verifyReadyForNpmPublish(options) {
    const packageName = options.packageName || DEFAULT_PACKAGE_NAME;
    const fetchImpl = options.fetchImpl || fetch;
    const packageVersion = String(options.packageVersion || "").trim();
    if (!packageVersion) {
        throw new Error("package.json version is required.");
    }

    const productionVersion = await fetchProductionVersion(
        options.updatesBaseUrl || DEFAULT_UPDATES_BASE_URL,
        fetchImpl,
    );
    assertProductionVersionMatch(packageVersion, productionVersion);

    const npmVersion = await fetchNpmLatestVersion(packageName, fetchImpl);
    if (npmVersion === packageVersion) {
        assertNotAlreadyPublished(packageName, npmVersion);
    }

    return {
        packageName,
        packageVersion,
        productionVersion,
        npmLatestVersion: npmVersion,
    };
}

module.exports = {
    DEFAULT_UPDATES_BASE_URL,
    DEFAULT_PACKAGE_NAME,
    parseProductionVersionFromLatestYml,
    assertProductionVersionMatch,
    npmRegistryPackagePath,
    fetchNpmLatestVersion,
    fetchProductionVersion,
    verifyReadyForNpmPublish,
};
