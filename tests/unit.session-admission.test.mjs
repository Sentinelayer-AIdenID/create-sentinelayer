import "./setup-env.mjs";
// The CLI side of agent admission against a FAITHFUL fake API. The fake verifies
// what the real API verifies: the per-route HMAC CSRF token on every mutation, and
// the Ed25519 claim signature over the canonical preimage with the key stored at
// REQUEST time. A route-id or preimage mismatch fails here, not first in prod.

import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID, sign as signBytes, verify as verifyBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CLAIM_DOMAIN,
  CLAIM_FIELDS,
  RECOVERY_DOMAIN,
  RECOVERY_FIELDS,
  admissionCredentialPath,
  agentKeyPath,
  readAdmissionCredentialState,
  loadOrCreateAgentKey,
  parseScope,
  publishKeyFile,
  parseTtlSeconds,
  runAdmissionJoin,
  withAdmissionCredentialLock,
} from "../src/session/admission.js";
import { canonicalPreimage } from "../src/session/admission-preimage.js";
import { createSessionMutationCsrfToken } from "../src/session/invitations.js";
import { bearerOf } from "./credential-probe.mjs";

const SID = "e9e8dc5e-8d57-4603-975f-09156e3b4473";
const TOKEN = "unit-test-human-bearer";
// The fake API is the configured API: the user's credential is only sent to that origin.
process.env.SENTINELAYER_API_URL = "https://api.test";

test("recovery proof is byte-identical to the Python API fixture", () => {
  const fields = {
    admissionId: "00000000-0000-4000-8000-000000000001", sessionId: "test-room", agentId: "test-agent",
    publicKey: "A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg",
    keyThumbprint: "56475aa75463474c0285df5dbf2bcab73da651358839e9b77481b2eab107708c",
    nonce: "AAAAAHDb2awAAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHw",
    delegatorUserId: "00000000-0000-4000-8000-000000000002",
    tenantUserId: "00000000-0000-4000-8000-000000000003", grantId: "test-grant", passportId: "test-passport",
    goalDigest: "a".repeat(64), actions: ["session.post", "session.read"], policyVersion: "admission-v0.1",
    expiresAt: 1893459600, aidenidIdentityId: "test-identity", aidenidHandle: "test-agent@example.invalid",
    challengeExpiresAt: 1893456300,
  };
  const preimage = canonicalPreimage(fields, { domain: RECOVERY_DOMAIN, fields: [...RECOVERY_FIELDS] });
  assert.equal(createHash("sha256").update(preimage).digest("hex"), "6e67c9a0c3763946bce9f56027c6eab2fc4e3a399d71f5620f6e08b63633f71d");
  // RFC8410 PKCS#8 framing; inert fixture seed 00..1f, never a deployed key.
  const key = createPrivateKey({ key: Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(Array.from({ length: 32 }, (_, i) => i)),
  ]), format: "der", type: "pkcs8" });
  assert.equal(signBytes(null, preimage, key).toString("base64url"), "_-Nr_gUTPQhqOfQaw9KPDPRMfRQpaL3VotyczsPeeXCe63arHhNMP6bi8Lxp8Qvuggk1f8P4_FpspRv7DuJiCQ");
});

