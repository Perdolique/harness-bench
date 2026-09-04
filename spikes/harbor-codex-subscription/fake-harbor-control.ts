import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { validateArtifactManifest } from "./artifact-manifest.ts";
import { PROTOCOL_REVISION, REPOSITORY_ROOT } from "./constants.ts";
import { finalizeRunRecord } from "./records.ts";
import { makeJobConfig, materializeTask } from "./run-inputs.ts";

// Oracle is a deterministic local script, not a provider or native Codex run.
export async function runHarborFakeControl(
  root: string,
): Promise<{ name: string; passed: boolean }> {
  const id = randomUUID();
  const runPath = join(root, `fake-harbor-${id}`);
  await mkdir(runPath, { mode: 0o700 });
  const datasetPath = await materializeTask(runPath);
  const taskPath = join(datasetPath, "normalize-room-label");
  const solutionPath = join(taskPath, "solution");
  await mkdir(solutionPath);
  const markers = [
    "auth-readable",
    "config-base-effort",
    "config-chatgpt-only",
    "config-empty-mcp",
    "config-file-store",
    "config-web-search-off",
    "docker-socket-absent",
    "host-home-absent",
    "sandbox-bypass",
    "skill-loaded",
  ];
  const fakeScript = [
    "import { writeFileSync, existsSync, mkdirSync } from 'node:fs';",
    "if (existsSync('/var/run/docker.sock') || existsSync('/app/.git') || existsSync('/tests/hidden.test.mjs')) throw new Error('Unexpected agent mount');",
    "const response = await fetch('https://example.com', { signal: AbortSignal.timeout(20000) });",
    "if (response.status !== 200) throw new Error('Public HTTPS control failed');",
    "console.log('PUBLIC_HTTPS_OK');",
    `writeFileSync('/app/src/normalize-room-label.mjs', ${JSON.stringify('export function normalizeRoomLabel(value) { return value.trim().toLowerCase().replace(/\\s+/gu, "-"); }\n')});`,
    "mkdirSync('/tmp/harness-canary', { recursive: true });",
    `for (const marker of ${JSON.stringify(markers)}) writeFileSync('/tmp/harness-canary/' + marker, 'ok\\n');`,
    "console.log('SYNTHETIC_CANARY_NOT_NATIVE_EVIDENCE');",
    "await new Promise(resolve => setTimeout(resolve, 3000));",
  ].join("\n");
  await writeFile(join(solutionPath, "fake.mjs"), fakeScript);
  await writeFile(
    join(solutionPath, "solve.sh"),
    "#!/bin/sh\nset -eu\nnode /solution/fake.mjs\nnpm test\n",
    { mode: 0o700 },
  );
  const composePath = join(taskPath, "environment", "docker-compose.yaml");
  const compose = await readFile(composePath, "utf8");
  await writeFile(
    composePath,
    compose.replace(
      "  main:\n",
      `  main:\n    labels:\n      harness-bench.control-id: ${id}\n`,
    ),
  );
  const job = makeJobConfig(
    runPath,
    datasetPath,
    "/unused-provider-free-auth",
    `fake-${id}`,
  ) as Record<string, unknown>;
  job.agents = [{ name: "oracle", n_concurrent: 1 }];
  const jobPath = join(runPath, "job.json");
  await writeFile(jobPath, JSON.stringify(job, null, 2));
  const environment = { ...process.env, HARBOR_TELEMETRY: "off" };
  for (const key of [
    "CODEX_HOME",
    "CODEX_AUTH_JSON_PATH",
    "CODEX_ACCESS_TOKEN",
    "CODEX_FORCE_AUTH_JSON",
    "OPENAI_API_KEY",
  ])
    delete (environment as NodeJS.ProcessEnv)[key];
  const child = spawn(
    join(REPOSITORY_ROOT, ".venv/bin/harbor"),
    ["run", "--config", jobPath, "--yes"],
    {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  const observed: { mainNetworkMode: string | null } = {
    mainNetworkMode: null,
  };
  const inspectMain = setInterval(() => {
    try {
      const ids = execFileSync(
        "docker",
        ["ps", "--quiet", "--filter", `label=harness-bench.control-id=${id}`],
        { encoding: "utf8" },
      )
        .trim()
        .split("\n")
        .filter(Boolean);
      if (ids.length === 1)
        observed.mainNetworkMode = execFileSync(
          "docker",
          ["inspect", "--format", "{{.HostConfig.NetworkMode}}", ids[0]!],
          { encoding: "utf8" },
        ).trim();
    } catch {
      /* A container may stop between the two read-only probes. */
    }
  }, 500);
  let exitCode: number | null;
  try {
    exitCode = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearInterval(inspectMain);
  }
  await writeFile(join(runPath, "harbor.log"), output, { mode: 0o600 });
  const jobResultPath = join(runPath, "harbor", `issue-2-fake-${id}`);
  const trials = (await readdir(jobResultPath)).filter((name) =>
    name.startsWith("normalize-room-label__"),
  );
  if (exitCode !== 0 || trials.length !== 1)
    throw new Error(
      `Fake Harbor lifecycle failed; restricted diagnostics: ${runPath}`,
    );
  const trialPath = join(jobResultPath, trials[0]!);
  validateArtifactManifest(
    JSON.parse(
      await readFile(join(trialPath, "artifacts/manifest.json"), "utf8"),
    ),
  );
  const trialLog = await readFile(join(trialPath, "trial.log"), "utf8");
  const oracleLog = await readFile(join(trialPath, "agent/oracle.txt"), "utf8");
  const reward = JSON.parse(
    await readFile(join(trialPath, "verifier/reward.json"), "utf8"),
  ) as Record<string, number>;
  const verification = JSON.parse(
    await readFile(join(trialPath, "verifier/verification.json"), "utf8"),
  ) as { checks: { network: { passed: boolean } }; validGrade: boolean };
  const stopIndex = trialLog.indexOf("Main service stopped");
  const collectIndex = trialLog.indexOf(
    "Collect hook in service 'collector' completed",
  );
  const { mainNetworkMode } = observed;
  const publicMain =
    mainNetworkMode !== null &&
    mainNetworkMode !== "none" &&
    mainNetworkMode !== "host" &&
    !mainNetworkMode.startsWith("container:");
  const passed =
    publicMain &&
    oracleLog.includes("PUBLIC_HTTPS_OK") &&
    stopIndex >= 0 &&
    collectIndex > stopIndex &&
    verification.checks.network.passed &&
    verification.validGrade &&
    ["integrity", "regressions", "scope", "task_contract"].every(
      (key) => reward[key] === 1,
    );
  await writeFile(
    join(runPath, "control-result.json"),
    JSON.stringify(
      {
        passed,
        mainNetworkMode,
        protocolRevision: PROTOCOL_REVISION,
        providerCalls: 0,
        syntheticCanary: true,
        nativeEvidence: false,
      },
      null,
      2,
    ),
  );
  const finalization = await finalizeRunRecord(runPath);
  if (!passed || !finalization.finalized)
    throw new Error(
      `Fake Harbor lifecycle did not establish the public/offline boundary; restricted diagnostics: ${runPath}`,
    );
  return {
    name: "harbor-public-agent-offline-verifier-lifecycle",
    passed: true,
  };
}
