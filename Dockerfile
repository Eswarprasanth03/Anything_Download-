FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ffmpeg \
    ca-certificates \
    && pip3 install --no-cache-dir --break-system-packages "yt-dlp[default,curl-cffi]" gallery-dl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public

RUN mkdir -p /app/downloads/guests

ENV NODE_ENV=production
ENV PUBLIC_HOSTED_MODE=true
ENV DOWNLOADS_DIR=/app/downloads
ENV PORT=10000

EXPOSE 10000

CMD ["node", "server.js"]
