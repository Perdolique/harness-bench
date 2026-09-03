#!/usr/bin/env python3
"""Publish planning objects through gh; never run the benchmark or a provider."""

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CATALOG = ROOT / ".planning/backlog.json"
STATE = ROOT / ".planning/github-state.json"
MARKER = "<!-- agent-stack-benchmark:planning-issue:{:02} -->"
DEP_BLOCK = re.compile(
    r"<!-- dependencies:start -->\n.*?\n<!-- dependencies:end -->", re.DOTALL
)


def digest(body):
    return hashlib.sha256(body.encode()).hexdigest()


def gh(*args, payload=None):
    result = subprocess.run(
        ["gh", *args],
        input=json.dumps(payload) if payload is not None else None,
        text=True,
        capture_output=True,
        check=False,
        cwd=ROOT,
    )
    if result.returncode:
        # Never retry an uncertain mutation. A rerun discovers our issue markers.
        raise RuntimeError(result.stderr.strip() or "GitHub CLI command failed")
    return json.loads(result.stdout) if result.stdout.strip() else None


def pages(endpoint):
    return [entry for page in gh("api", endpoint, "--paginate", "--slurp") for entry in page]


def mutate(method, endpoint, payload):
    return gh("api", "--method", method, endpoint, "--input", "-", payload=payload)


def save_state(state):
    temporary = STATE.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(STATE)


