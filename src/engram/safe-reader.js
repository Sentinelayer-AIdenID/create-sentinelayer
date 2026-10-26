/**
 * ENGRAM §EW04 — SSRF-safe source reader.
 *
 * Fetches an owner-approved public URL with defence-in-depth against SSRF:
 *   - DNS vetting: all resolved addresses checked against private/metadata ranges
 *   - IP pinning: connection made to the vetted IP, not the hostname
 *   - HTTPS only (http only via test-only injected transport)
 *   - Manual redirects (max 3), full re-check on every hop
 *   - 10 s total deadline, 5 MiB body cap, content-type allowlist
 *   - No cookies, credentials, or Authorization header
 *   - Generic errors: never echo resolved IPs or response bodies of refused fetches
 *
 * Library only. Node builtins + existing zod contracts. No new dependency.
 * No headless browser or JavaScript execution.
 */

import { promises as dnsPromises } from "node:dns";
import https from "node:https";
import http from "node:http";
import { createHash } from "node:crypto";
import { isIP } from "node:net";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_BODY_BYTES = 5 * 1024 * 1024;          // 5 MiB
export const MAX_REDIRECT_HOPS = 3;
export const TOTAL_DEADLINE_MS = 10_000;                  // 10 s

const ALLOWED_CONTENT_TYPES = new Set([
  "text/html",
  "application/json",
  "application/ld+json",
  "text/plain",
  "application/xml",
  "text/xml",
]);

const REQUEST_HEADERS = {
  "Accept": "text/html, application/json, application/ld+json, text/plain, application/xml, text/xml",
  "User-Agent": "ENGRAM-SafeReader/1.0",
};

// ---------------------------------------------------------------------------
// Address classification — every private/metadata range from the ticket
// ---------------------------------------------------------------------------

const IPV4_PRIVATE_RANGES = [
  { start: 0x00000000, end: 0x00ffffff, label: "0/8" },               // 0.0.0.0/8
  { start: 0x0a000000, end: 0x0affffff, label: "10/8" },               // 10.0.0.0/8
  { start: 0x7f000000, end: 0x7fffffff, label: "127/8" },              // 127.0.0.0/8
  { start: 0xa9fe0000, end: 0xa9feffff, label: "169.254/16" },         // 169.254.0.0/16 (includes 169.254.169.254)
  { start: 0xac100000, end: 0xac1fffff, label: "172.16/12" },          // 172.16.0.0/12
  { start: 0xc0a80000, end: 0xc0a8ffff, label: "192.168/16" },         // 192.168.0.0/16
  { start: 0x64400000, end: 0x647fffff, label: "100.64/10" },          // 100.64.0.0/10 (CGNAT)
  { start: 0xe0000000, end: 0xefffffff, label: "224/4" },              // 224.0.0.0/4 (multicast)
  { start: 0xf0000000, end: 0xffffffff, label: "240/4" },              // 240.0.0.0/4 (reserved, incl 255.255.255.255)
  { start: 0xc0000000, end: 0xc00000ff, label: "192.0.0/24" },         // 192.0.0.0/24 (IETF protocol assignments)
  { start: 0xc6120000, end: 0xc613ffff, label: "198.18/15" },          // 198.18.0.0/15 (benchmarking)
];

function ipv4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => { const n = Number(p); return (n >= 0 && n <= 255 && String(n) === p) ? n : null; });
  if (nums.includes(null)) return null;
  return ((nums[0] << 24) | (nums[1] << 16) | (nums[2] << 8) | nums[3]) >>> 0;
}

function isPrivateIPv4(ip) {
  const int = ipv4ToInt(ip);
  if (int === null) return false;
  for (const range of IPV4_PRIVATE_RANGES) {
    if (int >= range.start && int <= range.end) return true;
  }
  return false;
}

