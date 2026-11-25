const path = require("path");
const { execFile } = require("child_process");
const mime = require("mime-types");
const config = require("./config");
const { resolveYtDlpPath, resolveGalleryDlPath } = require("./binaries");
const { assertSafePublicUrl, safeFetch, validatePublicHttpUrl } = require("./ssrf");
const { sanitizeFilename, parseContentDisposition } = require("./utils");

const DEFAULT_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const KNOWN_MEDIA_HOSTS = [
    "youtube.com",
    "youtu.be",
    "music.youtube.com",
    "instagram.com",
    "instagr.am",
    "twitter.com",
    "x.com",
    "tiktok.com",
    "vm.tiktok.com",
    "vimeo.com",
    "reddit.com",
    "v.redd.it",
    "i.redd.it",
    "twitch.tv",
    "clips.twitch.tv",
    "facebook.com",
    "fb.watch",
    "soundcloud.com",
    "dailymotion.com",
    "pinterest.com",
    "pin.it",
    "threads.net",
    "bilibili.com",
    "streamable.com",
    "imgur.com",
    "flickr.com",
    "deviantart.com",
    "tumblr.com",
];

const ALLOWED_CONTENT_TYPES = new Set([
    "auto",
    "video",
    "image",
    "audio",
    "document",
    "webpage",
]);

function normalizeContentType(value) {
    const normalized = String(value || "auto").trim().toLowerCase();
    return ALLOWED_CONTENT_TYPES.has(normalized) ? normalized : "auto";
}

function isKnownMediaHost(urlStr) {
    try {
        const hostname = new URL(urlStr).hostname.toLowerCase();
        return KNOWN_MEDIA_HOSTS.some(
            (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
        );
    } catch {
        return false;
    }
}

function classifyMime(mimeType) {
    if (!mimeType) return "file";
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("video/")) return "video";
    if (mimeType.startsWith("audio/")) return "audio";
    if (
        mimeType.includes("zip") ||
        mimeType.includes("tar") ||
        mimeType.includes("gzip") ||
        mimeType.includes("7z") ||
        mimeType.includes("rar")
    ) {
        return "archive";
    }
    if (
        mimeType === "application/pdf" ||
        mimeType.includes("document") ||
        mimeType.includes("spreadsheet") ||
        mimeType.includes("presentation") ||
        mimeType.startsWith("text/")
    ) {
        return "document";
    }
    return "file";
}

function deriveFilenameFromUrl(urlStr, mimeType) {
    const parsed = new URL(urlStr);
    const rawSegment = decodeURIComponent(path.basename(parsed.pathname) || "");
    const extFromMime = mimeType ? mime.extension(mimeType) : null;

    if (rawSegment && rawSegment !== "/") {
        const hasExt = Boolean(path.extname(rawSegment));
        if (!hasExt && extFromMime) {
            return sanitizeFilename(`${rawSegment}.${extFromMime}`);
        }
        return sanitizeFilename(rawSegment);
    }

    const host = parsed.hostname.replace(/^www\./, "");
    return sanitizeFilename(extFromMime ? `${host}.${extFromMime}` : `${host}.bin`);
}

