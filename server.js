const fs = require("fs");
const path = require("path");
const express = require("express");
const rateLimit = require("express-rate-limit");
const mime = require("mime-types");

const { getBinaryStatus } = require("./src/binaries");
const { analyzeUrl } = require("./src/analyzer");
const jobManager = require("./src/jobManager");
const { DOWNLOADS_DIR, ensureDirSync } = require("./src/utils");

ensureDirSync(DOWNLOADS_DIR);

const app = express();
const PORT = Number(process.env.PORT) || 4000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    message: { error: "Too many requests. Please slow down and try again shortly." },
    standardHeaders: "draft-8",
    legacyHeaders: false,
});

function listDownloadedFiles() {
    ensureDirSync(DOWNLOADS_DIR);
    const entries = fs.readdirSync(DOWNLOADS_DIR, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (entry.name.startsWith(".") || entry.name.endsWith(".part")) continue;
        const fullPath = path.join(DOWNLOADS_DIR, entry.name);
        const stat = fs.statSync(fullPath);
        files.push({
            name: entry.name,
            size: stat.size,
            mimeType: mime.lookup(entry.name) || "application/octet-stream",
            modifiedAt: stat.mtime.toISOString(),
        });
    }

    return files.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
}

function resolveSafeDownloadFile(rawName) {
    const baseName = path.basename(rawName || "");
    if (!baseName || baseName === "." || baseName === "..") {
        return null;
    }
    const target = path.resolve(DOWNLOADS_DIR, baseName);
    if (!target.startsWith(DOWNLOADS_DIR + path.sep)) {
        return null;
    }
    return target;
}

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        binaries: getBinaryStatus(),
        downloadsDir: DOWNLOADS_DIR,
    });
});

app.post("/api/analyze", apiLimiter, async (req, res) => {
    try {
        const { url, cookiesBrowser, contentType } = req.body || {};
        const result = await analyzeUrl(url, { cookiesBrowser, contentType });
        res.json(result);
    } catch (err) {
        res.status(400).json({ error: err.message || "Unable to analyze URL" });
    }
});

app.post("/api/downloads", apiLimiter, async (req, res) => {
    try {
        const { url, quality, container, cookiesBrowser, customFilename, forceDirect, contentType } =
            req.body || {};
        const job = await jobManager.startDownload({
            url,
            quality,
            container,
            cookiesBrowser,
            customFilename,
            forceDirect: Boolean(forceDirect),
            contentType,
        });
        res.status(202).json(job);
    } catch (err) {
        res.status(400).json({ error: err.message || "Unable to start download" });
    }
});

app.get("/api/downloads", (req, res) => {
    res.json({ jobs: jobManager.listJobs() });
});

app.post("/api/downloads/:id/cancel", (req, res) => {
    const cancelled = jobManager.cancelJob(req.params.id);
    if (!cancelled) {
        return res.status(404).json({ error: "Download job not found" });
    }
    res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (eventName, payload) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("init", { jobs: jobManager.listJobs() });

    const onJobUpdate = (job) => sendEvent("job", job);
    jobManager.on("job", onJobUpdate);

    const heartbeat = setInterval(() => {
        res.write(": ping\n\n");
    }, 20000);

    req.on("close", () => {
        clearInterval(heartbeat);
        jobManager.off("job", onJobUpdate);
    });
});

app.get("/api/files", (req, res) => {
    res.json({ files: listDownloadedFiles() });
});

app.get("/api/files/:name", (req, res) => {
    const filePath = resolveSafeDownloadFile(req.params.name);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
    }

    if (req.query.inline === "1") {
        return res.sendFile(filePath);
    }
    return res.download(filePath, path.basename(filePath));
});

app.delete("/api/files/:name", (req, res) => {
    const filePath = resolveSafeDownloadFile(req.params.name);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Universal Downloader running at http://localhost:${PORT}`);
    });
}

module.exports = app;


app.post("/api/downloads", apiLimiter, async (req, res) => {
    try {
        const { url, quality, container, cookiesBrowser, customFilename, forceDirect } = req.body || {};
        const job = await jobManager.startDownload({
            url,
            quality,
            container,
            cookiesBrowser,
            customFilename,
            forceDirect: Boolean(forceDirect),
        });
        res.status(202).json(job);
    } catch (err) {
        res.status(400).json({ error: err.message || "Unable to start download" });
    }
});

app.get("/api/downloads", (req, res) => {
    res.json({ jobs: jobManager.listJobs() });
});

app.post("/api/downloads/:id/cancel", (req, res) => {
    const cancelled = jobManager.cancelJob(req.params.id);
    if (!cancelled) {
        return res.status(404).json({ error: "Download job not found" });
    }
    res.json({ ok: true });
});

app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const sendEvent = (eventName, payload) => {
        res.write(`event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    sendEvent("init", { jobs: jobManager.listJobs() });

    const onJobUpdate = (job) => sendEvent("job", job);
    jobManager.on("job", onJobUpdate);

    const heartbeat = setInterval(() => {
        res.write(": ping\n\n");
    }, 20000);

    req.on("close", () => {
        clearInterval(heartbeat);
        jobManager.off("job", onJobUpdate);
    });
});

app.get("/api/files", (req, res) => {
    res.json({ files: listDownloadedFiles() });
});

app.get("/api/files/:name", (req, res) => {
    const filePath = resolveSafeDownloadFile(req.params.name);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
    }

    if (req.query.inline === "1") {
        return res.sendFile(filePath);
    }
    return res.download(filePath, path.basename(filePath));
});

app.delete("/api/files/:name", (req, res) => {
    const filePath = resolveSafeDownloadFile(req.params.name);
    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).json({ error: "File not found" });
    }
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Universal Downloader running at http://localhost:${PORT}`);
    });
}

module.exports = app;