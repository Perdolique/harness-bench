# Planning maintenance

This directory contains planning metadata, complete issue bodies and publication evidence. Its Python scripts use the standard library and GitHub CLI only. They are documentation/backlog tooling, not the benchmark CLI, runtime schemas, fixtures, Harbor integration, or issue 1's development skeleton.

- `backlog.json` defines 27 dependency-ordered planning items, five milestones, 20 labels, and the direct dependency graph. Purple denotes work type, blue area, red critical priority, orange owner decisions, and green provider-free CI policy. GitHub's native issue dependencies enforce the published graph; `decision-required` remains separate because closing a prerequisite cannot approve an owner gate.
- `issues/*.md` is the complete local copy of every issue body, including acceptance criteria and owner-gate links. Dependency edges are not duplicated in issue prose.
- `github-state.json`, when present, records real numbers/URLs and last-published body hashes. Planning IDs are stable and never assumed to equal GitHub numbers.
- [Roadmap](../docs/roadmap.md) explains dependencies, gates, and the item 18 split.

## Validate without GitHub or provider access

```sh
python3 .planning/validate.py
python3 .planning/test_sync_github.py
```

Checks include local links/anchors, Markdown structure, required deliverables, complete issue acceptance criteria, milestone placement, acyclic dependency order, label references and recorded publication hashes. Remote checking also verifies the exact native dependency set for every issue. It never runs Harbor, Codex inference, package installation, or benchmark tests.

The publication regression checks simulate renamed or missing saved issues and an unchanged repeat publication. GitHub requests and local writes are mocked.

## Publish or recover an interrupted bootstrap

From this checkout with `gh` authenticated to `Perdolique/harness-bench`:

```sh
python3 .planning/sync-github.py --check
python3 .planning/sync-github.py --apply
python3 .planning/sync-github.py --check
python3 .planning/validate.py
```

`--check` is read-only and exits nonzero for missing or divergent objects. `--apply` first inspects origin and all remote pages, creates missing labels and milestones, creates issues in dependency order, then creates missing native issue dependencies and resolves owner-gate links in a second pass. It retains local drafts and records each issue immediately so interruptions can be resumed. A second unchanged apply creates nothing and rewrites no issue bodies.

Native dependency relationships remain attached after a prerequisite closes, so no label or resolved-dependency bookkeeping is needed. Unexpected native dependencies or remote label differences stop publication before mutation.

Issues are identified by an exact hidden planning marker, including closed issues; saved issue numbers must still match that marker. A missing saved issue or removed marker stops publication before any writes instead of creating a replacement. Milestones are identified by exact title and labels by exact name. Existing unrelated objects are never deleted or modified. Conflicting names, duplicate markers, manual body changes, changed labels/titles/milestones, or a different origin stop publication for reconciliation. The script never reopens closed issues, resets labels, assigns people, comments, enables workflows, purchases credits, or pushes Git commits.

After uncertain GitHub mutation errors, do not blindly retry the POST. Run the script again so it reads the remote markers before creating anything. Run one publisher at a time; no distributed creation lock is claimed. Preserve manual issue edits and update the local planning copy deliberately before any later sync.

If GitHub CLI/access is unavailable, all drafts and definitions remain usable. Nothing about that state is a benchmark failure. Publish later with the same commands and then commit the resulting issue links/publication state separately.

## Publication scope

The bootstrap authorizes GitHub labels, milestones and issue publication plus a local planning commit. Implementation starts in a fresh session with planning issue 1. The bootstrap does not push the planning branch, close issue 1, enable CI/schedules, or run a provider-backed benchmark.

## Published bootstrap snapshot

On 2026-09-03, publication created five milestones, 21 planning labels, and 27 issues numbered 1–27. The 2026-09-05 migration removed the redundant `blocked` label and represented all 49 direct edges with [GitHub's native issue dependencies](https://github.com/Perdolique/harness-bench/issues). The remaining 20 planning labels, local bodies, recorded hashes, and owner-gate links match GitHub. An unchanged apply creates zero objects, edges, or body updates.

The migration validation covers 47 Markdown files, 27 complete issue bodies, 210 acceptance criteria, 20 labels, exact native dependencies, and the acyclic dependency order. The historical official-source permalink checks remain recorded in repository history. No benchmark functionality is added by planning maintenance.