// reportsIdentityReadiness=false is a server that issues the claim challenge on
// approval and never reports identity readiness (the shape sentinelayer-api served
// before identity-gated claims).
function fakeApi({ onPoll, reportsIdentityReadiness = true, onRecoveryChallenge, onRecoveryResult } = {}) {
  const admissions = new Map();
  const calls = [];
  const expectCsrf = (headers, routeId, idempotencyKey) => {
    const expected = createSessionMutationCsrfToken({ bearerToken: TOKEN, sessionId: SID, routeId, idempotencyKey });
    assert.equal(headers["X-CSRF-Token"], expected, `bad CSRF for ${routeId}`);
  };
  const requestMutation = async (url, { method, headers, body, idempotencyKey }) => {
    calls.push({ method, url, body });
    assert.equal(method, "POST");
    const base = `https://api.test/api/v1/sessions/${SID}/admissions`;
    if (url === base) {
      expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions", idempotencyKey);
      // The API's R1 rule: a live grant for this agent and key is reused only for the
      // SAME purpose; a different goal is a 409, never a silent inheritance.
      const live = [...admissions.values()].find(
        (a) => a.status === "active" && a.body.agentId === body.agentId && a.body.publicKey === body.publicKey
      );
      if (live) {
        if (
          JSON.stringify(live.body.goal) !== JSON.stringify(body.goal) ||
          live.body.requestedScope.ttlSeconds !== body.requestedScope.ttlSeconds
        ) {
          throw new Error("409 ADMISSION_CONFLICT: cancel or revoke it before requesting a different goal, duration, scope or key");
        }
        return { admissionId: live.id, status: "active", reused: true, agentId: body.agentId };
      }
      const id = randomUUID();
      admissions.set(id, { id, status: "pending", body, nonce: null, identityReady: true });
      return { admissionId: id, status: "pending", agentId: body.agentId, approveUrl: `https://web.test/?admission=${id}`, pollAfterSeconds: 5 };
    }
    const claimMatch = url.match(/\/admissions\/([^/]+)\/claim$/);
    if (claimMatch) {
      expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/claim", idempotencyKey);
      const adm = admissions.get(decodeURIComponent(claimMatch[1]));
      assert.equal(body.nonce, adm.nonce, "claim must present the current nonce");
      const fields = {
        admissionId: adm.id,
        sessionId: SID,
        agentId: adm.body.agentId,
        publicKey: adm.body.publicKey, // the key stored at REQUEST time
        keyThumbprint: "t".repeat(64),
        nonce: adm.nonce,
      };
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: adm.body.publicKey }, format: "jwk" });
      const ok = verifyBytes(null, canonicalPreimage(fields, { domain: CLAIM_DOMAIN, fields: [...CLAIM_FIELDS] }), publicKey, Buffer.from(body.signature, "base64url"));
      if (!ok) throw new Error("claim proof did not verify");
      adm.status = "active";
      adm.claimed = {
        admissionId: adm.id,
        status: "active",
        identity: { subject: `sl-agent:u/${adm.body.agentId}`, passportId: "pid", passportStatus: "issued", keyThumbprint: "t".repeat(64), popAssurance: "agent_held_key", email: { status: "provisioned", address: `${adm.body.agentId}@agents.test` }, passport: { passport_id: "pid" } },
        grant: { grantId: "g", sessionId: SID, actions: adm.body.requestedScope.actions, expiresAt: Math.floor(Date.now() / 1000) + 3600, goalDigest: "d", document: null },
        correlation: { actorRef: `adm:${adm.id}` },
        jev: { verificationStatus: "not_evaluated" },
        credential: { token: `sladm_${"S".repeat(43)}`, deliveredOnce: true },
      };
      return adm.claimed;
    }
    const recoveryMatch = url.match(/\/admissions\/([^/]+)\/recover(\/challenge)?$/);
    if (recoveryMatch) {
      const adm = admissions.get(decodeURIComponent(recoveryMatch[1]));
      assert.equal(adm.status, "active", "only a live grant can be recovered");
      const preimage = {
        admissionId: adm.id, sessionId: SID, agentId: adm.body.agentId,
        publicKey: adm.body.publicKey, keyThumbprint: adm.claimed.identity.keyThumbprint,
        delegatorUserId: "human-1", tenantUserId: "tenant-1", grantId: adm.claimed.grant.grantId,
        passportId: adm.claimed.identity.passportId, goalDigest: adm.claimed.grant.goalDigest,
        actions: [...adm.claimed.grant.actions].sort(), policyVersion: "admission-v0.1",
        expiresAt: adm.claimed.grant.expiresAt, aidenidIdentityId: "email-id-1",
        aidenidHandle: adm.claimed.identity.email.address,
        nonce: adm.recoveryNonce, challengeExpiresAt: Math.floor(Date.now() / 1000) + 300,
      };
      if (recoveryMatch[2]) {
        expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/recover/challenge", idempotencyKey);
        adm.recoveryNonce = randomBytes(40).toString("base64url");
        preimage.nonce = adm.recoveryNonce;
        adm.recoveryPreimage = preimage;
        const challenge = { admissionId: adm.id, status: "active", recovery: {
          domain: RECOVERY_DOMAIN, fields: [...RECOVERY_FIELDS], preimage,
        } };
        onRecoveryChallenge?.(challenge);
        return challenge;
      }
      expectCsrf(headers, "POST /api/v1/sessions/{session_id}/admissions/{admission_id}/recover", idempotencyKey);
      assert.equal(body.nonce, adm.recoveryNonce);
      const publicKey = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: adm.body.publicKey }, format: "jwk" });
      assert.equal(verifyBytes(null, canonicalPreimage(adm.recoveryPreimage, {
        domain: RECOVERY_DOMAIN, fields: [...RECOVERY_FIELDS],
      }), publicKey, Buffer.from(body.signature, "base64url")), true);
      adm.recoveryNonce = null;
      const result = { ...adm.claimed, recovered: true, credential: {
        token: `sladm_${randomBytes(32).toString("base64url")}`, deliveredOnce: true,
      } };
      onRecoveryResult?.(result);
      return result;
    }
    throw new Error(`unexpected mutation ${url}`);
  };
  const requestRead = async (url, { credential }) => {
    calls.push({ method: "GET", url });
    assert.equal(await bearerOf(credential), TOKEN);
    assert.equal(credential.origin, "https://api.test");
    const id = decodeURIComponent(url.split("/").pop());
    const adm = admissions.get(id);
    onPoll?.(adm);
    const view = { admissionId: id, status: adm.status, agentId: adm.body.agentId, pollAfterSeconds: 5 };
    if (!reportsIdentityReadiness) {
      if (adm.status === "approved") {
        adm.nonce = randomBytes(32).toString("base64url");
        view.grantedActions = adm.body.requestedScope.actions;
        view.claim = {
          domain: CLAIM_DOMAIN,
          fields: [...CLAIM_FIELDS],
          preimage: {
            admissionId: id,
            sessionId: SID,
            agentId: adm.body.agentId,
            publicKey: adm.body.publicKey,
            keyThumbprint: "t".repeat(64),
            nonce: adm.nonce,
          },
        };
      }
      return view;
    }
    if (adm.status === "approved") {
      view.identityReady = adm.identityReady === true;
      view.identity = {
        email: adm.identityReady
          ? { status: "provisioned", address: `${adm.body.agentId}@agents.test` }
          : { status: "pending", address: null },
        purpose: adm.identityReady
          ? { status: "declared", verification: "verified", receiptId: "receipt-1" }
          : { status: "pending" },
      };
    }
    if (adm.status === "approved" && adm.identityReady === true) {
      adm.nonce = randomBytes(32).toString("base64url"); // rotates on every poll
      view.claim = {
        domain: CLAIM_DOMAIN,
        fields: [...CLAIM_FIELDS],
        preimage: {
          admissionId: id,
          sessionId: SID,
          agentId: adm.body.agentId,
          publicKey: adm.body.publicKey,
          keyThumbprint: "t".repeat(64),
          nonce: adm.nonce,
        },
      };
    }
    return view;
  };
  return { admissions, calls, requestMutation, requestRead };
}

