const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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
    return {
        ytdlp: {
            available: Boolean(ytdlpPath),
            path: ytdlpPath,
        },
        ffmpeg: {
            available: Boolean(ffmpegPath),
            path: ffmpegPath,
        },
        galleryDl: {
            available: Boolean(galleryDlPath),
            path: galleryDlPath,
        },
    };
}

module.exports = {
    resolveYtDlpPath,
    resolveFfmpegPath,
    resolveGalleryDlPath,
    getBinaryStatus,
};
