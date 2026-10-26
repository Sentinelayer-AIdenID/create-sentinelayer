import "./setup-env.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { createServer } from "node:http";
import { createSafeReader, SafeReaderError } from "../src/engram/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startHttpServer(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function mockResolver(ipv4, ipv6 = []) {
  return {
    resolve4: async () => ipv4,
    resolve6: async () => ipv6,
  };
}

// makeTestTransport: wraps http.request, asserts the vetted IP, then dials 127.0.0.1
function makeTestTransport(expectedVettedIp) {
  return {
    request(opts) {
      const origLookup = opts.lookup;
      opts.lookup = (host, lookupOpts, cb) => {
        origLookup(host, lookupOpts, (err, ip, family) => {
          // The production code pinned the vetted IP — assert it
          const actualIp = lookupOpts.all ? ip[0].address : ip;
          assert.strictEqual(actualIp, expectedVettedIp);
          // Override to dial localhost for the test server
          if (lookupOpts.all) {
            cb(null, [{ address: "127.0.0.1", family: 4 }]);
          } else {
            cb(null, "127.0.0.1", 4);
          }
        });
      };
      return http.request(opts);
    },
    _isTestHttp: true,
  };
}

// ---------------------------------------------------------------------------
// (a) Happy path — local HTTP server
// ---------------------------------------------------------------------------

test("(a) happy path: local HTTP server fetches HTML and returns byte version", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<html><head><title>Hello</title></head><body><p>World</p></body></html>");
  });

  try {
    // Resolver returns a public-looking address; test transport asserts it then dials localhost
    // Use example.com as hostname so Node calls our lookup override
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
    });
    const approved = new Set([`http://example.com:${port}`]);
    const result = await reader.read(`http://example.com:${port}/`, { approvedOrigins: approved });

    assert.equal(result.contentType.includes("text/html"), true);
    assert.equal(result.finalUrl, `http://example.com:${port}/`);
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.ok(result.bytes.length > 0);
    assert.equal(result.version.startsWith("sha256:"), true);
    assert.equal(typeof result.fetchedAt, "string");
    assert.equal(result.bytes.toString("utf-8").includes("<title>Hello</title>"), true);

    // version is the sha256 of the bytes
    const expectedHash = `sha256:${createHash("sha256").update(result.bytes).digest("hex")}`;
    assert.equal(result.version, expectedHash);
  } finally {
    server.close();
  }
});

test("(a) happy path: chunked response gives exact entity bytes with correct sha256", async () => {
  // Send a chunked response with known entity body
  const entityBody = "<!DOCTYPE html>\n<html><head><title>Chunked Test</title></head><body><p>Hello chunked world</p></body></html>";
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Transfer-Encoding": "chunked",
    });
    const parts = [
      entityBody.slice(0, 30),
      entityBody.slice(30, 70),
      entityBody.slice(70),
    ];
    for (const part of parts) {
      res.write(part);
    }
    res.end();
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
    });
    const approved = new Set([`http://example.com:${port}`]);
    const result = await reader.read(`http://example.com:${port}/`, { approvedOrigins: approved });

    // The body should be exactly the entity body, no chunk framing
    const received = result.bytes.toString("utf-8");
    assert.equal(received, entityBody, "chunked response must yield the exact entity bytes, not chunk framing");

    // sha256 must match entity body
    const expectedHash = `sha256:${createHash("sha256").update(entityBody).digest("hex")}`;
    assert.equal(result.version, expectedHash, "version must be sha256 of entity bytes");
  } finally {
    server.close();
  }
});