async function scratch() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "sl-admission-"));
  return { homeDir: path.join(dir, "home"), targetPath: path.join(dir, "ws") };
}

function base(api, dirs, extra = {}) {
  // A fake clock that sleeping advances: an approval or identity wait that never
  // resolves ends at the default wait deadline (a failed assertion) instead of spinning.
  let clock = Date.now();
  return {
    agentId: "builder-1",
    goal: "Implement and test the admission flow.",
    ttlSeconds: 3600,
    ...dirs,
    resolveAuthSession: async () => ({ token: TOKEN, apiUrl: "https://api.test" }),
    requestMutation: api.requestMutation,
    requestRead: api.requestRead,
    now: () => clock,
    sleep: async (ms) => { clock += Math.max(1, Number(ms) || 0); },
    ...extra,
  };
}

test("full flow: request, wait, approve, claim; credential stored and never output", async () => {
  const dirs = await scratch();
  let polls = 0;
  const api = fakeApi({ onPoll: (adm) => { if (++polls === 2) adm.status = "approved"; } });
  const pending = [];
  const result = await runAdmissionJoin(SID, base(api, dirs, { onPending: (p) => pending.push(p) }));
  assert.equal(result.status, "active");
  assert.equal(pending.length, 1);
  assert.ok(pending[0].approveUrl.includes("admission="));
  assert.equal(JSON.stringify(result).includes("sladm_"), false, "token leaked into output");
  assert.equal(result.credential.redacted, true);
  const { state, credential: stored } = await readAdmissionCredentialState(SID, "builder-1", { homeDir: dirs.homeDir });
  assert.equal(state, "live");
  assert.ok(stored.token.startsWith("sladm_"));
  if (process.platform !== "win32") {
    const mode = fs.statSync(admissionCredentialPath(SID, "builder-1", { homeDir: dirs.homeDir })).mode & 0o777;
    assert.equal(mode, 0o600);
  }
  const requestBody = api.calls.find((c) => c.method === "POST" && c.url.endsWith("/admissions")).body;
  assert.equal(requestBody.popAssurance, "agent_held_key");
  assert.equal(requestBody.clientKind, "cli");
  assert.equal("privateKey" in requestBody || JSON.stringify(requestBody).includes("PRIVATE"), false);
});

test("approved admission waits for verified AIdenID identity evidence before claiming", async () => {
  const dirs = await scratch();
  let polls = 0;
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      polls += 1;
      adm.identityReady = polls >= 2;
    },
  });
  const pending = [];
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, { onPending: (value) => pending.push(value) }),
  );
  assert.equal(result.status, "active");
  assert.equal(result.identity.email.status, "provisioned");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, "identity");
  assert.equal(pending[0].identityReady, false);
  assert.equal(api.calls.filter((call) => call.method === "GET").length, 3,
    "two readiness polls plus a fresh nonce read inside the credential publication lock");
  assert.equal(api.calls.filter((call) => call.url.endsWith("/claim")).length, 1);
});

test("identity provisioning timeout is retryable and never attempts claim", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      adm.identityReady = false;
    },
  });
  let clock = 0;
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, {
      waitTimeoutMs: 10_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
    }),
  );
  assert.equal(result.status, "approved");
  assert.equal(result.phase, "identity");
  assert.equal(result.identityReady, false);
  assert.equal(result.timedOut, true);
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
  const before = api.calls.length;
  const resumed = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(resumed.status, "approved");
  assert.equal(api.calls.length, before);
});