// IPv6 private and special-purpose ranges (normalized, uncompressed form)
const IPV6_PRIVATE_NETWORKS = [
  { prefixBits: 0x00000000000000000000000000000000n, len: 16, label: "::/16 (unspecified/IPv4-mapped)" },
  // ::1 is handled by the raw string check above; ::/16 below catches unspecified
  { prefixBits: 0xfc000000000000000000000000000000n, len: 7,  label: "fc00::/7 (unique-local)" },
  { prefixBits: 0xfe800000000000000000000000000000n, len: 10, label: "fe80::/10 (link-local)" },
  { prefixBits: 0xff000000000000000000000000000000n, len: 8,  label: "ff00::/8 (multicast)" },
  // R7-4: special-purpose ranges (RFC 6890, RFC 3849, RFC 6666, RFC 2928)
  { prefixBits: 0x20010db8000000000000000000000000n, len: 32, label: "2001:db8::/32 (documentation)" },
  { prefixBits: 0x01000000000000000000000000000000n, len: 64, label: "100::/64 (discard)" },
  { prefixBits: 0x20010000000000000000000000000000n, len: 23, label: "2001::/23 (IETF protocol assignments)" },
];

// NAT64 well-known prefix: 64:ff9b::/96 — 12 bytes (24 hex chars) in expanded flat form
const NAT64_PREFIX_BITS = 0x0064ff9b000000000000000000000000n;

// 6to4: 2002::/16 — 2 bytes (4 hex chars) in expanded flat form, then embedded IPv4 at bytes 2-5 (hex 4-12)
const SIXTO4_PREFIX = "2002";

