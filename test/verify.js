const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { execFileSync } = require("child_process");

process.env.NODE_ENV = "test";
process.env.ALLOW_TEST_LOCALHOST = "1";
process.env.PUBLIC_HOSTED_MODE = "false";

const app = require("../server");
const jobManager = require("../src/jobManager");
const storage = require("../src/storage");
const { verifySignedGuestToken } = require("../src/guestSession");
const { resolveFfmpegPath } = require("../src/binaries");
const { DOWNLOADS_DIR } = require("../src/utils");

function startServer(serverApp) {
    return new Promise((resolve) => {
        const srv = serverApp.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
        });
    });
}

async function waitForJob(baseUrl, cookie, jobId) {
    for (let i = 0; i < 200; i++) {
        await new Promise((r) => setTimeout(r, 100));
        const listRes = await fetch(`${baseUrl}/api/downloads`, {
            headers: { Cookie: cookie },
        });
        const { jobs } = await listRes.json();
        const found = jobs.find((j) => j.id === jobId);
        if (found && found.status === "completed") return found;
        if (found && found.status === "error") {
            throw new Error(`Job errored: ${found.error}`);
        }
    }
    throw new Error(`Timed out waiting for job ${jobId}`);
}

async function run() {
    const sampleArchive = Buffer.from("UNIVERSAL-DOWNLOADER-BINARY-PAYLOAD-1234567890");
    const sampleImage = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
        "hex"
    );

    const ffmpegPath = resolveFfmpegPath();
    const tmpMp4Path = path.join(DOWNLOADS_DIR, ".fixture_clip.mp4");
    execFileSync(ffmpegPath, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=320x180:d=1",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=stereo",
        "-t",
        "1",
        "-c:v",
        "libx264",
        "-c:a",
        "aac",
        tmpMp4Path,
    ]);
    const sampleVideoBytes = fs.readFileSync(tmpMp4Path);

    const mockFixture = http.createServer((req, res) => {
        if (req.url === "/clip.mp4") {
            res.writeHead(200, {
                "Content-Type": "video/mp4",
                "Content-Length": sampleVideoBytes.length,
            });
            res.end(sampleVideoBytes);
            return;
        }
        if (req.url === "/sample-archive.zip") {
            res.writeHead(200, {
                "Content-Type": "application/zip",
                "Content-Length": sampleArchive.length,
                "Content-Disposition": 'attachment; filename="test-bundle.zip"',
            });
            res.end(sampleArchive);
            return;
        }
        if (req.url === "/cdn/photo?id=42") {
            res.writeHead(200, {
                "Content-Type": "image/png",
                "Content-Length": sampleImage.length,
            });
            res.end(sampleImage);
            return;
        }
        if (req.url === "/page-assets.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
                <html>
                <head>
                    <meta property="og:image" content="/og-cover?format=jpg" />
                </head>
                <body>
                    <img src="/avatar?size=full" srcset="/small.jpg 400w, /hero.jpg 1600w" />
                    <a href="/guide.pdf">Download PDF</a>
                </body>
                </html>
            `);
            return;
        }
        if (req.url === "/page-video.html") {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`
                <html><body>
                    <video src="/clip.mp4"></video>
                </body></html>
            `);
            return;
        }
        res.writeHead(404);
        res.end("Not found");
    });

    const fixture = await startServer(mockFixture);
    const api = await startServer(app);
    const createdFiles = [];
    let guestCookie = null;
    let guestId = null;

    try {
        // 1. Health endpoint & guest session initialization
        const healthRes = await fetch(`${api.baseUrl}/api/health`);
        assert.strictEqual(healthRes.status, 200);
        guestCookie = healthRes.headers.get("set-cookie").split(";")[0];
        guestId = verifySignedGuestToken(decodeURIComponent(guestCookie.split("=")[1])).guestId;

        const health = await healthRes.json();
        assert.strictEqual(health.ok, true);
        assert.strictEqual(health.binaries.ytdlp.available, true);
        assert.strictEqual(health.binaries.ffmpeg.available, true);
        assert.strictEqual(health.binaries.galleryDl.available, true);
        assert.strictEqual(health.mode.localBrowserCookiesAllowed, true);

        const guestDir = storage.getGuestDir(guestId);

        // 2. Analyze direct archive file
        const analyzeDirectRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/sample-archive.zip` }),
        });
        assert.strictEqual(analyzeDirectRes.status, 200);
        const directInfo = await analyzeDirectRes.json();
        assert.strictEqual(directInfo.kind, "direct");
        assert.strictEqual(directInfo.filename, "test-bundle.zip");

        // 3. Analyze extensionless CDN image URL
        const analyzeImgRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/cdn/photo?id=42` }),
        });
        assert.strictEqual(analyzeImgRes.status, 200);
        const imgInfo = await analyzeImgRes.json();
        assert.strictEqual(imgInfo.kind, "direct");
        assert.strictEqual(imgInfo.category, "image");
        assert.strictEqual(imgInfo.mimeType, "image/png");
        assert.ok(imgInfo.filename.endsWith(".png"));

        // 4. Analyze webpage with og:image, srcset, extensionless <img>, and PDF
        const analyzePageRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/page-assets.html` }),
        });
        assert.strictEqual(analyzePageRes.status, 200);
        const pageInfo = await analyzePageRes.json();
        assert.strictEqual(pageInfo.kind, "webpage");
        assert.strictEqual(pageInfo.allowHtmlSave, true);
        assert.ok(pageInfo.assets.some((a) => a.url.includes("/og-cover?format=jpg")));
        assert.ok(pageInfo.assets.some((a) => a.url.includes("/hero.jpg")));
        assert.ok(pageInfo.assets.some((a) => a.url.includes("/avatar?size=full")));
        assert.ok(pageInfo.assets.some((a) => a.url.includes("/guide.pdf")));

        // 5. Analyze webpage with HTML5 video
        const analyzeVideoPageRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/page-video.html` }),
        });
        assert.strictEqual(analyzeVideoPageRes.status, 200);
        const videoPageInfo = await analyzeVideoPageRes.json();
        assert.strictEqual(videoPageInfo.kind, "media");

        // 5b. Explicit contentType filtering ("image", "document", "webpage")
        const analyzeImageModeRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-assets.html`,
                contentType: "image",
            }),
        });
        assert.strictEqual(analyzeImageModeRes.status, 200);
        const imageModeInfo = await analyzeImageModeRes.json();
        assert.strictEqual(imageModeInfo.kind, "webpage");
        assert.ok(imageModeInfo.assets.every((a) => a.category === "image"));

        const analyzeDocModeRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-assets.html`,
                contentType: "document",
            }),
        });
        assert.strictEqual(analyzeDocModeRes.status, 200);
        const docModeInfo = await analyzeDocModeRes.json();
        assert.strictEqual(docModeInfo.kind, "webpage");
        assert.ok(docModeInfo.assets.some((a) => a.url.includes("/guide.pdf")));

        const analyzeWebpageModeRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-video.html`,
                contentType: "webpage",
            }),
        });
        assert.strictEqual(analyzeWebpageModeRes.status, 200);
        const webpageModeInfo = await analyzeWebpageModeRes.json();
        assert.strictEqual(webpageModeInfo.kind, "webpage");
        assert.ok(webpageModeInfo.assets.some((a) => a.url.includes("/clip.mp4")));

        // 6. Download direct ZIP file
        const dlZipRes = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/sample-archive.zip` }),
        });
        assert.strictEqual(dlZipRes.status, 202);
        const zipJob = await waitForJob(api.baseUrl, guestCookie, (await dlZipRes.json()).id);
        createdFiles.push(zipJob.filename);
        assert.deepStrictEqual(fs.readFileSync(path.join(guestDir, zipJob.filename)), sampleArchive);

        // 7. Download extensionless CDN image
        const dlImgRes = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({ url: `${fixture.baseUrl}/cdn/photo?id=42` }),
        });
        assert.strictEqual(dlImgRes.status, 202);
        const imgJob = await waitForJob(api.baseUrl, guestCookie, (await dlImgRes.json()).id);
        createdFiles.push(imgJob.filename);
        assert.ok(imgJob.filename.endsWith(".png"));
        assert.deepStrictEqual(fs.readFileSync(path.join(guestDir, imgJob.filename)), sampleImage);

        // 7b. Verify Target Quality dropdown selectors + real yt-dlp/ffmpeg MP4 & MP3 downloads
        const expectedSort = {
            "4k": "res:2160,ext:mp4:m4a",
            max: "ext:mp4:m4a",
            "1440p": "res:1440,ext:mp4:m4a",
            "1080p": "res:1080,ext:mp4:m4a",
            "720p": "res:720,ext:mp4:m4a",
        };
        for (const [q, sortStr] of Object.entries(expectedSort)) {
            const sel = jobManager._buildFormatSelector(q, true, "mp4");
            assert.strictEqual(sel.format, "bestvideo+bestaudio/best");
            assert.strictEqual(sel.formatSort, sortStr);
        }
        const audioSel = jobManager._buildFormatSelector("audio", true, "mp4");
        assert.strictEqual(audioSel.format, "bestaudio/best");
        assert.deepStrictEqual(audioSel.extraArgs, ["-x", "--audio-format", "mp3", "--audio-quality", "0"]);

        const dl1080Res = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-video.html`,
                contentType: "video",
                quality: "1080p",
                container: "mp4",
            }),
        });
        assert.strictEqual(dl1080Res.status, 202);
        const job1080 = await waitForJob(api.baseUrl, guestCookie, (await dl1080Res.json()).id);
        createdFiles.push(job1080.filename);
        assert.ok(job1080.filename.includes("[1080p]"));

        const dl720Res = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-video.html`,
                contentType: "video",
                quality: "720p",
                container: "mp4",
            }),
        });
        assert.strictEqual(dl720Res.status, 202);
        const job720 = await waitForJob(api.baseUrl, guestCookie, (await dl720Res.json()).id);
        createdFiles.push(job720.filename);
        assert.ok(job720.filename.includes("[720p]"));
        assert.notStrictEqual(job1080.filename, job720.filename);

        const dlAudioRes = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestCookie },
            body: JSON.stringify({
                url: `${fixture.baseUrl}/page-video.html`,
                contentType: "auto",
                quality: "audio",
            }),
        });
        assert.strictEqual(dlAudioRes.status, 202);
        const jobAudio = await waitForJob(api.baseUrl, guestCookie, (await dlAudioRes.json()).id);
        createdFiles.push(jobAudio.filename);
        assert.ok(jobAudio.filename.endsWith(".mp3"));

        // 8. File listing & deletion
        const filesRes = await fetch(`${api.baseUrl}/api/files`, {
            headers: { Cookie: guestCookie },
        });
        const { files } = await filesRes.json();
        for (const name of createdFiles) {
            assert.ok(files.some((f) => f.name === name));
            const delRes = await fetch(
                `${api.baseUrl}/api/files/${encodeURIComponent(name)}`,
                { method: "DELETE", headers: { Cookie: guestCookie } }
            );
            assert.strictEqual(delRes.status, 200);
            assert.strictEqual(fs.existsSync(path.join(guestDir, name)), false);
        }
        createdFiles.length = 0;

        console.log("ALL LOCAL API, IMAGE, WEBPAGE & FILE DOWNLOAD TESTS PASSED");
    } finally {
        if (fs.existsSync(tmpMp4Path)) fs.unlinkSync(tmpMp4Path);
        if (guestId) {
            fs.rmSync(storage.getGuestDir(guestId), { recursive: true, force: true });
        }
        fixture.server.close();
        api.server.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