test("(a) happy path: plain HTTP refused in production mode", async () => {
  const reader = createSafeReader(); // default transport = https
  const approved = new Set(["http://example.com"]);
  await assert.rejects(
    reader.read("http://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_blocked",
    "plain HTTP must be refused in production mode",
  );
});

// ---------------------------------------------------------------------------
// (b) Private and metadata ranges refused
// These tests use mock resolvers that return private IPs — the DNS vet catches them.
// Vetting stays ON in all tests.
// ---------------------------------------------------------------------------

test("(b) private IPv4 ranges refused via DNS vet", async () => {
  const privateIPs = ["10.0.0.1", "172.16.0.1", "192.168.1.1", "100.64.0.1", "169.254.1.1", "0.0.0.0"];
  for (const ip of privateIPs) {
    const reader = createSafeReader({ resolver: mockResolver([ip]) });
    const approved = new Set(["https://example.com"]);
    await assert.rejects(
      reader.read("https://example.com/", { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
      `${ip} should be refused as private`,
    );
  }
});

test("(b) metadata address 169.254.169.254 refused via DNS vet", async () => {
  const reader = createSafeReader({ resolver: mockResolver(["169.254.169.254"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "metadata address must be refused",
  );
});

test("(b) loopback 127.0.0.1 refused via DNS vet", async () => {
  const reader = createSafeReader({ resolver: mockResolver(["127.0.0.1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "loopback must be refused",
  );
});

test("(b) IPv6 private ranges refused via DNS vet", async () => {
  const privateV6 = ["::1", "fc00::1", "fe80::1", "ff00::1", "::"];
  for (const ip of privateV6) {
    const reader = createSafeReader({ resolver: mockResolver([], [ip]) });
    const approved = new Set(["https://example.com"]);
    await assert.rejects(
      reader.read("https://example.com/", { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
      `${ip} should be refused as private IPv6`,
    );
  }
});

test("(b) IPv4-mapped IPv6 loopback refused via DNS vet", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["::ffff:127.0.0.1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "IPv4-mapped IPv6 loopback must be refused",
  );
});

// ---------------------------------------------------------------------------
// (b2) Additional missing ranges
// ---------------------------------------------------------------------------

test("(b2) multicast 224.0.0.0/4 refused via DNS vet", async () => {
  const ips = ["224.0.0.1", "239.255.255.255"];
  for (const ip of ips) {
    const reader = createSafeReader({ resolver: mockResolver([ip]) });
    const approved = new Set(["https://example.com"]);
    await assert.rejects(
      reader.read("https://example.com/", { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
      `${ip} (multicast) should be refused`,
    );
  }
});

test("(b2) reserved 240.0.0.0/4 refused via DNS vet", async () => {
  const ips = ["240.0.0.1", "255.255.255.255"];
  for (const ip of ips) {
    const reader = createSafeReader({ resolver: mockResolver([ip]) });
    const approved = new Set(["https://example.com"]);
    await assert.rejects(
      reader.read("https://example.com/", { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
      `${ip} (reserved) should be refused`,
    );
  }
});

test("(b2) 192.0.0.0/24 refused via DNS vet", async () => {
  const reader = createSafeReader({ resolver: mockResolver(["192.0.0.1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "192.0.0.1 (IETF protocol assignments) should be refused",
  );
});

test("(b2) 198.18.0.0/15 refused via DNS vet", async () => {
  const ips = ["198.18.0.1", "198.19.255.255"];
  for (const ip of ips) {
    const reader = createSafeReader({ resolver: mockResolver([ip]) });
    const approved = new Set(["https://example.com"]);
    await assert.rejects(
      reader.read("https://example.com/", { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
      `${ip} (benchmarking) should be refused`,
    );
  }
});

test("(b2) NAT64 64:ff9b::/96 with loopback embedded refused", async () => {
  // 64:ff9b::7f00:1 — embeds 127.0.0.1
  const reader = createSafeReader({ resolver: mockResolver([], ["64:ff9b::7f00:1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "NAT64 with embedded loopback should be refused",
  );
});

test("(b2) 6to4 2002::/16 with loopback embedded refused", async () => {
  // 2002:7f00:0001:: — embeds 127.0.0.1
  const reader = createSafeReader({ resolver: mockResolver([], ["2002:7f00:0001::"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "6to4 with embedded loopback should be refused",
  );
});

test("(b2) NAT64 with public embedded address passes vetting", async () => {
  // 64:ff9b::5db8:d822 — embeds 93.184.216.34 (example.com)
  const reader = createSafeReader({ resolver: mockResolver(["93.184.216.34"], ["64:ff9b::5db8:d822"]) });
  const approved = new Set(["https://example.com"]);
  // Should not throw fetch_private_address; will fail on connect which is fine
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code !== "fetch_private_address",
    "NAT64 with embedded public address should NOT be refused as private",
  );
});

// ---------------------------------------------------------------------------
// (c) DNS rebinding
// ---------------------------------------------------------------------------

test("(c) DNS rebinding: changing resolver between calls is pinned to first vetted address", async () => {
  let callCount = 0;
  const rebindingResolver = {
    async resolve4() {
      callCount++;
      if (callCount === 1) return ["93.184.216.34"];
      return ["10.0.0.1"];
    },
    async resolve6() { return []; },
  };

  const reader = createSafeReader({
        transport: makeTestTransport("93.184.216.34"),
    resolver: rebindingResolver,
  });
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><head><title>OK</title></head></html>");
  });

  try {
    const approved = new Set([`http://example.com:${port}`]);
    const result = await reader.read(`http://example.com:${port}/`, { approvedOrigins: approved });
    assert.ok(result.bytes.toString("utf-8").includes("<title>OK</title>"));
    // Second resolution returned private but was never used — we already pinned
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// (d) Redirects
// ---------------------------------------------------------------------------

test("(d) manual redirects are followed up to 3 hops with full re-vet", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    if (req.url === "/hop1") {
      res.writeHead(301, { "Location": `/hop2`, "Content-Type": "text/plain" });
      res.end("redirecting");
    } else if (req.url === "/hop2") {
      res.writeHead(302, { "Location": `/final`, "Content-Type": "text/plain" });
      res.end("redirecting");
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Final</title></head></html>");
    }
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
      limits: { maxRedirects: 3 },
    });
    const approved = new Set([`http://example.com:${port}`]);
    const result = await reader.read(`http://example.com:${port}/hop1`, { approvedOrigins: approved });
    assert.equal(result.finalUrl, `http://example.com:${port}/final`);
    assert.ok(result.bytes.toString("utf-8").includes("<title>Final</title>"));
  } finally {
    server.close();
  }
});

test("(d) max redirects exceeded", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(301, { "Location": `/next`, "Content-Type": "text/plain" });
    res.end("redirecting");
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
      limits: { maxRedirects: 1 },
    });
    const approved = new Set([`http://example.com:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_redirect_loop",
    );
  } finally {
    server.close();
  }
});

test("(d) redirect to unapproved origin is refused", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(301, { "Location": "http://evil.com/", "Content-Type": "text/plain" });
    res.end("redirecting");
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
    });
    const approved = new Set([`http://example.com:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_redirect_rejected",
    );
  } finally {
    server.close();
  }
});


// (d) redirect to approved origin whose DNS resolves to a private address is refused
test("(d) redirect to approved origin resolving to 127.0.0.1 is refused", async () => {
  const hostAResolver = mockResolver(["93.184.216.34"]);
  const hostBResolver = mockResolver(["127.0.0.1"]);

  const hostnameKeyedResolver = {
    async resolve4(hostname) {
      if (hostname === "other.example") {
        return hostBResolver.resolve4(hostname);
      }
      return hostAResolver.resolve4(hostname);
    },
    async resolve6(hostname) { return []; },
  };

  const { server, port } = await startHttpServer((req, res) => {
    if (req.headers.host && req.headers.host.startsWith("other.example")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Evil</title></head></html>");
    } else {
      res.writeHead(302, { "Location": `http://other.example:${port}/landing`, "Content-Type": "text/plain" });
      res.end("redirecting");
    }
  });

  try {
    const reader = createSafeReader({
      transport: makeTestTransport("93.184.216.34"),
      resolver: hostnameKeyedResolver,
      limits: { maxRedirects: 3 },
    });
    const approved = new Set([`http://example.com:${port}`, `http://other.example:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    );
  } finally {
    server.close();
  }
});

test("(d) redirect to approved origin resolving to 169.254.169.254 is refused", async () => {
  const hostAResolver = mockResolver(["93.184.216.34"]);
  const hostBResolver = mockResolver(["169.254.169.254"]);

  const hostnameKeyedResolver = {
    async resolve4(hostname) {
      if (hostname === "other.example") {
        return hostBResolver.resolve4(hostname);
      }
      return hostAResolver.resolve4(hostname);
    },
    async resolve6(hostname) { return []; },
  };

  const { server, port } = await startHttpServer((req, res) => {
    if (req.headers.host && req.headers.host.startsWith("other.example")) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head><title>Metadata</title></head></html>");
    } else {
      res.writeHead(302, { "Location": `http://other.example:${port}/landing`, "Content-Type": "text/plain" });
      res.end("redirecting");
    }
  });

  try {
    const reader = createSafeReader({
      transport: makeTestTransport("93.184.216.34"),
      resolver: hostnameKeyedResolver,
      limits: { maxRedirects: 3 },
    });
    const approved = new Set([`http://example.com:${port}`, `http://other.example:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    );
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// (e) Content-type allowlist
// ---------------------------------------------------------------------------

test("(e) disallowed content type is rejected", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.alloc(100));
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
    });
    const approved = new Set([`http://example.com:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_bad_content_type",
    );
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// (f) Body cap
// ---------------------------------------------------------------------------

test("(f) body over 5 MiB cap is rejected mid-stream", async () => {
  const bigBody = Buffer.alloc(6 * 1024 * 1024, 65); // 6 MiB of 'A'
  const { server, port } = await startHttpServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(bigBody);
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
    });
    const approved = new Set([`http://example.com:${port}`]);
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_too_large",
    );
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// (g) Deadline / timeout
// ---------------------------------------------------------------------------

test("(g) total deadline kills a slow fetch", async () => {
  const { server, port } = await startHttpServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("too late");
    }, 2000);
  });

  try {
    const reader = createSafeReader({
            transport: makeTestTransport("93.184.216.34"),
      resolver: mockResolver(["93.184.216.34"]),
      limits: { deadlineMs: 500 },
    });
    const approved = new Set([`http://example.com:${port}`]);
    const start = Date.now();
    await assert.rejects(
      reader.read(`http://example.com:${port}/`, { approvedOrigins: approved }),
      (err) => err instanceof SafeReaderError && err.code === "fetch_timeout",
      "slow server must be timed out",
    );
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 3000, `timeout took ${elapsed}ms, expected <3000ms`);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// (h) JSON-LD extraction
// ---------------------------------------------------------------------------

test("(h) unparseable JSON-LD becomes unverified, not a guess", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = Buffer.from(`<html><head>
<script type="application/ld+json">{"@context": "https://schema.org", "@type": "Person", "name": "Alice"}</script>
<script type="application/ld+json">{broken json!!!}</script>
</head><body></body></html>`, "utf-8");

  const result = extractFromHtml(html);
  assert.equal(result.jsonLd.length, 2);

  const first = result.jsonLd[0];
  assert.equal(first.verified, true);
  assert.deepEqual(first.data, { "@context": "https://schema.org", "@type": "Person", "name": "Alice" });
  assert.equal(typeof first.evidence.start, "number");
  assert.equal(typeof first.evidence.end, "number");
  assert.ok(first.evidence.start < first.evidence.end);

  const second = result.jsonLd[1];
  assert.equal(second.verified, false, "unparseable JSON-LD must be unverified");
  assert.equal(second.data, null, "unparseable JSON-LD must be null, not a guess");
  assert.equal(typeof second.raw, "string");
});

test("HTML extraction yields byte-offset evidence for all fields", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = `<html><head><title>Test Page</title><meta name="description" content="A test page"></head><body><h1>Heading 1</h1><p>Content</p><a href="/page">Link text</a></body></html>`;
  const bytes = Buffer.from(html, "utf-8");

  const result = extractFromHtml(bytes);

  assert.equal(result.title, "Test Page");
  assert.equal(result.description, "A test page");
  assert.equal(result.headings.length, 1);
  assert.equal(result.headings[0].level, 1);
  assert.equal(result.headings[0].text, "Heading 1");
  assert.equal(typeof result.headings[0].evidence.start, "number");
  assert.equal(typeof result.headings[0].evidence.end, "number");
  assert.ok(result.headings[0].evidence.start < result.headings[0].evidence.end);

  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].href, "/page");
  assert.equal(result.links[0].text, "Link text");
  assert.equal(typeof result.links[0].evidence.start, "number");
});

test("HTML extraction with canonical link", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = `<html><head><link rel="canonical" href="https://example.com/page"></head><body></body></html>`;
  const result = extractFromHtml(Buffer.from(html, "utf-8"));
  assert.equal(result.canonical, "https://example.com/page");
});

// ---------------------------------------------------------------------------
// P2-2: Title extraction excludes SVG/<math> titles
// ---------------------------------------------------------------------------

test("P2-2: document title extracted; inline SVG title excluded", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = `<html><head><title>Real Page Title</title></head><body>
<svg><title>svg hover text</title><circle r="5"/></svg>
<p>Content</p>
</body></html>`;
  const result = extractFromHtml(Buffer.from(html, "utf-8"));
  assert.equal(result.title, "Real Page Title", "must return the <head> <title>, not the SVG <title>");
});

test("P2-2: math title excluded from document title", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = `<html><head><title>Math Page</title></head><body>
<math><title>math hover text</title><mi>x</mi></math>
</body></html>`;
  const result = extractFromHtml(Buffer.from(html, "utf-8"));
  assert.equal(result.title, "Math Page", "must return the <head> <title>, not the <math> <title>");
});

test("P2-2: first non-SVG title used when head has no title", async () => {
  const { extractFromHtml } = await import("../src/engram/extract-html.js");
  const html = `<html><head></head><body>
<svg><title>svg hover</title></svg>
<h1>Main</h1>
<title>Fallback Title</title>
<p>Text</p>
</body></html>`;
  const result = extractFromHtml(Buffer.from(html, "utf-8"));
  assert.equal(result.title, "Fallback Title", "must pick first <title> not inside SVG or math");
});

// ---------------------------------------------------------------------------
// Additional SafeReader tests
// ---------------------------------------------------------------------------

test("unapproved origin is blocked", async () => {
  const reader = createSafeReader({ transport: http, resolver: mockResolver(["93.184.216.34"]) });
  const approved = new Set(["https://other.example"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_blocked",
  );
});

test("URL with credentials is blocked", async () => {
  const reader = createSafeReader({ transport: http, resolver: mockResolver(["93.184.216.34"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://user:pass@example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_blocked",
  );
});

test("safe-reader errors are generic — never echo resolved IPs", async () => {
  const reader = createSafeReader({ resolver: mockResolver(["10.0.0.1"]) });
  const approved = new Set(["https://example.com"]);
  try {
    await reader.read("https://example.com/", { approvedOrigins: approved });
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof SafeReaderError);
    assert.equal(err.message, err.code);
    assert.ok(!err.message.includes("10.0.0.1"), "error must not echo private IP");
  }
});

test("resolved DNS returning no addresses is refused", async () => {
  const resolver = {
    async resolve4() { return []; },
    async resolve6() { return []; },
  };
  const reader = createSafeReader({ resolver });
  const approved = new Set(["https://no-such-host.example"]);
  await assert.rejects(
    reader.read("https://no-such-host.example/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_dns_failed",
  );
});
test("transport:http with resolver returning 127.0.0.1 is refused — no SSRF bypass", async () => {
  // Even with transport: http injected, vetting MUST still run.
  // A resolver returning a private address must cause refusal.
  const reader = createSafeReader({
    transport: http,
    resolver: mockResolver(["127.0.0.1"]),
  });
  const approved = new Set(["http://example.com"]);
  await assert.rejects(
    reader.read("http://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "transport:http must not disable vetting; private address must be refused",
  );
});

test("transport:http with resolver returning 169.254.169.254 is refused — no SSRF bypass", async () => {
  // 169.254.169.254 is the AWS/cloud metadata IP — must always be blocked.
  const reader = createSafeReader({
    transport: http,
    resolver: mockResolver(["169.254.169.254"]),
  });
  const approved = new Set(["http://example.com"]);
  await assert.rejects(
    reader.read("http://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "transport:http must not disable vetting; metadata IP must be refused",
  );
});

// =============================================================================
// Witness tests (ex witness-finding1.mjs): IPv6 boundary addresses
// =============================================================================

test("Witness F1: fd00::1 (unique-local) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["fd00::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: fd42:1234::1 (unique-local) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["fd42:1234::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: fe90::1 (link-local fe80::/10) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["fe90::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: fea0::1 (link-local fe80::/10) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["fea0::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: feb0::1 (link-local fe80::/10) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["feb0::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: 2002:a00:0:0:0:0:0:1 (6to4, embeds 10.0.0.1) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2002:a00:0:0:0:0:0:1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: febf::1 (edge of fe80::/10) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["febf::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("Witness F1: fdff:ffff::1 (edge of fc00::/7) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["fdff:ffff::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

// =============================================================================
// Witness tests (ex witness-finding2.mjs): DNS deadline
// =============================================================================

// Resolver that never settles
function neverResolver() {
  return {
    resolve4: () => new Promise(() => {}),
    resolve6: () => new Promise(() => {}),
  };
}

test("Witness F2: DNS deadline — pending resolver gives fetch_timeout on first hop", async () => {
  const reader = createSafeReader({
    resolver: neverResolver(),
    limits: { deadlineMs: 20 },
  });
  const approved = new Set(["https://example.com"]);
  const start = Date.now();
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_timeout",
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 20 + 50, `DNS deadline should fire within deadline+50ms, but took ${elapsed}ms`);
});

test("Witness F2: DNS deadline — pending resolver gives fetch_timeout on redirect hop", async () => {
  let redirectDone = false;
  const redirectTransport = {
    request(opts) {
      if (!redirectDone) {
        redirectDone = true;
        return {
          on: (event, cb) => {
            if (event === "response") {
              const res = {
                statusCode: 301,
                headers: { location: "https://other.example/" },
                on: (ev, cb2) => { if (ev === "end") cb2(); },
                destroy: () => {},
              };
              cb(res);
            }
            if (event === "error") {}
          },
          end: () => {},
          destroy: () => {},
        };
      }
      return {
        on: (event, cb) => {
          if (event === "error") {}
        },
        end: () => {},
        destroy: () => {},
      };
    },
    _isTestHttp: true,
  };

  const reader = createSafeReader({
    transport: redirectTransport,
    resolver: neverResolver(),
    limits: { deadlineMs: 20 },
  });
  const approved = new Set(["https://example.com", "https://other.example"]);
  const start = Date.now();
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_timeout",
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 20 + 50, `DNS deadline should fire within deadline+50ms on redirect hop, but took ${elapsed}ms`);
});

// =============================================================================
// R7-4: IPv6 special-purpose ranges
// =============================================================================

test("R7-4: 2001:db8::1 (documentation 2001:db8::/32) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001:db8::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001:db8:ffff:ffff:ffff:ffff:ffff:ffff (last of 2001:db8::/32) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001:db8:ffff:ffff:ffff:ffff:ffff:ffff"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001:db8:0:0:0:0:0:0 (first of 2001:db8::/32) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001:db8::"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 100::1 (discard 100::/64) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["100::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 100::ffff:ffff:ffff:ffff (last of 100::/64) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["100::ffff:ffff:ffff:ffff"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 100:: (first of 100::/64) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["100::"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001::1 (IETF protocol 2001::/23) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff (last of 2001::/23) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001:100::1 (interior of 2001::/23) is refused", async () => {
  const reader = createSafeReader({ resolver: mockResolver([], ["2001:100::1"]) });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
  );
});

test("R7-4: 2001:200::1 (outside 2001::/23) is allowed through", async () => {
  // 2001:200:: is outside 2001::/23, so it should reach the transport layer.
  // Use a mock transport that immediately closes to avoid async network noise.
  const mockTransport = {
    request(opts) {
      const req = {
        on: (event, cb) => {
          if (event === "error") {
            // Simulate a transport error (not a vetting error)
            setImmediate(() => cb(new Error("mock transport error")));
          }
        },
        end: () => {},
        destroy: () => {},
      };
      return req;
    },
    _isTestHttp: true,
  };
  const reader = createSafeReader({
    transport: mockTransport,
    resolver: mockResolver([], ["2001:200::1"]),
  });
  const approved = new Set(["https://example.com"]);
  let sawPrivate = false;
  try {
    await reader.read("https://example.com/", { approvedOrigins: approved });
  } catch (err) {
    if (err instanceof SafeReaderError && err.code === "fetch_private_address") {
      sawPrivate = true;
    }
  }
  assert.equal(sawPrivate, false, "2001:200::1 is outside the blocked ranges and must not be refused as private");
});

// R11: dotted-tail IPv6 forms — NAT64 (64:ff9b::/96) and IPv4-mapped (::ffff:x.x.x.x)
// with dotted decimal tails. The reader must normalize these to flat hex before
// matching private-address prefixes.

const R11_REFUSED = [
  "64:ff9b::0.0.0.0",
  "64:ff9b::10.0.0.0",
  "64:ff9b::10.255.255.255",
  "64:ff9b::100.64.0.0",
  "64:ff9b::127.0.0.1",
  "64:ff9b::169.254.169.254",
  "64:ff9b::172.16.0.0",
  "64:ff9b::192.168.255.255",
  "64:ff9b::198.18.0.0",
  "64:ff9b::224.0.0.0",
  "64:ff9b::240.0.0.0",
  "64:ff9b::255.255.255.255",
  "::ffff:10.1.2.3",
  "0:0:0:0:0:ffff:127.0.0.1",
];

const R11_PUBLIC = [
  "64:ff9b::93.184.216.34",
  "::ffff:93.184.216.34",
];

const R11_MALFORMED = [
  "64:ff9b::10.0.0",
  "64:ff9b::256.0.0.1",
  "64:ff9b::1.2.3.4.5",
];

test("R11: dotted-tail private addresses are refused (fetch_private_address, ZERO transport)", async (t) => {
  for (const addr of R11_REFUSED) {
    await t.test(addr, async () => {
      let transportCalled = false;
      const transport = {
        request(_opts) {
          transportCalled = true;
          const req = {
            on: (event, cb) => { if (event === "error") setImmediate(() => cb(new Error("mock"))); },
            end: () => {},
            destroy: () => {},
          };
          return req;
        },
        _isTestHttp: true,
      };
      const reader = createSafeReader({
        transport,
        resolver: mockResolver([], [addr]),
      });
      const approved = new Set(["https://example.com"]);
      await assert.rejects(
        reader.read("https://example.com/", { approvedOrigins: approved }),
        (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
        `${addr}: expected fetch_private_address`,
      );
      assert.equal(transportCalled, false, `${addr}: transport must not be called`);
    });
  }
});

test("R11: dotted-tail public addresses reach transport", async (t) => {
  for (const addr of R11_PUBLIC) {
    await t.test(addr, async () => {
      let transportCalled = false;
      const transport = {
        request(_opts) {
          transportCalled = true;
          const req = {
            on: (event, cb) => { if (event === "error") setImmediate(() => cb(new Error("mock"))); },
            end: () => {},
            destroy: () => {},
          };
          return req;
        },
        _isTestHttp: true,
      };
      const reader = createSafeReader({
        transport,
        resolver: mockResolver([], [addr]),
      });
      const approved = new Set(["https://example.com"]);
      let sawPrivate = false;
      try {
        await reader.read("https://example.com/", { approvedOrigins: approved });
      } catch (err) {
        if (err instanceof SafeReaderError && err.code === "fetch_private_address") {
          sawPrivate = true;
        }
      }
      assert.equal(sawPrivate, false, `${addr}: must not be refused as private`);
      assert.equal(transportCalled, true, `${addr}: must reach transport`);
    });
  }
});

test("R11: malformed dotted-tails are rejected, never treated as valid", async (t) => {
  for (const addr of R11_MALFORMED) {
    await t.test(addr, async () => {
      let transportCalled = false;
      const transport = {
        request(_opts) {
          transportCalled = true;
          const req = {
            on: (event, cb) => { if (event === "error") setImmediate(() => cb(new Error("mock"))); },
            end: () => {},
            destroy: () => {},
          };
          return req;
        },
        _isTestHttp: true,
      };
      const reader = createSafeReader({
        transport,
        resolver: mockResolver([], [addr]),
      });
      const approved = new Set(["https://example.com"]);
      try {
        await reader.read("https://example.com/", { approvedOrigins: approved });
        assert.fail(`${addr}: expected rejection`);
      } catch (err) {
        // Must be rejected somehow — private or otherwise
      }
      assert.equal(transportCalled, false, `${addr}: transport must not be called`);
    });
  }
});

test("R12: fail-closed — resolver returning garbage non-IP string is refused before transport", async () => {
  let transportCalled = false;
  const transport = {
    request(_opts) {
      transportCalled = true;
      const req = {
        on: (event, cb) => { if (event === "error") setImmediate(() => cb(new Error("mock"))); },
        end: () => {},
        destroy: () => {},
      };
      return req;
    },
    _isTestHttp: true,
  };
  const reader = createSafeReader({
    transport,
    resolver: mockResolver([], ["not-an-ip"]),
  });
  const approved = new Set(["https://example.com"]);
  await assert.rejects(
    reader.read("https://example.com/", { approvedOrigins: approved }),
    (err) => err instanceof SafeReaderError && err.code === "fetch_private_address",
    "garbage resolver result must be refused as private",
  );
  assert.equal(transportCalled, false, "transport must not be called for garbage resolver result");
});
