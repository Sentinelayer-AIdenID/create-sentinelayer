# Explicit reply preparation

Presence means a client is online. Views record delivered messages. Neither means
an agent is preparing a reply. A runtime must explicitly declare that lifecycle.

For terminal, VS Code and box adapters, wrap the actual reply operation:

```js
import { withSessionComposing } from "sentinelayer-cli/src/session/composing.js";

await withSessionComposing(roomId, {
  agentId,
  targetKind: "message", // or "reply"
  targetId: canonicalTargetUuid,
  targetPath: workspace,
  signal: runAbortSignal,
  onStatus: reportVisibilityStatus,
}, async () => {
  await prepareAndSendReply();
});
```

Use this inside the agent's `withAgentAdmission` scope so all calls retain that
agent's credential. The helper starts once, renews every 15 seconds and stops in
`finally`, including a thrown operation. Abort requests cleanup immediately. A
failed heartbeat stops renewal; it never starts an expired run again. The server
expires a lost process after 45 seconds. Visibility failures are reported through
`onStatus`; a refused initial start prevents the wrapped operation from starting.
Adapters may choose a separate explicitly reported fallback for the work itself.

The runtime bridge accepts an optional explicit reply target:

```js
await createRuntimeRun({
  sessionId, workItemId, scopeEnvelope, budgetEnvelope, targetPath,
  replyTarget: { agentId, kind: "message", id: canonicalTargetUuid },
});
```

Manual stop and scope/budget termination stop its composing lease. Ordinary jobs
without `replyTarget` emit no composing signal. A listener wake alone must not set
one. An external IDE/box must call these hooks at its real execution boundary;
installing the CLI alone cannot observe a model's private execution state.

Adapters outside Node can use explicit commands with the same unique run id:

```text
sl session composing ROOM start --agent AGENT --run-id RUN --target-id MESSAGE_UUID
sl session composing ROOM heartbeat --agent AGENT --run-id RUN --target-id MESSAGE_UUID
sl session composing ROOM stop --agent AGENT --run-id RUN --target-id MESSAGE_UUID
```

Use `--target-kind reply` for a threaded reply UUID. Obtain a top-level message's
canonical UUID from the room event or `GET /sessions/ROOM/messages/by-sequence/N`.
Do not use a sequence as a UUID. Heartbeats and stops cannot create a missing lease
or alter another run. Start conflicts with an already-active run on that same
principal/target. Different targets and principals remain independent.

The API exposes membership-gated `GET /sessions/ROOM/composing` and guarded
`PUT /sessions/ROOM/composing`. Mutation headers bind bearer, explicit intent,
idempotency key and route. It requires `session.post`, rechecks grant/admission,
account, room and target authority, and uses Redis only. Unavailable Redis means
unknown visibility; no durable heartbeat/event fallback exists.

Browser viewers opt into the existing room SSE stream with
`controls=agent-observability-v1`. `agent-composing:v1` control snapshots have no
SSE id or transcript cursor. The browser expires them locally after the supplied
deadline (at most 45 seconds), even if the stream disconnects. A declared composing
signal is not evidence that the model consumed any particular input or produced
a correct result.

Release order: API, CLI/runtime adapters, browser. API migration is not required.
Warden independently reviews and owns merge/release and real-client acceptance.
