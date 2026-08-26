"use strict";

/**
 * Upload halo-agent release artifacts from artifacts/ to Cloudflare R2 staging/.
 *
 * Required env: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
 * Optional: R2_BUCKET (defaults to halo-agent-releases)
 *
 * Usage:
 *   node scripts/release/upload-r2-release.js [--dry-run]
 *
 * Production promotion: https://www.halosoftworks.com/admin/releases
 */

require("./load-release-env.cjs").loadReleaseEnv();

const fs = require("fs");
const path = require("path");
const {
    S3Client,
    PutObjectCommand,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    CopyObjectCommand,
} = require("@aws-sdk/client-s3");
const {
    DEFAULT_R2_BUCKET,
    STAGING_RETAIN_COUNT,
    listReleaseArtifactNames,
    contentTypeForReleaseArtifact,
    cacheControlForReleaseArtifact,
    objectKeyForReleaseArtifact,
    selectStagingKeysToArchive,
} = require("./release-publish.cjs");

const repoRoot = path.join(__dirname, "..", "..");
const artifactsDir = path.join(repoRoot, "artifacts");
const dryRun = process.argv.includes("--dry-run");

function requiredEnv(name) {
    const value = String(process.env[name] || "").trim();
    if (!value) {
        throw new Error(`Missing ${name}. Set R2 credentials for release upload.`);
    }
    return value;
}

function createR2Client() {
    const accountId = requiredEnv("R2_ACCOUNT_ID");
    return new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
            secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
        },
    });
}

/**
 * @param {import("@aws-sdk/client-s3").S3Client} client
 * @param {string} bucket
 * @param {string} prefix
 */
async function listAllObjects(client, bucket, prefix) {
    /** @type {Array<{ Key: string, LastModified?: Date }>} */
    const entries = [];
    let token;
    do {
        const page = await client.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: token,
            }),
        );
        for (const obj of page.Contents || []) {
            if (obj.Key) {
                entries.push({ Key: obj.Key, LastModified: obj.LastModified });
            }
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return entries;
}

function copySourceForKey(bucket, key) {
    return `${bucket}/${String(key).split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * @param {import("@aws-sdk/client-s3").S3Client | null} client
 * @param {string} bucket
 */
async function archiveOldStagingArtifacts(client, bucket) {
    if (dryRun || !client) {
        console.log(
            `[dry-run] Would archive staging/ to ${STAGING_RETAIN_COUNT} versions (overflow → archive/staging/)`,
        );
        return;
    }

    const listed = await listAllObjects(client, bucket, "staging/");
    const moves = selectStagingKeysToArchive(listed, { retainCount: STAGING_RETAIN_COUNT });
    if (moves.length === 0) {
        console.log(`Staging retention: nothing to archive (keeping up to ${STAGING_RETAIN_COUNT} versions)`);
        return;
    }

    for (const { sourceKey, destKey } of moves) {
        await client.send(
            new CopyObjectCommand({
                Bucket: bucket,
                CopySource: copySourceForKey(bucket, sourceKey),
                Key: destKey,
            }),
        );
    }

    const toDelete = moves.map((m) => m.sourceKey);
    for (let i = 0; i < toDelete.length; i += 1000) {
        const chunk = toDelete.slice(i, i + 1000);
        await client.send(
            new DeleteObjectsCommand({
                Bucket: bucket,
                Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
            }),
        );
    }

    console.log(
        `Staging retention: archived ${moves.length} object(s) → archive/staging/; `
            + `kept up to ${STAGING_RETAIN_COUNT} newest versions under staging/`,
    );
}

async function uploadArtifacts() {
    const artifacts = listReleaseArtifactNames(artifactsDir);
    if (!artifacts.includes("latest.yml")) {
        throw new Error("artifacts/latest.yml is missing. Run stage-release-artifacts first.");
    }
    if (!artifacts.some((name) => name.endsWith(".zip"))) {
        throw new Error("artifacts/ is missing the .zip required for upload.");
    }

    const bucket = String(process.env.R2_BUCKET || "").trim() || DEFAULT_R2_BUCKET;
    const client = dryRun ? null : createR2Client();

    console.log(`Uploading ${artifacts.length} release file(s) to R2 bucket "${bucket}" (staging/)`);

    for (const name of artifacts) {
        const filePath = path.join(artifactsDir, name);
        const body = fs.readFileSync(filePath);
        const key = objectKeyForReleaseArtifact(name, "staging");

        if (dryRun) {
            console.log(`[dry-run] PUT s3://${bucket}/${key} (${body.length} bytes)`);
            continue;
        }

        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: body,
                ContentType: contentTypeForReleaseArtifact(name),
                CacheControl: cacheControlForReleaseArtifact(name),
            }),
        );
        console.log(`Uploaded ${key} (${body.length} bytes)`);
    }

    await archiveOldStagingArtifacts(client, bucket);
    console.log("Update feed: https://halo-agent-releases.halosoftworks.com/staging/latest.yml");
    console.log("Promote to production at: https://www.halosoftworks.com/admin/releases");
}

uploadArtifacts().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
});
