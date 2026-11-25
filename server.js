const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const mime = require("mime-types");

const config = require("./src/config");
const { getBinaryStatus } = require("./src/binaries");
const { requireGuestSession } = require("./src/guestSession");
const { analyzeUrl } = require("./src/analyzer");
const jobManager = require("./src/jobManager");
const storage = require("./src/storage");
const { ensureDirSync } = require("./src/utils");

ensureDirSync(config.BASE_DOWNLOADS_DIR);

const app = express();
app.set("trust proxy", 1);

const ACTIVE_INLINE_MIME_TYPES = new Set([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "application/javascript",
    "text/javascript",
    "application/xml",
    "text/xml",
]);

function applyCors(req, res, next) {
    const origin = req.headers.origin;
    if (origin && config.CORS_ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Vary", "Origin");
        if (req.method === "OPTIONS") {
            return res.status(204).end();
        }
    }
    return next();
}

function serializeJob(job) {
    if (!job) return null;
    const { guestId, ...publicJob } = job;
    return publicJob;
}

function createGuestRateLimiter(maxPerMinute) {
    return rateLimit({
        windowMs: 60 * 1000,
        limit: maxPerMinute,
        keyGenerator: (req) => req.guestId || req.ip,
        validate: { keyGeneratorIpFallback: false },
        message: { error: "Rate limit exceeded for your guest session. Please wait a moment." },
        standardHeaders: "draft-8",
        legacyHeaders: false,
    });
}

const analyzeLimiter = createGuestRateLimiter(config.GUEST_ANALYZE_RATE_LIMIT);
const downloadLimiter = createGuestRateLimiter(config.GUEST_DOWNLOAD_RATE_LIMIT);

app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    next();
});
app.use(applyCors);
app.use(express.json({ limit: "256kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", requireGuestSession, (req, res) => {
    const status = getBinaryStatus();
    res.json({
        ok: true,
        binaries: {
            ytdlp: status.ytdlp,
            ffmpeg: status.ffmpeg,
            galleryDl: status.galleryDl,
        },
        mode: status.mode,
        limits: status.limits,
        ...(!config.PUBLIC_HOSTED_MODE ? { downloadsDir: config.BASE_DOWNLOADS_DIR } : {}),
    });
});

app.post("/api/analyze", requireGuestSession, analyzeLimiter, async (req, res) => {
    try {
        const { url, cookiesBrowser, cookiesTxt, contentType } = req.body || {};
        const result = await analyzeUrl(url, { cookiesBrowser, cookiesTxt, contentType });
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message || "Unable to analyze URL" });
    }
});

app.post("/api/downloads", requireGuestSession, downloadLimiter, async (req, res) => {
    try {
        const {
            url,
            quality,
            container,
            cookiesBrowser,
            cookiesTxt,
            customFilename,
            forceDirect,
            contentType,
        } = req.body || {};
        const job = await jobManager.startDownload({
            guestId: req.guestId,
            url,
            quality,
            container,
            cookiesBrowser,
            cookiesTxt,
            customFilename,
            forceDirect: Boolean(forceDirect),
            contentType,
        });
        res.status(202).json(serializeJob(job));
    } catch (err) {
        res.status(err.statusCode || 400).json({ error: err.message || "Unable to start download" });
    }
});

app.get("/api/downloads", requireGuestSession, (req, res) => {
    res.json({ jobs: jobManager.listJobs(req.guestId).map(serializeJob) });
});

app.post("/api/downloads/:id/cancel", requireGuestSession, (req, res) => {
    const cancelled = jobManager.cancelJob(req.params.id, req.guestId);
    if (!cancelled) {
        return res.status(404).json({ error: "Download job not found" });
    }
    res.json({ ok: true });
});

app.get("/api/events", requireGuestSession, (req, res) => {
    const guestId = req.guestId;
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const sendEvent = (eventName, payload) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("init", { jobs: jobManager.listJobs(guestId).map(serializeJob) });

    const onJobUpdate = (job) => {
        if (job.guestId === guestId) {
            sendEvent("job", serializeJob(job));
        }
    };
    jobManager.on("job", onJobUpdate);

    const heartbeat = setInterval(() => {
        res.write(": ping\n\n");
    }, 20000);

    req.on("close", () => {
        clearInterval(heartbeat);
        jobManager.off("job", onJobUpdate);
    });
});

app.get("/api/files", requireGuestSession, (req, res) => {
    const files = storage.listGuestFiles(req.guestId);
    const usedBytes = storage.getGuestStorageUsage(req.guestId);
    res.json({
        files,
        usedBytes,
        quotaBytes: config.MAX_GUEST_STORAGE_BYTES,
    });
});

app.get("/api/files/:name", requireGuestSession, (req, res) => {
    const filePath = storage.resolveGuestFile(req.guestId, req.params.name);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
    }

    const detectedMime = (mime.lookup(filePath) || "application/octet-stream").toLowerCase();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, no-store");

    if (req.query.inline === "1" && !ACTIVE_INLINE_MIME_TYPES.has(detectedMime)) {
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        return res.sendFile(filePath);
    }
    return res.download(filePath, path.basename(filePath));
});

app.delete("/api/files/:name", requireGuestSession, (req, res) => {
    const deleted = storage.deleteGuestFile(req.guestId, req.params.name);
    if (!deleted) {
        return res.status(404).json({ error: "File not found" });
    }
    res.json({ ok: true });
});

if (require.main === module) {
    jobManager.startCleanupScheduler();
    app.listen(config.PORT, () => {
        console.log(
            `Anything Download running on port ${config.PORT} (mode: ${
                config.PUBLIC_HOSTED_MODE ? "public-hosted" : "local-dev"
            })`
        );
    });
}

module.exports = app;
