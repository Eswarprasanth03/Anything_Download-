const urlInput = document.getElementById("urlInput");
const pasteBtn = document.getElementById("pasteBtn");
const analyzeBtn = document.getElementById("analyzeBtn");
const downloadBtn = document.getElementById("downloadBtn");
const downloadForm = document.getElementById("downloadForm");
const qualitySelect = document.getElementById("qualitySelect");
const containerSelect = document.getElementById("containerSelect");
const qualityGroup = document.getElementById("qualityGroup");
const containerGroup = document.getElementById("containerGroup");
const contentTypePills = document.getElementById("contentTypePills");
const contentTypeHint = document.getElementById("contentTypeHint");
const cookiesGroup = document.getElementById("cookiesGroup");
const cookiesSelect = document.getElementById("cookiesSelect");
const filenameInput = document.getElementById("filenameInput");
const statusBanner = document.getElementById("statusBanner");
const previewCard = document.getElementById("previewCard");
const engineStatus = document.getElementById("engineStatus");
const jobsList = document.getElementById("jobsList");
const jobCount = document.getElementById("jobCount");
const filesList = document.getElementById("filesList");
const downloadsDirLabel = document.getElementById("downloadsDirLabel");
const refreshFilesBtn = document.getElementById("refreshFilesBtn");

const jobsMap = new Map();
let selectedContentType = "auto";
let localBrowserCookiesAllowed = false;
const MAX_SHARE_BYTES = 50 * 1024 * 1024;
const canNativeFileShare =
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function";

function getApiBase() {
    if (typeof window.API_BASE_URL === "string" && window.API_BASE_URL.trim()) {
        return window.API_BASE_URL.trim().replace(/\/+$/, "");
    }
    const meta = document.querySelector('meta[name="api-base-url"]');
    const content = meta?.getAttribute("content") || "";
    return content.trim().replace(/\/+$/, "");
}

function apiUrl(endpointPath) {
    return `${getApiBase()}${endpointPath}`;
}

function apiFetch(endpointPath, options = {}) {
    return fetch(apiUrl(endpointPath), {
        credentials: "include",
        ...options,
    });
}

function supportsFileShare(file) {
    if (!canNativeFileShare || !file || file.size > MAX_SHARE_BYTES) return false;
    try {
        const probe = new File([""], file.name || "file", {
            type: file.mimeType || "application/octet-stream",
        });
        return navigator.canShare({ files: [probe] });
    } catch {
        return false;
    }
}

async function shareFileToDevice(filename, mimeType, triggerBtn) {
    const originalText = triggerBtn?.textContent || "Share / Photos";
    if (triggerBtn) {
        triggerBtn.disabled = true;
        triggerBtn.textContent = "Preparing...";
    }
    try {
        const res = await apiFetch(`/api/files/${encodeURIComponent(filename)}`);
        if (!res.ok) throw new Error("Unable to fetch file for sharing");
        const blob = await res.blob();
        const fileObj = new File([blob], filename, {
            type: mimeType || blob.type || "application/octet-stream",
        });
        await navigator.share({ files: [fileObj], title: filename });
    } catch (err) {
        if (err && err.name !== "AbortError") {
            showBanner(err.message || "Share not supported for this file — tap Save to Device instead.", "info");
        }
    } finally {
        if (triggerBtn) {
            triggerBtn.disabled = false;
            triggerBtn.textContent = originalText;
        }
    }
}

const CONTENT_TYPE_HINTS = {
    auto: "Automatically detects video, image, audio, or direct file",
    video: "Downloads video in 4K / 1080p+ from YouTube, Instagram, X, TikTok, or direct MP4/MKV",
    image: "Downloads original-resolution images & carousels from Instagram, X, Pinterest, Reddit, or direct image URLs",
    audio: "Extracts high-quality MP3 audio from videos or downloads direct audio files",
    document: "Downloads direct files of any type (PDF, ZIP, DOCX, DMG, EXE, APK, CSV, JSON, etc.)",
    webpage: "Inspect extracts all images, videos & files on the page; Download Now saves the HTML page",
};