test("identity-ready response without a claim challenge fails closed", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const requestRead = async (...args) => {
    const view = await api.requestRead(...args);
    delete view.claim;
    return view;
  };
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { requestRead })),
    /Identity-ready admission did not include a valid claim challenge/,
  );
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("claim challenge exposed before identity readiness fails closed", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const requestRead = async (...args) => {
    const view = await api.requestRead(...args);
    view.identityReady = false;
    return view;
  };
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { requestRead })),
    /claim challenge before AIdenID identity evidence was ready/,
  );
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("a server that does not report identity readiness: the approved admission is claimed at once", async () => {
  const dirs = await scratch();
  let polls = 0;
  const api = fakeApi({
    reportsIdentityReadiness: false,
    onPoll: (adm) => { if (++polls === 2) adm.status = "approved"; },
  });
  const pending = [];
  const result = await runAdmissionJoin(SID, base(api, dirs, { onPending: (value) => pending.push(value) }));
  assert.equal(result.status, "active");
  assert.equal(api.calls.filter((call) => call.url.endsWith("/claim")).length, 1);
  assert.deepEqual(pending.map((value) => value.phase), ["approval"], "no identity wait without the capability");
});

test("a server that does not report identity readiness and sends no claim challenge still fails closed", async () => {
  const dirs = await scratch();
  const api = fakeApi({ reportsIdentityReadiness: false, onPoll: (adm) => { adm.status = "approved"; } });
  const requestRead = async (...args) => {
    const view = await api.requestRead(...args);
    delete view.claim;
    return view;
  };
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { requestRead })),
    /Approved admission did not include a valid claim challenge/,
  );
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("a stopped admission ends the wait at once and attempts no claim", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "stopped"; } });
  let clock = 0;
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, { waitTimeoutMs: 60_000, now: () => clock, sleep: async (ms) => { clock += ms; } }),
  );
  assert.equal(result.status, "stopped");
  assert.equal(result.timedOut, undefined, "a final status, not a timeout");
  assert.equal(api.calls.filter((call) => call.method === "GET").length, 1);
  assert.equal(api.calls.some((call) => call.url.endsWith("/claim")), false);
});

test("--no-wait returns pending with the approve URL immediately", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  const result = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(result.status, "pending");
  assert.ok(result.approveUrl);
  assert.equal(api.calls.filter((c) => c.method === "GET").length, 0);
});

test("a pending noAutoGrant request keeps its opt-out when resumed without the flag", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const pending = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true, wait: false }));
  assert.equal(pending.status, "pending");
  assert.equal((await readAdmissionCredentialState(SID, "builder-1", dirs)).state, "none");

  const resumed = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(resumed.status, "active");
  assert.equal(api.calls.filter((call) => call.method === "POST" && call.url.endsWith("/admissions")).length, 1);
  const stored = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(stored.state, "live");
  assert.equal(stored.credential.noAutoGrant, true);
});

test("an opt-out added while pending survives another resume without the flag", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  const stillPending = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true, wait: false }));
  assert.equal(stillPending.status, "pending");

  const resumed = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(resumed.status, "active");
  const stored = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(stored.credential.noAutoGrant, true);
});

test("a concurrent first claim applies the later caller's noAutoGrant opt-out", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { if (adm.status === "pending") adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));

  let otherClaimed = false;
  const requestRead = async (...args) => {
    const approved = await api.requestRead(...args);
    if (!otherClaimed) {
      otherClaimed = true;
      const first = await runAdmissionJoin(SID, base(api, dirs));
      assert.equal(first.status, "active");
    }
    // The opted-out caller received approval before the other claim completed.
    return approved;
  };
  const second = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true, requestRead }));
  assert.equal(otherClaimed, true);
  assert.equal(second.status, "active");
  assert.equal(second.reused, true);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/claim")).length, 1);
  const stored = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(stored.credential.noAutoGrant, true);
});

test("a re-run resumes the same request instead of filing a new one", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1);
});

test("refuses to sign a challenge naming another key", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => {
      adm.status = "approved";
      adm.body = { ...adm.body, publicKey: Buffer.alloc(32, 7).toString("base64url") };
    },
  });
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs)), /does not name this agent's key/);
  assert.equal(api.calls.some((c) => c.url.endsWith("/claim")), false);
});

test("denied ends the flow and clears resumable state", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "denied"; } });
  const result = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(result.status, "denied");
  const again = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.notEqual(again.admissionId, result.admissionId);
});

test("a bounded wait times out as pending and keeps state to resume", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  let clock = 0;
  const result = await runAdmissionJoin(
    SID,
    base(api, dirs, { waitTimeoutMs: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; } })
  );
  assert.equal(result.status, "pending");
  assert.equal(result.timedOut, true);
  const resumed = await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  assert.equal(resumed.admissionId, result.admissionId);
});

test("only the IDENTICAL request is reused locally, with no request at all", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs));
  const before = api.calls.length;
  const reused = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(reused.reused, true);
  assert.equal(api.calls.length, before);
});

test("email and cryptographic identity survive a cached reconnect without exposing the bearer", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  const again = await runAdmissionJoin(SID, base(api, dirs));
  assert.deepEqual(again.identity, first.identity);
  assert.equal(again.identity.email.address, "builder-1@agents.test");
  assert.equal(again.identity.subject, first.identity.subject);
  assert.equal(again.identity.keyThumbprint, first.identity.keyThumbprint);
  assert.equal(JSON.stringify(again).includes("sladm_"), false);
});