function expandIPv6(ip) {
  // Remove brackets if present
  const raw = ip.replace(/^\[|\]$/g, "");

  // Detect dotted IPv4 tail: last group matches a.b.c.d with each octet 0-255.
  const dottedV4Re = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const convertDottedTail = (groups) => {
    if (groups.length === 0) return groups;
    const last = groups[groups.length - 1];
    const m = last.match(dottedV4Re);
    if (!m) return groups;
    const octets = m.slice(1).map(Number);
    if (octets.some((o) => o > 255 || o < 0)) return groups;
    const h1 = ((octets[0] << 8) | octets[1]).toString(16).padStart(4, "0");
    const h2 = ((octets[2] << 8) | octets[3]).toString(16).padStart(4, "0");
    return [...groups.slice(0, -1), h1, h2];
  };

  // Handle :: compression
  const parts = raw.split("::");
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(":") : [];
  const right = parts[1] ? parts[1].split(":") : [];

  // No compression case: 7 groups with a dotted tail (e.g. 0:0:0:0:0:ffff:127.0.0.1)
  // expands to 8; 8 fully-expanded groups also handled here.
  if (parts.length === 1) {
    const norm = convertDottedTail(left);
    // After normalization, must be exactly 8 valid hextets
    if (norm.length !== 8 || norm.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
    return norm.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
  }

  const normalizedLeft = convertDottedTail(left);
  const normalizedRight = convertDottedTail(right);

  if (normalizedLeft.length + normalizedRight.length > 7) return null;
  const middle = Array(8 - normalizedLeft.length - normalizedRight.length).fill("0");
  const all = [...normalizedLeft, ...middle, ...normalizedRight];
  if (all.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null;
  return all.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

function ipv6ToBigInt(expanded) {
  const flat = expanded.replace(/:/g, "");
  return BigInt("0x" + flat);
}

function isPrivateIPv6(ip) {
  const raw = ip.replace(/^\[|\]$/g, "").toLowerCase();
  // ::1
  if (raw === "::1" || raw === "0:0:0:0:0:0:0:1") return true;

  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  const v4Mapped = raw.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  if (v4Mapped) return isPrivateIPv4(v4Mapped[1]);

  const expanded = expandIPv6(ip);
  // FAIL CLOSED: if we cannot normalize an IPv6 address, treat it as dangerous.
  // Valid IPv6 addresses must normalize to canonical 8-hextet colon form.
  if (!expanded) return true;

  // BigInt-based numeric prefix matching
  const addrBits = ipv6ToBigInt(expanded);

  for (const net of IPV6_PRIVATE_NETWORKS) {
    const shift = 128n - BigInt(net.len);
    const mask = (~0n) << shift;
    if ((addrBits & mask) === (net.prefixBits & mask)) return true;
  }

  // NAT64: 64:ff9b::/96 — extract last 4 bytes as IPv4
  const NAT64_MASK = (~0n) << 32n;
  if ((addrBits & NAT64_MASK) === NAT64_PREFIX_BITS) {
    const embeddedV4 = Number(addrBits & 0xffffffffn);
    const octets = [
      (embeddedV4 >>> 24) & 0xff,
      (embeddedV4 >>> 16) & 0xff,
      (embeddedV4 >>> 8) & 0xff,
      embeddedV4 & 0xff,
    ];
    return isPrivateIPv4(octets.join("."));
  }

  // 6to4: 2002::/16 — extract embedded IPv4 at bytes 2-5 (bits 16-47)
  const SIXTO4_MASK = (~0n) << 112n;
  if ((addrBits & SIXTO4_MASK) === 0x20020000000000000000000000000000n) {
    const embeddedV4 = Number((addrBits >> 80n) & 0xffffffffn);
    const octets = [
      (embeddedV4 >>> 24) & 0xff,
      (embeddedV4 >>> 16) & 0xff,
      (embeddedV4 >>> 8) & 0xff,
      embeddedV4 & 0xff,
    ];
    return isPrivateIPv4(octets.join("."));
  }

  // IPv4-compatible IPv6 (deprecated): first 96 bits zero, last 32 bits are IPv4
  // Skip ::1 (already handled above) and :: (unspecified, caught by prefix match)
  if ((addrBits >> 32n) === 0n && (addrBits & 0xffffffffn) !== 0n && (addrBits & 0xffffffffn) !== 1n) {
    const embeddedV4 = Number(addrBits & 0xffffffffn);
    const octets = [
      (embeddedV4 >>> 24) & 0xff,
      (embeddedV4 >>> 16) & 0xff,
      (embeddedV4 >>> 8) & 0xff,
      embeddedV4 & 0xff,
    ];
    const v4Addr = octets.join(".");
    if (isIP(v4Addr) === 4) return isPrivateIPv4(v4Addr);
  }

  return false;
}

function isPrivateAddress(addr) {
  if (isIP(addr) === 4) return isPrivateIPv4(addr);
  if (isIP(addr) === 6) return isPrivateIPv6(addr);
  return false;
}

function isMetadataAddress(addr) {
  return addr === "169.254.169.254";
}

function isDangerousAddress(addr) {
  // isPrivateAddress already fails closed for unparseable IPv6.
  // But we double-check: if net.isIP says this is a v6 address and we cannot
  // produce a canonical form, it is dangerous regardless.
  if (isIP(addr) === 6) {
    const normalized = expandIPv6(addr);
    if (!normalized) return true;
  }
  if (isIP(addr) === 4) {
    if (ipv4ToInt(addr) === null) return true;
  }
  // Anything that isPrivateAddress cannot classify and isIP cannot identify:
  // we don't try to classify it here — let the caller decide (resolveAndVet
  // will refuse anything that isn't isIP 4 or 6).
  return isPrivateAddress(addr) || isMetadataAddress(addr);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class SafeReaderError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeReaderError";
    this.code = code;
  }
}

function reject(code) {
  throw new SafeReaderError(code);
}

// ---------------------------------------------------------------------------
// DNS resolution + vetting
// ---------------------------------------------------------------------------

async function resolveAndVet(hostname, resolver, signal) {
  // Check deadline before starting DNS
  if (signal && signal.aborted) {
    return { vetted: null, error: "fetch_timeout" };
  }

  if (isIP(hostname)) {
    // Raw IP — accept ONLY if isIP returns 4 or 6 AND it is not dangerous.
    // An unclassifiable address (isIP returns 0) is never dialed.
    const kind = isIP(hostname);
    if (kind !== 4 && kind !== 6) {
      return { vetted: null, error: "fetch_private_address" };
    }
    if (isDangerousAddress(hostname)) {
      return { vetted: null, error: "fetch_private_address" };
    }
    return { vetted: hostname, error: null };
  }

  // Resolve all addresses, racing against the deadline signal
  let v4 = [];
  let v6 = [];
  try {
    const dnsPromise = Promise.all([
      resolver.resolve4(hostname).catch(() => []),
      resolver.resolve6(hostname).catch(() => []),
    ]);

    if (signal) {
      const timeoutPromise = new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new SafeReaderError("fetch_timeout")), { once: true });
        if (signal.aborted) reject(new SafeReaderError("fetch_timeout"));
      });
      [v4, v6] = await Promise.race([dnsPromise, timeoutPromise]);
    } else {
      [v4, v6] = await dnsPromise;
    }
  } catch (err) {
    if (err instanceof SafeReaderError) {
      return { vetted: null, error: err.code };
    }
    return { vetted: null, error: "fetch_dns_failed" };
  }

  const allAddrs = [...v4, ...v6];
  if (allAddrs.length === 0) {
    return { vetted: null, error: "fetch_dns_failed" };
  }

  // Always refuse if ANY address is dangerous or unclassifiable.
  // An address is acceptable ONLY if isIP returns 4 or 6 AND it passes
  // the danger check (which fails closed for unparseable IPv6).
  for (const addr of allAddrs) {
    const kind = isIP(addr);
    if (kind !== 4 && kind !== 6) {
      return { vetted: null, error: "fetch_private_address" };
    }
    if (isDangerousAddress(addr)) {
      return { vetted: null, error: "fetch_private_address" };
    }
  }

  // Pin to the first IPv4 (or first IPv6 if no IPv4)
  const vetted = v4.length > 0 ? v4[0] : v6[0];
  return { vetted, error: null };
}

