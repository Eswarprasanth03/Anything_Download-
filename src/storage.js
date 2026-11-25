const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const config = require("./config");
const { isValidGuestId } = require("./guestSession");
const { ensureDirSync, ensureUniquePath } = require("./utils");

const GUESTS_ROOT_DIR = path.join(config.BASE_DOWNLOADS_DIR, "guests");

function getGuestDir(guestId) {
    if (!isValidGuestId(guestId)) {
        throw new Error("Invalid guest session.");
    }
    const dir = path.resolve(GUESTS_ROOT_DIR, guestId);
    if (!dir.startsWith(GUESTS_ROOT_DIR + path.sep)) {
        throw new Error("Invalid guest storage path.");
    }
    ensureDirSync(dir);
    return dir;
}

function getDirSizeBytes(dirPath) {
    if (!fs.existsSync(dirPath)) return 0;
    let total = 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        try {
            if (entry.isDirectory()) {
                total += getDirSizeBytes(full);
            } else if (entry.isFile()) {
                total += fs.statSync(full).size;
            }
        } catch {
            // Ignore race conditions with concurrent cleanup
        }
    }
    return total;
}

function getGuestStorageUsage(guestId) {
    return getDirSizeBytes(getGuestDir(guestId));
}

function getTotalStorageUsage() {
    ensureDirSync(GUESTS_ROOT_DIR);
    return getDirSizeBytes(GUESTS_ROOT_DIR);
}

function assertStorageQuota(guestId, additionalBytes = 0) {
    if (additionalBytes > config.MAX_DOWNLOAD_BYTES) {
        throw new Error(
            `File exceeds the maximum allowed size (${Math.round(config.MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB).`
        );
    }

    const guestUsed = getGuestStorageUsage(guestId);
    if (guestUsed + additionalBytes > config.MAX_GUEST_STORAGE_BYTES) {
        throw new Error(
            "Your temporary guest storage quota is full. Delete old files or wait for automatic cleanup."
        );
    }

    const totalUsed = getTotalStorageUsage();
    if (totalUsed + additionalBytes > config.MAX_TOTAL_STORAGE_BYTES) {
        throw new Error("Server temporary storage is currently full. Please try again shortly.");
    }
}

function listGuestFiles(guestId) {
    const guestDir = getGuestDir(guestId);
    const entries = fs.readdirSync(guestDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".") || entry.name.endsWith(".part")) continue;
        const fullPath = path.join(guestDir, entry.name);
        try {
            const stat = fs.statSync(fullPath);
            files.push({
                name: entry.name,
                size: stat.size,
                mimeType: mime.lookup(entry.name) || "application/octet-stream",
                modifiedAt: stat.mtime.toISOString(),
                expiresAt: new Date(stat.mtimeMs + config.FILE_TTL_MS).toISOString(),
            });
        } catch {
            // Skip files removed concurrently
        }
    }

    return files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function resolveGuestFile(guestId, rawName) {
    const guestDir = getGuestDir(guestId);
    const baseName = path.basename(String(rawName || ""));
    if (!baseName || baseName === "." || baseName === ".." || baseName.startsWith(".")) {
        return null;
    }
    const target = path.resolve(guestDir, baseName);
    if (!target.startsWith(guestDir + path.sep)) {
        return null;
    }
    return target;
}

function deleteGuestFile(guestId, rawName) {
    const target = resolveGuestFile(guestId, rawName);
    if (!target || !fs.existsSync(target)) {
        return false;
    }
    fs.unlinkSync(target);
    return true;
}

function moveIntoGuestStorage(guestId, sourcePath, desiredFilename) {
    const guestDir = getGuestDir(guestId);
    const size = fs.statSync(sourcePath).size;
    assertStorageQuota(guestId, size);
    const destPath = ensureUniquePath(guestDir, desiredFilename);
    fs.renameSync(sourcePath, destPath);
    return {
        filename: path.basename(destPath),
        path: destPath,
        size,
    };
}

function cleanupExpiredStorage({ fileTtlMs = config.FILE_TTL_MS, nowMs = Date.now() } = {}) {
    ensureDirSync(GUESTS_ROOT_DIR);
    let removedFiles = 0;
    let removedDirs = 0;

    const guestDirs = fs.readdirSync(GUESTS_ROOT_DIR, { withFileTypes: true });
    for (const gEntry of guestDirs) {
        const guestPath = path.join(GUESTS_ROOT_DIR, gEntry.name);
        if (!gEntry.isDirectory()) continue;

        const items = fs.readdirSync(guestPath, { withFileTypes: true });
        for (const item of items) {
            const itemPath = path.join(guestPath, item.name);
            try {
                const stat = fs.statSync(itemPath);
                const ageMs = nowMs - stat.mtimeMs;
                if (item.isDirectory() && item.name.startsWith(".staging_") && ageMs > Math.min(fileTtlMs, 30 * 60 * 1000)) {
                    fs.rmSync(itemPath, { recursive: true, force: true });
                    removedDirs += 1;
                } else if (item.isFile() && ageMs > fileTtlMs) {
                    fs.unlinkSync(itemPath);
                    removedFiles += 1;
                }
            } catch {
                // Ignore concurrent deletion
            }
        }

        try {
            const remaining = fs.readdirSync(guestPath);
            if (remaining.length === 0) {
                fs.rmdirSync(guestPath);
                removedDirs += 1;
            }
        } catch {
            // Ignore non-empty or concurrent errors
        }
    }

    return { removedFiles, removedDirs };
}

module.exports = {
    GUESTS_ROOT_DIR,
    getGuestDir,
    getGuestStorageUsage,
    getTotalStorageUsage,
    assertStorageQuota,
    listGuestFiles,
    resolveGuestFile,
    deleteGuestFile,
    moveIntoGuestStorage,
    cleanupExpiredStorage,
};
