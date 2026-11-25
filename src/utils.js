const fs = require("fs");
const path = require("path");
const config = require("./config");
const { validatePublicHttpUrl } = require("./ssrf");

const DOWNLOADS_DIR = config.BASE_DOWNLOADS_DIR;

function ensureDirSync(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function validateHttpUrl(rawUrl, options = {}) {
    return validatePublicHttpUrl(rawUrl, options);
}

function sanitizeFilename(name, fallback = "download") {
    if (!name || typeof name !== "string") return fallback;
    const cleaned = name
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/[<>:"/\\|?*]+/g, "_")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/^\.+/, "");

    if (!cleaned) return fallback;
    if (cleaned.length <= 180) return cleaned;

    const ext = path.extname(cleaned);
    const base = path.basename(cleaned, ext).slice(0, Math.max(1, 180 - ext.length));
    return `${base}${ext}`;
}

function parseContentDisposition(headerValue) {
    if (!headerValue || typeof headerValue !== "string") return null;

    const utf8Match = headerValue.match(/filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;\r\n]+)/i);
    if (utf8Match && utf8Match[1]) {
        try {
            return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ""));
        } catch {
            // Fall through to standard filename parameter
        }
    }

    const asciiMatch = headerValue.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;\r\n]+)/i);
    if (asciiMatch) {
        const raw = (asciiMatch[1] || asciiMatch[2] || "").trim().replace(/^["']|["']$/g, "");
        if (raw) return raw;
    }
    return null;
}

function ensureUniquePath(dirPath, filename) {
    ensureDirSync(dirPath);
    const safe = sanitizeFilename(filename);
    const ext = path.extname(safe);
    const base = path.basename(safe, ext);
    let candidate = path.join(dirPath, safe);
    let counter = 1;

    while (fs.existsSync(candidate)) {
        candidate = path.join(dirPath, `${base} (${counter})${ext}`);
        counter += 1;
    }
    return candidate;
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return null;
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, idx);
    return `${value.toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

module.exports = {
    DOWNLOADS_DIR,
    ensureDirSync,
    validateHttpUrl,
    sanitizeFilename,
    parseContentDisposition,
    ensureUniquePath,
    formatBytes,
};
