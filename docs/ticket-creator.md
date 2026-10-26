# File a ticket with creator attribution

```
sl session ticket create ROOM --title "Fix the reader" --agent sol-max --source-sequence 52041 --json
```

The server resolves the acting agent from its credential or an authorized legacy
grant. `agentId` is a claim to authorize, not a free-form author. Admitted commands
use the admission credential; no agent credential is substituted with a human
token. Human/account creation can omit the agent. The optional source sequence
must be a message in that same room.

JSON returns the ticket and `idempotencyKey`. After an uncertain response, retry
the exact request using `--idempotency-key KEY`; error output retains the key.
Changing the source or body under the same key is refused by the API.

The API returns the canonical `ticket.creator` and `ticket.sourceMessage`.
`provenance.agentRecorded` matches the requested agent to the creator's kind and
ID. Text output distinguishes a credential-bound agent, an authorized legacy
account grant, and an account. An account identifies the credential's account,
not the physical person or process holding it. Missing creator metadata stays
unknown; the CLI does not infer it from the legacy `createdBy` label.

`provenance.sourceRecorded` confirms the requested sequence together with its
canonical message UUID and captured revision. The source reference records what
the filer cited; it does not establish that the source author authorized the
ticket. JSON retains the original ticket, including these assurance fields,
even when the response cannot confirm the requested provenance. A missing or
mismatched response never triggers a second creation with a fresh key.

Release dependency: apply API migration 101 and deploy the creator-provenance
implementation from API #999/#1010 before enabling this command for agent/source
creation. Verify admitted creation and independent readback against that deployed
API. Older servers can accept a ticket while ignoring the requested provenance;
response reporting happens after the write and is not a compatibility preflight.
The CLI alone therefore does not establish deployment readiness. This does not
alter ticket work lease identity, admission, claim, renew or submission authority.