function escapeHtml(str) {
    return String(str ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 2)} ${units[idx]}`;
}

function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    if (hrs > 0) {
        return `${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    }
    return `${mins}:${String(secs).padStart(2, "0")}`;
}

function showBanner(message, type = "info") {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner ${type}`;
    statusBanner.classList.remove("hidden");
}

function hideBanner() {
    statusBanner.classList.add("hidden");
}

async function loadHealth() {
    try {
        const res = await apiFetch("/api/health");
        const data = await res.json();

        localBrowserCookiesAllowed = Boolean(data.mode?.localBrowserCookiesAllowed);
        cookiesGroup.classList.toggle("hidden", !localBrowserCookiesAllowed);
        if (!localBrowserCookiesAllowed) {
            cookiesSelect.value = "";
        }

        const ttlMins = data.limits?.fileTtlMs ? Math.round(data.limits.fileTtlMs / 60000) : 60;
        const maxMb = data.limits?.maxDownloadBytes
            ? Math.round(data.limits.maxDownloadBytes / (1024 * 1024))
            : 200;
        downloadsDirLabel.textContent = data.downloadsDir
            ? `Folder: ${data.downloadsDir} · Auto-cleanup: ${ttlMins}m · Max file: ${maxMb} MB · Tap Save to Device to store locally`
            : `Isolated guest storage (${ttlMins}m TTL · Max ${maxMb} MB) · Tap Save to Device to store in your device Downloads/Files`;

        const ytdlpPill = data.binaries.ytdlp.available
            ? `<span class="pill pill-ok">yt-dlp ready</span>`
            : `<span class="pill pill-warn">yt-dlp missing</span>`;
        const ffmpegPill = data.binaries.ffmpeg.available
            ? `<span class="pill pill-ok">ffmpeg ready (4K/1080p)</span>`
            : `<span class="pill pill-warn">ffmpeg missing</span>`;
        const galleryPill = data.binaries.galleryDl?.available
            ? `<span class="pill pill-ok">gallery-dl ready (images)</span>`
            : `<span class="pill pill-warn">gallery-dl missing</span>`;
        const modePill = data.mode?.publicHosted
            ? `<span class="pill pill-muted">Public guest mode</span>`
            : `<span class="pill pill-muted">Local dev mode</span>`;

        engineStatus.innerHTML = `${ytdlpPill}${ffmpegPill}${galleryPill}${modePill}`;
    } catch {
        engineStatus.innerHTML = `<span class="pill pill-warn">Server status unavailable</span>`;
    }
}

async function inspectCurrentUrl() {
    const url = urlInput.value.trim();
    if (!url) {
        showBanner("Please paste a link first.", "error");
        return;
    }

    hideBanner();
    analyzeBtn.disabled = true;
    analyzeBtn.textContent = "Inspecting...";
    previewCard.classList.add("hidden");

    try {
        const res = await apiFetch("/api/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url,
                ...(localBrowserCookiesAllowed && cookiesSelect.value
                    ? { cookiesBrowser: cookiesSelect.value }
                    : {}),
                contentType: selectedContentType,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || "Failed to inspect link");
        }
        renderPreview(data);
    } catch (err) {
        showBanner(err.message, "error");
    } finally {
        analyzeBtn.disabled = false;
        analyzeBtn.textContent = "Inspect Link";
    }
}

function renderPreview(info) {
    previewCard.classList.remove("hidden");

    if (info.kind === "direct") {
        const isImage = info.category === "image" || (info.mimeType || "").startsWith("image/");
        previewCard.innerHTML = `
            <div class="preview-layout">
                ${isImage ? `<img class="direct-image-preview" src="${escapeHtml(info.url)}" alt="${escapeHtml(info.filename)}" />` : ""}
                <div class="preview-info">
                    <h3>Direct ${escapeHtml((info.category || "file").toUpperCase())}: ${escapeHtml(info.filename)}</h3>
                    <div class="preview-meta">
                        <span class="pill pill-ok">${escapeHtml(info.mimeType)}</span>
                        <span class="pill pill-muted">${formatBytes(info.fileSize)}</span>
                        <span class="pill pill-muted">${escapeHtml(info.platform)}</span>
                    </div>
                    <div class="preset-actions">
                        <button type="button" class="btn btn-primary" data-quick-url="${escapeHtml(info.url)}" data-quick-direct="1">
                            Download ${isImage ? "Image" : "File"}
                        </button>
                    </div>
                </div>
            </div>
        `;
        bindPreviewButtons();
        return;
    }

    if (info.kind === "gallery") {
        const cardsHtml = (info.items || [])
            .map(
                (item, idx) => `
                <div class="gallery-card">
                    ${item.category === "image" ? `<img src="${escapeHtml(item.url)}" alt="Item ${idx + 1}" loading="lazy" />` : ""}
                    <div class="file-meta">${escapeHtml(item.ext.toUpperCase())}${item.width && item.height ? ` · ${item.width}×${item.height}` : ""}</div>
                    <button type="button" class="btn btn-secondary btn-sm" data-quick-url="${escapeHtml(item.url)}" data-quick-direct="1">
                        Download #${idx + 1}
                    </button>
                </div>
            `
            )
            .join("");

        previewCard.innerHTML = `
            <div>
                <div class="section-header">
                    <div>
                        <h3>${escapeHtml(info.title)}</h3>
                        <div class="preview-meta">
                            <span class="pill pill-ok">${escapeHtml(info.platform)}</span>
                            ${info.uploader ? `<span class="pill pill-muted">${escapeHtml(info.uploader)}</span>` : ""}
                            <span class="pill pill-muted">${info.itemCount} item(s)</span>
                        </div>
                    </div>
                    <button type="button" class="btn btn-primary" data-quick-url="${escapeHtml(info.url)}">
                        Download All (${info.itemCount})
                    </button>
                </div>
                <div class="gallery-grid">${cardsHtml}</div>
            </div>
        `;
        bindPreviewButtons();
        return;
    }

    if (info.kind === "webpage") {
        const itemsHtml = (info.assets || [])
            .map(
                (asset) => `
                <div class="asset-item">
                    <div class="asset-left">
                        ${asset.category === "image" ? `<img class="asset-thumb" src="${escapeHtml(asset.url)}" alt="" loading="lazy" />` : ""}
                        <div>
                            <div class="file-name">${escapeHtml(asset.filename)}</div>
                            <div class="file-meta">${escapeHtml((asset.category || "file").toUpperCase())} · ${escapeHtml(asset.ext.toUpperCase())} · ${escapeHtml(asset.url)}</div>
                        </div>
                    </div>
                    <button type="button" class="btn btn-primary btn-sm" data-quick-url="${escapeHtml(asset.url)}" data-quick-direct="1">
                        Download
                    </button>
                </div>
            `
            )
            .join("");

        previewCard.innerHTML = `
            <div>
                <div class="section-header">
                    <div>
                        <h3>${escapeHtml(info.title)} (${info.assets.length} assets found)</h3>
                        <p class="subtitle">${escapeHtml(info.note || "")}</p>
                    </div>
                    ${
                        info.allowHtmlSave
                            ? `<button type="button" class="btn btn-secondary btn-sm" data-quick-url="${escapeHtml(info.url)}" data-quick-direct="1">Save Webpage (.html)</button>`
                            : ""
                    }
                </div>
                ${itemsHtml ? `<div class="assets-list">${itemsHtml}</div>` : ""}
            </div>
        `;
        bindPreviewButtons();
        return;
    }

    const duration = formatDuration(info.duration);
    const qualitySummary = info.has4K
        ? `<span class="pill pill-ok">4K Available (${info.maxHeight}p)</span>`
        : info.has1080p
            ? `<span class="pill pill-ok">1080p Available (${info.maxHeight}p max)</span>`
            : info.maxHeight
                ? `<span class="pill pill-warn">Source max: ${info.maxHeight}p</span>`
                : "";

    const presetButtons = (info.presets || [])
        .map(
            (preset) => `
            <button
                type="button"
                class="btn ${preset.id === "4k" || preset.id === "max" ? "btn-primary" : "btn-secondary"} btn-sm"
                data-quick-url="${escapeHtml(info.url)}"
                data-quick-quality="${escapeHtml(preset.id)}"
            >
                Download ${escapeHtml(preset.label)}
            </button>
        `
        )
        .join("");

    previewCard.innerHTML = `
        <div class="preview-layout">
            ${info.thumbnail ? `<img class="preview-thumb" src="${escapeHtml(info.thumbnail)}" alt="Thumbnail" />` : ""}
            <div class="preview-info">
                <h3>${escapeHtml(info.title)}</h3>
                <div class="preview-meta">
                    <span class="pill pill-muted">${escapeHtml(info.platform)}</span>
                    ${info.uploader ? `<span class="pill pill-muted">${escapeHtml(info.uploader)}</span>` : ""}
                    ${duration ? `<span class="pill pill-muted">${duration}</span>` : ""}
                    ${qualitySummary}
                </div>
                <div class="preset-actions">${presetButtons}</div>
            </div>
        </div>
    `;
    bindPreviewButtons();
}

function bindPreviewButtons() {
    previewCard.querySelectorAll("[data-quick-url]").forEach((btn) => {
        btn.addEventListener("click", () => {
            const targetUrl = btn.getAttribute("data-quick-url");
            const quality = btn.getAttribute("data-quick-quality");
            const forceDirect = btn.getAttribute("data-quick-direct") === "1";
            if (quality && Array.from(qualitySelect.options).some((opt) => opt.value === quality)) {
                qualitySelect.value = quality;
                syncContainerForQuality();
            }
            startDownload(targetUrl, quality || qualitySelect.value, forceDirect);
        });
    });
}

async function startDownload(overrideUrl, overrideQuality, forceDirect = false) {
    const url = (overrideUrl || urlInput.value).trim();
    if (!url) {
        showBanner("Please enter a valid URL.", "error");
        return;
    }

    hideBanner();
    downloadBtn.disabled = true;

    try {
        const res = await apiFetch("/api/downloads", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url,
                quality: overrideQuality || qualitySelect.value,
                container: containerSelect.value,
                ...(localBrowserCookiesAllowed && cookiesSelect.value
                    ? { cookiesBrowser: cookiesSelect.value }
                    : {}),
                customFilename: filenameInput.value.trim(),
                forceDirect,
                contentType: forceDirect ? "auto" : selectedContentType,
            }),
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.error || "Failed to start download");
        }
        jobsMap.set(data.id, data);
        renderJobs();
    } catch (err) {
        showBanner(err.message, "error");
    } finally {
        downloadBtn.disabled = false;
    }
}

async function cancelJob(id) {
    await apiFetch(`/api/downloads/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

function renderJobs() {
    const jobs = Array.from(jobsMap.values()).sort(
        (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );
    jobCount.textContent = String(jobs.length);

    if (jobs.length === 0) {
        jobsList.innerHTML = `<div class="empty-state">No downloads yet. Paste any link above to begin.</div>`;
        return;
    }

    jobsList.innerHTML = jobs
        .map((job) => {
            const pct = Number.isFinite(job.progress) ? job.progress : 0;
            const fillClass =
                job.status === "completed" ? "done" : job.status === "error" || job.status === "cancelled" ? "err" : "";

            const statsParts = [];
            if (job.resolution) statsParts.push(job.resolution);
            if (job.mode) statsParts.push(job.mode.toUpperCase());
            if (job.totalBytes) statsParts.push(formatBytes(job.totalBytes));
            if (typeof job.speed === "number") statsParts.push(`${formatBytes(job.speed)}/s`);
            else if (typeof job.speed === "string" && job.speed) statsParts.push(job.speed);
            if (job.eta && job.status === "downloading") statsParts.push(`ETA ${job.eta}`);

            const active =
                job.status === "queued" ||
                job.status === "analyzing" ||
                job.status === "downloading" ||
                job.status === "merging";

            const savedFiles =
                Array.isArray(job.files) && job.files.length > 0
                    ? job.files
                    : job.filename
                        ? [job.filename]
                        : [];

            return `
                <div class="job-item">
                    <div class="job-top">
                        <div>
                            <div class="job-title">${escapeHtml(job.filename || job.title || job.url)}</div>
                            <div class="job-sub">${escapeHtml(job.message || job.status)} ${statsParts.length ? `· ${escapeHtml(statsParts.join(" · "))}` : ""}</div>
                        </div>
                        <div class="job-actions">
                            ${
                                active
                                    ? `<button type="button" class="btn btn-danger btn-sm" data-cancel-id="${escapeHtml(job.id)}">Cancel</button>`
                                    : ""
                            }
                            ${
                                job.status === "completed" && savedFiles.length === 1
                                    ? `<a class="btn btn-primary btn-sm" href="${escapeHtml(apiUrl(`/api/files/${encodeURIComponent(savedFiles[0])}`))}" download="${escapeHtml(savedFiles[0])}">Save to Device</a>`
                                    : job.status === "completed" && savedFiles.length > 1
                                        ? `<span class="pill pill-ok">${savedFiles.length} files saved below</span>`
                                        : ""
                            }
                        </div>
                    </div>
                    <div class="progress-track">
                        <div class="progress-fill ${fillClass}" style="width: ${job.status === "completed" ? 100 : pct}%"></div>
                    </div>
                </div>
            `;
        })
        .join("");

    jobsList.querySelectorAll("[data-cancel-id]").forEach((btn) => {
        btn.addEventListener("click", () => cancelJob(btn.getAttribute("data-cancel-id")));
    });
}

async function syncJobs() {
    try {
        const res = await apiFetch("/api/downloads");
        if (!res.ok) return;
        const data = await res.json();
        jobsMap.clear();
        for (const job of data.jobs || []) {
            jobsMap.set(job.id, job);
        }
        renderJobs();
    } catch {
        // Ignore transient sync errors
    }
}

async function loadFiles() {
    try {
        const res = await apiFetch("/api/files");
        const data = await res.json();
        const files = data.files || [];

        if (files.length === 0) {
            filesList.innerHTML = `<div class="empty-state">Your downloaded files will appear here.</div>`;
            return;
        }

        filesList.innerHTML = files
            .map((file) => {
                const isImg = (file.mimeType || "").startsWith("image/");
                const downloadUrl = apiUrl(`/api/files/${encodeURIComponent(file.name)}`);
                const inlineUrl = apiUrl(`/api/files/${encodeURIComponent(file.name)}?inline=1`);
                const shareBtn = supportsFileShare(file)
                    ? `<button type="button" class="btn btn-secondary btn-sm" data-share-file="${escapeHtml(file.name)}" data-share-mime="${escapeHtml(file.mimeType)}">Share / Photos</button>`
                    : "";
                return `
                <div class="file-item">
                    <div class="file-left">
                        ${isImg ? `<img class="file-thumb" src="${escapeHtml(inlineUrl)}" alt="" loading="lazy" />` : ""}
                        <div>
                            <div class="file-name">${escapeHtml(file.name)}</div>
                            <div class="file-meta">${formatBytes(file.size)} · ${escapeHtml(file.mimeType)}</div>
                        </div>
                    </div>
                    <div class="file-actions">
                        <a class="btn btn-secondary btn-sm" href="${escapeHtml(inlineUrl)}" target="_blank" rel="noopener">Preview</a>
                        <a class="btn btn-primary btn-sm" href="${escapeHtml(downloadUrl)}" download="${escapeHtml(file.name)}">Save to Device</a>
                        ${shareBtn}
                        <button type="button" class="btn btn-danger btn-sm" data-delete-file="${escapeHtml(file.name)}">Delete</button>
                    </div>
                </div>
            `;
            })
            .join("");

        filesList.querySelectorAll("[data-share-file]").forEach((btn) => {
            btn.addEventListener("click", () => {
                shareFileToDevice(
                    btn.getAttribute("data-share-file"),
                    btn.getAttribute("data-share-mime"),
                    btn
                );
            });
        });

        filesList.querySelectorAll("[data-delete-file]").forEach((btn) => {
            btn.addEventListener("click", async () => {
                const name = btn.getAttribute("data-delete-file");
                await apiFetch(`/api/files/${encodeURIComponent(name)}`, { method: "DELETE" });
                loadFiles();
            });
        });
    } catch {
        // Ignore transient fetch errors
    }
}

function connectEvents() {
    const evtSource = new EventSource(apiUrl("/api/events"), { withCredentials: true });
    evtSource.addEventListener("open", () => {
        syncJobs();
        loadFiles();
    });
    evtSource.addEventListener("init", (event) => {
        const payload = JSON.parse(event.data);
        jobsMap.clear();
        for (const job of payload.jobs || []) {
            jobsMap.set(job.id, job);
        }
        renderJobs();
    });

    evtSource.addEventListener("job", (event) => {
        const job = JSON.parse(event.data);
        jobsMap.set(job.id, job);
        renderJobs();
        if (job.status === "completed") {
            loadFiles();
        }
    });
}

document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        syncJobs();
        loadFiles();
    }
});

