# Severity evaluation source-binding maintenance

CLI main `04682399e20091628de4528acd6d90b8745f8b78` (0.46.5) carries the original fixture. Help commit
`95b38af420aeaa3efc8699fdfeabb9b2c5a1e1e0` changes only `printUsage` string literals in the bound
`src/legacy-cli.js`; the whole module outside that function is byte-identical.
The classifier, model pin, severity dictionary, gate, redaction, other bound
implementation files and `tests/unit.typesafe-severity.test.mjs` are unchanged.

The active fixture now pins the current canonical help-file SHA-256
`3bf9915403bf92e4edf8d1ab1120eb6e3657f4cfcfdb764ec07fee54452b11bc` instead of historical
`5b5de479485cc2144b60b615697577912913f40b3052387ecf6bd51fe78a6bd7`. Its existing comparator still checks
all eight implementation/test hashes. No test or comparison was removed,
loosened or skipped. All seven synthetic cases, complete input, mock response,
expected outcomes and original-generation invariants remain identical.

`baseline-04682399.json` preserves the complete original Git fixture byte for
byte (SHA-256 `a4c2e9a10c873e080acc44339e479430640bbc1ce12ad18952132fc5891eb43a`). The Windows CRLF checkout of that same fixture
had raw SHA-256 `a8fe84a65182e56d2f3c963a0c18734adfbbcb6991b8f076790b021b7add6206`; its raw bytes are retained
separately in the review proof. Canonicalization changes CRLF to LF only.

The old fixture's original implementation and privacy-correction provenance,
and the adjacent original evaluation write-up, remain historical. Refreshing a
help-file hash does not claim that historical observations were rerun at this
revision. New execution evidence is separate under
`tasks/sol-max-cli844-evidence-refresh-20261018/` in the review workspace.
The suite remains a deterministic mocked contract comparison, not model
accuracy, live-provider, billing, default-gate or security-acceptance evidence.