function formatExtractorError(rawMessage) {
    const msg = String(rawMessage || "").trim();
    if (!msg) return "Unable to extract media from this link.";

    if (/confirm you.?re not a bot/i.test(msg)) {
        return config.PUBLIC_HOSTED_MODE
            ? "YouTube triggered an anti-bot verification check on this public cloud server. Public guest mode does not bypass YouTube's bot gate; try another source or run the app locally."
            : "YouTube triggered an anti-bot check. In local mode, select your local browser under Browser Cookies and try again.";
    }
    if (/sign in|login required|authentication|cookies|private|followers only|age-restricted/i.test(msg)) {
        return config.PUBLIC_HOSTED_MODE
            ? "This content requires login, is private, or is age-restricted. Public guest mode only supports publicly accessible links."
            : "This content requires login or is age-restricted. In local mode, select your local browser under Browser Cookies and try again.";
    }
    if (/429|too many requests|rate.?limit/i.test(msg)) {
        return "The source platform temporarily rate-limited requests. Please try again later.";
    }
    if (/video unavailable|not available in your country|geo.?restricted|has been removed|404|not found/i.test(msg)) {
        return "This content is unavailable, deleted, or region-restricted on the source platform.";
    }
    if (/unsupported url/i.test(msg)) {
        return "This URL is not supported by the media extractor. Try clicking \"Inspect Link\" to scan for direct files or images on the page.";
    }
    if (/file is larger than max-filesize|max.?filesize/i.test(msg)) {
        return `File exceeds the maximum allowed size (${Math.round(config.MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB).`;
    }
    if (/timed out|etimedout|aborted/i.test(msg)) {
        return "The source server timed out while responding. Please try again.";
    }

    // Strip internal file paths if any leaked in stderr
    return msg.replace(/\/[^\s:]+\//g, "").slice(0, 280);
}

function validateCookieOptions({ cookiesBrowser, cookiesTxt } = {}) {
    if (cookiesTxt && String(cookiesTxt).trim()) {
        throw new Error("Visitor cookie uploads are disabled in this deployment.");
    }
    if (cookiesBrowser && config.PUBLIC_HOSTED_MODE) {
        throw new Error("Browser cookie extraction is only available in local development mode.");
    }
}

function buildCookieArgs(cookiesBrowser) {
    if (config.PUBLIC_HOSTED_MODE) {
        return [];
    }
    const allowed = new Set(["chrome", "safari", "firefox", "edge", "brave", "chromium"]);
    if (cookiesBrowser && allowed.has(String(cookiesBrowser).toLowerCase())) {
        return ["--cookies-from-browser", String(cookiesBrowser).toLowerCase()];
    }
    return [];
}

function getYtDlpBaseArgs() {
    return ["--js-runtimes", `node:${process.execPath}`];
}

async function resolveShareRedirect(urlStr) {
    try {
        const parsed = new URL(urlStr);
        if (/reddit\.com$/i.test(parsed.hostname) && /\/s\//.test(parsed.pathname)) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 8000);
            try {
                const { finalUrl } = await safeFetch(urlStr, {
                    method: "HEAD",
                    headers: DEFAULT_HEADERS,
                    signal: controller.signal,
                });
                if (finalUrl && !/\/s\//.test(new URL(finalUrl).pathname)) {
                    return finalUrl;
                }
            } finally {
                clearTimeout(timer);
            }
        }
    } catch {
        // Keep original URL on failure
    }
    return urlStr;
}

async function probeDirectHttp(urlStr) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);

    try {
        let { res, finalUrl } = await safeFetch(urlStr, {
            method: "HEAD",
            headers: DEFAULT_HEADERS,
            signal: controller.signal,
        });

        if (res.status === 400 || res.status === 403 || res.status === 405 || res.status === 501) {
            const retry = await safeFetch(urlStr, {
                method: "GET",
                headers: { ...DEFAULT_HEADERS, Range: "bytes=0-1023" },
                signal: controller.signal,
            });
            res = retry.res;
            finalUrl = retry.finalUrl;
            try {
                await res.body?.cancel();
            } catch {
                // Ignore cancel errors
            }
        }

        const contentTypeRaw = res.headers.get("content-type") || "";
        const mimeType = contentTypeRaw.split(";")[0].trim().toLowerCase();
        const contentDisposition = res.headers.get("content-disposition") || "";
        const contentLengthHeader = res.headers.get("content-length");
        const contentRangeHeader = res.headers.get("content-range");

        let fileSize = null;
        if (contentRangeHeader) {
            const match = contentRangeHeader.match(/\/(\d+)$/);
            if (match) fileSize = Number(match[1]);
        }
        if (fileSize === null && contentLengthHeader && /^\d+$/.test(contentLengthHeader)) {
            fileSize = Number(contentLengthHeader);
        }

        const isAttachment = /\battachment\b/i.test(contentDisposition);
        const isHtml =
            mimeType === "text/html" || mimeType === "application/xhtml+xml" || mimeType === "";

        const dispositionName = parseContentDisposition(contentDisposition);
        const resolvedUrl = finalUrl || urlStr;
        const filename = sanitizeFilename(
            dispositionName || deriveFilenameFromUrl(resolvedUrl, mimeType)
        );

        return {
            ok: res.ok,
            status: res.status,
            finalUrl: resolvedUrl,
            mimeType: mimeType || "application/octet-stream",
            category: classifyMime(mimeType),
            fileSize,
            filename,
            isDirectFile: res.ok && (!isHtml || isAttachment),
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}

function runYtDlpJson(urlStr, { cookiesBrowser } = {}) {
    const ytdlpPath = resolveYtDlpPath();
    if (!ytdlpPath) {
        return Promise.reject(new Error("Media extractor (yt-dlp) is not available."));
    }

    const args = [
        ...getYtDlpBaseArgs(),
        "--dump-single-json",
        "--no-warnings",
        "--no-playlist",
        "--skip-download",
        "--socket-timeout",
        "20",
        ...buildCookieArgs(cookiesBrowser),
        urlStr,
    ];

    return new Promise((resolve, reject) => {
        execFile(
            ytdlpPath,
            args,
            { maxBuffer: 25 * 1024 * 1024, timeout: 45000 },
            (err, stdout, stderr) => {
                if (err) {
                    const message = (stderr || err.message || "yt-dlp failed").trim();
                    return reject(new Error(formatExtractorError(message)));
                }
                try {
                    const parsed = JSON.parse(stdout);
                    resolve(parsed);
                } catch {
                    reject(new Error("Failed to parse media metadata from this link."));
                }
            }
        );
    });
}

function runGalleryDlJson(urlStr, { cookiesBrowser } = {}) {
    const galleryDlPath = resolveGalleryDlPath();
    if (!galleryDlPath) {
        return Promise.reject(new Error("Gallery extractor (gallery-dl) is not available."));
    }

    const args = [
        "--dump-json",
        "--range",
        "1-30",
        ...buildCookieArgs(cookiesBrowser),
        urlStr,
    ];

    return new Promise((resolve, reject) => {
        execFile(
            galleryDlPath,
            args,
            { maxBuffer: 25 * 1024 * 1024, timeout: 45000 },
            (err, stdout, stderr) => {
                if (err) {
                    const message = (stderr || err.message || "gallery-dl failed").trim();
                    return reject(new Error(formatExtractorError(message)));
                }
                try {
                    const entries = JSON.parse(stdout);
                    if (!Array.isArray(entries)) {
                        return reject(new Error("Unexpected gallery extractor response."));
                    }
                    const items = [];
                    let meta = {};
                    for (const entry of entries) {
                        if (!Array.isArray(entry)) continue;
                        if (entry[0] === 2 && entry[1] && typeof entry[1] === "object") {
                            meta = { ...meta, ...entry[1] };
                        } else if (entry[0] === 3 && typeof entry[1] === "string") {
                            try {
                                validatePublicHttpUrl(entry[1], {
                                    allowPrivateForTests:
                                        process.env.NODE_ENV === "test" &&
                                        process.env.ALLOW_TEST_LOCALHOST === "1",
                                });
                            } catch {
                                continue;
                            }
                            const itemMeta = entry[2] && typeof entry[2] === "object" ? entry[2] : {};
                            const ext =
                                itemMeta.extension ||
                                path.extname(new URL(entry[1]).pathname).replace(".", "") ||
                                "jpg";
                            const base = itemMeta.filename || itemMeta.id || `item_${items.length + 1}`;
                            items.push({
                                url: entry[1],
                                filename: sanitizeFilename(`${base}.${ext}`),
                                ext: ext.toLowerCase(),
                                width: itemMeta.width || null,
                                height: itemMeta.height || null,
                                category: /^(mp4|webm|mov|m4v)$/i.test(ext) ? "video" : "image",
                            });
                        }
                    }
                    if (items.length === 0) {
                        return reject(new Error("No downloadable media items found at this link."));
                    }
                    resolve({ meta, items });
                } catch {
                    reject(new Error("Failed to parse gallery metadata from this link."));
                }
            }
        );
    });
}

function summarizeMediaFormats(info) {
    const formats = Array.isArray(info.formats) ? info.formats : [];
    const videoHeights = new Set();
    const detailedFormats = [];

    for (const fmt of formats) {
        if (fmt.vcodec && fmt.vcodec !== "none" && Number.isFinite(fmt.height)) {
            const shortSide =
                Number.isFinite(fmt.width) && fmt.width > 0
                    ? Math.min(fmt.width, fmt.height)
                    : fmt.height;
            videoHeights.add(shortSide);
        }
    }

    const sortedHeights = Array.from(videoHeights).sort((a, b) => b - a);
    const maxHeight = sortedHeights[0] || null;

    const presets = [];
    if (maxHeight && maxHeight >= 2160) {
        presets.push({
            id: "4k",
            label: `4K Ultra HD (${maxHeight}p)`,
            badge: "4K",
            height: maxHeight,
        });
    } else {
        presets.push({
            id: "max",
            label: maxHeight ? `Best Available (${maxHeight}p)` : "Best Available Video",
            badge: maxHeight >= 2160 ? "4K" : maxHeight >= 1080 ? "FHD" : "BEST",
            height: maxHeight,
        });
    }

    if (maxHeight && maxHeight >= 1440) {
        presets.push({ id: "1440p", label: "2K QHD (1440p)", badge: "2K", height: 1440 });
    }
    if (!maxHeight || maxHeight >= 1080) {
        presets.push({ id: "1080p", label: "Full HD (1080p)", badge: "1080p", height: 1080 });
    }
    if (!maxHeight || maxHeight >= 720) {
        presets.push({ id: "720p", label: "HD (720p)", badge: "720p", height: 720 });
    }
    presets.push({ id: "audio", label: "Audio Only (MP3)", badge: "MP3", height: null });

    const seenRes = new Set();
    for (const h of sortedHeights) {
        if (seenRes.has(h)) continue;
        seenRes.add(h);
        const matching = formats.filter((f) => {
            if (!f.vcodec || f.vcodec === "none" || !Number.isFinite(f.height)) return false;
            const shortSide =
                Number.isFinite(f.width) && f.width > 0 ? Math.min(f.width, f.height) : f.height;
            return shortSide === h;
        });
        const bestMatch = matching.sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
        if (bestMatch) {
            detailedFormats.push({
                height: h,
                fps: bestMatch.fps || null,
                vcodec: bestMatch.vcodec,
                ext: bestMatch.ext,
                filesize: bestMatch.filesize || bestMatch.filesize_approx || null,
            });
        }
    }

    return {
        maxHeight,
        availableHeights: sortedHeights,
        has4K: Boolean(maxHeight && maxHeight >= 2160),
        has1080p: Boolean(maxHeight && maxHeight >= 1080),
        presets,
        detailedFormats,
    };
}

function pickBestSrcsetCandidate(srcsetValue, baseUrl) {
    if (!srcsetValue) return null;
    const parts = srcsetValue.split(",").map((s) => s.trim()).filter(Boolean);
    let bestUrl = null;
    let bestScore = -1;

    for (const part of parts) {
        const tokens = part.split(/\s+/);
        const candidateUrl = tokens[0];
        const descriptor = tokens[1] || "";
        const num = parseFloat(descriptor) || 1;
        const score = descriptor.endsWith("w") ? num : num * 1000;
        if (score >= bestScore) {
            try {
                bestUrl = new URL(candidateUrl, baseUrl).toString();
                bestScore = score;
            } catch {
                // Ignore invalid URL
            }
        }
    }
    return bestUrl;
}

async function extractWebpageAssets(urlStr) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
        const { res, finalUrl } = await safeFetch(urlStr, {
            method: "GET",
            headers: DEFAULT_HEADERS,
            signal: controller.signal,
        });
        if (!res.ok) return { title: null, assets: [] };
        const html = (await res.text()).slice(0, 1024 * 1024);
        const base = finalUrl || urlStr;
        const found = new Map();

        const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        const pageTitle = titleMatch ? titleMatch[1].trim() : null;

        const addAsset = (rawUrl, category = "file", explicitExt = null) => {
            if (
                !rawUrl ||
                rawUrl.startsWith("data:") ||
                rawUrl.startsWith("javascript:") ||
                rawUrl.startsWith("#")
            ) {
                return;
            }
            try {
                const resolved = validatePublicHttpUrl(new URL(rawUrl, base).toString(), {
                    allowPrivateForTests:
                        process.env.NODE_ENV === "test" &&
                        process.env.ALLOW_TEST_LOCALHOST === "1",
                });
                if (found.has(resolved) || found.size >= 40) return;
                const urlExt = path.extname(new URL(resolved).pathname).replace(".", "").toLowerCase();
                const ext =
                    explicitExt ||
                    urlExt ||
                    (category === "image" ? "img" : category === "video" ? "mp4" : "file");
                found.set(resolved, {
                    url: resolved,
                    filename: deriveFilenameFromUrl(
                        resolved,
                        category === "image" && !urlExt ? "image/jpeg" : null
                    ),
                    ext,
                    category,
                });
            } catch {
                // Ignore invalid or private URLs
            }
        };

        const metaRegex =
            /<meta\b[^>]*?(?:property|name)\s*=\s*["'](og:image(?::secure_url)?|twitter:image(?::src)?|og:video(?::url|:secure_url)?)["'][^>]*?content\s*=\s*["']([^"']+)["'][^>]*>/gi;
        const metaRegexRev =
            /<meta\b[^>]*?content\s*=\s*["']([^"']+)["'][^>]*?(?:property|name)\s*=\s*["'](og:image(?::secure_url)?|twitter:image(?::src)?|og:video(?::url|:secure_url)?)["'][^>]*>/gi;

        let match;
        while ((match = metaRegex.exec(html)) !== null) {
            const key = match[1].toLowerCase();
            addAsset(match[2].trim(), key.includes("video") ? "video" : "image");
        }
        while ((match = metaRegexRev.exec(html)) !== null) {
            const key = match[2].toLowerCase();
            addAsset(match[1].trim(), key.includes("video") ? "video" : "image");
        }

        const srcsetRegex = /\bsrcset\s*=\s*["']([^"']+)["']/gi;
        while ((match = srcsetRegex.exec(html)) !== null) {
            const best = pickBestSrcsetCandidate(match[1], base);
            if (best) addAsset(best, "image");
        }

        const imgTagRegex = /<img\b[^>]*?\b(?:src|data-src)\s*=\s*["']([^"']+)["'][^>]*>/gi;
        while ((match = imgTagRegex.exec(html)) !== null) {
            addAsset(match[1].trim(), "image");
        }

        const mediaTagRegex = /<(?:video|audio|source)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
        while ((match = mediaTagRegex.exec(html)) !== null) {
            addAsset(match[1].trim(), "video");
        }

        const attrRegex = /(?:src|href|content)\s*=\s*["']([^"']+)["']/gi;
        const assetExtRegex =
            /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|wav|flac|ogg|aac|png|jpe?g|webp|avif|heic|gif|svg|ico|pdf|docx?|xlsx?|pptx?|txt|csv|json|xml|zip|tar|gz|tgz|bz2|xz|7z|rar|dmg|pkg|exe|msi|apk|ipa|iso|epub|mobi|woff2?|ttf|otf)(\?.*)?$/i;

        while ((match = attrRegex.exec(html)) !== null) {
            const raw = match[1].trim();
            const extMatch = raw.match(assetExtRegex);
            if (extMatch) {
                const ext = extMatch[1].toLowerCase();
                const cat = /^(png|jpe?g|webp|avif|heic|gif|svg|ico)$/.test(ext)
                    ? "image"
                    : /^(mp4|webm|mov|m4v|mkv)$/.test(ext)
                        ? "video"
                        : /^(mp3|m4a|wav|flac|ogg|aac)$/.test(ext)
                            ? "audio"
                            : "file";
                addAsset(raw, cat, ext);
            }
        }

        return { title: pageTitle, assets: Array.from(found.values()) };
    } catch {
        return { title: null, assets: [] };
    } finally {
        clearTimeout(timeout);
    }
}

async function analyzeUrl(rawUrl, options = {}) {
    validateCookieOptions(options);
    const initialUrl = await assertSafePublicUrl(rawUrl);
    const urlStr = await resolveShareRedirect(initialUrl);
    const contentType = normalizeContentType(options.contentType);

    if (contentType === "webpage") {
        const { title: pageTitle, assets } = await extractWebpageAssets(urlStr);
        return {
            kind: "webpage",
            url: urlStr,
            title: pageTitle || new URL(urlStr).hostname,
            platform: new URL(urlStr).hostname.replace(/^www\./, ""),
            assets,
            allowHtmlSave: true,
            note:
                assets.length > 0
                    ? "Extracted downloadable images, media, and files from this webpage."
                    : "No embedded assets found; you can save the webpage HTML directly.",
        };
    }

    if (contentType === "document") {
        const probe = await probeDirectHttp(urlStr);
        if (probe && probe.isDirectFile) {
            return {
                kind: "direct",
                url: probe.finalUrl,
                originalUrl: urlStr,
                filename: probe.filename,
                mimeType: probe.mimeType,
                category: probe.category,
                fileSize: probe.fileSize,
                title: probe.filename,
                platform: new URL(probe.finalUrl).hostname.replace(/^www\./, ""),
            };
        }

        const { title: pageTitle, assets } = await extractWebpageAssets(urlStr);
        const docAssets = assets.filter((a) => a.category === "file" || a.category === "audio");
        return {
            kind: "webpage",
            url: urlStr,
            title: pageTitle || new URL(urlStr).hostname,
            platform: new URL(urlStr).hostname.replace(/^www\./, ""),
            assets: docAssets.length > 0 ? docAssets : assets,
            allowHtmlSave: true,
            note:
                docAssets.length > 0
                    ? "Link returned a webpage; detected downloadable documents & files on the page."
                    : "Link returned a webpage rather than a direct file. Pick an asset below or save the HTML.",
        };
    }

    if (contentType === "image") {
        const probe = await probeDirectHttp(urlStr);
        if (probe && probe.isDirectFile) {
            return {
                kind: "direct",
                url: probe.finalUrl,
                originalUrl: urlStr,
                filename: probe.filename,
                mimeType: probe.mimeType,
                category: probe.category,
                fileSize: probe.fileSize,
                title: probe.filename,
                platform: new URL(probe.finalUrl).hostname.replace(/^www\./, ""),
            };
        }

        try {
            const gallery = await runGalleryDlJson(urlStr, options);
            const title =
                gallery.meta.description ||
                gallery.meta.title ||
                gallery.meta.content ||
                `Images from ${new URL(urlStr).hostname.replace(/^www\./, "")}`;
            return {
                kind: "gallery",
                url: urlStr,
                title: String(title).slice(0, 140),
                uploader:
                    gallery.meta.username ||
                    gallery.meta.author?.name ||
                    gallery.meta.user?.name ||
                    null,
                platform: gallery.meta.category || new URL(urlStr).hostname.replace(/^www\./, ""),
                itemCount: gallery.items.length,
                items: gallery.items,
            };
        } catch (galErr) {
            const { title: pageTitle, assets } = await extractWebpageAssets(urlStr);
            const imgAssets = assets.filter((a) => a.category === "image");
            if (imgAssets.length > 0) {
                return {
                    kind: "webpage",
                    url: urlStr,
                    title: pageTitle || new URL(urlStr).hostname,
                    platform: new URL(urlStr).hostname.replace(/^www\./, ""),
                    assets: imgAssets,
                    allowHtmlSave: false,
                    note: `Found ${imgAssets.length} image(s) on this page.`,
                };
            }
            throw new Error(galErr.message || "No downloadable images found at this link.");
        }
    }

    if (contentType !== "video" && !isKnownMediaHost(urlStr)) {
        const probe = await probeDirectHttp(urlStr);
        if (probe && probe.isDirectFile) {
            return {
                kind: "direct",
                url: probe.finalUrl,
                originalUrl: urlStr,
                filename: probe.filename,
                mimeType: probe.mimeType,
                category: probe.category,
                fileSize: probe.fileSize,
                title: probe.filename,
                platform: new URL(probe.finalUrl).hostname.replace(/^www\./, ""),
            };
        }
    }

    let ytErrMessage = null;
    try {
        const info = await runYtDlpJson(urlStr, options);
        const isCarousel = info._type === "playlist" && Array.isArray(info.entries);
        const primaryEntry = isCarousel ? info.entries[0] || info : info;
        const summary = summarizeMediaFormats(primaryEntry);

        if (contentType === "audio") {
            summary.presets = summary.presets.filter((p) => p.id === "audio");
        }

        return {
            kind: "media",
            url: urlStr,
            title: info.title || primaryEntry.title || "Media Download",
            uploader: info.uploader || info.channel || primaryEntry.uploader || null,
            duration: info.duration || primaryEntry.duration || null,
            thumbnail: info.thumbnail || primaryEntry.thumbnail || null,
            platform: info.extractor_key || info.extractor || "Media",
            isCarousel,
            entryCount: isCarousel ? info.entries.length : 1,
            ...summary,
        };
    } catch (ytErr) {
        ytErrMessage = ytErr.message;
    }

    if (contentType === "video" || contentType === "audio") {
        const probe = await probeDirectHttp(urlStr);
        if (probe && probe.isDirectFile) {
            return {
                kind: "direct",
                url: probe.finalUrl,
                originalUrl: urlStr,
                filename: probe.filename,
                mimeType: probe.mimeType,
                category: probe.category,
                fileSize: probe.fileSize,
                title: probe.filename,
                platform: new URL(probe.finalUrl).hostname.replace(/^www\./, ""),
            };
        }
        throw new Error(ytErrMessage || `Could not extract ${contentType} from this link.`);
    }

    try {
        const gallery = await runGalleryDlJson(urlStr, options);
        const title =
            gallery.meta.description ||
            gallery.meta.title ||
            gallery.meta.content ||
            `Gallery from ${new URL(urlStr).hostname.replace(/^www\./, "")}`;
        return {
            kind: "gallery",
            url: urlStr,
            title: String(title).slice(0, 140),
            uploader:
                gallery.meta.username ||
                gallery.meta.author?.name ||
                gallery.meta.user?.name ||
                null,
            platform: gallery.meta.category || new URL(urlStr).hostname.replace(/^www\./, ""),
            itemCount: gallery.items.length,
            items: gallery.items,
        };
    } catch {
        // Fall through
    }

    const probe = await probeDirectHttp(urlStr);
    if (probe && probe.isDirectFile) {
        return {
            kind: "direct",
            url: probe.finalUrl,
            originalUrl: urlStr,
            filename: probe.filename,
            mimeType: probe.mimeType,
            category: probe.category,
            fileSize: probe.fileSize,
            title: probe.filename,
            platform: new URL(probe.finalUrl).hostname.replace(/^www\./, ""),
        };
    }

    const { title: pageTitle, assets } = await extractWebpageAssets(urlStr);
    return {
        kind: "webpage",
        url: urlStr,
        title: pageTitle || new URL(urlStr).hostname,
        platform: new URL(urlStr).hostname.replace(/^www\./, ""),
        assets,
        allowHtmlSave: true,
        note:
            assets.length > 0
                ? "Detected downloadable images, media, and files on this page."
                : ytErrMessage || "No embedded media matched; you can still save the webpage HTML.",
    };
}

module.exports = {
    analyzeUrl,
    normalizeContentType,
    isKnownMediaHost,
    probeDirectHttp,
    buildCookieArgs,
    validateCookieOptions,
    getYtDlpBaseArgs,
    resolveShareRedirect,
    formatExtractorError,
    DEFAULT_HEADERS,
};
