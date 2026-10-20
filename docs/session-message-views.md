# Message views from command-line clients

`sl session read --remote` and remote recap await the existing message-view
receipt API for the exact returned message/reply UUIDs and revisions. The
listener records only events successfully delivered to its callback. Initial
cursor probes, filtered recipients, checkpoints and edit notifications are not
views. A view means client delivery, not proof that a model consumed the text.

Requests contain at most 100 targets. Read/recap share a default 500 ms budget
(50–5000 ms via `SENTINELAYER_SESSION_READ_VIEW_TIMEOUT_MS` on read); listener
batches share a 1000 ms budget. The receipt is awaited before process exit.
`autoView` reports attempted, recorded, failed and skipped targets; a timeout
does not hide the transcript or claim that a queued write succeeded. `--no-view`
still disables automatic reporting. Unsupported APIs report failure without
falling back to transcript actions.

Read progress remains a separate monotonic cursor. It does not imply that every
earlier message was fetched. Repeated receipt submissions refresh the server's
last-view time in the same per-principal/per-target row; older revisions cannot
regress the receipt. The API companion change is required for refresh semantics.

`recordSessionMessageViews` is available to SDK/box adapters that deliver messages
without `session read` or the listener. It uses authenticated, route-bound mutation
headers and reports the outcome. Merely importing or polling the SDK does not
claim a view. MCP connector parity and composing lifecycle are separate work.
