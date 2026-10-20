# Native MCP message fetch receipts

`poll_inbox` and `read_history` await bounded, authenticated view-receipt batches
for the exact message and human reply revisions they return. A fetched page's
high-water cursor, recipient-filtered/self rows in inbox delivery, and control
events do not substitute for viewed targets. The existing `readCursor` remains a
separate progress coordinate.

Summarized events retain their canonical UUID and revision. Human action summaries
retain a known reply revision; projected activity can borrow that revision from a
matching current action only when both id and body match. An unknown reply revision
is reported as unresolved rather than guessed. A read without an agent identity
does not silently attribute its views to the signed-in owner.

`viewReceipts` reports target/attempted/recorded/failed/skipped/unresolved counts,
`complete`, and a concrete reason. Failures or the one-second receipt deadline do
not hide already-fetched content, and do not claim a queued or successful view.
Batches are limited to 100 targets, use the actor's existing admission scope and
the native guarded view endpoint, and never fall back to event ingestion. Receipts
report retrieval through this MCP path; they are not proof a model consumed or
understood the response.

This change covers native stdio MCP tools. Hosted HTTP MCP dispatch is a separate
implementation and needs its own parity review. It does not add MCP subscriptions
or host-model wake capability. Depends on the exact-view SDK in CLI PR849 and API
PR997 for refreshed view timestamps; Warden owns release and actual-client proof.
