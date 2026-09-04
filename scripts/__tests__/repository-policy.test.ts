import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EXPECTED_TOOLCHAIN } from "../toolchain.ts";

const root = resolve(import.meta.dirname, "../..");

const workspaceManifests = [
  ["apps/benchctl/package.json", "@harness-bench/benchctl"],
  ["packages/schemas/package.json", "@harness-bench/schemas"],
  ["packages/core/package.json", "@harness-bench/core"],
  ["packages/results/package.json", "@harness-bench/results"],
  ["packages/statistics/package.json", "@harness-bench/statistics"],
  ["packages/reporting/package.json", "@harness-bench/reporting"],
] as const;

const expectedActions = [
  "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
  "astral-sh/setup-uv@20cfd1bf945f4377ade1205e4dbc17946fc9a30d",
] as const;

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(resolve(root, path), "utf8")) as Record<
    string,
    unknown
  >;
}

function providerPolicyViolations(workflow: string): string[] {
  const checks = [
    ["GitHub secret reference", /\bsecrets\./i],
    [
      "provider credential reference",
      /\b(?:OPENAI|ANTHROPIC|GEMINI|CODEX)_(?:API_KEY|ACCESS_TOKEN|AUTH_JSON_PATH)\b/i,
    ],
    ["Codex provider command", /\bcodex\s+exec\b/i],
    ["Harbor execution command", /\bharbor\s+(?:run|job|jobs)\b/i],
  ] as const;

  return checks
    .filter(([, pattern]) => pattern.test(workflow))
    .map(([message]) => message);
}

describe("repository skeleton", () => {
  it("pins every runtime and direct tool dependency exactly", () => {
    const manifest = readJson("package.json");
    const pyproject = readFileSync(resolve(root, "pyproject.toml"), "utf8");

    expect(readFileSync(resolve(root, ".node-version"), "utf8").trim()).toBe(
      EXPECTED_TOOLCHAIN.node,
    );
    expect(readFileSync(resolve(root, ".python-version"), "utf8").trim()).toBe(
      EXPECTED_TOOLCHAIN.python,
    );
    expect(manifest.packageManager).toBe(`pnpm@${EXPECTED_TOOLCHAIN.pnpm}`);
    expect(manifest.engines).toEqual({
      node: EXPECTED_TOOLCHAIN.node,
      pnpm: EXPECTED_TOOLCHAIN.pnpm,
    });
    expect(manifest.devDependencies).toEqual({
      "@openai/codex": EXPECTED_TOOLCHAIN.codex,
      "@types/node": "26.4.1",
      oxlint: "1.81.0",
      prettier: "3.9.6",
      typescript: "7.0.2",
      vitest: "5.0.0",
    });
    expect(pyproject).toContain(
      `requires-python = "==${EXPECTED_TOOLCHAIN.python}"`,
    );
    expect(pyproject).toContain(
      `dependencies = ["harbor==${EXPECTED_TOOLCHAIN.harbor}"]`,
    );
    expect(pyproject).toContain('dev = ["ruff==0.16.6"]');
    expect(pyproject).toContain(
      `required-version = "==${EXPECTED_TOOLCHAIN.uv}"`,
    );
  });

  it("keeps every workspace manifest-only", () => {
    for (const [path, name] of workspaceManifests) {
      const manifest = readJson(path);
      expect(manifest).toEqual({
        name,
        version: "0.0.0",
        private: true,
        type: "module",
      });
      expect(manifest).not.toHaveProperty("bin");
      expect(manifest).not.toHaveProperty("exports");
      expect(manifest).not.toHaveProperty("dependencies");
      expect(readdirSync(resolve(root, dirname(path)))).toEqual([
        "package.json",
      ]);
    }
  });

  it("ignores run state, generated environments, build output, and coverage", () => {
    const paths = [
      ".agent-stack-bench/runs/example/result.json",
      ".agent-stack-bench/generated/example.json",
      ".agent-stack-bench/environments/example/config.json",
      "packages/core/dist/index.js",
      "coverage/index.html",
      ".env.production",
    ];

    for (const path of paths) {
      expect(
        execFileSync("git", ["check-ignore", "-q", path], { cwd: root }),
      ).toEqual(Buffer.alloc(0));
    }

    expect(() =>
      execFileSync("git", ["check-ignore", "-q", ".env.example"], {
        cwd: root,
      }),
    ).toThrow();
  });
});

describe("provider-free CI policy", () => {
  const workflow = readFileSync(
    resolve(root, ".github/workflows/check.yml"),
    "utf8",
  );

  it("uses read-only permissions and pinned actions without persistent credentials", () => {
    expect(workflow).toMatch(/permissions:\n  contents: read/);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("HARBOR_TELEMETRY: off");

    const actionReferences = [...workflow.matchAll(/^\s*- uses: (\S+)/gm)].map(
      (match) => match[1],
    );
    expect(actionReferences).toEqual(expectedActions);
    for (const reference of actionReferences) {
      expect(reference).toMatch(/@[0-9a-f]{40}$/);
    }
  });

  it("runs only locked installation and the aggregate check", () => {
    const commands = [...workflow.matchAll(/^\s+run: (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(commands).toEqual([
      "pnpm install --frozen-lockfile",
      "uv sync --locked",
      "pnpm check",
    ]);
  });

  it("disables caches and uploads no artifacts", () => {
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow).toContain("enable-cache: false");
    expect(workflow).toContain("cache: false");
    expect(workflow).not.toMatch(/actions\/cache|upload-artifact/i);
  });

  it("contains no provider access or credentials", () => {
    expect(providerPolicyViolations(workflow)).toEqual([]);
  });

  it.each([
    ["Codex execution", "run: codex exec --json task"],
    ["Harbor run", "run: harbor run benchmark/task"],
    ["Harbor job", "run: harbor jobs start benchmark/task"],
    ["credential", "env:\n  CODEX_AUTH_JSON_PATH: /credentials/auth.json"],
    ["secret", "env:\n  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}"],
  ])("rejects a %s fixture", (_name, fixture) => {
    expect(providerPolicyViolations(fixture)).not.toEqual([]);
  });
});