test("a retained key recovers a lost credential without new approval or extending expiry", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  await fsp.unlink(admissionCredentialPath(SID, "builder-1", dirs));
  const again = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(again.recovered, true);
  assert.equal(again.admissionId, first.admissionId);
  assert.equal(again.grant.expiresAt, first.grant.expiresAt);
  assert.equal(again.identity.email.address, first.identity.email.address);
  assert.equal(api.admissions.size, 1);
  assert.equal(JSON.stringify(again).includes("sladm_"), false);
  assert.equal((await readAdmissionCredentialState(SID, "builder-1", dirs)).state, "live");
});

test("an interrupted claim response recovers on resume using a fresh recovery proof", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { if (adm.status === "pending") adm.status = "approved"; } });
  const interrupted = async (url, options) => {
    const result = await api.requestMutation(url, options);
    if (url.endsWith("/claim")) throw new Error("synthetic response lost after commit");
    return result;
  };
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs, { requestMutation: interrupted })), /response lost/);
  const result = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(result.recovered, true);
  assert.equal(api.admissions.size, 1);
});

test("concurrent recovery serializes server rotation and the local credential write", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs));
  const filePath = admissionCredentialPath(SID, "builder-1", dirs);
  await fsp.unlink(filePath);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const firstRotated = new Promise((resolve) => { started = resolve; });
  let newestToken;
  const transport = async (url, options) => {
    const result = await api.requestMutation(url, options);
    if (url.endsWith("/recover")) {
      newestToken = result.credential.token;
      started();
      await blocked;
    }
    return result;
  };
  const first = runAdmissionJoin(SID, base(api, dirs, { requestMutation: transport }));
  await firstRotated;
  const second = runAdmissionJoin(SID, base(api, dirs, { requestMutation: transport }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(api.calls.filter((call) => call.url.endsWith("/recover")).length, 1);
  release();
  await Promise.all([first, second]);
  const stored = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(stored.credential.token, newestToken);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/recover")).length, 1);
});

test("a remotely replaced bearer can be explicitly recovered without human relogin", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  const old = await readAdmissionCredentialState(SID, "builder-1", dirs);
  const result = await runAdmissionJoin(SID, base(api, dirs, { recoverActive: true }));
  const current = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(result.recovered, true);
  assert.notEqual(current.credential.token, old.credential.token);
  assert.equal(result.admissionId, first.admissionId);
  assert.equal(result.grant.expiresAt, first.grant.expiresAt);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/admissions") && call.method === "POST").length, 1,
    "recovery must not open a new pending request");
});

test("recovery of a revoked cached grant cannot create a new admission request", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  api.admissions.get(first.admissionId).status = "revoked";
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs, { recoverActive: true })), /only a live grant/);
  assert.equal(api.admissions.size, 1);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/admissions") && call.method === "POST").length, 1);
});

test("a delayed initial claim cannot overwrite a recovered replacement", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { if (adm.status === "pending") adm.status = "approved"; } });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const claimCommitted = new Promise((resolve) => { started = resolve; });
  let originalToken;
  const transport = async (url, options) => {
    const result = await api.requestMutation(url, options);
    if (url.endsWith("/claim")) { originalToken = result.credential.token; started(); await blocked; }
    return result;
  };
  const first = runAdmissionJoin(SID, base(api, dirs, { requestMutation: transport }));
  await claimCommitted;
  const second = runAdmissionJoin(SID, base(api, dirs, { requestMutation: transport }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(api.calls.some((call) => call.url.endsWith("/recover")), false, "recovery cannot rotate while first claim is publishing");
  release();
  await Promise.all([first, second]);
  const stored = await readAdmissionCredentialState(SID, "builder-1", dirs);
  assert.equal(stored.credential.token, originalToken);
  assert.equal(api.calls.filter((call) => call.url.endsWith("/claim")).length, 1);
});

test("a locked recovery refuses boundedly without age-based lock stealing", async () => {
  const dirs = await scratch();
  const filePath = admissionCredentialPath(SID, "builder-1", dirs);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let started;
  const entered = new Promise((resolve) => { started = resolve; });
  const first = withAdmissionCredentialLock(filePath, async () => { started(); await blocked; });
  await entered;
  try {
    await assert.rejects(withAdmissionCredentialLock(filePath, async () => assert.fail("lock stolen"), { timeoutMs: 30 }), /already locked/);
  } finally {
    release();
    await first;
  }
  assert.equal(fs.existsSync(`${filePath}.recovery-lock`), false);
});

for (const [label, corrupt] of [
  ["key", (value) => { value.recovery.preimage.publicKey = "other-key"; }],
  ["session", (value) => { value.recovery.preimage.sessionId = "other-room"; }],
  ["agent", (value) => { value.recovery.preimage.agentId = "other-agent"; }],
  ["email", (value) => { value.recovery.preimage.aidenidHandle = ""; }],
  ["domain", (value) => { value.recovery.domain = CLAIM_DOMAIN; }],
  ["fields", (value) => { value.recovery.fields = [...CLAIM_FIELDS]; }],
  ["deadline", (value) => { value.recovery.preimage.challengeExpiresAt = 1; }],
]) {
  test(`recovery refuses a mismatched ${label} before signing or posting proof`, async () => {
    const dirs = await scratch();
    const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; }, onRecoveryChallenge: corrupt });
    await runAdmissionJoin(SID, base(api, dirs));
    await fsp.unlink(admissionCredentialPath(SID, "builder-1", dirs));
    await assert.rejects(runAdmissionJoin(SID, base(api, dirs)), /invalid or mismatched.*recovery challenge/);
    assert.equal(api.calls.some((call) => call.url.endsWith("/recover")), false);
  });
}

