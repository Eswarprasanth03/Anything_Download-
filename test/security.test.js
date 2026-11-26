const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");

// Force hosted public mode for security tests (and no ALLOW_TEST_LOCALHOST)
process.env.PUBLIC_HOSTED_MODE = "true";
process.env.NODE_ENV = "production";
process.env.SESSION_SECRET = "test-secret-for-security-suite-32bytes";

const app = require("../server");
const config = require("../src/config");
const {
    generateGuestId,
    createSignedGuestToken,
    verifySignedGuestToken,
} = require("../src/guestSession");
const {
    isPrivateOrReservedIp,
    validatePublicHttpUrl,
    assertSafePublicUrl,
} = require("../src/ssrf");
const storage = require("../src/storage");
const jobManager = require("../src/jobManager");
const { formatExtractorError } = require("../src/analyzer");

function startServer(serverApp) {
    return new Promise((resolve) => {
        const srv = serverApp.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            resolve({ server: srv, baseUrl: `http://127.0.0.1:${addr.port}` });
        });
    });
}

function extractCookiePair(res) {
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) return null;
    return setCookie.split(";")[0];
}

async function run() {
    // 1. Guest token generation, signing, tamper & expiry checks
    const gid = generateGuestId();
    assert.match(gid, /^[a-f0-9]{32}$/);
    const token = createSignedGuestToken(gid, 1_000_000);
    const verified = verifySignedGuestToken(token, 1_005_000);
    assert.strictEqual(verified.guestId, gid);

    const [p1, p2, sig] = token.split(".");
    const tampered = `${p1}.${p2}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;
    assert.strictEqual(verifySignedGuestToken(tampered, 1_005_000), null);
    assert.strictEqual(verifySignedGuestToken(`../evil.${p2}.${sig}`, 1_005_000), null);
    assert.strictEqual(verifySignedGuestToken(token, 1_000_000 + 48 * 3600 * 1000), null);

    // 2. IP & URL SSRF validation checks
    const blockedIps = [
        "127.0.0.1",
        "127.10.0.1",
        "10.0.0.1",
        "172.16.0.1",
        "172.31.255.254",
        "192.168.1.10",
        "169.254.169.254",
        "100.64.0.1",
        "0.0.0.0",
        "::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "::ffff:7f00:1",
    ];
    for (const ip of blockedIps) {
        assert.strictEqual(isPrivateOrReservedIp(ip), true, `Expected ${ip} to be blocked`);
    }
    assert.strictEqual(isPrivateOrReservedIp("93.184.216.34"), false);
    assert.strictEqual(isPrivateOrReservedIp("2606:2800:220:1:248:1893:25c8:1946"), false);

    const blockedUrls = [
        "file:///etc/passwd",
        "ftp://example.com/file.zip",
        "javascript:alert(1)",
        "http://user:pass@example.com/",
        "http://localhost:4000/api/health",
        "http://sub.localhost/",
        "http://internal-service.local/",
        "http://127.0.0.1:4000/",
        "http://[::1]:4000/",
        "http://169.254.169.254/latest/meta-data/",
        "http://192.168.0.1/",
        "http://10.20.30.40/",
    ];
    for (const badUrl of blockedUrls) {
        assert.throws(() => validatePublicHttpUrl(badUrl), `Expected ${badUrl} to be rejected`);
    }

    // DNS rebinding / private DNS resolution check
    await assert.rejects(
        () =>
            assertSafePublicUrl("https://rebind.example.com/file.mp4", {
                lookupFn: async () => [{ address: "10.0.0.5", family: 4 }],
            }),
        /private or reserved IP/i
    );
    await assert.rejects(
        () =>
            assertSafePublicUrl("https://v6local.example.com/file.mp4", {
                lookupFn: async () => [{ address: "::1", family: 6 }],
            }),
        /private or reserved IP/i
    );
    const okPublic = await assertSafePublicUrl("https://example.com/video.mp4", {
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
    });
    assert.strictEqual(okPublic, "https://example.com/video.mp4");

    // 3. Extractor error sanitization checks
    const ytBotMsg = formatExtractorError(
        "ERROR: [youtube] xyz: Sign in to confirm you're not a bot. /app/secret/path/file"
    );
    assert.ok(ytBotMsg.includes("anti-bot verification"));
    assert.ok(!ytBotMsg.includes("/app/secret/path/"));

    // 4. Live HTTP server isolation, cookies restriction, XSS protection & cleanup
    const api = await startServer(app);
    let guestACookie = null;
    let guestBCookie = null;
    let guestAId = null;
    let guestBId = null;

    try {
        // Guest A gets signed HttpOnly cookie
        const resA = await fetch(`${api.baseUrl}/api/health`);
        assert.strictEqual(resA.status, 200);
        const setCookieA = resA.headers.get("set-cookie");
        assert.ok(setCookieA && setCookieA.includes("HttpOnly"));
        assert.ok(setCookieA.includes("SameSite=Lax"));
        guestACookie = extractCookiePair(resA);
        const healthA = await resA.json();
        assert.strictEqual(healthA.mode.publicHosted, true);
        assert.strictEqual(healthA.mode.localBrowserCookiesAllowed, false);
        assert.strictEqual(healthA.downloadsDir, undefined);
        assert.strictEqual(healthA.binaries.ytdlp.path, undefined);

        // Guest B gets distinct signed cookie
        const resB = await fetch(`${api.baseUrl}/api/health`);
        guestBCookie = extractCookiePair(resB);
        assert.notStrictEqual(guestACookie, guestBCookie);

        guestAId = verifySignedGuestToken(decodeURIComponent(guestACookie.split("=")[1])).guestId;
        guestBId = verifySignedGuestToken(decodeURIComponent(guestBCookie.split("=")[1])).guestId;

        // Hosted mode rejects visitor cookies.txt and browser cookies
        const rejectTxtRes = await fetch(`${api.baseUrl}/api/analyze`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestACookie },
            body: JSON.stringify({
                url: "https://example.com/video.mp4",
                cookiesTxt: "# Netscape HTTP Cookie File\n",
            }),
        });
        assert.strictEqual(rejectTxtRes.status, 400);
        assert.match((await rejectTxtRes.json()).error, /disabled/i);

        const rejectBrowserRes = await fetch(`${api.baseUrl}/api/downloads`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Cookie: guestACookie },
            body: JSON.stringify({
                url: "https://example.com/video.mp4",
                cookiesBrowser: "chrome",
            }),
        });
        assert.strictEqual(rejectBrowserRes.status, 400);
        assert.match((await rejectBrowserRes.json()).error, /local development/i);

        // Tampered cookie cannot impersonate Guest A
        const guestADir = storage.getGuestDir(guestAId);
        fs.writeFileSync(path.join(guestADir, "secret.txt"), "guest-a-private");
        fs.writeFileSync(path.join(guestADir, "evil.html"), "<script>alert(1)</script>");

        const forgedRes = await fetch(`${api.baseUrl}/api/files`, {
            headers: { Cookie: "ad_guest=forged.12345.bad" },
        });
        assert.strictEqual(forgedRes.status, 200);
        const forgedFiles = await forgedRes.json();
        assert.strictEqual(forgedFiles.files.length, 0);

        // Guest B cannot list, download, or delete Guest A's files
        const listBRes = await fetch(`${api.baseUrl}/api/files`, {
            headers: { Cookie: guestBCookie },
        });
        assert.strictEqual((await listBRes.json()).files.length, 0);

        const getAByB = await fetch(`${api.baseUrl}/api/files/secret.txt`, {
            headers: { Cookie: guestBCookie },
        });
        assert.strictEqual(getAByB.status, 404);

        const delAByB = await fetch(`${api.baseUrl}/api/files/secret.txt`, {
            method: "DELETE",
            headers: { Cookie: guestBCookie },
        });
        assert.strictEqual(delAByB.status, 404);

        // Path traversal blocked
        const traversalRes = await fetch(`${api.baseUrl}/api/files/..%2F..%2Fserver.js`, {
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(traversalRes.status, 404);

        // HTML inline preview forced as attachment with nosniff
        const htmlPreviewRes = await fetch(`${api.baseUrl}/api/files/evil.html?inline=1`, {
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(htmlPreviewRes.status, 200);
        assert.strictEqual(htmlPreviewRes.headers.get("x-content-type-options"), "nosniff");
        assert.match(htmlPreviewRes.headers.get("content-disposition") || "", /attachment/i);

        // Job & cancellation isolation between Guest A and Guest B
        const jobAId = "testjob_a_1";
        jobManager.jobs.set(jobAId, {
            id: jobAId,
            guestId: guestAId,
            url: "https://example.com/a.mp4",
            status: "downloading",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });

        const jobsBRes = await fetch(`${api.baseUrl}/api/downloads`, {
            headers: { Cookie: guestBCookie },
        });
        assert.strictEqual((await jobsBRes.json()).jobs.length, 0);

        const cancelAByB = await fetch(`${api.baseUrl}/api/downloads/${jobAId}/cancel`, {
            method: "POST",
            headers: { Cookie: guestBCookie },
        });
        assert.strictEqual(cancelAByB.status, 404);

        // SSE event isolation: Guest B only sees Guest B jobs, never Guest A job updates
        const sseController = new AbortController();
        const sseRes = await fetch(`${api.baseUrl}/api/events`, {
            headers: { Cookie: guestBCookie },
            signal: sseController.signal,
        });
        const reader = sseRes.body.getReader();
        const decoder = new TextDecoder();
        const firstChunk = decoder.decode((await reader.read()).value);
        assert.ok(firstChunk.includes("event: init"));
        assert.ok(!firstChunk.includes(jobAId));

        jobManager.updateJob(jobAId, { progress: 50 });
        const jobBId = "testjob_b_1";
        jobManager.jobs.set(jobBId, {
            id: jobBId,
            guestId: guestBId,
            url: "https://example.com/b.mp4",
            status: "downloading",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        });
        jobManager.updateJob(jobBId, { progress: 75 });

        const secondChunk = decoder.decode((await reader.read()).value);
        assert.ok(secondChunk.includes(jobBId));
        assert.ok(!secondChunk.includes(jobAId));
        sseController.abort();
        jobManager.jobs.delete(jobAId);
        jobManager.jobs.delete(jobBId);

        // Missing or deleted files return clear 404 without crashing
        const missingGet = await fetch(`${api.baseUrl}/api/files/nonexistent.mp4`, {
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(missingGet.status, 404);
        assert.match((await missingGet.json()).error, /not found/i);

        const missingInline = await fetch(`${api.baseUrl}/api/files/nonexistent.mp4?inline=1`, {
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(missingInline.status, 404);

        const missingDel = await fetch(`${api.baseUrl}/api/files/nonexistent.mp4`, {
            method: "DELETE",
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(missingDel.status, 404);

        // Verify Render Free TTL, cleanup interval, storage bounds & writability
        assert.strictEqual(config.FILE_TTL_MS, 60 * 60 * 1000);
        assert.strictEqual(config.CLEANUP_INTERVAL_MS, 5 * 60 * 1000);
        assert.ok(config.MAX_TOTAL_STORAGE_BYTES <= 1024 * 1024 * 1024);
        const readyPaths = storage.ensureStorageReady();
        assert.ok(readyPaths.guestsRootDir.endsWith(path.join("downloads", "guests")));

        // Verify storage quota & real disk availability checks
        assert.throws(
            () => storage.assertStorageQuota(guestAId, config.MAX_DOWNLOAD_BYTES + 1),
            /maximum allowed size/i
        );
        assert.throws(
            () => storage.assertStorageQuota(guestAId, 1024, { availableDiskBytes: config.MIN_FREE_DISK_BYTES }),
            /disk capacity is currently low/i
        );
        const origGuestMax = config.MAX_GUEST_STORAGE_BYTES;
        const origTotalMax = config.MAX_TOTAL_STORAGE_BYTES;
        try {
            config.MAX_GUEST_STORAGE_BYTES = 10;
            assert.throws(
                () => storage.assertStorageQuota(guestAId, 1, { availableDiskBytes: 10 * 1024 * 1024 * 1024 }),
                /guest storage quota is full/i
            );
            config.MAX_GUEST_STORAGE_BYTES = origGuestMax;
            config.MAX_TOTAL_STORAGE_BYTES = 10;
            assert.throws(
                () => storage.assertStorageQuota(guestAId, 1, { availableDiskBytes: 10 * 1024 * 1024 * 1024 }),
                /server temporary storage is currently full/i
            );
        } finally {
            config.MAX_GUEST_STORAGE_BYTES = origGuestMax;
            config.MAX_TOTAL_STORAGE_BYTES = origTotalMax;
        }

        // Cleanup removes expired files & expired terminal jobs, while protecting active downloads
        const activeJobId = "active_dl_1";
        const expiredJobId = "expired_done_1";
        const guestBDir = storage.getGuestDir(guestBId);
        const activePartPath = path.join(guestBDir, "in_progress.mp4.part");
        const activeStagingDir = path.join(guestBDir, `.staging_${activeJobId}`);
        fs.writeFileSync(activePartPath, "partial-bytes");
        fs.mkdirSync(activeStagingDir, { recursive: true });
        fs.writeFileSync(path.join(activeStagingDir, "frag.ts"), "fragment");

        const oldIso = new Date(Date.now() - 2 * config.FILE_TTL_MS).toISOString();
        jobManager.jobs.set(activeJobId, {
            id: activeJobId,
            guestId: guestBId,
            url: "https://example.com/active.mp4",
            status: "downloading",
            createdAt: oldIso,
            updatedAt: oldIso,
        });
        jobManager.trackActiveFilePath(activeJobId, activePartPath);

        jobManager.jobs.set(expiredJobId, {
            id: expiredJobId,
            guestId: guestAId,
            url: "https://example.com/old.mp4",
            status: "completed",
            filename: "secret.txt",
            createdAt: oldIso,
            updatedAt: oldIso,
        });

        const cycleRes = jobManager.runCleanupCycle(Date.now() + 2 * config.FILE_TTL_MS);
        assert.ok(cycleRes.removedFiles >= 2);
        assert.ok(cycleRes.prunedJobs >= 1);
        assert.strictEqual(storage.listGuestFiles(guestAId).length, 0);
        assert.strictEqual(jobManager.getJob(expiredJobId), null);

        // Active download files, staging dir, and active job record MUST survive cleanup
        assert.strictEqual(fs.existsSync(activePartPath), true);
        assert.strictEqual(fs.existsSync(activeStagingDir), true);
        assert.ok(jobManager.getJob(activeJobId));
        jobManager.clearTrackedFilePaths(activeJobId);
        jobManager.jobs.delete(activeJobId);

        // Fetching an expired/deleted file returns 404
        const expiredGet = await fetch(`${api.baseUrl}/api/files/secret.txt`, {
            headers: { Cookie: guestACookie },
        });
        assert.strictEqual(expiredGet.status, 404);

        console.log("ALL GUEST ISOLATION, SSRF, COOKIE POLICY & SECURITY TESTS PASSED");
    } finally {
        if (guestAId) fs.rmSync(storage.getGuestDir(guestAId), { recursive: true, force: true });
        if (guestBId) fs.rmSync(storage.getGuestDir(guestBId), { recursive: true, force: true });
        api.server.close();
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