// ---------------------------------------------------------------------------
// Unified request + body read (de-chunked by Node)
// ---------------------------------------------------------------------------

/**
 * Make an HTTP(S) request and read the response with the 5 MiB cap enforced
 * in the data handler. Uses Node's request API so Transfer-Encoding: chunked
 * is decoded automatically.
 */
function doRequest({ transport, hostname, ip, port, path, signal }) {
  return new Promise((resolve, reject) => {
    const lookup = (host, opts, cb) => {
      const family = isIP(ip) === 6 ? 6 : 4;
      const dialIp = ip;
      if (opts.all) {
        cb(null, [{ address: dialIp, family }]);
      } else {
        cb(null, dialIp, family);
      }
    };

    const reqOpts = {
      host: hostname,
      port,
      path: path || "/",
      method: "GET",
      agent: false,
      signal,
      lookup,
      headers: { ...REQUEST_HEADERS },
    };

    // Only set servername/rejectUnauthorized for https
    if (transport === https) {
      reqOpts.servername = hostname;
      reqOpts.rejectUnauthorized = true;
    }

    const req = transport.request(reqOpts);

    req.on("error", (err) => {
      if (err.name === "AbortError") {
        reject(new SafeReaderError("fetch_timeout"));
      } else {
        reject(new SafeReaderError("fetch_io_error"));
      }
    });

    req.on("response", (resp) => {
      let bodyLength = 0;
      const chunks = [];

      resp.on("data", (chunk) => {
        bodyLength += chunk.length;
        if (bodyLength > MAX_BODY_BYTES) {
          resp.destroy();
          reject(new SafeReaderError("fetch_too_large"));
          return;
        }
        chunks.push(chunk);
      });

      resp.on("end", () => {
        const body = Buffer.concat(chunks, bodyLength);
        const contentType = resp.headers["content-type"] || "";
        resolve({
          status: resp.statusCode,
          location: resp.headers["location"] || null,
          body,
          contentType,
        });
      });

      resp.on("error", (err) => {
        if (err.name === "AbortError") {
          reject(new SafeReaderError("fetch_timeout"));
        } else {
          reject(new SafeReaderError("fetch_io_error"));
        }
      });
    });

    req.end();
  });
}

// ---------------------------------------------------------------------------
// Main fetch function (internal)
// ---------------------------------------------------------------------------

async function fetchOne({
  url,
  approvedOrigins,
  resolver,
  transport,
  deadlineSignal,
}) {
  const parsed = new URL(url);

  // Protocol check
  if (parsed.protocol !== "https:") {
    if (parsed.protocol === "http:" && (transport === http || transport._isTestHttp)) {
      // http only with injected test transport
    } else {
      reject("fetch_blocked");
    }
  }

  // Origin must be in approved set
  if (!approvedOrigins.has(parsed.origin)) {
    reject("fetch_blocked");
  }

  // No userinfo
  if (parsed.username || parsed.password) {
    reject("fetch_blocked");
  }

  // DNS vet
  const hostname = parsed.hostname;
  const { vetted, error } = await resolveAndVet(hostname, resolver, deadlineSignal);

  if (error) reject(error);
  if (!vetted) reject("fetch_dns_failed");

  // Check deadline
  if (deadlineSignal.aborted) reject("fetch_timeout");

  const port = parsed.port || (parsed.protocol === "https:" ? 443 : 80);

  const result = await doRequest({
    transport,
    hostname,
    ip: vetted,
    port,
    path: parsed.pathname + parsed.search,
    signal: deadlineSignal,
  });

  const status = result.status;
  const responseBody = result.body;
  const contentType = result.contentType;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();

  if (status === null || status < 200 || status >= 300) {
    // Check for redirect
    if (result.location && [301, 302, 303, 307, 308].includes(status)) {
      return { redirect: result.location, status };
    }
    reject("fetch_bad_status");
  }

  // Content-type check
  if (!ALLOWED_CONTENT_TYPES.has(mediaType)) {
    reject("fetch_bad_content_type");
  }

  return {
    bytes: responseBody,
    contentType: contentType,
    finalUrl: url,
  };
}

