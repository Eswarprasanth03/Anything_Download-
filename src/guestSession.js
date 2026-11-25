const crypto = require("crypto");
const config = require("./config");

const GUEST_ID_REGEX = /^[a-f0-9]{32}$/;

function isValidGuestId(guestId) {
    return typeof guestId === "string" && GUEST_ID_REGEX.test(guestId);
}

function generateGuestId() {
    return crypto.randomBytes(16).toString("hex");
}

function signPayload(payload, secret = config.SESSION_SECRET) {
    return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function createSignedGuestToken(guestId = generateGuestId(), issuedAtMs = Date.now()) {
    if (!isValidGuestId(guestId)) {
        throw new Error("Invalid guest ID");
    }
    const payload = `${guestId}.${issuedAtMs}`;
    const sig = signPayload(payload);
    return `${payload}.${sig}`;
}

function verifySignedGuestToken(token, nowMs = Date.now()) {
    if (typeof token !== "string" || !token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [guestId, issuedAtStr, providedSig] = parts;
    if (!isValidGuestId(guestId)) return null;

    const issuedAtMs = Number(issuedAtStr);
    if (!Number.isFinite(issuedAtMs) || issuedAtMs <= 0) return null;
    if (nowMs - issuedAtMs > config.SESSION_TTL_MS) return null;

    const expectedSig = signPayload(`${guestId}.${issuedAtStr}`);
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    const providedBuf = Buffer.from(providedSig, "utf8");
    if (expectedBuf.length !== providedBuf.length) return null;
    if (!crypto.timingSafeEqual(expectedBuf, providedBuf)) return null;

    return { guestId, issuedAtMs };
}

function parseCookies(cookieHeader) {
    const cookies = {};
    if (!cookieHeader || typeof cookieHeader !== "string") return cookies;

    const pairs = cookieHeader.split(";");
    for (const pair of pairs) {
        const idx = pair.indexOf("=");
        if (idx <= 0) continue;
        const name = pair.slice(0, idx).trim();
        const rawVal = pair.slice(idx + 1).trim();
        try {
            cookies[name] = decodeURIComponent(rawVal);
        } catch {
            cookies[name] = rawVal;
        }
    }
    return cookies;
}

function isRequestHttps(req) {
    if (req.secure) return true;
    const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
    return forwarded === "https";
}

function serializeGuestCookie(token, req) {
    const isHttps = isRequestHttps(req);
    const sameSite = config.CROSS_SITE_COOKIES ? "None" : "Lax";
    const secure = config.CROSS_SITE_COOKIES || isHttps || config.IS_PRODUCTION;
    const maxAgeSec = Math.floor(config.SESSION_TTL_MS / 1000);

    const attrs = [
        `${config.SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
        "Path=/",
        `Max-Age=${maxAgeSec}`,
        "HttpOnly",
        `SameSite=${sameSite}`,
    ];
    if (secure) attrs.push("Secure");
    return attrs.join("; ");
}

function requireGuestSession(req, res, next) {
    const cookies = parseCookies(req.headers.cookie);
    const rawToken = cookies[config.SESSION_COOKIE_NAME];
    const verified = verifySignedGuestToken(rawToken);

    if (verified) {
        req.guestId = verified.guestId;
        return next();
    }

    const newGuestId = generateGuestId();
    const newToken = createSignedGuestToken(newGuestId);
    req.guestId = newGuestId;
    res.append("Set-Cookie", serializeGuestCookie(newToken, req));
    return next();
}

module.exports = {
    isValidGuestId,
    generateGuestId,
    createSignedGuestToken,
    verifySignedGuestToken,
    parseCookies,
    requireGuestSession,
};
