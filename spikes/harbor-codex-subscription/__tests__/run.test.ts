import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyTerminal,
  assertInvocationSequence,
  parseArguments,
  type EvidenceStatus,
  type HarborExecution,
} from "../run.ts";

const successfulExecution: HarborExecution = { exitCode: 0, signal: null };
const testDirectory = dirname(fileURLToPath(import.meta.url));
const completeEvidence: EvidenceStatus = {
  artifactManifest: [],
  artifactManifestError: null,
  artifactManifestValid: true,
  atifPresent: true,
  cliInvocationObserved: true,
  collectorCompleted: true,
  effectiveConfigObserved: true,
  mainStopped: true,
  mergedOutputPresent: true,
  nativeSessionPresent: true,
  reward: {
    integrity: 1,
    regressions: 1,
    scope: 1,
    task_contract: 1,
  },
  rewardFacetsValid: true,
  trialPath: "harbor/trial",
  upstreamExceptionMessage: null,
  upstreamExceptionType: null,
  verificationPresent: true,
};

describe("subscription terminal classification", () => {
  it("records only an explicitly selected supported effort without changing the default", () => {
    const args = ["--phase", "public", "--run-id", "public-02"];
    expect(parseArguments(args).reasoningEffort).toBe("medium");
    expect(parseArguments([...args, "--effort", "low"]).reasoningEffort).toBe(
      "low",
    );
    expect(() => parseArguments([...args, "--effort", "high"])).toThrow(
      "--effort must be low or medium",
    );
  });
  it("rejects retired phases and caps the revised protocol at two invocations", () => {
    expect(() =>
      parseArguments(["--phase", "discovery", "--run-id", "old"]),
    ).toThrow("--phase must be public");
    const first = {
      invocation: 1,
      phase: "public" as const,
      protocolRevision: "public-1",
      runId: "one",
    };
    expect(assertInvocationSequence("public", [])).toBe(1);
    expect(assertInvocationSequence("public", [first])).toBe(2);
    expect(() =>
      assertInvocationSequence("public", [first, { ...first, invocation: 2 }]),
    ).toThrow("budget");
    expect(() =>
      assertInvocationSequence("public", [
        { ...first, protocolRevision: "spike-1" },
      ]),
    ).toThrow("protocol");
  });

  it("accepts the pnpm argument separator before provider preflight", () => {
    const environment = { ...process.env };
    delete environment.BENCH_RUN_ROOT;
    delete environment.CODEX_ACCESS_TOKEN;
    delete environment.CODEX_AUTH_JSON_PATH;
    delete environment.OPENAI_API_KEY;
    const result = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        join(testDirectory, "..", "run.ts"),
        "--",
        "--phase",
        "public",
        "--run-id",
        "separator-test",
      ],
      { encoding: "utf8", env: environment },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "CODEX_AUTH_JSON_PATH and BENCH_RUN_ROOT are required",
    );
    expect(result.stderr).not.toContain("Unknown argument");
  });

  it("requires confirmed main stop and completed collector", () => {
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        mainStopped: false,
      }),
    ).toBe("integrity-failure");
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        collectorCompleted: false,
      }),
    ).toBe("integrity-failure");
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        artifactManifestError: "collector artifact is missing",
        artifactManifestValid: false,
      }),
    ).toBe("integrity-failure");
  });

  it("keeps runner and valid task failures distinct", () => {
    expect(
      classifyTerminal({ exitCode: 1, signal: null }, completeEvidence),
    ).toBe("runner-failure");
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        reward: { ...completeEvidence.reward!, task_contract: 0 },
      }),
    ).toBe("task-failure");
  });

  it("classifies upstream failure families without fabricating a score", () => {
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        upstreamExceptionType: "AgentAuthenticationError",
      }),
    ).toBe("provider-failure");
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        upstreamExceptionType: "VerifierTimeoutError",
      }),
    ).toBe("verifier-failure");
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        upstreamExceptionType: "DockerComposeError",
      }),
    ).toBe("infrastructure-failure");
  });

  it("accepts only complete successful evidence", () => {
    expect(classifyTerminal(successfulExecution, completeEvidence)).toBe(
      "completed",
    );
  });

  it("never turns compromised integrity into a task score", () => {
    expect(
      classifyTerminal(successfulExecution, {
        ...completeEvidence,
        reward: { ...completeEvidence.reward!, integrity: 0 },
      }),
    ).toBe("integrity-failure");
  });
});