window.addEventListener("pageshow", () => {
    syncJobs();
    loadFiles();
});

window.addEventListener("online", () => {
    syncJobs();
    loadFiles();
});

function syncContainerForQuality() {
    const needsVideoQuality = selectedContentType === "auto" || selectedContentType === "video";
    const isAudioQuality = qualitySelect.value === "audio";
    const disableContainer = !needsVideoQuality || isAudioQuality;
    containerSelect.disabled = disableContainer;
    containerGroup.classList.toggle("dimmed", disableContainer);
}

function setContentType(type) {
    selectedContentType = type;
    contentTypePills.querySelectorAll("[data-content-type]").forEach((btn) => {
        btn.classList.toggle("active", btn.getAttribute("data-content-type") === type);
    });
    contentTypeHint.textContent = CONTENT_TYPE_HINTS[type] || "";

    const needsVideoQuality = type === "auto" || type === "video";
    const isAudio = type === "audio";

    if (isAudio) {
        qualitySelect.value = "audio";
    } else if (needsVideoQuality && qualitySelect.value === "audio" && type === "video") {
        qualitySelect.value = "4k";
    }

    qualitySelect.disabled = !needsVideoQuality;
    qualityGroup.classList.toggle("dimmed", !needsVideoQuality);
    syncContainerForQuality();
}

qualitySelect.addEventListener("change", syncContainerForQuality);

contentTypePills.querySelectorAll("[data-content-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
        setContentType(btn.getAttribute("data-content-type"));
    });
});

pasteBtn.addEventListener("click", async () => {
    try {
        const text = await navigator.clipboard.readText();
        if (text) urlInput.value = text.trim();
    } catch {
        showBanner("Clipboard read was blocked by your browser — paste manually.", "info");
    }
});

analyzeBtn.addEventListener("click", inspectCurrentUrl);
refreshFilesBtn.addEventListener("click", loadFiles);

downloadForm.addEventListener("submit", (e) => {
    e.preventDefault();
    startDownload();
});

loadHealth().then(() => {
    loadFiles();
    connectEvents();
});
