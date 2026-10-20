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

Requires the API creator-provenance companion change. This does not alter ticket
work lease identity, admission, claim, renew or submission authority.