test("recovery refuses a response with a different email or extended authority", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; }, onRecoveryResult: (result) => {
    result.grant = { ...result.grant, expiresAt: result.grant.expiresAt + 1 };
  } });
  await runAdmissionJoin(SID, base(api, dirs));
  await fsp.unlink(admissionCredentialPath(SID, "builder-1", dirs));
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs)), /unchanged signed authority/);
  assert.equal((await readAdmissionCredentialState(SID, "builder-1", dirs)).state, "none");
});

test("a narrower scope for the same goal asks the server, which reuses the held grant", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  const before = api.calls.filter((c) => c.method === "POST").length;
  const again = await runAdmissionJoin(SID, base(api, dirs, { actions: ["session.read"] }));
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1, "the server must be asked");
  assert.equal(again.reused, true);
  assert.equal(again.admissionId, first.admissionId);
});

test("a changed goal never inherits the approval: the server's conflict surfaces", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { goal: "Read source only" }));
  const before = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { goal: "Delete all project resources", ttlSeconds: 300 })),
    /different goal/
  );
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1, "the server must be asked");
});

test("a changed duration is a question for the server, which refuses to pass the old grant off as it", async () => {
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  await runAdmissionJoin(SID, base(api, dirs, { ttlSeconds: 3600 }));
  const before = api.calls.filter((c) => c.method === "POST").length;
  await assert.rejects(runAdmissionJoin(SID, base(api, dirs, { ttlSeconds: 1800 })), /different goal, duration/);
  assert.equal(api.calls.filter((c) => c.method === "POST").length, before + 1);
});

test("a different request while one is pending is refused, not silently resumed", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  await runAdmissionJoin(SID, base(api, dirs, { wait: false }));
  await assert.rejects(
    runAdmissionJoin(SID, base(api, dirs, { wait: false, goal: "Something else" })),
    /already waiting.*--cancel-admission/s
  );
  assert.equal(api.calls.filter((c) => c.method === "POST").length, 1);
});

test("two agents in one workspace keep separate pending requests", async () => {
  const dirs = await scratch();
  const api = fakeApi();
  const one = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-one" }));
  const two = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-two" }));
  assert.notEqual(one.admissionId, two.admissionId);
  const oneAgain = await runAdmissionJoin(SID, base(api, dirs, { wait: false, agentId: "agent-one" }));
  assert.equal(oneAgain.admissionId, one.admissionId, "agent-one resumes its own request");
});

test("the agent key is created once and reused", async () => {
  const dirs = await scratch();
  const first = await loadOrCreateAgentKey("builder-1", { homeDir: dirs.homeDir });
  const second = await loadOrCreateAgentKey("builder-1", { homeDir: dirs.homeDir });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.publicKey, second.publicKey);
  assert.equal(Buffer.from(first.publicKey, "base64url").length, 32);
});

test("scope and TTL parsing refuse out-of-contract input", () => {
  assert.deepEqual(parseScope(""), ["session.read", "session.post"]);
  assert.deepEqual(parseScope("session.read,tickets.work"), ["session.read", "tickets.work"]);
  assert.throws(() => parseScope("session.read,admin"), /Unknown --scope/);
  assert.equal(parseTtlSeconds("2h"), 7200);
  assert.equal(parseTtlSeconds("90m"), 5400);
  assert.throws(() => parseTtlSeconds("1m"), /between 5m and 24h/);
  assert.throws(() => parseTtlSeconds("2w"), /--ttl must look like/);
});

// ------------------------------------------------------------ identity storage

test("concurrent first use in ONE process: every caller gets the persisted key", async () => {
  const dirs = await scratch();
  const settled = await Promise.allSettled(
    Array.from({ length: 24 }, () => loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir }))
  );
  const rejected = settled.filter((r) => r.status === "rejected");
  assert.deepEqual(rejected.map((r) => String(r.reason)), []);
  const persisted = await loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir });
  assert.equal(persisted.created, false);
  for (const { value } of settled) assert.equal(value.publicKey, persisted.publicKey);
  assert.equal(settled.filter((r) => r.value.created).length, 1, "exactly one caller created it");
});

