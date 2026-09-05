#!/usr/bin/env python3
"""Validate planning Markdown, local links and backlog integrity without network."""

import hashlib
import json
import re
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = [
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "docs/product-spec.md",
    "docs/architecture.md",
    "docs/methodology.md",
    "docs/security.md",
    "docs/task-authoring.md",
    "docs/operations.md",
    "docs/roadmap.md",
    "docs/research-snapshot.md",
    "docs/adr/README.md",
    "docs/adr/0001-harbor-execution-kernel.md",
    "docs/adr/0002-typescript-control-plane.md",
    "docs/adr/0003-separate-verifier-boundary.md",
    "docs/adr/0004-subscription-authentication.md",
    "docs/adr/0005-immutable-raw-artifacts.md",
    ".github/ISSUE_TEMPLATE/implementation.md",
    ".github/pull_request_template.md",
    ".planning/README.md",
    ".planning/backlog.json",
    ".planning/sync-github.py",
    ".planning/validate.py",
]
SECTIONS = [
    "Context",
    "Goal",
    "In scope",
    "Out of scope",
    "Technical constraints",
    "Acceptance criteria",
    "Test/evidence plan",
    "Documentation changes",
    "Dependencies and owner gates",
    "Risks/open questions",
    "Definition of Done",
]


def prose(text, name, errors):
    fence = None
    output = []
    for number, line in enumerate(text.splitlines(), 1):
        match = re.match(r"^\s*(`{3,}|~{3,})", line)
        if match:
            delimiter = match[1]
            if fence is None:
                fence = delimiter
            elif delimiter[0] == fence[0] and len(delimiter) >= len(fence):
                fence = None
            output.append("")
        else:
            output.append("" if fence else line)
        if line.rstrip() != line:
            errors.append(f"{name}:{number}: trailing whitespace")
    if fence:
        errors.append(f"{name}: unclosed Markdown fence")
    return "\n".join(output)


def anchors(text):
    result = set()
    occurrences = {}
    for title in re.findall(r"^#{1,6} (.+)$", text, re.M):
        slug = re.sub(r"[^\w\- ]", "", title.lower()).replace(" ", "-")
        count = occurrences.get(slug, 0)
        occurrences[slug] = count + 1
        result.add(f"{slug}-{count}" if count else slug)
    return result


