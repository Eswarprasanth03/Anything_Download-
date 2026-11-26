const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const { spawn } = require("child_process");
const { Readable } = require("stream");

const config = require("./config");
const { resolveYtDlpPath, resolveFfmpegPath, resolveGalleryDlPath } = require("./binaries");
const { isValidGuestId } = require("./guestSession");
const { assertSafePublicUrl, safeFetch } = require("./ssrf");
const storage = require("./storage");
const {
    normalizeContentType,
    isKnownMediaHost,
    probeDirectHttp,
    buildCookieArgs,
    validateCookieOptions,
    getYtDlpBaseArgs,
    resolveShareRedirect,
    formatExtractorError,
    DEFAULT_HEADERS,
} = require("./analyzer");
const {
    ensureDirSync,
    sanitizeFilename,
    ensureUniquePath,
    parseContentDisposition,
} = require("./utils");

class JobManager extends EventEmitter {
    constructor() {
        super();
        this.jobs = new Map();
        this.controllers = new Map();
        this.activeFilePaths = new Map(); // jobId -> Set(resolvedFilePath)
        this.queue = [];
        this.activeCount = 0;
        this.cleanupTimer = null;
    }

    isActiveStatus(status) {
        return (
            status === "queued" ||
            status === "analyzing" ||
            status === "downloading" ||
            status === "merging"
        );
    }

    getActiveCleanupExclusions() {
        const activeJobIds = new Set();
        const activeGuestIds = new Set();
        const activeFilePaths = new Set();

        for (const job of this.jobs.values()) {
            if (!this.isActiveStatus(job.status)) continue;
            activeJobIds.add(job.id);
            if (job.guestId) activeGuestIds.add(job.guestId);
            const tracked = this.activeFilePaths.get(job.id);
            if (tracked) {
                for (const p of tracked) activeFilePaths.add(p);
            }
        }

        return { activeJobIds, activeGuestIds, activeFilePaths };
    }

    trackActiveFilePath(jobId, filePath) {
        if (!filePath) return;
        let set = this.activeFilePaths.get(jobId);
        if (!set) {
            set = new Set();
            this.activeFilePaths.set(jobId, set);
        }
        set.add(path.resolve(filePath));
    }

    clearTrackedFilePaths(jobId) {
        this.activeFilePaths.delete(jobId);
    }

    runCleanupCycle(nowMs = Date.now()) {
        const exclusions = this.getActiveCleanupExclusions();
        const storageResult = storage.cleanupExpiredStorage({
            fileTtlMs: config.FILE_TTL_MS,
            nowMs,
            ...exclusions,
        });
        const prunedJobs = this.pruneOldJobs(config.JOB_RETENTION_MS, nowMs);
        return { ...storageResult, prunedJobs };
    }

    startCleanupScheduler() {
        if (this.cleanupTimer) return;
        this.cleanupTimer = setInterval(() => {
            try {
                this.runCleanupCycle();
            } catch (err) {
                console.error("[cleanup] Error during scheduled cleanup:", err.message);
            }
        }, config.CLEANUP_INTERVAL_MS);
        this.cleanupTimer.unref?.();
    }

