const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const config = require("./config");

const ROOT_DIR = path.resolve(__dirname, "..");
const LOCAL_BIN_DIR = path.join(ROOT_DIR, "bin");
const VENV_BIN_DIR = path.join(ROOT_DIR, ".venv", "bin");

function isExecutableFile(filePath) {
    if (!filePath) return false;
    try {
        fs.accessSync(filePath, fs.constants.X_OK);
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function findOnPath(binaryName) {
    try {
        const resolved = execFileSync("which", [binaryName], { encoding: "utf8" }).trim();
        return isExecutableFile(resolved) ? resolved : null;
    } catch {
        return null;
    }
}

function resolveYtDlpPath() {
    const candidates = [
        process.env.YTDLP_PATH,
        path.join(LOCAL_BIN_DIR, "yt-dlp"),
        path.join(LOCAL_BIN_DIR, "yt-dlp_macos"),
        findOnPath("yt-dlp"),
    ];
    return candidates.find(isExecutableFile) || null;
}

function resolveFfmpegPath() {
    let ffmpegStaticPath = null;
    try {
        ffmpegStaticPath = require("ffmpeg-static");
    } catch {
        ffmpegStaticPath = null;
    }

    const candidates = [
        process.env.FFMPEG_PATH,
        ffmpegStaticPath,
        path.join(LOCAL_BIN_DIR, "ffmpeg"),
        findOnPath("ffmpeg"),
    ];
    return candidates.find(isExecutableFile) || null;
}

function resolveGalleryDlPath() {
    const candidates = [
        process.env.GALLERY_DL_PATH,
        path.join(VENV_BIN_DIR, "gallery-dl"),
        path.join(LOCAL_BIN_DIR, "gallery-dl"),
        findOnPath("gallery-dl"),
    ];
    return candidates.find(isExecutableFile) || null;
}

function getBinaryStatus() {
    const ytdlpPath = resolveYtDlpPath();
    const ffmpegPath = resolveFfmpegPath();
    const galleryDlPath = resolveGalleryDlPath();
    const exposePaths = !config.PUBLIC_HOSTED_MODE;

    return {
        ytdlp: {
            available: Boolean(ytdlpPath),
            ...(exposePaths ? { path: ytdlpPath } : {}),
        },
        ffmpeg: {
            available: Boolean(ffmpegPath),
            ...(exposePaths ? { path: ffmpegPath } : {}),
        },
        galleryDl: {
            available: Boolean(galleryDlPath),
            ...(exposePaths ? { path: galleryDlPath } : {}),
        },
        mode: {
            publicHosted: config.PUBLIC_HOSTED_MODE,
            localBrowserCookiesAllowed: !config.PUBLIC_HOSTED_MODE,
        },
        limits: {
            maxDownloadBytes: config.MAX_DOWNLOAD_BYTES,
            maxGuestStorageBytes: config.MAX_GUEST_STORAGE_BYTES,
            maxConcurrentDownloads: config.MAX_CONCURRENT_DOWNLOADS,
            maxQueueSize: config.MAX_QUEUE_SIZE,
            maxActivePerGuest: config.MAX_ACTIVE_PER_GUEST,
            fileTtlMs: config.FILE_TTL_MS,
            jobTimeoutMs: config.JOB_TIMEOUT_MS,
        },
    };
}

module.exports = {
    resolveYtDlpPath,
    resolveFfmpegPath,
    resolveGalleryDlPath,
    getBinaryStatus,
};
