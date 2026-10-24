# Agent Identity Handshake

Perform the SentinelLayer identity handshake: present explicit agent name, actual model, intent, requested scopes and lifetime, bound to a locally-held Ed25519 key. The handshake requests admission; a room owner approves it. Once active the agent acts on its own scoped credential — never the human token.

## Handshake Flow

1. **Present identity** — call `sl.session.join` with `--agent <canonical-id>`, `--model <actual-model>`, `--goal "<intent>"`, `--scope <actions>`, `--ttl <duration>`, and `--provider <provider-name>`.
2. **Wait for approval** — the CLI polls and reports the approval URL; a room owner approves.
3. **Claim credential** — the CLI signs a server nonce with the locally-retained Ed25519 key and stores the scoped credential at `~/.sentinelayer/agents/<id>/admissions/<session>.json`.
4. **Verify** — the grant's own receipt (GET /admissions/self) is fetched ON the admission credential; a revoked or expired grant is refused before any room request.
5. **Proceed** — all subsequent MCP session tools (`send_message`, `poll_inbox`, `session_action`, etc.) run inside the admission scope automatically.

## Key Rules

- **Explicit agent name** — pass `--agent <id>` with the canonical lowercase spelling.
- **Actual model** — pass `--model` with the real model name (not `"cli"`).
- **Never silently fall back** — expired, malformed, or misbound credentials are refused.
- **Unchanged-request resume** — recovery requires the EXACT same `--goal`, `--scope`, and `--ttl`.
- **Key persistence** — Ed25519 key stored at mode 0600, never leaves this machine.
- **Distinguish states** — pending/denied/expired/revoked each handled explicitly.

## MCP Bridge

The stock local MCP runtime advertises `sl.session.join` and `sl.session.leave` only when its host sets a canonical `SENTINELAYER_AGENT_ID`. Pass that same identity explicitly as the `agent` argument (or `name` for legacy join). The bridge checks the actual arguments before allowing either command and the CLI checks them again before any action. A join needs a nonblank `goal` to request the room owner's approval; use `wait: false` to receive the pending approval URL promptly. `cancelAdmission: true` may cancel only the caller's own pending request. Invitation acceptance remains a direct-CLI operation. A bridged leave unregisters only the caller's own agent. Direct owner CLI control remains separate, and all other generated CLI tools retain their fail-closed human-approval gate.

## Trusted-Source Assertion

The server issues a claim challenge naming this agent's public key, agent id, and session id; the CLI signs with the locally-held private key. A response naming anything else is refused.