// ---------------------------------------------------------------------------
// Public API: createSafeReader
// ---------------------------------------------------------------------------

/**
 * Create a safe reader configured with the given dependencies.
 *
 * @param {object} options
 * @param {object} [options.resolver] — dns.promises by default; injectable for tests
 * @param {function} [options.now] — Date.now by default; injectable for tests
 * @param {object} [options.limits] — override limits
 * @param {object} [options.transport] — node:https by default; inject a test transport for tests only
 *   Test transport MUST have .request(opts) and _isTestHttp:true flag
 * @returns {{ read: function }}
 */
export function createSafeReader({
  resolver = dnsPromises,
  now = () => Date.now(),
  limits = {},
  transport = https,
} = {}) {
  const maxBytes = limits.maxBytes ?? MAX_BODY_BYTES;
  const maxRedirects = limits.maxRedirects ?? MAX_REDIRECT_HOPS;
  const deadlineMs = limits.deadlineMs ?? TOTAL_DEADLINE_MS;

  /**
   * Read a URL, returning bytes, content type, final URL, version hash, and fetch time.
   *
   * @param {string} url — the URL to fetch
   * @param {Set<string>} approvedOrigins — allowed origins
   * @returns {Promise<{bytes: Buffer, contentType: string, finalUrl: string, version: string, fetchedAt: string}>}
   */
  async function read(url, opts) {
    if (!opts || !(opts.approvedOrigins instanceof Set)) reject("fetch_blocked");
    const { approvedOrigins } = opts;

    const startTime = now();
    const deadline = startTime + deadlineMs;

    const controller = new AbortController();
    const deadlineTimer = setTimeout(() => controller.abort(), deadlineMs);

    try {
      let currentUrl = url;
      let result;

      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (controller.signal.aborted) reject("fetch_timeout");

        result = await fetchOne({
          url: currentUrl,
          approvedOrigins,
          resolver,
          transport,
          deadlineSignal: controller.signal,
        });

        if (!result.redirect) break;

        // Resolve redirect target
        let nextUrl;
        try {
          nextUrl = new URL(result.redirect, currentUrl).href;
        } catch {
          reject("fetch_redirect_rejected");
        }

        // Check redirect target origin is approved
        const nextOrigin = new URL(nextUrl).origin;
        if (!approvedOrigins.has(nextOrigin)) {
          reject("fetch_redirect_rejected");
        }

        // DNS vet on redirect target
        const nextHostname = new URL(nextUrl).hostname;
        const { vetted: nextVetted, error: nextError } = await resolveAndVet(nextHostname, resolver, controller.signal);
        if (nextError) reject(nextError);
        if (!nextVetted) reject("fetch_redirect_rejected");
        if (isDangerousAddress(nextVetted)) reject("fetch_redirect_rejected");

        // Cycle detection
        if (nextUrl === currentUrl) reject("fetch_redirect_loop");

        currentUrl = nextUrl;
      }

      if (result.redirect) {
        reject("fetch_redirect_loop"); // exceeded max hops
      }

      const fetchedAt = new Date(now()).toISOString();
      const version = `sha256:${createHash("sha256").update(result.bytes).digest("hex")}`;

      return {
        bytes: result.bytes,
        contentType: result.contentType,
        finalUrl: result.finalUrl,
        version,
        fetchedAt,
      };
    } finally {
      clearTimeout(deadlineTimer);
    }
  }

  return { read };
}
