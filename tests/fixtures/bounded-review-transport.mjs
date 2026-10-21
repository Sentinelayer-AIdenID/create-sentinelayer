// Actual-bin transport fixture: synthetic auth only, no native network allowed.
import "../setup-env.mjs";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { syncBuiltinESMExports } from "node:module";

process.env.SENTINELAYER_TOKEN = "synthetic-bounded-review-session";
// The proof must not depend on the test bootstrap's remote-write skip flag.
delete process.env.SENTINELAYER_SKIP_REMOTE_SYNC;
Date.now = () => Date.parse("2026-10-21T12:00:00Z");
const receipt = { providerCalls: 0, otherRoutes: [], nativeAttempts: 0 };
const refuse = () => { receipt.nativeAttempts++; throw new Error("FIXTURE_NETWORK_REFUSED"); };
http.request = http.get = https.request = https.get = refuse;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = refuse;
syncBuiltinESMExports();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.origin !== "https://api.openai.com" || !["/v1/responses", "/v1/chat/completions"].includes(url.pathname)) {
    receipt.otherRoutes.push({ origin: url.origin, path: url.pathname, method: init.method || "GET" });
    throw new Error("FIXTURE_NON_PROVIDER_REFUSED");
  }
  receipt.providerCalls++;
  if (process.env.EXPOSURE_FIXTURE_UNCERTAIN === "1") throw new Error("FIXTURE_UNCERTAIN_SEND");
  const text = '{"findings":[]}';
  const payload = url.pathname.endsWith("/responses") ? {
    model: "gpt-5.3-codex", status: "completed", service_tier: "default",
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text }] }],
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 3 } },
  } : {
    model: "gpt-5.3-codex", choices: [{ finish_reason: "stop", message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
};
Object.defineProperty(globalThis.fetch, Symbol.for("sentinelayer.testEgressGuard"), { value: true });
process.on("exit", () => fs.writeFileSync(process.env.EXPOSURE_FIXTURE_RECEIPT, JSON.stringify(receipt)));