def main():
    errors = []
    for filename in REQUIRED:
        if not (ROOT / filename).is_file():
            errors.append(f"Missing required artifact: {filename}")
    catalog = json.loads((ROOT / ".planning/backlog.json").read_text())
    issues = catalog["issues"]
    ids = [item["id"] for item in issues]
    if ids != list(range(1, 28)):
        errors.append("Expected ordered planning items 1–27")
    labels = {label["name"] for label in catalog["labels"]}
    if len(labels) != len(catalog["labels"]):
        errors.append("Duplicate label names")
    if "blocked" in labels:
        errors.append("The blocked label is superseded by native issue dependencies")
    for label in catalog["labels"]:
        if not re.fullmatch(r"[0-9a-f]{6}", label["color"]) or not label["description"]:
            errors.append(f"Invalid label definition: {label['name']}")
    milestones = [m["title"] for m in catalog["milestones"]]
    if milestones != [
        "M0 Feasibility",
        "M1 Vertical-slice MVP",
        "M2 Controlled experiments",
        "M3 Pilot benchmark",
        "M4 Hardening and expansion",
    ]:
        errors.append("Milestone definitions drifted")
    seen = set()
    files = REQUIRED + [i["file"] for i in issues]
    actual_drafts = {
        str(p.relative_to(ROOT)) for p in (ROOT / ".planning/issues").glob("*.md")
    }
    if actual_drafts != {i["file"] for i in issues}:
        errors.append("Draft files do not exactly match backlog metadata")
    criteria_count = 0
    for item in issues:
        number = item["id"]
        body = (ROOT / item["file"]).read_text()
        if any(dep not in seen for dep in item["dependencies"]):
            errors.append(f"Item {number}: dependency order is not acyclic/topological")
        seen.add(number)
        if len(item["dependencies"]) != len(set(item["dependencies"])):
            errors.append(f"Item {number}: duplicate dependency")
        if (
            not set(item["labels"]) <= labels
            or "no-provider-call-in-ci" not in item["labels"]
        ):
            errors.append(f"Item {number}: invalid/missing labels")
        if "blocked" in item["labels"]:
            errors.append(
                f"Item {number}: use native issue dependencies instead of blocked label"
            )
        if "resolved_dependencies" in item:
            errors.append(
                f"Item {number}: native dependencies do not need resolved bookkeeping"
            )
        if number <= 3:
            expected_milestone = 0
        elif number <= 9:
            expected_milestone = 1
        elif number <= 13:
            expected_milestone = 2
        elif number <= 17:
            expected_milestone = 3
        else:
            expected_milestone = 4
        if item["milestone"] != milestones[expected_milestone]:
            errors.append(f"Item {number}: wrong milestone")
        if not body.startswith(f"# {item['title']}\n"):
            errors.append(f"Item {number}: title mismatch")
        if (
            body.count(f"<!-- agent-stack-benchmark:planning-issue:{number:02} -->")
            != 1
        ):
            errors.append(f"Item {number}: missing/duplicate ownership marker")
        if re.findall(r"^## (.+)$", body, re.M) != SECTIONS:
            errors.append(
                f"Item {number}: missing, reordered or duplicate required sections"
            )
        for section in SECTIONS:
            content = re.search(
                rf"^## {re.escape(section)}\n\n(.+?)(?=\n## |\Z)", body, re.M | re.S
            )
            if not content or not content[1].strip():
                errors.append(f"Item {number}: empty {section}")
        ac = body.split("## Acceptance criteria\n", 1)[1].split("\n## ", 1)[0]
        criteria = re.findall(r"^- \[ \] (.+)$", ac, re.M)
        criteria_count += len(criteria)
        if not criteria:
            errors.append(f"Item {number}: acceptance criteria are not checkboxes")
        if number >= 18 and "Outside the v1 critical path" not in body:
            errors.append(f"Item {number}: missing expansion boundary")
    state_path = ROOT / ".planning/github-state.json"
    if state_path.exists():
        state = json.loads(state_path.read_text())
        if state["repository"] != catalog["repository"] or set(state["issues"]) != {
            str(i) for i in ids
        }:
            errors.append("Incomplete or mismatched GitHub publication state")
        for item in issues:
            body = (ROOT / item["file"]).read_text()
            saved = state["issues"].get(str(item["id"]), {})
            if saved.get("body_sha256") != hashlib.sha256(body.encode()).hexdigest():
                errors.append(
                    f"Item {item['id']}: local body differs from publication hash"
                )
        if state.get("labels") != [label["name"] for label in catalog["labels"]]:
            errors.append(
                "GitHub publication label state differs from backlog metadata"
            )
    link_count = 0
    markdown_files = [ROOT / f for f in files if f.endswith(".md")]
    for path in markdown_files:
        text = path.read_text()
        name = str(path.relative_to(ROOT))
        if not text.endswith("\n"):
            errors.append(f"{name}: missing final newline")
        content = prose(text, name, errors)
        if (
            not name.startswith(".github/")
            and len(re.findall(r"^# ", content, re.M)) != 1
        ):
            errors.append(f"{name}: expected exactly one top-level heading")
        for target in re.findall(r"\[[^\]\n]+\]\(([^)]+)\)", content):
            url = urlsplit(target.strip("<>"))
            if url.scheme:
                continue
            local = (path.parent / unquote(url.path)).resolve() if url.path else path
            link_count += 1
            if not local.exists():
                errors.append(f"{name}: broken local link {target}")
            elif url.fragment and local.suffix == ".md":
                if unquote(url.fragment) not in anchors(
                    prose(local.read_text(), str(local), [])
                ):
                    errors.append(f"{name}: missing anchor {target}")
    for filename in (".planning/sync-github.py", ".planning/validate.py"):
        compile((ROOT / filename).read_text(), filename, "exec")
    if errors:
        print("\n".join(errors))
        return 1
    print(
        f"PASS: {len(markdown_files)} Markdown files; {link_count} local links; "
        f"27 complete issues; {criteria_count} acceptance checkboxes; "
        f"5 milestones; {len(labels)} labels; native dependency declarations; "
        "acyclic order; Python syntax; publication hashes when present."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
