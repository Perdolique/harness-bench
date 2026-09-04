#!/usr/bin/env python3
"""Regression checks for planning publication; all external writes are mocked."""

import contextlib
import copy
import io
import json
import re
import subprocess
import types
import unittest
from pathlib import Path
from unittest.mock import patch


class PublicationIdentityTests(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).with_name("sync-github.py")
        self.sync = types.ModuleType("planning_sync")
        self.sync.__file__ = str(script)
        exec(compile(script.read_text(), str(script), "exec"), self.sync.__dict__)
        self.catalog = json.loads(self.sync.CATALOG.read_text())
        self.state = json.loads(self.sync.STATE.read_text())
        self.repo = self.catalog["repository"]
        self.issues = []
        for item in self.catalog["issues"]:
            saved = self.state["issues"][str(item["id"])]
            self.issues.append(
                {
                    "number": saved["number"],
                    "html_url": saved["url"],
                    "title": item["title"],
                    "body": (self.sync.ROOT / item["file"]).read_text(),
                    "labels": [{"name": name} for name in item["labels"]],
                    "milestone": {"title": item["milestone"]},
                }
            )
        milestones = []
        for item in self.catalog["milestones"]:
            saved = self.state["milestones"][item["title"]]
            milestones.append(
                {**item, "number": saved["number"], "html_url": saved["url"]}
            )
        self.responses = {
            f"repos/{self.repo}/labels?per_page=100": copy.deepcopy(
                self.catalog["labels"]
            ),
            f"repos/{self.repo}/milestones?state=all&per_page=100": milestones,
            f"repos/{self.repo}/issues?state=all&per_page=100": self.issues,
        }

    def apply(self, expected_error=None, expected_mutation=None):
        success = subprocess.CompletedProcess(
            [], 0, stdout=f"git@github.com:{self.repo}.git\n", stderr=""
        )
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch("sys.argv", ["sync-github.py", "--apply"]))
            stack.enter_context(
                patch.object(self.sync.subprocess, "run", return_value=success)
            )
            stack.enter_context(
                patch.object(self.sync, "gh", return_value={"has_issues": True})
            )
            stack.enter_context(
                patch.object(self.sync, "pages", side_effect=self.responses.__getitem__)
            )
            mutation = stack.enter_context(
                patch.object(
                    self.sync,
                    "mutate",
                    side_effect=(
                        None
                        if expected_mutation
                        else AssertionError("Unexpected GitHub mutation")
                    ),
                )
            )
            save = stack.enter_context(patch.object(self.sync, "save_state"))
            stack.enter_context(
                patch.object(
                    Path,
                    "write_text",
                    side_effect=AssertionError("Unexpected local file mutation"),
                )
            )
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            if expected_error:
                with self.assertRaisesRegex(RuntimeError, re.escape(expected_error)):
                    self.sync.main()
                save.assert_not_called()
            else:
                self.assertEqual(self.sync.main(), 0)
            if expected_mutation:
                mutation.assert_called_once_with(*expected_mutation)
            else:
                mutation.assert_not_called()

    def test_renamed_saved_issue_without_marker_blocks_publication(self):
        self.issues[0]["title"] = "Renamed by the owner"
        self.issues[0]["body"] = "The owner replaced the description."
        self.apply(f"Saved issue #{self.issues[0]['number']}")

    def test_missing_saved_issue_blocks_publication(self):
        removed = self.issues.pop(0)
        self.apply(f"Saved issue #{removed['number']}")

    def test_unchanged_publication_does_not_mutate_github(self):
        self.apply()

    def test_resolved_dependency_can_remove_only_stale_blocked_label(self):
        issue = self.issues[1]
        issue["labels"].append({"name": "blocked"})
        desired = self.catalog["issues"][1]["labels"]

        self.apply(
            expected_mutation=(
                "PATCH",
                f"repos/{self.repo}/issues/{issue['number']}",
                {"labels": desired},
            )
        )


if __name__ == "__main__":
    unittest.main()
