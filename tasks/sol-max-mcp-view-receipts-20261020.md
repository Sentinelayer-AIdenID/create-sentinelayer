# MCP exact-view receipt parity

- [x] Isolate from CLI849/23e52933 and reuse its guarded exact-revision view SDK; no new MCP tool or admission handshake.
- [x] Await bounded receipts for inbox/history messages actually returned and human replies with known matching revisions. Keep progress/cursors separate and preserve UUID/revision metadata.
- [x] Report unresolved identity/revision, timeout and partial failures without hiding already-read content or fabricating a queued view.
- [x] Focused tests: 25 pass; final targeted preload/MCP cohort 22 pass. Removed-filter mutation fails; exact source bytes restored.
- [x] Final unit suite: 2517 pass, 3 skip. Syntax/docs/pack pass. Required verify: E2E134/136, the same previously established help-URL and legacy-join baseline failures; no overall verify-green claim.
- [x] Deterministic Omar: zero P0/P1/P2. Legacy audit PASS with three existing P2s.
- [ ] Warden independent review, parent849 merge, release and actual-client readback. Hosted HTTP MCP parity is separate; no universal model-wake claim.