    stopCleanupScheduler() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
            this.cleanupTimer = null;
        }
    }

    pruneOldJobs(retentionMs = config.JOB_RETENTION_MS, nowMs = Date.now()) {
        let removed = 0;
        for (const [id, job] of this.jobs.entries()) {
            const terminal =
                job.status === "completed" || job.status === "error" || job.status === "cancelled";
            if (!terminal) continue;
            const updatedAtMs = new Date(job.updatedAt).getTime();
            if (Number.isFinite(updatedAtMs) && nowMs - updatedAtMs > retentionMs) {
                this.jobs.delete(id);
                removed += 1;
            }
        }
        return removed;
    }

    listJobs(guestId) {
        if (!isValidGuestId(guestId)) return [];
        return Array.from(this.jobs.values())
            .filter((job) => job.guestId === guestId)
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    getJob(id, guestId = null) {
        const job = this.jobs.get(id) || null;
        if (!job) return null;
        if (guestId && job.guestId !== guestId) return null;
        return job;
    }

    countGuestActiveJobs(guestId) {
        let count = 0;
        for (const job of this.jobs.values()) {
            if (
                job.guestId === guestId &&
                (job.status === "queued" ||
                    job.status === "analyzing" ||
                    job.status === "downloading" ||
                    job.status === "merging")
            ) {
                count += 1;
            }
        }
        return count;
    }

    updateJob(id, patch) {
        const job = this.jobs.get(id);
        if (!job) return null;
        Object.assign(job, patch, { updatedAt: new Date().toISOString() });
        this.emit("job", { ...job });
        return job;
    }

    cancelJob(id, guestId) {
        const job = this.getJob(id, guestId);
        if (!job) return false;

        // Remove from queue if still queued
        const qIdx = this.queue.findIndex((item) => item.id === id);
        if (qIdx !== -1) {
            this.queue.splice(qIdx, 1);
        }

        const ctrl = this.controllers.get(id);
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
        guestId,
        url,
        quality = "4k",
        container = "mp4",
        cookiesBrowser = "",
        cookiesTxt = "",
        customFilename = "",
        forceDirect = false,
        contentType = "auto",
    }) {
        if (!isValidGuestId(guestId)) {
            throw new Error("Invalid guest session.");
        }
        validateCookieOptions({ cookiesBrowser, cookiesTxt });
        const cleanUrl = await assertSafePublicUrl(url);
        const normalizedType = normalizeContentType(contentType);

        storage.assertStorageQuota(guestId, 0);

        if (this.countGuestActiveJobs(guestId) >= config.MAX_ACTIVE_PER_GUEST) {
            const err = new Error(
                `You can run up to ${config.MAX_ACTIVE_PER_GUEST} active downloads at a time.`
            );
            err.statusCode = 429;
            throw err;
        }

        if (
            this.activeCount >= config.MAX_CONCURRENT_DOWNLOADS &&
            this.queue.length >= config.MAX_QUEUE_SIZE
        ) {
            const err = new Error("Server download queue is full. Please try again in a moment.");
            err.statusCode = 503;
            throw err;
        }

        const id = crypto.randomUUID().slice(0, 12);
        const now = new Date().toISOString();
        const isQueued = this.activeCount >= config.MAX_CONCURRENT_DOWNLOADS;

        const job = {
            id,
            guestId,
            url: cleanUrl,
            contentType: normalizedType,
            quality: normalizedType === "audio" ? "audio" : quality,
            container,
            status: isQueued ? "queued" : "analyzing",
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
            message: isQueued ? "Queued — waiting for an available worker slot..." : "Inspecting link...",
            error: null,
            createdAt: now,
            updatedAt: now,
        };

        this.jobs.set(id, job);
        this.emit("job", { ...job });

        const task = {
            id,
            guestId,
            opts: {
                url: cleanUrl,
                quality: job.quality,
                container,
                cookiesBrowser,
                customFilename,
                forceDirect: Boolean(forceDirect),
                contentType: normalizedType,
            },
        };

        this.queue.push(task);
        this._drainQueue();

        return { ...job };
    }

    _drainQueue() {
        while (this.activeCount < config.MAX_CONCURRENT_DOWNLOADS && this.queue.length > 0) {
            const task = this.queue.shift();
            const job = this.jobs.get(task.id);
            if (!job || job.status === "cancelled") continue;

            this.activeCount += 1;
            this._runTaskWithTimeout(task)
                .catch((err) => {
                    const current = this.jobs.get(task.id);
                    if (current && current.status !== "cancelled") {
                        this.updateJob(task.id, {
                            status: "error",
                            error: err.message || "Download failed",
                            message: err.message || "Download failed",
                        });
                    }
                })
                .finally(() => {
                    this.activeCount = Math.max(0, this.activeCount - 1);
                    this._drainQueue();
                });
        }
    }

    async _runTaskWithTimeout(task) {
        const { id, guestId, opts } = task;
        this.updateJob(id, { status: "analyzing", message: "Inspecting link..." });

        const timeoutController = new AbortController();
        const timeoutHandle = setTimeout(() => {
            timeoutController.abort(new Error("Download exceeded maximum execution time."));
            const activeCtrl = this.controllers.get(id);
            if (activeCtrl) activeCtrl.abort();
        }, config.JOB_TIMEOUT_MS);
        timeoutHandle.unref?.();

        try {
            await this._executeJob(id, guestId, opts, timeoutController.signal);
        } finally {
            clearTimeout(timeoutHandle);
        }
    }

    async _executeJob(id, guestId, opts, timeoutSignal) {
        if (timeoutSignal.aborted) {
            throw new Error("Download timed out.");
        }

        const { forceDirect, contentType } = opts;
        const url = await resolveShareRedirect(opts.url);
        await assertSafePublicUrl(url);
        const resolvedOpts = { ...opts, url, timeoutSignal };

        if (forceDirect || contentType === "webpage") {
            const probe = await probeDirectHttp(url);
            if (probe?.fileSize && probe.fileSize > config.MAX_DOWNLOAD_BYTES) {
                throw new Error(
                    `File exceeds the maximum allowed size (${Math.round(config.MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB).`
                );
            }
            this.updateJob(id, {
                mode: "direct",
                status: "downloading",
                title: probe?.filename || url,
                totalBytes: probe?.fileSize || null,
                message: `Downloading ${probe?.mimeType || "file"}...`,
            });
            await this._downloadDirect(
                id,
                guestId,
                probe?.finalUrl || url,
                probe,
                resolvedOpts.customFilename,
                timeoutSignal
            );
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
            await this._downloadDirect(
                id,
                guestId,
                probe.finalUrl || url,
                probe,
                resolvedOpts.customFilename,
                timeoutSignal
            );
            return;
        }

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
                await this._downloadDirect(
                    id,
                    guestId,
                    probe.finalUrl || url,
                    probe,
                    resolvedOpts.customFilename,
                    timeoutSignal
                );
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
                await this._downloadWithGalleryDl(id, guestId, resolvedOpts, galleryDlPath);
                return;
            }
            throw new Error(
                "No direct image or supported gallery found. Try \"Inspect Link\" to extract images from the page."
            );
        }

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
                await this._downloadDirect(
                    id,
                    guestId,
                    probe.finalUrl || url,
                    probe,
                    resolvedOpts.customFilename,
                    timeoutSignal
                );
                return;
            }
        }

        let ytErr = null;
        const ytdlpPath = resolveYtDlpPath();
        if (ytdlpPath) {
            this.updateJob(id, {
                mode: contentType === "audio" ? "audio" : "media",
                status: "downloading",
                message: contentType === "audio" ? "Extracting audio stream..." : "Fetching media streams...",
            });
            try {
                await this._downloadWithYtDlp(id, guestId, resolvedOpts, ytdlpPath);
                return;
            } catch (err) {
                ytErr = err;
                if (this.getJob(id)?.status === "cancelled" || timeoutSignal.aborted) throw err;
                if (contentType === "audio" || contentType === "video") {
                    const directProbe = probe || (await probeDirectHttp(url));
                    if (directProbe && directProbe.isDirectFile) {
                        await this._downloadDirect(
                            id,
                            guestId,
                            directProbe.finalUrl || url,
                            directProbe,
                            resolvedOpts.customFilename,
                            timeoutSignal
                        );
                        return;
                    }
                    throw err;
                }
                const msg = err.message || "";
                if (/bot|sign in|login|private|age-restricted|rate-limited|unavailable|exceeds/i.test(msg)) {
                    throw err;
                }
            }
        }

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
                await this._downloadWithGalleryDl(id, guestId, resolvedOpts, galleryDlPath);
                return;
            } catch (err) {
                galErr = err;
                if (this.getJob(id)?.status === "cancelled" || timeoutSignal.aborted) throw err;
            }
        }

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
                guestId,
                fallbackProbe.finalUrl || url,
                fallbackProbe,
                resolvedOpts.customFilename,
                timeoutSignal
            );
            return;
        }

        throw new Error(
            ytErr?.message ||
                galErr?.message ||
                "Could not extract media from this link. Try clicking \"Inspect Link\" to check for downloadable files or images."
        );
    }

    async _downloadDirect(id, guestId, url, probe, customFilename, timeoutSignal) {
        const guestDir = storage.getGuestDir(guestId);
        const controller = new AbortController();
        this.controllers.set(id, controller);

        const onTimeoutAbort = () => controller.abort();
        timeoutSignal?.addEventListener("abort", onTimeoutAbort, { once: true });

        const { res: response } = await safeFetch(url, {
            method: "GET",
            headers: DEFAULT_HEADERS,
            signal: controller.signal,
        });

        if (!response.ok || !response.body) {
            this.controllers.delete(id);
            this.clearTrackedFilePaths(id);
            timeoutSignal?.removeEventListener("abort", onTimeoutAbort);
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

        if (totalBytes !== null) {
            storage.assertStorageQuota(guestId, totalBytes);
        }

        const targetName = sanitizeFilename(
            customFilename || headerDisposition || probe?.filename || "download.bin"
        );
        const finalPath = ensureUniquePath(guestDir, targetName);
        const partPath = `${finalPath}.part`;
        this.trackActiveFilePath(id, partPath);
        this.trackActiveFilePath(id, finalPath);

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
                    const reason = timeoutSignal?.aborted
                        ? new Error("Download timed out.")
                        : new Error("Aborted");
                    readable.destroy(reason);
                    fileStream.destroy();
                };
                controller.signal.addEventListener("abort", cleanupAbort, { once: true });

                readable.on("data", (chunk) => {
                    downloadedBytes += chunk.length;
                    if (downloadedBytes > config.MAX_DOWNLOAD_BYTES) {
                        const limitErr = new Error(
                            `File exceeds the maximum allowed size (${Math.round(config.MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB).`
                        );
                        readable.destroy(limitErr);
                        fileStream.destroy();
                        return;
                    }

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

            storage.assertStorageQuota(guestId, downloadedBytes);
            fs.renameSync(partPath, finalPath);
            this.controllers.delete(id);
            this.clearTrackedFilePaths(id);
            timeoutSignal?.removeEventListener("abort", onTimeoutAbort);

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
            this.clearTrackedFilePaths(id);
            timeoutSignal?.removeEventListener("abort", onTimeoutAbort);
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

    _downloadWithGalleryDl(id, guestId, opts, galleryDlPath) {
        const guestDir = storage.getGuestDir(guestId);
        const stagingDir = path.join(guestDir, `.staging_${id}`);
        ensureDirSync(stagingDir);

        const args = [
            "--directory",
            stagingDir,
            "-o",
            "directory=[]",
            "--range",
            "1-30",
            "--filesize-max",
            String(config.MAX_DOWNLOAD_BYTES),
            ...buildCookieArgs(opts.cookiesBrowser),
            opts.url,
        ];

        return new Promise((resolve, reject) => {
            const child = spawn(galleryDlPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const controller = new AbortController();
            const killChild = () => {
                child.kill("SIGTERM");
                setTimeout(() => {
                    if (!child.killed) child.kill("SIGKILL");
                }, 2000).unref?.();
            };
            controller.signal.addEventListener("abort", killChild);
            opts.timeoutSignal?.addEventListener("abort", killChild, { once: true });
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
                opts.timeoutSignal?.removeEventListener("abort", killChild);
                fs.rmSync(stagingDir, { recursive: true, force: true });
                reject(err);
            });

            child.on("close", (code) => {
                this.controllers.delete(id);
                opts.timeoutSignal?.removeEventListener("abort", killChild);
                if (stdoutBuffer.trim()) handleStdoutLine(stdoutBuffer);

                if (opts.timeoutSignal?.aborted) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(new Error("Download timed out."));
                }
                if (controller.signal.aborted) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(new Error("Download cancelled"));
                }

                const stagedFiles = fs.existsSync(stagingDir)
                    ? fs.readdirSync(stagingDir).map((f) => path.join(stagingDir, f))
                    : [];
                const sourceFiles = stagedFiles.filter((p) => fs.statSync(p).isFile());

                if (code !== 0 || sourceFiles.length === 0) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(
                        new Error(
                            formatExtractorError(stderrBuffer.trim() || `gallery-dl exited with code ${code}`)
                        )
                    );
                }

                const movedFilenames = [];
                let totalBytes = 0;

                try {
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
                        const moved = storage.moveIntoGuestStorage(guestId, srcPath, desiredName);
                        totalBytes += moved.size;
                        movedFilenames.push(moved.filename);
                    });
                } catch (quotaErr) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(quotaErr);
                }

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

    _downloadWithYtDlp(id, guestId, opts, ytdlpPath) {
        const guestDir = storage.getGuestDir(guestId);
        const ffmpegPath = resolveFfmpegPath();
        const { quality = "4k", container = "mp4", cookiesBrowser = "", customFilename = "" } = opts;
        const allowedContainers = new Set(["mp4", "mkv", "webm"]);
        const mergeFormat = allowedContainers.has(container) ? container : "mp4";
        const { format, formatSort, extraArgs } = this._buildFormatSelector(
            quality,
            Boolean(ffmpegPath),
            mergeFormat
        );

        const stagingDir = path.join(guestDir, `.staging_${id}`);
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
            "--socket-timeout",
            "20",
            "--max-filesize",
            String(config.MAX_DOWNLOAD_BYTES),
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
            ...buildCookieArgs(cookiesBrowser),
            "-o",
            outputTemplate,
            opts.url,
        ];

        return new Promise((resolve, reject) => {
            const child = spawn(ytdlpPath, args, { stdio: ["ignore", "pipe", "pipe"] });
            const controller = new AbortController();
            const killChild = () => {
                child.kill("SIGTERM");
                setTimeout(() => {
                    if (!child.killed) child.kill("SIGKILL");
                }, 2000).unref?.();
            };
            controller.signal.addEventListener("abort", killChild);
            opts.timeoutSignal?.addEventListener("abort", killChild, { once: true });
            this.controllers.set(id, controller);

            let finalFilePath = null;
            let stderrBuffer = "";
            let stdoutBuffer = "";
            let sizeExceeded = false;

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
                    if (
                        (Number.isFinite(parsedDl) && parsedDl > config.MAX_DOWNLOAD_BYTES) ||
                        (parsedTotal && parsedTotal > config.MAX_DOWNLOAD_BYTES)
                    ) {
                        sizeExceeded = true;
                        killChild();
                        return;
                    }
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
                opts.timeoutSignal?.removeEventListener("abort", killChild);
                fs.rmSync(stagingDir, { recursive: true, force: true });
                reject(err);
            });

            child.on("close", (code) => {
                this.controllers.delete(id);
                opts.timeoutSignal?.removeEventListener("abort", killChild);
                if (stdoutBuffer.trim()) handleLine(stdoutBuffer);

                if (sizeExceeded) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(
                        new Error(
                            `File exceeds the maximum allowed size (${Math.round(config.MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB).`
                        )
                    );
                }
                if (opts.timeoutSignal?.aborted) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(new Error("Download timed out."));
                }
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
                    return reject(new Error(formatExtractorError(errMsg)));
                }

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
                try {
                    if (sourcePath && fs.existsSync(sourcePath)) {
                        const moved = storage.moveIntoGuestStorage(
                            guestId,
                            sourcePath,
                            path.basename(sourcePath)
                        );
                        resolvedName = moved.filename;
                        fileSize = moved.size;
                    }
                } catch (quotaErr) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    return reject(quotaErr);
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
