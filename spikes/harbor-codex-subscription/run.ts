import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { finished } from "node:stream/promises";

import {
  CODEX_VERSION,
  PROTOCOL_REVISION,
  HARBOR_VERSION,
  LIMITS,
  MODEL,
  REASONING_EFFORT,
  REPOSITORY_ROOT,
  type SpikePhase,
} from "./constants.ts";
import {
  validateArtifactManifest,
  type ArtifactManifestEntry,
} from "./artifact-manifest.ts";
import {
  assertExternalRunRoot,
  assertNoAmbientProviderCredentials,
  collectHostIdentity,
  inspectAuthFile,
  type AuthMetadata,
} from "./host.ts";
import { verifyImageLock } from "./images.ts";
import { finalizeRunRecord } from "./records.ts";
import { makeJobConfig, materializeTask } from "./run-inputs.ts";

interface Arguments {
  readonly reasoningEffort: "low" | "medium";
  readonly phase: SpikePhase;
  readonly runId: string;
}

export interface ExistingIntent {
  readonly protocolRevision: string;
  readonly invocation: number;
  readonly phase: SpikePhase;
  readonly runId: string;
}

export interface HarborExecution {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface RewardRecord {
  readonly integrity: number;
  readonly regressions: number;
  readonly scope: number;
  readonly task_contract: number;
}

export interface EvidenceStatus {
  readonly artifactManifest: readonly ArtifactManifestEntry[];
  readonly artifactManifestError: string | null;
  readonly artifactManifestValid: boolean;
  readonly atifPresent: boolean;
  readonly cliInvocationObserved: boolean;
  readonly collectorCompleted: boolean;
  readonly effectiveConfigObserved: boolean;
  readonly mainStopped: boolean;
  readonly mergedOutputPresent: boolean;
  readonly nativeSessionPresent: boolean;
  readonly reward: RewardRecord | null;
  readonly rewardFacetsValid: boolean;
  readonly trialPath: string | null;
  readonly upstreamExceptionMessage: string | null;
  readonly upstreamExceptionType: string | null;
  readonly verificationPresent: boolean;
}

export type TerminalClass =
  | "agent-failure"
  | "cancellation"
  | "completed"
  | "infrastructure-failure"
  | "integrity-failure"
  | "provider-failure"
  | "task-failure"
  | "verifier-failure"
  | "runner-failure";

const allowedTerminalKeys = [
  "integrity",
  "regressions",
  "scope",
  "task_contract",
] as const;

export function parseArguments(argv: readonly string[]): Arguments {
  let reasoningEffort: "low" | "medium" = REASONING_EFFORT;
  let phase: SpikePhase | undefined;
  let runId: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--" && index === 0) {
      continue;
    } else if (value === "--phase") {
      const candidate = argv[index + 1];
      if (candidate === "public") {
        phase = candidate;
      } else {
        throw new Error("--phase must be public");
      }
      index += 1;
    } else if (value === "--effort") {
      const candidate = argv[index + 1];
      if (candidate !== "low" && candidate !== "medium") {
        throw new Error("--effort must be low or medium");
      }
      reasoningEffort = candidate;
      index += 1;
    } else if (value === "--run-id") {
      runId = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${String(value)}`);
    }
  }
  if (!phase || !runId) {
    throw new Error("Usage: --phase public --run-id <id>");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(runId)) {
    throw new Error("--run-id must be a lowercase filesystem-safe identifier");
  }
  return { phase, runId, reasoningEffort };
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function findFiles(
  root: string,
  predicate: (path: string) => boolean,
): Promise<string[]> {
  const results: string[] = [];
  if (!(await pathExists(root))) {
    return results;
  }
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && predicate(path)) {
        results.push(path);
      }
    }
  };
  await visit(root);
  return results.sort();
}

async function loadExistingIntents(
  runsPath: string,
): Promise<ExistingIntent[]> {
  if (!(await pathExists(runsPath))) {
    return [];
  }
  const entries = await readdir(runsPath, { withFileTypes: true });
  const intents: ExistingIntent[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const intentPath = join(runsPath, entry.name, "run-intent.json");
    if (await pathExists(intentPath)) {
      intents.push(await readJson<ExistingIntent>(intentPath));
    }
  }
  intents.sort((left, right) => left.invocation - right.invocation);
  return intents;
}

export function assertInvocationSequence(
  phase: SpikePhase,
  existing: readonly ExistingIntent[],
): number {
  if (existing.length >= 2) {
    throw new Error("The two-invocation public-network budget is exhausted");
  }
  if (
    phase !== "public" ||
    existing.some(
      (intent, index) =>
        intent.invocation !== index + 1 ||
        intent.phase !== "public" ||
        intent.protocolRevision !== PROTOCOL_REVISION,
    )
  ) {
    throw new Error(
      "Existing run intents do not match the fixed public-network protocol",
    );
  }
  return existing.length + 1;
}

async function writeImmutableJson(
  path: string,
  value: unknown,
): Promise<string> {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(path, source, { encoding: "utf8", flag: "wx", mode: 0o400 });
  return sha256(source);
}

function cleanHarborEnvironment(authPath: string): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of [
    "CODEX_ACCESS_TOKEN",
    "CODEX_FORCE_AUTH_JSON",
    "CODEX_HOME",
    "OPENAI_API_KEY",
  ]) {
    delete environment[name];
  }
  environment.CODEX_AUTH_JSON_PATH = authPath;
  environment.HARBOR_TELEMETRY = "off";
  return environment;
}

async function runHarbor(
  runPath: string,
  jobConfigPath: string,
  authPath: string,
): Promise<HarborExecution> {
  const stdoutPath = join(runPath, "harbor-stdout.log");
  const stderrPath = join(runPath, "harbor-stderr.log");
  const stdout = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const child = spawn(
    join(REPOSITORY_ROOT, ".venv", "bin", "harbor"),
    ["run", "--config", jobConfigPath, "--yes"],
    {
      cwd: REPOSITORY_ROOT,
      env: cleanHarborEnvironment(authPath),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  try {
    return await new Promise<HarborExecution>((resolveExecution, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) =>
        resolveExecution({ exitCode, signal }),
      );
    });
  } finally {
    stdout.end();
    stderr.end();
    await Promise.all([finished(stdout), finished(stderr)]);
  }
}

function parseReward(value: unknown): RewardRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
      [...allowedTerminalKeys].sort().join(",") ||
    allowedTerminalKeys.some(
      (key) =>
        typeof record[key] !== "number" ||
        !Number.isFinite(record[key]) ||
        Number(record[key]) < 0 ||
        Number(record[key]) > 1,
    )
  ) {
    return null;
  }
  return record as unknown as RewardRecord;
}

async function inspectEvidence(
  runPath: string,
  reasoningEffort: "low" | "medium",
): Promise<EvidenceStatus> {
  const manifests = await findFiles(
    join(runPath, "harbor"),
    (path) =>
      basename(path) === "manifest.json" &&
      basename(dirname(path)) === "artifacts",
  );
  let artifactManifest: ArtifactManifestEntry[] = [];
  let artifactManifestError: string | null = null;
  if (manifests.length !== 1) {
    artifactManifestError = `Expected one artifact manifest, found ${manifests.length}`;
  } else {
    try {
      artifactManifest = validateArtifactManifest(
        await readJson<unknown>(manifests[0]!),
      );
    } catch (error) {
      artifactManifestError = errorMessage(error);
    }
  }

  const trialPath = manifests[0] ? dirname(dirname(manifests[0])) : null;
  const trialLogPath = trialPath ? join(trialPath, "trial.log") : null;
  const trialLog =
    trialLogPath && (await pathExists(trialLogPath))
      ? await readFile(trialLogPath, "utf8")
      : "";
  const configPath = trialPath ? join(trialPath, "config.json") : null;
  const config =
    configPath && (await pathExists(configPath))
      ? await readJson<Record<string, unknown>>(configPath)
      : null;
  const serializedConfig = JSON.stringify(config);
  const resultPath = trialPath ? join(trialPath, "result.json") : null;
  const result =
    resultPath && (await pathExists(resultPath))
      ? await readJson<{
          exception_info?: {
            exception_message?: string;
            exception_type?: string;
          } | null;
        }>(resultPath)
      : null;

  const rewards = await findFiles(
    join(runPath, "harbor"),
    (path) =>
      basename(path) === "reward.json" &&
      basename(dirname(path)) === "verifier",
  );
  const reward =
    rewards.length === 1 ? parseReward(await readJson(rewards[0]!)) : null;
  const verificationFiles = await findFiles(
    join(runPath, "harbor"),
    (path) =>
      basename(path) === "verification.json" &&
      basename(dirname(path)) === "verifier",
  );
  const mergedOutputs = await findFiles(
    join(runPath, "harbor"),
    (path) =>
      basename(path) === "codex.txt" && basename(dirname(path)) === "agent",
  );
  const nativeSessions = await findFiles(
    join(runPath, "harbor"),
    (path) => basename(path).startsWith("rollout-") && path.endsWith(".jsonl"),
  );
  const atifFiles = await findFiles(
    join(runPath, "harbor"),
    (path) =>
      basename(path) === "trajectory.json" &&
      path.includes(`${sep}agent${sep}`),
  );

  return {
    artifactManifest,
    artifactManifestError,
    artifactManifestValid: artifactManifestError === null,
    atifPresent: atifFiles.length === 1,
    cliInvocationObserved:
      trialLog.includes("codex exec") &&
      trialLog.includes(`--model ${MODEL}`) &&
      trialLog.includes(`model_reasoning_effort=${reasoningEffort}`),
    collectorCompleted: trialLog.includes(
      "Collect hook in service 'collector' completed",
    ),
    effectiveConfigObserved:
      serializedConfig.includes(`"model_name":"${MODEL}"`) &&
      serializedConfig.includes(`"reasoning_effort":"${reasoningEffort}"`) &&
      serializedConfig.includes('"web_search":"disabled"'),
    mainStopped: trialLog.includes("Main service stopped"),
    mergedOutputPresent: mergedOutputs.length === 1,
    nativeSessionPresent: nativeSessions.length >= 1,
    reward,
    rewardFacetsValid: reward !== null,
    trialPath: trialPath ? normalizedRelativePath(runPath, trialPath) : null,
    upstreamExceptionMessage: result?.exception_info?.exception_message ?? null,
    upstreamExceptionType: result?.exception_info?.exception_type ?? null,
    verificationPresent: verificationFiles.length === 1,
  };
}

function classifyUpstreamException(type: string): TerminalClass {
  if (/cancel|keyboardinterrupt/i.test(type)) {
    return "cancellation";
  }
  if (/verifier|reward/i.test(type)) {
    return "verifier-failure";
  }
  if (
    /authentication|api|modelnotfound|networkconnection|ratelimit|quota|provider/i.test(
      type,
    )
  ) {
    return "provider-failure";
  }
  if (/docker|environment|infrastructure|container|image/i.test(type)) {
    return "infrastructure-failure";
  }
  if (/agent|codex|timeout/i.test(type)) {
    return "agent-failure";
  }
  return "runner-failure";
}

export function classifyTerminal(
  execution: HarborExecution,
  evidence: EvidenceStatus,
): TerminalClass {
  if (execution.signal === "SIGINT" || execution.signal === "SIGTERM") {
    return "cancellation";
  }
  if (evidence.upstreamExceptionType) {
    return classifyUpstreamException(evidence.upstreamExceptionType);
  }
  if (execution.exitCode !== 0 || execution.signal !== null) {
    return "runner-failure";
  }
  if (
    !evidence.artifactManifestValid ||
    !evidence.rewardFacetsValid ||
    !evidence.verificationPresent ||
    !evidence.mainStopped ||
    !evidence.collectorCompleted
  ) {
    return "integrity-failure";
  }
  if (
    !evidence.mergedOutputPresent ||
    !evidence.nativeSessionPresent ||
    !evidence.atifPresent ||
    !evidence.cliInvocationObserved ||
    !evidence.effectiveConfigObserved
  ) {
    return "integrity-failure";
  }
  if (evidence.reward?.integrity !== 1) {
    return "integrity-failure";
  }
  if (
    evidence.reward.regressions !== 1 ||
    evidence.reward.scope !== 1 ||
    evidence.reward.task_contract !== 1
  ) {
    return "task-failure";
  }
  return "completed";
}

async function main(): Promise<void> {
  const arguments_ = parseArguments(process.argv.slice(2));
  assertNoAmbientProviderCredentials();
  const authPath = process.env.CODEX_AUTH_JSON_PATH;
  const rawRunRoot = process.env.BENCH_RUN_ROOT;
  if (!authPath || !rawRunRoot) {
    throw new Error("CODEX_AUTH_JSON_PATH and BENCH_RUN_ROOT are required");
  }

  const root = assertExternalRunRoot(rawRunRoot);
  await mkdir(root, { mode: 0o700, recursive: true });
  await chmod(root, 0o700);
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("BENCH_RUN_ROOT must be a real directory");
  }
  const preflight = await readJson<{
    controls: { name: string; passed: boolean }[];
    providerCalls: number;
    protocolRevision: string;
  }>(join(root, "provider-free-preflight.json"));
  if (
    preflight.protocolRevision !== PROTOCOL_REVISION ||
    preflight.providerCalls !== 0 ||
    preflight.controls.length === 0 ||
    !preflight.controls.some(
      (control) =>
        control.name === "harbor-public-agent-offline-verifier-lifecycle",
    ) ||
    !preflight.controls.some(
      (control) => control.name === "networked-verifier-rejected",
    ) ||
    preflight.controls.some((control) => !control.passed)
  ) {
    throw new Error("Provider-free preflight is missing or incomplete");
  }

  const [authBefore, images] = await Promise.all([
    inspectAuthFile(authPath),
    verifyImageLock(join(root, "image-lock.json")),
  ]);
  const host = collectHostIdentity();
  const runsPath = join(root, "runs");
  await mkdir(runsPath, { mode: 0o700, recursive: true });
  const existing = await loadExistingIntents(runsPath);
  const invocation = assertInvocationSequence(arguments_.phase, existing);
  const runPath = join(runsPath, arguments_.runId);
  await mkdir(runPath, { mode: 0o700 });

  const intent = {
    networkPolicy: "public-unrestricted-agent",
    protocolRevision: PROTOCOL_REVISION,
    reasoningEffort: arguments_.reasoningEffort,
    harnessRevision: `${PROTOCOL_REVISION}-${arguments_.reasoningEffort}`,
    auth: authBefore,
    authMode: "chatgpt-file",
    concurrency: 1,
    codexVersion: CODEX_VERSION,
    createdAt: new Date().toISOString(),
    harborVersion: HARBOR_VERSION,
    host,
    images,
    invocation,
    model: MODEL,
    phase: arguments_.phase,
    resources: {
      agentTimeoutSeconds: LIMITS.agentTimeoutSeconds,
      buildTimeoutSeconds: LIMITS.buildTimeoutSeconds,
      cpuCount: LIMITS.cpuCount,
      memoryMegabytes: LIMITS.memoryMegabytes,
      verifierTimeoutSeconds: LIMITS.verifierTimeoutSeconds,
    },
    retries: 0,
    runId: arguments_.runId,
    schemaVersion: "spike-1",
    telemetry: "off",
    webSearch: "disabled",
  };
  const intentSha256 = await writeImmutableJson(
    join(runPath, "run-intent.json"),
    intent,
  );

  let execution: HarborExecution = { exitCode: null, signal: null };
  let executionError: string | null = null;
  let evidence: EvidenceStatus;
  try {
    const datasetPath = await materializeTask(runPath);
    const jobConfigPath = join(runPath, "harbor-job.json");
    await writeFile(
      jobConfigPath,
      `${JSON.stringify(
        makeJobConfig(
          runPath,
          datasetPath,
          authPath,
          arguments_.runId,
          arguments_.reasoningEffort,
        ),
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    execution = await runHarbor(runPath, jobConfigPath, authPath);
  } catch (error) {
    executionError = errorMessage(error);
  }

  evidence = await inspectEvidence(runPath, arguments_.reasoningEffort);
  let terminalClass = classifyTerminal(execution, evidence);
  if (executionError) {
    terminalClass = "runner-failure";
  }
  let authAfter: AuthMetadata | null = null;
  try {
    authAfter = await inspectAuthFile(authPath);
  } catch (error) {
    executionError ??= `Post-run auth metadata unavailable: ${errorMessage(error)}`;
    terminalClass = "integrity-failure";
  }
  const terminalHasValidGrade =
    terminalClass === "completed" || terminalClass === "task-failure";
  const effectiveReward = evidence.reward
    ? {
        ...evidence.reward,
        integrity:
          terminalHasValidGrade && evidence.reward.integrity === 1 ? 1 : 0,
      }
    : null;
  const completion = {
    auth: {
      after: authAfter,
      before: authBefore,
      changed:
        authAfter === null ||
        authAfter.sourceSha256 !== authBefore.sourceSha256,
    },
    completedAt: new Date().toISOString(),
    protocolRevision: PROTOCOL_REVISION,
    effectiveReward,
    evidence,
    execution,
    executionError,
    intentSha256,
    schemaVersion: "spike-1",
    terminalClass,
    validGrade: terminalHasValidGrade && effectiveReward?.integrity === 1,
  };
  await writeImmutableJson(join(runPath, "completion.json"), completion);
  const finalization = await finalizeRunRecord(runPath);
  const result = {
    findings: finalization.findings,
    finalized: finalization.finalized,
    manifestEntries: finalization.manifest.length,
    runId: arguments_.runId,
    terminalClass,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!finalization.finalized || terminalClass !== "completed") {
    process.exitCode = 2;
  }
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
