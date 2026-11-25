# Anything_Download-

Universal web downloader for images, photo galleries/carousels, documents, archives, audio (MP3), and 4K / 1080p videos from YouTube, Instagram, X/Twitter, and direct links.

## Local Setup

```bash
npm install
```

Make sure `yt-dlp` (in `bin/yt-dlp` or on `PATH`) and `gallery-dl` (in `.venv/bin/gallery-dl` or on `PATH`) are available for social media video & image extraction (`ffmpeg-static` is installed via npm).

```bash
npm start
```

Open `http://localhost:4000`.

## Deploy on Render

This repository includes a `Dockerfile` (with Node.js, Python, `yt-dlp`, `gallery-dl`, and `ffmpeg`) and a `render.yaml` Blueprint.

1. Push this repo to GitHub.
2. In the [Render Dashboard](https://dashboard.render.com), click **New +** → **Blueprint** (or **Web Service** → select **Docker** runtime).
3. Connect the `Eswarprasanth03/Anything_Download-` repository and deploy.
4. *(Optional)* If YouTube/Instagram asks for login on cloud IPs, upload a Netscape-format `cookies.txt` as a Render **Secret File** at `/etc/secrets/cookies.txt` (or set `COOKIES_FILE`).
5. *(Optional)* To persist downloaded files across restarts, attach a Render Disk and set `DOWNLOADS_DIR` to the disk mount path.
