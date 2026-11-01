# Bundled skill evaluation

AI change class: B (new skill instructions and a setup-guide recommendation).
Auth change class: D (only the offline `skills install` and `skills list` commands
are exempted from login; unrecognized skills commands and session writes stay gated).
Both skills commands are explicitly blocked from the MCP CLI bridge: this feature
does not grant tool callers access to arbitrary local skill paths.

Baseline: the npm package contains no skills and the setup guide has no skill-install
recommendation. Candidate: three versioned, public skills plus the listener helper
are packaged; generated coordination sections recommend `sl skills install`.

The supplied source files were checked against their source index SHA-256 digests
before adaptation. Public copies replace private examples and machine-specific
paths, remove dated internal deployment narratives, and retain the identity,
command, listener/Monitor and safety-net workflows. No credentials or source-access
URLs are packaged. The listener reads explicit environment configuration and is
never started by installation.

Deterministic input set and acceptance criteria:

- A fresh temporary home: list reports missing skills; install copies all content
  without authentication; a repeated install preserves file contents and mtimes.
- A changed guide or helper: reject without force before copying any skill; forced
  replacement restores the bundled bytes and preserves unrelated local files.
- Symlink/file-directory collisions: refuse, including with force; external targets
  remain untouched. Installation is not a transaction against concurrent writers.
- Local version changes, malformed frontmatter and missing files: list reports the
  actual content state and version when available.
- The supplied classifier/receipt checks exercise the shipped wrapper slices:
  addressed replies, broadcast coalescing, timestamp-normalized deduplication and
  trailing receipt persistence. They do not establish live room delivery.
- Scan all packaged skill files for room UUIDs, private addresses/hostnames and
  credential shapes; check public link hosts, skill metadata and local references.
- npm pack includes all three SKILL.md files and referenced helpers.
- Setup-guides text, JSON and generated instructions mention the install command.

No model routing or live room behavior was exercised. Human review should assess
instruction quality. Rollback: revert the feature; users may remove the three
installed skill directories after saving any local edits.
