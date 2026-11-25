# Anything_Download-

Multi-user public guest downloader for images, photo galleries/carousels, documents, archives, audio (MP3), and 4K / 1080p videos from publicly accessible links.

## Architecture & Security

- **Anonymous Guest Isolation:** Every visitor receives a cryptographically random 128-bit guest ID stored in an HMAC-SHA256 signed `HttpOnly` cookie (`ad_guest`). All jobs, SSE events, cancellation requests, and temporary files are scoped to that guest session.
- **No Shared / Visitor Cookies in Hosted Mode:** `PUBLIC_HOSTED_MODE=true` disables server-side shared cookies, visitor cookie uploads, and `--cookies-from-browser`. Browser cookie extraction is available in local development mode (`PUBLIC_HOSTED_MODE=false`) only.
- **SSRF & Redirect Protection:** Validates `http://` / `https://` URLs, resolves DNS and blocks loopback, private, link-local, CGNAT, and cloud metadata IPs, and validates every HTTP redirect hop.
- **Bounded Queue & Resource Limits:** Enforces per-guest rate limits, global concurrency (`MAX_CONCURRENT_DOWNLOADS`), bounded queue (`MAX_QUEUE_SIZE`), per-file size limits (`MAX_DOWNLOAD_BYTES`), execution timeouts (`JOB_TIMEOUT_MS`), per-guest/global storage caps, and scheduled temporary file cleanup (`FILE_TTL_MS`).

## Local Development

```bash
npm install
npm start
```

Open `http://localhost:4000`. In local development (`NODE_ENV !== "production"` and `PUBLIC_HOSTED_MODE !== "true"`), browser cookies (`Chrome`, `Safari`, `Firefox`, `Brave`, `Edge`) remain available for local use.

## Run Tests

```bash
npm test
```

## Deploy on Render (Backend + Static Frontend)

1. Push this repo to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint**, connect `Eswarprasanth03/Anything_Download-`, and apply `render.yaml` (`SESSION_SECRET` is auto-generated).
3. *(Optional)* Attach a Render Disk and set `DOWNLOADS_DIR` to persist temporary guest files across restarts.

## Optional Vercel Frontend + Render Backend Proxy

If hosting `public/` separately on Vercel:
1. Update the destination URL in `vercel.json` (`/api/:path*` → `https://<your-render-service>.onrender.com/api/:path*`) so requests share the same origin and `HttpOnly; SameSite=Lax` guest session cookies work across all browsers.
2. If calling Render cross-origin instead of via `vercel.json` proxy, set `<meta name="api-base-url" content="https://<your-render-service>.onrender.com" />` in `public/index.html` and configure `CORS_ALLOWED_ORIGINS` + `CROSS_SITE_COOKIES=true` on Render.