test("concurrent first use across PROCESSES: every process gets the persisted key", async () => {
  const dirs = await scratch();
  const moduleUrl = new URL("../src/session/admission.js", import.meta.url).href;
  const script =
    `const m = await import(${JSON.stringify(moduleUrl)});` +
    `const k = await m.loadOrCreateAgentKey("same-agent", { homeDir: ${JSON.stringify(dirs.homeDir)} });` +
    `process.stdout.write(k.publicKey);`;
  const { spawn } = await import("node:child_process");
  const run = () =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err}`))));
    });
  const keys = await Promise.all(Array.from({ length: 8 }, run));
  const persisted = await loadOrCreateAgentKey("same-agent", { homeDir: dirs.homeDir });
  assert.deepEqual([...new Set(keys)], [persisted.publicKey]);
});

test("a key file that is not this agent's, or is inconsistent, is refused", async () => {
  const dirs = await scratch();
  const mine = await loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir });
  const keyPath = mine.keyPath;
  const record = JSON.parse(await fsp.readFile(keyPath, "utf8"));
  await fsp.writeFile(keyPath, JSON.stringify({ ...record, agentId: "agent-b" }));
  await assert.rejects(loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir }), /does not belong/);
  const other = await loadOrCreateAgentKey("agent-c", { homeDir: dirs.homeDir });
  await fsp.writeFile(keyPath, JSON.stringify({ ...record, publicKey: other.publicKey }));
  await assert.rejects(loadOrCreateAgentKey("agent-a", { homeDir: dirs.homeDir }), /inconsistent/);
});

test("storage paths are one identity each: injective, and case-folded", () => {
  const homeDir = path.join(os.tmpdir(), "sl-path-probe");
  assert.notEqual(agentKeyPath("agent:one", { homeDir }), agentKeyPath("agent_one", { homeDir }));
  assert.equal(agentKeyPath("Agent-One", { homeDir }), agentKeyPath("agent-one", { homeDir }));
  assert.notEqual(
    admissionCredentialPath(SID, "agent:one", { homeDir }),
    admissionCredentialPath(SID, "agent_one", { homeDir })
  );
  assert.throws(() => agentKeyPath("../escape", { homeDir }), /not a valid identifier/);
});

async function storeCredential(homeDir, overrides = {}) {
  const filePath = admissionCredentialPath(SID, "builder-1", { homeDir });
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const record = {
    version: 2,
    sessionId: SID,
    agentId: "builder-1",
    apiUrl: "https://api.test",
    admissionId: "a",
    token: `sladm_${"S".repeat(43)}`,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  };
  await fsp.writeFile(filePath, typeof overrides === "string" ? overrides : JSON.stringify(record));
  return filePath;
}

test("a stored admission is live, absent, or a TOMBSTONE, never quietly absent", async () => {
  const cases = [
    [{}, "live", undefined],
    [{ expiresAt: Math.floor(Date.now() / 1000) - 1 }, "refused", "expired"],
    [{ sessionId: "00000000-0000-0000-0000-000000000000" }, "refused", "bound_to_another_session_or_agent"],
    [{ apiUrl: "" }, "refused", "no_issuing_authority"],
    [{ token: "not-an-admission" }, "refused", "malformed"],
    ["{ not json", "refused", "malformed"],
  ];
  for (const [overrides, state, reason] of cases) {
    const dirs = await scratch();
    await storeCredential(dirs.homeDir, overrides);
    const held = await readAdmissionCredentialState(SID, "builder-1", { homeDir: dirs.homeDir });
    assert.equal(held.state, state, JSON.stringify(overrides));
    assert.equal(held.reason, reason, JSON.stringify(overrides));
  }
  const empty = await scratch();
  assert.equal((await readAdmissionCredentialState(SID, "builder-1", { homeDir: empty.homeDir })).state, "none");
});

test("publishing a key NEVER replaces an existing identity (the property the race depends on)", async () => {
  const dirs = await scratch();
  const keyPath = path.join(dirs.homeDir, "agents", "probe", "identity-ed25519.json");
  await publishKeyFile(keyPath, { agentId: "probe", publicKey: "first" });
  await publishKeyFile(keyPath, { agentId: "probe", publicKey: "second" });
  assert.equal(JSON.parse(await fsp.readFile(keyPath, "utf8")).publicKey, "first");
  const leftovers = (await fsp.readdir(path.dirname(keyPath))).filter((name) => name.endsWith(".tmp"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
});

// --- noAutoGrant persistence on cached/reused credentials ---

test("noAutoGrant is persisted on reused live credential (fast path, !recoverActive)", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => { adm.status = "approved"; },
    reportsIdentityReadiness: true,
  });
  // First join without noAutoGrant
  await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: false }));
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  let stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant || false, false, "initial credential has noAutoGrant false");

  // Second join WITH noAutoGrant (identical fingerprint -> fast path)
  const result = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true }));
  assert.equal(result.reused, true);
  // Read back: noAutoGrant should now be true
  stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "fast path must persist noAutoGrant on reused credential");
});

test("noAutoGrant false does not overwrite existing true on fast-path reuse", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => { adm.status = "approved"; },
    reportsIdentityReadiness: true,
  });
  // First join WITH noAutoGrant
  await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true }));
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  let stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "initial credential has noAutoGrant true");

  // Second join WITHOUT noAutoGrant (fast path)
  const result = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: false }));
  assert.equal(result.reused, true);
  // Read back: noAutoGrant should still be true (not downgraded)
  stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "noAutoGrant must not be downgraded from true to false on reuse");
});


test("noAutoGrant is persisted on reused live credential (recoverAndStore path)", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => { adm.status = "approved"; },
    reportsIdentityReadiness: true,
  });
  // First join without noAutoGrant
  await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: false }));
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  let stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant || false, false, "initial credential has noAutoGrant false");

  // Force token change to ensure recoverAndStore takes the store path (not reuse)
  // We do this by using recoverActive which goes through recovery and calls recoverAndStore
  const result = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true, recoverActive: true }));
  assert.equal(result.recovered, true, "recovery happened");
  // After recovery, noAutoGrant should be persisted
  stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "recoverAndStore must persist noAutoGrant after recovery");
});
test("noAutoGrant survives recovery when caller omits the flag (do not clear existing opt-out)", async () => {
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => { adm.status = "approved"; },
    reportsIdentityReadiness: true,
  });
  // First join WITH noAutoGrant=true to set the opt-out
  await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true }));
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  let stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "initial credential has noAutoGrant true");

  // Recover WITHOUT repeating noAutoGrant — the existing opt-out must survive
  const result = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: false, recoverActive: true }));
  // Recovery still happened
  assert.equal(result.recovered, true, "recovery happened");
  stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true,
    "existing noAutoGrant opt-out must survive recovery even when caller omits the flag");
});







test("noAutoGrant survives storeClaimedCredential even when previous credential is not live (expired/revoked)", async () => {
  // Regression: storeClaimedCredential previously checked previous.state === "live"
  // before preserving noAutoGrant. An expired/revoked credential with noAutoGrant=true
  // would lose its opt-out on recovery, allowing later auto-grant on IDENTITY_FORGERY.
  const dirs = await scratch();
  const api = fakeApi({
    onPoll: (adm) => { adm.status = "approved"; },
    reportsIdentityReadiness: true,
  });
  // First join WITH noAutoGrant=true to set the opt-out
  await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: true }));
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  let stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true, "initial credential has noAutoGrant true");

  // Force the credential to appear expired by overwriting expiresAt
  stored.expiresAt = 1; // long-expired
  stored.token = "sladm_expired";
  await fsp.writeFile(credPath, JSON.stringify(stored));

  // Now recover without repeating noAutoGrant — the opt-out must survive
  // even though the previous credential state is NOT "live"
  const result = await runAdmissionJoin(SID, base(api, dirs, { noAutoGrant: false, recoverActive: true }));
  assert.equal(result.recovered, true, "recovery happened");
  stored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.equal(stored.noAutoGrant, true,
    "noAutoGrant opt-out must survive recovery even when previous credential was expired");
});

test("second fast-path (server-reused) locks against concurrent token rotation", async () => {
  // Regression: when the server responds reused=true for an in-flight admission
  // and the local credential is live with matching admissionId, the second
  // fast-path wrote held.credential without a lock. A concurrent recovery could
  // rotate the token, and this path would restore the stale one.
  //
  // To bypass the first fast path (which also has fingerprint match), we keep
  // the credential file live but modify its stored fingerprint so the first
  // fast-path fingerprint check fails. The server has the same agent+key in
  // memory and returns reused=true. The second fast path then fires.
  const dirs = await scratch();
  const api = fakeApi({ onPoll: (adm) => { adm.status = "approved"; } });
  const first = await runAdmissionJoin(SID, base(api, dirs));
  assert.equal(first.status, "active");
  const credPath = admissionCredentialPath(SID, "builder-1", dirs);
  const firstStored = JSON.parse(await fsp.readFile(credPath, "utf8"));
  assert.ok(firstStored.token, "first join stored a token");

  // Modify the stored fingerprint so the first fast path (which compares
  // held.credential.requestFingerprint === fingerprint) does not match.
  firstStored.requestFingerprint = firstStored.requestFingerprint + "_stale";
  await fsp.writeFile(credPath, JSON.stringify(firstStored));

  // Simulate a concurrent writer that replaces the credential entirely
  // between the server response and the lock acquisition. The transport
  // wrapper replaces the credential with a different live one (different
  // admissionId) after the server responds reused.
  let rotatedToken;
  let rotationDone = false;
  const transport = async (url, options) => {
    const result = await api.requestMutation(url, options);
    if (result?.reused && !rotationDone) {
      // Replace the credential with a different live one, simulating a
      // concurrent recovery with a rotated token and different admissionId.
      rotatedToken = "sladm_" + "R".repeat(43);
      const rotated = {
        token: rotatedToken,
        sessionId: SID.toLowerCase(),
        agentId: "builder-1",
        publicKey: firstStored.publicKey,
        apiUrl: firstStored.apiUrl,
        requestFingerprint: "different_fingerprint_xyz",
        admissionId: "different-adm-id",
        identity: firstStored.identity,
        grant: firstStored.grant,
        correlation: firstStored.correlation,
        expiresAt: firstStored.expiresAt + 7200,
        storedAt: new Date().toISOString(),
      };
      await fsp.writeFile(credPath, JSON.stringify(rotated));
      rotationDone = true;
    }
    return result;
  };

  // The join must throw because the credential changed (admissionId mismatch)
  // and the fix rejects stale fallback instead of silently writing it.
  await assert.rejects(
    () => runAdmissionJoin(SID, base(api, dirs, { requestMutation: transport })),
    /Admission credential changed during join/,
    "must throw when credential changes under lock instead of writing stale snapshot"
  );
});