def dependency_body(item, body, issue_map):
    match = DEP_BLOCK.search(body)
    if match is None:
        raise ValueError(f"Missing dependency block: {item['file']}")
    lines = ["<!-- dependencies:start -->"]
    if item["dependencies"]:
        for dependency in item["dependencies"]:
            remote = issue_map[dependency]
            lines.append(
                f"- Blocked by [planning issue {dependency} / GitHub #{remote['number']}]"
                f"({remote['html_url']})."
            )
    else:
        lines.append(
            "- No issue dependencies. This is the first implementation issue after planning is committed."
        )
    for line in match.group().splitlines():
        if line.startswith("- Required gate:") or line.startswith("- Outside the v1"):
            def link_gate(found):
                number = int(found[1])
                return f"[planning issue {number}]({issue_map[number]['html_url']})"
            lines.append(re.sub(r"(?<!planning )issue (\d+)", link_gate, line))
    lines.append("<!-- dependencies:end -->")
    return body[:match.start()] + "\n".join(lines) + body[match.end():]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true", help="Read-only remote verification")
    mode.add_argument("--apply", action="store_true", help="Create missing planning objects and resolve links")
    args = parser.parse_args()
    catalog = json.loads(CATALOG.read_text())
    repo = catalog["repository"]
    auth = subprocess.run(["gh", "auth", "status"], capture_output=True, text=True, check=False)
    if auth.returncode:
        raise RuntimeError("GitHub CLI authentication is unavailable; complete local drafts remain intact.")
    remote = subprocess.run(
        ["git", "remote", "get-url", "origin"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.strip()
    if remote not in (f"git@github.com:{repo}.git", f"https://github.com/{repo}.git", f"https://github.com/{repo}"):
        raise RuntimeError("Origin does not match the explicit planning repository; refusing publication.")
    endpoint = f"repos/{repo}"
    repo_info = gh("api", endpoint)
    if not repo_info["has_issues"]:
        raise RuntimeError("Repository issues are disabled; no repository settings were changed.")
    state = json.loads(STATE.read_text()) if STATE.exists() else {
        "repository": repo, "issues": {}, "milestones": {}, "labels": []
    }
    if state["repository"] != repo:
        raise RuntimeError("Publication state belongs to another repository.")
    labels = {x["name"]: x for x in pages(f"{endpoint}/labels?per_page=100")}
    milestone_list = pages(f"{endpoint}/milestones?state=all&per_page=100")
    milestones = {}
    for item in milestone_list:
        if item["title"] in milestones:
            raise RuntimeError(f"Ambiguous milestone title: {item['title']}")
        milestones[item["title"]] = item
    issues = [x for x in pages(f"{endpoint}/issues?state=all&per_page=100") if "pull_request" not in x]
    issue_map = {}
    problems = []
    for item in catalog["labels"]:
        existing = labels.get(item["name"])
        if existing and any(existing.get(key) != item[key] for key in ("color", "description")):
            problems.append(f"Existing label differs; preserve it: {item['name']}")
    for item in catalog["milestones"]:
        existing = milestones.get(item["title"])
        if existing and existing.get("description") != item["description"]:
            problems.append(f"Existing milestone differs; preserve it: {item['title']}")
    for item in catalog["issues"]:
        matches = [x for x in issues if MARKER.format(item["id"]) in (x.get("body") or "")]
        if len(matches) > 1:
            problems.append(f"Duplicate planning markers for item {item['id']}")
        elif matches:
            issue_map[item["id"]] = matches[0]
            saved = state["issues"].get(str(item["id"]))
            if saved and saved["number"] != matches[0]["number"]:
                problems.append(f"Issue mapping changed for item {item['id']}")
        elif any(x["title"] == item["title"] for x in issues):
            problems.append(f"Unrelated issue has the expected title: {item['title']}")
    # Refuse to overwrite manual edits before creating any new objects.
    for item in catalog["issues"]:
        existing = issue_map.get(item["id"])
        if not existing:
            continue
        local = (ROOT / item["file"]).read_text()
        saved = state["issues"].get(str(item["id"]), {})
        accepted = {digest(local), saved.get("body_sha256")}
        if len(issue_map) == len(catalog["issues"]):
            accepted.add(digest(dependency_body(item, local, issue_map)))
        if digest(existing.get("body") or "") not in accepted:
            problems.append(f"Remote body changed manually: planning item {item['id']}")
        if existing["title"] != item["title"]:
            problems.append(f"Remote title changed: planning item {item['id']}")
        if {x["name"] for x in existing["labels"]} != set(item["labels"]):
            problems.append(f"Remote labels changed: planning item {item['id']}")
        if not existing["milestone"] or existing["milestone"]["title"] != item["milestone"]:
            problems.append(f"Remote milestone changed: planning item {item['id']}")
    if problems:
        raise RuntimeError("\n".join(problems))
    missing = {
        "labels": [x["name"] for x in catalog["labels"] if x["name"] not in labels],
        "milestones": [x["title"] for x in catalog["milestones"] if x["title"] not in milestones],
        "issues": [x["id"] for x in catalog["issues"] if x["id"] not in issue_map],
    }
    if args.check and any(missing.values()):
        print(json.dumps({"unapplied": missing}, indent=2))
        return 1
    created = {"labels": 0, "milestones": 0, "issues": 0}
    updated = 0
    if args.apply:
        for item in catalog["labels"]:
            if item["name"] not in labels:
                labels[item["name"]] = mutate("POST", f"{endpoint}/labels", item)
                created["labels"] += 1
                print(f"Created label: {item['name']}", flush=True)
        state["labels"] = [x["name"] for x in catalog["labels"]]
        for item in catalog["milestones"]:
            if item["title"] not in milestones:
                milestones[item["title"]] = mutate("POST", f"{endpoint}/milestones", item)
                created["milestones"] += 1
                print(f"Created milestone: {item['title']}", flush=True)
            state["milestones"][item["title"]] = {
                "number": milestones[item["title"]]["number"],
                "url": milestones[item["title"]]["html_url"],
            }
        save_state(state)
        # Pass one: create all issues in dependency order using complete drafts.
        for item in catalog["issues"]:
            if item["id"] not in issue_map:
                payload = {
                    "title": item["title"],
                    "body": (ROOT / item["file"]).read_text(),
                    "labels": item["labels"],
                    "milestone": milestones[item["milestone"]]["number"],
                }
                issue_map[item["id"]] = mutate("POST", f"{endpoint}/issues", payload)
                created["issues"] += 1
                print(f"Created planning item {item['id']}: {issue_map[item['id']]['html_url']}", flush=True)
            existing = issue_map[item["id"]]
            state["issues"][str(item["id"])] = {
                "number": existing["number"], "url": existing["html_url"],
                "body_sha256": digest(existing.get("body") or ""),
            }
            save_state(state)
    # Pass two: actual GitHub links replace local dependency links in both copies.
    for item in catalog["issues"]:
        local_path = ROOT / item["file"]
        body = dependency_body(item, local_path.read_text(), issue_map)
        existing = issue_map[item["id"]]
        if args.check:
            if body != existing["body"] or body != local_path.read_text():
                problems.append(f"Body/link mismatch for planning item {item['id']}")
            saved = state["issues"].get(str(item["id"]), {})
            if saved.get("body_sha256") != digest(existing["body"]):
                problems.append(f"Saved body hash mismatch for planning item {item['id']}")
        else:
            if body != existing["body"]:
                mutate("PATCH", f"{endpoint}/issues/{existing['number']}", {"body": body})
                updated += 1
                print(f"Resolved dependencies: {existing['html_url']}", flush=True)
            if body != local_path.read_text():
                local_path.write_text(body)
            state["issues"][str(item["id"])] = {
                "number": existing["number"], "url": existing["html_url"],
                "body_sha256": digest(body),
            }
            save_state(state)
    if problems:
        raise RuntimeError("\n".join(problems))
    print(json.dumps({
        "mode": "apply" if args.apply else "check", "created": created,
        "updated_bodies": updated, "verified_issues": len(issue_map),
        "planning_labels": len(catalog["labels"]), "milestones": len(catalog["milestones"]),
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(str(error)) from error
