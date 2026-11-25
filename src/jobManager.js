const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { Readable } = require("stream");

const { resolveYtDlpPath, resolveFfmpegPath, resolveGalleryDlPath } = require("./binaries");
const {
    normalizeContentType,
    isKnownMediaHost,
    probeDirectHttp,
    buildCookieArgs,
    withCookieFile,
    getYtDlpBaseArgs,
    resolveShareRedirect,
    DEFAULT_HEADERS,
} = require("./analyzer");
const {
    DOWNLOADS_DIR,
    ensureDirSync,
    validateHttpUrl,
    sanitizeFilename,
    ensureUniquePath,
    parseContentDisposition,
} = require("./utils");

class JobManager extends EventEmitter {
    constructor() {
        super();
        ensureDirSync(DOWNLOADS_DIR);
        this.jobs = new Map();
        this.controllers = new Map();
    }

    listJobs() {
        return Array.from(this.jobs.values()).sort(
            (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
        );
    }

    getJob(id) {
        return this.jobs.get(id) || null;
    }

    updateJob(id, patch) {
        const job = this.jobs.get(id);
        if (!job) return null;
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
        this.emit("job", { ...job });
        return job;
    }

    cancelJob(id) {
        const ctrl = this.controllers.get(id);
        const job = this.jobs.get(id);
        if (!job) return false;
        if (ctrl) {
            ctrl.abort();
            this.controllers.delete(id);
        }
        if (
            job.status === "queued" ||
            job.status === "analyzing" ||
            job.status === "downloading" ||
            job.status === "merging"
        ) {
            this.updateJob(id, {
                status: "cancelled",
                message: "Download cancelled by user",
            });
        }
        return true;
    }

    async startDownload({
        url,
        quality = "4k",
        container = "mp4",
        cookiesBrowser = "",
        cookiesTxt = "",
        customFilename = "",
        forceDirect = false,
        contentType = "auto",
    }) {
        const cleanUrl = validateHttpUrl(url);
        const normalizedType = normalizeContentType(contentType);
        const id = crypto.randomUUID().slice(0, 12);
        const now = new Date().toISOString();

        const job = {
            id,
            url: cleanUrl,
            contentType: normalizedType,
            quality: normalizedType === "audio" ? "audio" : quality,
            container,
            status: "analyzing",
            mode: null,
            progress: 0,
            downloadedBytes: 0,
            totalBytes: null,
            speed: null,
            eta: null,
            filename: null,
            files: [],
            title: cleanUrl,
            resolution: null,
            message: "Inspecting link...",
            error: null,
            createdAt: now,
            updatedAt: now,
        };

        this.jobs.set(id, job);
        this.emit("job", { ...job });

        withCookieFile(cookiesTxt, (tempCookieFilePath) =>
            this._executeJob(id, {
                url: cleanUrl,
                quality: job.quality,
                container,
                cookiesBrowser,
                tempCookieFilePath,
                customFilename,
                forceDirect,
                contentType: normalizedType,
            })
        ).catch((err) => {
            const current = this.jobs.get(id);
            if (current && current.status !== "cancelled") {
                this.updateJob(id, {
                    status: "error",
                    error: err.message || "Download failed",
                    message: err.message || "Download failed",
                });
            }
        });

        return { ...job };
    }

    async _executeJob(id, opts) {
        const { forceDirect, contentType } = opts;
        const url = await resolveShareRedirect(opts.url);
        const resolvedOpts = { ...opts, url };

        // 1. Direct file download when forced, when user selected "webpage" (Save HTML), or when user selected "document"
        if (forceDirect || contentType === "webpage") {
            const probe = await probeDirectHttp(url);
            this.updateJob(id, {
                mode: "direct",
                status: "downloading",
                title: probe?.filename || url,
                totalBytes: probe?.fileSize || null,
                message: `Downloading ${probe?.mimeType || "file"}...`,
            });
            await this._downloadDirect(id, probe?.finalUrl || url, probe, resolvedOpts.customFilename);
            return;
        }

        if (contentType === "document") {
            const probe = await probeDirectHttp(url);
            if (!probe || !probe.ok) {
                throw new Error("Could not reach this file link.");
            }
            if (!probe.isDirectFile) {
                throw new Error(
                    "This link points to an HTML webpage rather than a direct file. Click \"Inspect Link\" to view files on the page."
                );
            }
            this.updateJob(id, {
                mode: "direct",
                status: "downloading",
                title: probe.filename,
                totalBytes: probe.fileSize,
                message: `Downloading ${probe.category} (${probe.mimeType})...`,
            });
            await this._downloadDirect(id, probe.finalUrl || url, probe, resolvedOpts.customFilename);
            return;
        }

        // 2. Explicit "image" mode: direct image first -> gallery-dl
        if (contentType === "image") {
            const probe = await probeDirectHttp(url);
            if (probe && probe.isDirectFile) {
                this.updateJob(id, {
                    mode: "direct",
                    status: "downloading",
                    title: probe.filename,
                    totalBytes: probe.fileSize,
                    message: `Downloading ${probe.category} (${probe.mimeType})...`,
                });
                await this._downloadDirect(id, probe.finalUrl || url, probe, resolvedOpts.customFilename);
                return;
            }
            const galleryDlPath = resolveGalleryDlPath();
            if (galleryDlPath) {
                this.updateJob(id, {
                    mode: "gallery",
                    status: "downloading",
                    progress: 10,
                    message: "Extracting image(s) / gallery...",
                });
                await this._downloadWithGalleryDl(id, resolvedOpts, galleryDlPath);
                return;
            }
            throw new Error("No direct image or supported gallery found. Try \"Inspect Link\" to extract images from the page.");
        }

        // 3. Auto / Video / Audio: probe direct files on non-social hosts
        let probe = null;
        if (contentType !== "video" && !isKnownMediaHost(url)) {
            probe = await probeDirectHttp(url);
            if (probe && probe.isDirectFile) {
                this.updateJob(id, {
                    mode: "direct",
                    status: "downloading",
                    title: probe.filename,
                    totalBytes: probe.fileSize,
                    message: `Downloading ${probe.category} (${probe.mimeType})...`,
                });
                await this._downloadDirect(id, probe.finalUrl || url, probe, resolvedOpts.customFilename);
                return;
            }
        }

        // 4. yt-dlp for video/audio links
        let ytErr = null;
        const ytdlpPath = resolveYtDlpPath();
        if (ytdlpPath) {
            this.updateJob(id, {
                mode: contentType === "audio" ? "audio" : "media",
                status: "downloading",
                message: contentType === "audio" ? "Extracting audio stream..." : "Fetching media streams...",
            });
            try {
                await this._downloadWithYtDlp(id, resolvedOpts, ytdlpPath);
                return;
            } catch (err) {
                ytErr = err;
                if (this.getJob(id)?.status === "cancelled") throw err;
                if (contentType === "audio" || contentType === "video") {
                    const directProbe = probe || (await probeDirectHttp(url));
                    if (directProbe && directProbe.isDirectFile) {
                        await this._downloadDirect(
                            id,
                            directProbe.finalUrl || url,
                            directProbe,
                            resolvedOpts.customFilename
                        );
                        return;
                    }
                    throw err;
                }
                // If yt-dlp specifically hit a bot/auth error, do not fall through to gallery-dl and mask the error
                const msg = err.message || "";
                if (/sign in|confirm you.?re not a bot|cookies|login|403|blocked/i.test(msg)) {
                    throw err;
                }
            }
        }

        // 5. Auto fallback: gallery-dl for images/photo posts/carousels
        let galErr = null;
        const galleryDlPath = resolveGalleryDlPath();
        if (galleryDlPath) {
            this.updateJob(id, {
                mode: "gallery",
                status: "downloading",
                progress: 10,
                message: "Extracting images / gallery items...",
            });
            try {
                await this._downloadWithGalleryDl(id, resolvedOpts, galleryDlPath);
                return;
            } catch (err) {
                galErr = err;
                if (this.getJob(id)?.status === "cancelled") throw err;
            }
        }

        // 6. Auto final fallback: direct HTTP probe
        const fallbackProbe = probe || (await probeDirectHttp(url));
        if (fallbackProbe && fallbackProbe.isDirectFile) {
            this.updateJob(id, {
                mode: "direct",
                status: "downloading",
                title: fallbackProbe.filename,
                totalBytes: fallbackProbe.fileSize,
                message: `Downloading ${fallbackProbe.category} (${fallbackProbe.mimeType})...`,
            });
            await this._downloadDirect(
                id,
                fallbackProbe.finalUrl || url,
                fallbackProbe,
                resolvedOpts.customFilename
            );
            return;
        }

        const primaryError = ytErr?.message || galErr?.message;
        throw new Error(
            primaryError ||
                "Could not extract media directly from this link. Try clicking \"Inspect Link\" to view downloadable images/files on the page, or upload a cookies.txt file if login is required."
        );
    }

    async _downloadDirect(id, url, probe, customFilename) {
        const controller = new AbortController();
        this.controllers.set(id, controller);

        const response = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: DEFAULT_HEADERS,
            signal: controller.signal,
        });

        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status} while downloading file`);
        }

        const headerDisposition = parseContentDisposition(
            response.headers.get("content-disposition") || ""
        );
        const contentLengthHeader = response.headers.get("content-length");
        const totalBytes =
            contentLengthHeader && /^\d+$/.test(contentLengthHeader)
                ? Number(contentLengthHeader)
                : probe?.fileSize || null;

        const targetName = sanitizeFilename(
            customFilename || headerDisposition || probe?.filename || "download.bin"
        );
        const finalPath = ensureUniquePath(DOWNLOADS_DIR, targetName);
        const partPath = `${finalPath}.part`;

        const fileStream = fs.createWriteStream(partPath);
        const readable = Readable.fromWeb(response.body);

        let downloadedBytes = 0;
        let lastTickTime = Date.now();
        let lastTickBytes = 0;

        const baseFilename = path.basename(finalPath);
        this.updateJob(id, {
            filename: baseFilename,
            title: baseFilename,
            totalBytes,
        });

        try {
            await new Promise((resolve, reject) => {
                const cleanupAbort = () => {
                    readable.destroy(new Error("Aborted"));
                    fileStream.destroy();
                };
                controller.signal.addEventListener("abort", cleanupAbort, { once: true });

                readable.on("data", (chunk) => {
                    downloadedBytes += chunk.length;
                    const now = Date.now();
                    const elapsedMs = now - lastTickTime;
                    if (elapsedMs >= 250) {
                        const rate = ((downloadedBytes - lastTickBytes) * 1000) / elapsedMs;
                        const progress = totalBytes
                            ? Math.min(99.9, Number(((downloadedBytes / totalBytes) * 100).toFixed(1)))
                            : null;
                        const etaSeconds =
                            totalBytes && rate > 0
                                ? Math.ceil((totalBytes - downloadedBytes) / rate)
                                : null;

                        this.updateJob(id, {
                            downloadedBytes,
                            progress,
                            speed: rate,
                            eta: etaSeconds !== null ? `${etaSeconds}s` : null,
                            message: totalBytes
                                ? `Downloading ${progress}%`
                                : `Downloaded ${(downloadedBytes / (1024 * 1024)).toFixed(2)} MB`,
                        });
                        lastTickTime = now;
                        lastTickBytes = downloadedBytes;
                    }
                });

                readable.on("error", reject);
                fileStream.on("error", reject);
                fileStream.on("finish", resolve);

                readable.pipe(fileStream);
            });

            fs.renameSync(partPath, finalPath);
            this.controllers.delete(id);

            this.updateJob(id, {
                status: "completed",
                progress: 100,
                downloadedBytes,
                totalBytes: totalBytes || downloadedBytes,
                speed: null,
                eta: "0s",
                filename: baseFilename,
                files: [baseFilename],
                message: "Download complete",
            });
        } catch (err) {
            this.controllers.delete(id);
            if (fs.existsSync(partPath)) {
                try {
                    fs.unlinkSync(partPath);
                } catch {
                    // Ignore cleanup error
                }
            }
            throw err;
        }
    }

    _downloadWithGalleryDl(id, opts, galleryDlPath) {
        const stagingDir = path.join(DOWNLOADS_DIR, `.staging_${id}`);
        ensureDirSync(stagingDir);

        const args = [
            "--directory",
            stagingDir,
            "-o",
            "directory=[]",
            "--range",
            "1-30",
            ...buildCookieArgs(opts.cookiesBrowser, opts.tempCookieFilePath),
            opts.url,
        ];

        return new Promise((resolve, reject) => {
            const child = spawn(galleryDlPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const controller = new AbortController();
            controller.signal.addEventListener("abort", () => {
                child.kill("SIGTERM");
            });
            this.controllers.set(id, controller);

            const downloadedPaths = [];
            let stderrBuffer = "";
            let stdoutBuffer = "";

            const handleStdoutLine = (line) => {
                const cleaned = line.replace(/^#\s*/, "").trim();
                if (!cleaned) return;
                if (fs.existsSync(cleaned) && fs.statSync(cleaned).isFile()) {
                    downloadedPaths.push(cleaned);
                    this.updateJob(id, {
                        status: "downloading",
                        progress: Math.min(95, 15 + downloadedPaths.length * 15),
                        message: `Downloaded ${downloadedPaths.length} item(s)...`,
                    });
                }
            };

            child.stdout.on("data", (chunk) => {
                stdoutBuffer += chunk.toString("utf8");
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || "";
                for (const line of lines) handleStdoutLine(line);
            });

            child.stderr.on("data", (chunk) => {
                stderrBuffer += chunk.toString("utf8");
            });

            child.on("error", (err) => {
                this.controllers.delete(id);
                fs.rmSync(stagingDir, { recursive: true, force: true });
                reject(err);
            });

            child.on("close", (code) => {
                this.controllers.delete(id);
                if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);

                if (controller.signal.aborted) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(new Error("Download cancelled"));
                }

                // Collect any files written inside stagingDir
                const stagedFiles = fs.existsSync(stagingDir)
                    ? fs.readdirSync(stagingDir).map((f) => path.join(stagingDir, f))
                    : [];
                const sourceFiles = stagedFiles.filter((p) => fs.statSync(p).isFile());

                if (code !== 0 || sourceFiles.length === 0) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(
                        new Error(stderrBuffer.trim() || `gallery-dl exited with code ${code}`)
                    );
                }

                const movedFilenames = [];
                let totalBytes = 0;

                sourceFiles.forEach((srcPath, index) => {
                    const ext = path.extname(srcPath);
                    const originalBase = path.basename(srcPath);
                    let desiredName = originalBase;
                    if (opts.customFilename) {
                        const baseCustom = sanitizeFilename(path.parse(opts.customFilename).name);
                        desiredName =
                            sourceFiles.length > 1
                                ? `${baseCustom}_${index + 1}${ext}`
                                : `${baseCustom}${ext}`;
                    }
                    const destPath = ensureUniquePath(DOWNLOADS_DIR, desiredName);
                    fs.renameSync(srcPath, destPath);
                    totalBytes += fs.statSync(destPath).size;
                    movedFilenames.push(path.basename(destPath));
                });

                fs.rmSync(stagingDir, { recursive: true, force: true });

                this.updateJob(id, {
                    status: "completed",
                    progress: 100,
                    filename: movedFilenames[0],
                    files: movedFilenames,
                    title:
                        movedFilenames.length > 1
                            ? `${movedFilenames.length} files (${movedFilenames[0]} + ${movedFilenames.length - 1} more)`
                            : movedFilenames[0],
                    totalBytes,
                    downloadedBytes: totalBytes,
                    speed: null,
                    eta: "0s",
                    message:
                        movedFilenames.length > 1
                            ? `Downloaded ${movedFilenames.length} files`
                            : "Download complete",
                });
                resolve();
            });
        });
    }

    _buildFormatSelector(quality, hasFfmpeg, container = "mp4") {
        if (quality === "audio") {
            return {
                format: "bestaudio/best",
                formatSort: null,
                extraArgs: ["-x", "--audio-format", "mp3", "--audio-quality", "0"],
            };
        }

        const resMap = {
            "4k": "res:2160",
            "1440p": "res:1440",
            "1080p": "res:1080",
            "720p": "res:720",
        };
        const resSort = quality === "max" ? null : resMap[quality] || "res:2160";
        const extSort =
            container === "webm"
                ? "ext:webm"
                : container === "mp4"
                    ? "ext:mp4:m4a"
                    : null;
        const sortParts = [resSort, extSort].filter(Boolean);

        return {
            format: hasFfmpeg ? "bestvideo+bestaudio/best" : "best[ext=mp4]/best",
            formatSort: sortParts.length > 0 ? sortParts.join(",") : null,
            extraArgs: [],
        };
    }

    _downloadWithYtDlp(id, opts, ytdlpPath) {
        const ffmpegPath = resolveFfmpegPath();
        const { quality = "4k", container = "mp4", cookiesBrowser = "", customFilename = "" } = opts;
        const allowedContainers = new Set(["mp4", "mkv", "webm"]);
        const mergeFormat = allowedContainers.has(container) ? container : "mp4";
        const { format, formatSort, extraArgs } = this._buildFormatSelector(
            quality,
            Boolean(ffmpegPath),
            mergeFormat
        );

        const stagingDir = path.join(DOWNLOADS_DIR, `.staging_${id}`);
        ensureDirSync(stagingDir);

        const safeQualityTag = sanitizeFilename(quality || "4k");
        const outputTemplate = customFilename
            ? path.join(stagingDir, `${sanitizeFilename(path.parse(customFilename).name)}.%(ext)s`)
            : path.join(stagingDir, `%(title).120B [%(id)s] [${safeQualityTag}].%(ext)s`);

        const args = [
            ...getYtDlpBaseArgs(),
            "--no-playlist",
            "--no-warnings",
            "--newline",
            "--progress",
            "--progress-template",
            "download:PROGRESS|%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s",
            "--print",
            "before_dl:META|%(title)s|%(resolution)s|%(width)s|%(height)s",
            "--print",
            "after_move:FINALPATH|%(filepath)s",
            "-f",
            format,
            ...(formatSort ? ["-S", formatSort] : []),
            ...extraArgs,
            ...(quality !== "audio" && ffmpegPath ? ["--merge-output-format", mergeFormat] : []),
            ...(ffmpegPath ? ["--ffmpeg-location", ffmpegPath] : []),
            ...buildCookieArgs(cookiesBrowser, opts.tempCookieFilePath),
            "-o",
            outputTemplate,
            opts.url,
        ];

        return new Promise((resolve, reject) => {
            const child = spawn(ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const controller = new AbortController();
            controller.signal.addEventListener("abort", () => {
                child.kill("SIGTERM");
            });
            this.controllers.set(id, controller);

            let finalFilePath = null;
            let stderrBuffer = "";
            let stdoutBuffer = "";

            const handleLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;

                if (trimmed.startsWith("META|")) {
                    const [, title, rawRes, rawW, rawH] = trimmed.split("|");
                    const resText =
                        rawRes && rawRes !== "NA"
                            ? rawRes
                            : rawW && rawH && rawW !== "NA" && rawH !== "NA"
                                ? `${rawW}x${rawH}`
                                : null;
                    this.updateJob(id, {
                        title: title || opts.url,
                        resolution: resText,
                        message: resText
                            ? `Downloading (${resText})...`
                            : "Downloading media...",
                    });
                    return;
                }

                if (trimmed.startsWith("FINALPATH|")) {
                    finalFilePath = trimmed.slice("FINALPATH|".length).trim();
                    return;
                }

                if (trimmed.startsWith("PROGRESS|")) {
                    const [, pctStr, speedStr, etaStr, dlBytes, totalBytes, estBytes] =
                        trimmed.split("|");
                    const pct = parseFloat((pctStr || "").replace("%", "").trim());
                    const parsedDl = Number(dlBytes);
                    const parsedTotal = Number(totalBytes) || Number(estBytes) || null;
                    this.updateJob(id, {
                        status: "downloading",
                        progress: Number.isFinite(pct) ? Math.min(99.9, pct) : null,
                        downloadedBytes: Number.isFinite(parsedDl) ? parsedDl : 0,
                        totalBytes: Number.isFinite(parsedTotal) && parsedTotal > 0 ? parsedTotal : null,
                        speed: speedStr && speedStr !== "NA" ? speedStr.trim() : null,
                        eta: etaStr && etaStr !== "NA" ? etaStr.trim() : null,
                        message: Number.isFinite(pct)
                            ? `Downloading ${pct.toFixed(1)}%`
                            : "Downloading media...",
                    });
                    return;
                }

                if (trimmed.includes("[Merger]") || trimmed.includes("Merging formats")) {
                    this.updateJob(id, {
                        status: "merging",
                        progress: 99,
                        message: "Merging high-resolution video & audio with ffmpeg...",
                    });
                } else if (trimmed.includes("[ExtractAudio]")) {
                    this.updateJob(id, {
                        status: "merging",
                        progress: 99,
                        message: "Converting audio to MP3...",
                    });
                }
            };

            child.stdout.on("data", (chunk) => {
                stdoutBuffer += chunk.toString("utf8");
                const lines = stdoutBuffer.split(/\r?\n/);
                stdoutBuffer = lines.pop() || "";
                for (const line of lines) handleLine(line);
            });

            child.stderr.on("data", (chunk) => {
                const text = chunk.toString("utf8");
                stderrBuffer += text;
                const lines = text.split(/\r?\n/);
                for (const line of lines) handleLine(line);
            });

            child.on("error", (err) => {
                this.controllers.delete(id);
                fs.rmSync(stagingDir, { recursive: true, force: true });
                reject(err);
            });

            child.on("close", (code) => {
                this.controllers.delete(id);
                if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

                if (controller.signal.aborted) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(new Error("Download cancelled"));
                }

                if (code !== 0) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    const cleanErr = stderrBuffer
                        .split(/\r?\n/)
                        .filter((l) => l.includes("ERROR:"))
                        .join(" ")
                        .trim();
                    const errMsg = cleanErr || stderrBuffer.trim() || `yt-dlp exited with code ${code}`;
                    return reject(
                        new Error(
                            errMsg.includes("cookies") ||
                                errMsg.includes("Sign in") ||
                                errMsg.includes("login") ||
                                errMsg.includes("bot")
                                ? `${errMsg} — Upload a cookies.txt file under Cookies (required on cloud servers like Render).`
                                : errMsg
                        )
                    );
                }

                // Locate downloaded file (from FINALPATH or fallback to scanning stagingDir)
                let sourcePath = finalFilePath && fs.existsSync(finalFilePath) ? finalFilePath : null;
                if (!sourcePath && fs.existsSync(stagingDir)) {
                    const stagedFiles = fs
                        .readdirSync(stagingDir)
                        .map((f) => path.join(stagingDir, f))
                        .filter((p) => fs.statSync(p).isFile() && !p.endsWith(".part"));
                    sourcePath = stagedFiles[0] || null;
                }

                let resolvedName = null;
                let fileSize = null;
                if (sourcePath && fs.existsSync(sourcePath)) {
                    const destPath = ensureUniquePath(DOWNLOADS_DIR, path.basename(sourcePath));
                    fs.renameSync(sourcePath, destPath);
                    resolvedName = path.basename(destPath);
                    fileSize = fs.statSync(destPath).size;
                }

                fs.rmSync(stagingDir, { recursive: true, force: true });

                this.updateJob(id, {
                    status: "completed",
                    progress: 100,
                    filename: resolvedName,
                    files: resolvedName ? [resolvedName] : [],
                    totalBytes: fileSize || this.getJob(id)?.totalBytes || null,
                    downloadedBytes: fileSize || this.getJob(id)?.downloadedBytes || 0,
                    speed: null,
                    eta: "0s",
                    message: "Download complete",
                });
                resolve();
            });
        });
    }
}

module.exports = new JobManager();
