const crypto = require("crypto");
const path = require("path");

const NODE_ENV = process.env.NODE_ENV || "development";
const IS_PRODUCTION = NODE_ENV === "production";

function parseBool(value, defaultValue) {
    if (value === undefined || value === null || value === "") return defaultValue;
    return String(value).toLowerCase() === "true" || String(value) === "1";
}

function parsePositiveInt(value, defaultValue) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue;
}

const PUBLIC_HOSTED_MODE = parseBool(process.env.PUBLIC_HOSTED_MODE, IS_PRODUCTION);

let sessionSecret = process.env.SESSION_SECRET || "";
if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString("hex");
    if (IS_PRODUCTION) {
        console.warn(
            "[config] SESSION_SECRET is not set; using an ephemeral per-process secret. Set SESSION_SECRET in production for persistent guest sessions across restarts."
        );
    }
}

const BASE_DOWNLOADS_DIR = process.env.DOWNLOADS_DIR
    ? path.resolve(process.env.DOWNLOADS_DIR)
    : path.resolve(__dirname, "..", "downloads");

const CORS_ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

module.exports = {
    NODE_ENV,
    IS_PRODUCTION,
    PUBLIC_HOSTED_MODE,
    PORT: parsePositiveInt(process.env.PORT, 4000),
    BASE_DOWNLOADS_DIR,
    SESSION_SECRET: sessionSecret,
    SESSION_COOKIE_NAME: process.env.SESSION_COOKIE_NAME || "ad_guest",
    SESSION_TTL_MS: parsePositiveInt(process.env.SESSION_TTL_MS, 24 * 60 * 60 * 1000),
    CROSS_SITE_COOKIES: parseBool(process.env.CROSS_SITE_COOKIES, false),
    CORS_ALLOWED_ORIGINS,
    MAX_CONCURRENT_DOWNLOADS: parsePositiveInt(process.env.MAX_CONCURRENT_DOWNLOADS, 3),
    MAX_QUEUE_SIZE: parsePositiveInt(process.env.MAX_QUEUE_SIZE, 20),
    MAX_ACTIVE_PER_GUEST: parsePositiveInt(process.env.MAX_ACTIVE_PER_GUEST, 2),
    GUEST_ANALYZE_RATE_LIMIT: parsePositiveInt(process.env.GUEST_ANALYZE_RATE_LIMIT, 20),
    GUEST_DOWNLOAD_RATE_LIMIT: parsePositiveInt(process.env.GUEST_DOWNLOAD_RATE_LIMIT, 10),
    MAX_DOWNLOAD_BYTES: parsePositiveInt(process.env.MAX_DOWNLOAD_BYTES, 500 * 1024 * 1024),
    MAX_GUEST_STORAGE_BYTES: parsePositiveInt(
        process.env.MAX_GUEST_STORAGE_BYTES,
        1024 * 1024 * 1024
    ),
    MAX_TOTAL_STORAGE_BYTES: parsePositiveInt(
        process.env.MAX_TOTAL_STORAGE_BYTES,
        4 * 1024 * 1024 * 1024
    ),
    JOB_TIMEOUT_MS: parsePositiveInt(process.env.JOB_TIMEOUT_MS, 5 * 60 * 1000),
    FILE_TTL_MS: parsePositiveInt(process.env.FILE_TTL_MS, 60 * 60 * 1000),
    JOB_RETENTION_MS: parsePositiveInt(process.env.JOB_RETENTION_MS, 60 * 60 * 1000),
    CLEANUP_INTERVAL_MS: parsePositiveInt(process.env.CLEANUP_INTERVAL_MS, 5 * 60 * 1000),
};
