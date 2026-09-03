# ADR 0005: Immutable raw records as the source of truth

- Date: 2026-09-03
- Status: Proposed — pending feasibility

## Context

Summaries alone cannot explain failed behavior, parser drift, grading changes, or
provider failures. Rewriting results destroys the basis for comparing harnesses.
Raw trajectories and patches may contain sensitive source and must stay restricted.

## Decision

Retain immutable raw execution and verifier records with hashes, initial/completion
manifests, native trajectory evidence, and declared artifacts. Normalized reports,
redacted exports, and regrades are new derived records with complete provenance.
Never overwrite original outcomes or pretend a regrade incurred another agent cost.

## Evidence

[Research](../research-snapshot.md) records Harbor output formats, ATIF conversion,
collection manifests, and separate single-step regrade requirements. Codex adapter
conversion may estimate API cost and merge stderr/stdout, so normalized data cannot
replace original evidence or claim unavailable fidelity.

## Alternatives

Keeping only a composite loses failure and facet evidence. Editing raw results to
fix a parser hides history. Keeping credentials in raw records for completeness is
forbidden; capture must exclude them before finalization.

## Consequences

Storage and access control are local operational responsibilities. Hash mismatches
block valid reuse. Sanitized publication requires separate scanning and provenance.
A discovered secret requires the incident procedure in [security](../security.md),
not a silent rewrite. Unsupported output revisions fail explicitly.

## Validation gate

Issue 2 proves retention coverage; issues 8 and 13 later implement normalization
and regrade over it. [Issue 3](../../.planning/issues/03-evidence-based-decisions.md)
accepts the decision only with concrete spike evidence and documented limitations.
