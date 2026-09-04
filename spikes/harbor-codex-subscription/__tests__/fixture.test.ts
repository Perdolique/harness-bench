import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SPIKE_ROOT } from "../constants.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

function runTest(workspace: string, testPath: string) {
  return spawnSync(process.execPath, ["--test", testPath], {
    cwd: workspace,
    encoding: "utf8",
    env: { ...process.env, SPIKE_WORKSPACE: workspace },
  });
}

describe("normalizeRoomLabel fixture controls", () => {
  it("keeps regressions green while base fails and known-good passes the task", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-2-fixture-test-"));
    temporaryPaths.push(root);
    const workspace = join(root, "workspace");
    await cp(join(SPIKE_ROOT, "fixture", "base"), workspace, {
      recursive: true,
    });
    const regression = join(workspace, "test", "regression.test.mjs");
    const hidden = join(SPIKE_ROOT, "fixture", "hidden.test.mjs");

    expect(runTest(workspace, regression).status).toBe(0);
    expect(runTest(workspace, hidden).status).not.toBe(0);
    const apply = spawnSync(
      "git",
      ["apply", join(SPIKE_ROOT, "fixture", "known-good.patch")],
      { cwd: workspace, encoding: "utf8" },
    );
    expect(apply.status, apply.stderr).toBe(0);
    expect(runTest(workspace, regression).status).toBe(0);
    expect(runTest(workspace, hidden).status).toBe(0);
  });
});
