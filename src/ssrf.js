const dns = require("dns").promises;
const net = require("net");

const BLOCKED_HOSTNAMES = new Set([
    "localhost",
    "localhost.localdomain",
    "ip6-localhost",
    "ip6-loopback",
    "metadata.google.internal",
    "metadata.goog",
    "169.254.169.254",
]);

function ipv4ToInt(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
        return null;
    }
    return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function isInCidr4(ipInt, networkInt, prefixLen) {
    const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
    return (ipInt & mask) === (networkInt & mask);
}

function isPrivateOrReservedIpv4(ip) {
    const n = ipv4ToInt(ip);
    if (n === null) return true;

    const blockedRanges = [
        [0x00000000, 8], // 0.0.0.0/8 ("this" network)
        [0x0a000000, 8], // 10.0.0.0/8 (RFC 1918)
        [0x64400000, 10], // 100.64.0.0/10 (CGNAT)
        [0x7f000000, 8], // 127.0.0.0/8 (Loopback)
        [0xa9fe0000, 16], // 169.254.0.0/16 (Link-local / Cloud metadata)
        [0xac100000, 12], // 172.16.0.0/12 (RFC 1918)
        [0xc0000000, 24], // 192.0.0.0/24 (IETF protocol assignments)
        [0xc0000200, 24], // 192.0.2.0/24 (TEST-NET-1)
        [0xc0a80000, 16], // 192.168.0.0/16 (RFC 1918)
        [0xc6120000, 15], // 198.18.0.0/15 (Benchmarking)
        [0xc6336400, 24], // 198.51.100.0/24 (TEST-NET-2)
        [0xcb007100, 24], // 203.0.113.0/24 (TEST-NET-3)
        [0xe0000000, 4], // 224.0.0.0/4 (Multicast)
        [0xf0000000, 4], // 240.0.0.0/4 (Reserved / Broadcast)
    ];

    return blockedRanges.some(([netInt, prefix]) => isInCidr4(n, netInt, prefix));
}

function extractMappedIpv4(ipv6) {
    const lower = ipv6.toLowerCase();
    // Handles ::ffff:127.0.0.1 or ::ffff:7f00:1
    const dottedMatch = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (dottedMatch) return dottedMatch[1];

    const hexMatch = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMatch) {
        const hi = parseInt(hexMatch[1], 16);
        const lo = parseInt(hexMatch[2], 16);
        return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
    return null;
}

function isPrivateOrReservedIpv6(ip) {
    const clean = ip.split("%")[0].toLowerCase();
    if (clean === "::" || clean === "::1") return true;

    const mapped4 = extractMappedIpv4(clean);
    if (mapped4) return isPrivateOrReservedIpv4(mapped4);

    // Unique local addresses (fc00::/7) and link-local (fe80::/10) and multicast (ff00::/8)
    const firstHextet = parseInt(clean.split(":")[0] || "0", 16);
    if (Number.isNaN(firstHextet)) return true;
    if ((firstHextet & 0xfe00) === 0xfc00) return true; // fc00::/7
    if ((firstHextet & 0xffc0) === 0xfe80) return true; // fe80::/10
    if ((firstHextet & 0xff00) === 0xff00) return true; // ff00::/8

    return false;
}

function isPrivateOrReservedIp(ip) {
    if (!ip || typeof ip !== "string") return true;
    const clean = ip.replace(/^\[|\]$/g, "").split("%")[0];
    const ipType = net.isIP(clean);
    if (ipType === 4) return isPrivateOrReservedIpv4(clean);
    if (ipType === 6) return isPrivateOrReservedIpv6(clean);
    return true;
}

function validatePublicHttpUrl(rawUrl, { allowPrivateForTests = false } = {}) {
    if (typeof rawUrl !== "string" || !rawUrl.trim()) {
        throw new Error("Please provide a URL.");
    }
    if (rawUrl.trim().length > 2048) {
        throw new Error("URL is too long (max 2048 characters).");
    }

    let parsed;
    try {
        parsed = new URL(rawUrl.trim());
    } catch {
        throw new Error("Invalid URL format. Include http:// or https://.");
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs are supported.");
    }
    if (parsed.username || parsed.password) {
        throw new Error("URLs containing embedded credentials are not allowed.");
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname) {
        throw new Error("URL must include a valid hostname.");
    }

    if (!allowPrivateForTests) {
        if (
            BLOCKED_HOSTNAMES.has(hostname) ||
            hostname.endsWith(".localhost") ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
        ) {
            throw new Error("Requests to localhost or internal network hosts are not allowed.");
        }

        const bareHost = hostname.replace(/^\[|\]$/g, "");
        if (net.isIP(bareHost) && isPrivateOrReservedIp(bareHost)) {
            throw new Error("Requests to private or reserved IP addresses are not allowed.");
        }
    }

    return parsed.toString();
}

function shouldAllowPrivateInTests(options = {}) {
    return (
        options.allowPrivateForTests === true ||
        (process.env.NODE_ENV === "test" && process.env.ALLOW_TEST_LOCALHOST === "1")
    );
}

async function assertSafePublicUrl(rawUrl, options = {}) {
    const allowPrivate = shouldAllowPrivateInTests(options);
    const cleanUrl = validatePublicHttpUrl(rawUrl, { allowPrivateForTests: allowPrivate });
    if (allowPrivate) {
        return cleanUrl;
    }

    const parsed = new URL(cleanUrl);
    const bareHost = parsed.hostname.replace(/^\[|\]$/g, "");
    if (net.isIP(bareHost)) {
        if (isPrivateOrReservedIp(bareHost)) {
            throw new Error("Requests to private or reserved IP addresses are not allowed.");
        }
        return cleanUrl;
    }

    const lookupFn = options.lookupFn || ((host) => dns.lookup(host, { all: true }));
    let records;
    try {
        records = await lookupFn(bareHost);
    } catch {
        throw new Error(`Could not resolve hostname "${bareHost}".`);
    }

    if (!Array.isArray(records) || records.length === 0) {
        throw new Error(`Could not resolve hostname "${bareHost}".`);
    }

    for (const rec of records) {
        if (isPrivateOrReservedIp(rec.address)) {
            throw new Error("Target hostname resolves to a private or reserved IP address.");
        }
    }

    return cleanUrl;
}

async function safeFetch(rawUrl, fetchOptions = {}, ssrfOptions = {}) {
    const maxRedirects = ssrfOptions.maxRedirects ?? 5;
    let currentUrl = await assertSafePublicUrl(rawUrl, ssrfOptions);

    for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const res = await fetch(currentUrl, {
            ...fetchOptions,
            redirect: "manual",
        });

        if (res.status >= 300 && res.status < 400) {
            const location = res.headers.get("location");
            try {
                await res.body?.cancel();
            } catch {
                // Ignore body cancel errors on redirect
            }
            if (!location) {
                return { res, finalUrl: currentUrl };
            }
            if (hop === maxRedirects) {
                throw new Error("Too many redirects while fetching URL.");
            }
            const nextUrl = new URL(location, currentUrl).toString();
            currentUrl = await assertSafePublicUrl(nextUrl, ssrfOptions);
            continue;
        }

        return { res, finalUrl: currentUrl };
    }

    throw new Error("Redirect loop detected.");
}

module.exports = {
    isPrivateOrReservedIp,
    validatePublicHttpUrl,
    assertSafePublicUrl,
    safeFetch,
};
