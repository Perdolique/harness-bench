# ADR 0005: Immutable raw records as the source of truth

- Date: 2026-09-03
- Accepted: 2026-09-05
- Status: Accepted

## Context

Summaries alone cannot explain failed behavior, parser drift, grading changes, or
provider failures. Rewriting results destroys the basis for comparing harnesses.
Raw trajectories and patches may contain sensitive source and must stay restricted.

## Decision

Retain immutable raw execution and verifier records with hashes, separate initial
and completion records, native trajectory evidence, and declared artifacts.
Normalized reports, sanitized exports, and regrades are new derived records with
complete provenance. Never overwrite an original outcome or represent a regrade as
another agent invocation.

Retain native JSONL, ATIF, and Harbor's merged `codex.txt` as distinct evidence.
The upstream adapter irreversibly combines stdout and stderr; no derived record may
claim to reconstruct their original separation.

## Evidence

Version-specific Harbor collection and regrade sources are pinned in the
[research source register](../research-snapshot.md#primary-source-register).
The [public native results](../spikes/harbor-codex-subscription.md#public-network-native-results)
record the exact commands, retained surfaces, usage, timing, errors, and outcomes.
Each successful run contains 28 hashed entries, a completion linked to its immutable
intent, and a read-only run directory. The manifest SHA-256 values are public-01
`62b9c15290b12185c3f45a767e475ebb6d4a54c81a27729a086f0627741b81eb`,
public-02 `88b7d0c00e500fed64627330e6ee19235fbb1612f68c80a62d98e32bfd2ceb50`,
and public-03 `6f5cf36cc589ed908db0d0173220b94bf83466aef598de1e0dc17bd69c9242f6`.

The retained provider-free preflight SHA-256 is
`a2ba6b8bc21dc4023d1b25f8c30bafc7a974186d0d3f2eb540dceaf1dea7d9da`.
The historical failed restricted-network record remains separate from the public
revision and was not rewritten into a success.

## Alternatives

Keeping only a composite loses failure and facet evidence. Editing raw results to
fix a parser hides history. Keeping credentials in raw records for completeness is
forbidden; capture must exclude suspected credentials before finalization.

## Consequences

Raw records stay in a restricted external root. Secret scanning occurs before
finalization; a finding leaves the staged record quarantined and blocks durable
finalization or publication. Scanning is not proof that every secret was detected
and cannot stop network exfiltration during execution. A later discovery triggers
the incident procedure rather than silent rewriting.

Filesystem modes and hashes expose accidental or detected mutation; they are not a
defense against a malicious local owner. Unsupported output revisions and hash
mismatches fail explicitly. Issues 8 and 13 implement normalization and regrade
without weakening this source-of-truth boundary.

## Validation gate

Issue 2 demonstrated retention coverage, intent linkage, hashing, quarantine,
read-only finalization, and separate failure history. Issue 3 accepts this decision
with the stream-separation and secret-scanner limits stated above.
