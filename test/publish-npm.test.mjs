import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
    assertProductionVersionMatch,
    npmRegistryPackagePath,
    parseProductionVersionFromLatestYml,
    verifyReadyForNpmPublish,
} = require("../scripts/release/publish-npm-logic.cjs");

test("parseProductionVersionFromLatestYml reads version", () => {
    const version = parseProductionVersionFromLatestYml([
        "version: 0.1.0",
        "path: bf-agent-0.1.0.zip",
    ].join("\n"));
    assert.equal(version, "0.1.0");
});

test("assertProductionVersionMatch requires package and CDN alignment", () => {
    assert.doesNotThrow(() => assertProductionVersionMatch("0.1.0", "0.1.0"));
    assert.throws(
        () => assertProductionVersionMatch("0.1.1", "0.1.0"),
        /production CDN is v0\.1\.0/,
    );
});

test("npmRegistryPackagePath encodes scoped package names", () => {
    assert.equal(npmRegistryPackagePath("@bitfieldcreek/bf-agent"), "@bitfieldcreek%2Fbf-agent");
});

test("verifyReadyForNpmPublish checks CDN and npm registry", async () => {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(String(url));
        if (String(url).endsWith("/latest.yml")) {
            return {
                ok: true,
                async text() {
                    return "version: 0.2.0\npath: bf-agent-0.2.0.zip\n";
                },
            };
        }
        if (String(url).includes("registry.npmjs.org")) {
            return {
                ok: true,
                status: 200,
                async json() {
                    return { version: "0.1.0" };
                },
            };
        }
        throw new Error(`unexpected fetch: ${url}`);
    };

    const status = await verifyReadyForNpmPublish({
        packageName: "@bitfieldcreek/bf-agent",
        packageVersion: "0.2.0",
        fetchImpl,
    });

    assert.equal(status.productionVersion, "0.2.0");
    assert.equal(status.npmLatestVersion, "0.1.0");
    assert.equal(calls.length, 2);
});

test("verifyReadyForNpmPublish rejects when npm already has this version", async () => {
    const fetchImpl = async (url) => {
        if (String(url).endsWith("/latest.yml")) {
            return {
                ok: true,
                async text() {
                    return "version: 0.2.0\n";
                },
            };
        }
        return {
            ok: true,
            status: 200,
            async json() {
                return { version: "0.2.0" };
            },
        };
    };

    await assert.rejects(
        () => verifyReadyForNpmPublish({
            packageName: "@bitfieldcreek/bf-agent",
            packageVersion: "0.2.0",
            fetchImpl,
        }),
        /already on npm/,
    );
});
