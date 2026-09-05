import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import * as v from "valibot";

import {
  CompletionRunRecordSchema,
  ExperimentDocumentSchema,
  HarnessDocumentSchema,
  InitialRunRecordStructureSchema,
  RunDocumentSchema,
  ScoreDocumentSchema,
  StackDocumentSchema,
  SuiteDocumentSchema,
  TaskDocumentSchema,
  validateDocumentRelationships,
  type CompletionRunRecord,
} from "../src/index.ts";

const examplesRoot = resolve(import.meta.dirname, "../examples");

function readExample(directory: "valid" | "invalid", name: string): unknown {
  const source = readFileSync(
    resolve(examplesRoot, directory, `${name}.json`),
    "utf8",
  );
  return JSON.parse(source) as unknown;
}

function pathsFor(
  result: v.SafeParseResult<v.GenericSchema>,
): (string | null)[] {
  return result.issues?.map((issue) => v.getDotPath(issue)) ?? [];
}

const digest = (character: string): string => `sha256:${character.repeat(64)}`;
const patternedDigest = (pattern: string): string =>
  `sha256:${pattern.repeat(64 / pattern.length)}`;

function passedEvidence(character: string) {
  return {
    status: "passed" as const,
    evidence_digest: { status: "known" as const, value: digest(character) },
  };
}

function completionRecord(
  classification: CompletionRunRecord["classification"] = "task_success",
  validGrade = classification === "task_success" ||
    classification === "task_failure",
): CompletionRunRecord {
  return v.parse(CompletionRunRecordSchema, {
    document_type: "run",
    schema_version: 1,
    record_type: "completion",
    identity: { run_id: "run-v1-r1", attempt_id: "attempt-1" },
    completed_at: "2026-09-05T10:00:00Z",
    initial_manifest_digest: digest("2"),
    classification,
    termination:
      classification === "cancellation"
        ? { kind: "cancelled", reason: "Owner cancelled the run" }
        : classification === "task_success" || classification === "task_failure"
          ? { kind: "success" }
          : { kind: "error", reason: `${classification} fixture` },
    collection: {
      collector_revision: "1",
      collector_image_digest: digest("6"),
      quiescence: passedEvidence("a"),
      collection: passedEvidence("b"),
      exact_manifest: passedEvidence("c"),
      hashes: passedEvidence("d"),
    },
    verifier: {
      verifier_revision: "1",
      verifier_image_digest: digest("7"),
      network_enforcement_sidecar_digest: {
        status: "known",
        value: digest("8"),
      },
      separate_environment: passedEvidence("e"),
      network_disabled: passedEvidence("f"),
      credential_free: passedEvidence("1"),
      result_digest: { status: "known", value: patternedDigest("17") },
    },
    valid_grade: validGrade,
    score_id: validGrade
      ? { status: "known", value: "score-v1-r1" }
      : { status: "not_applicable", reason: "No valid quality grade" },
    timings: {
      total_seconds: 60,
      agent_seconds: { status: "known", value: 40 },
      verifier_seconds: { status: "known", value: 10 },
    },
    usage: {
      input_tokens: { status: "unknown", reason: "Not exposed" },
      output_tokens: { status: "unknown", reason: "Not exposed" },
      subscription_money: {
        status: "not_applicable",
        reason: "Subscription usage is not API spend",
      },
      upstream_api_price_estimate: {
        status: "unknown",
        reason: "No upstream estimate retained",
      },
    },
    raw_artifact_path: "/restricted/run-v1-r1",
    raw_artifact_manifest_digest: digest("3"),
  });
}

describe("versioned document schemas", () => {
  const cases = [
    ["stack", StackDocumentSchema],
    ["harness", HarnessDocumentSchema],
    ["task", TaskDocumentSchema],
    ["suite", SuiteDocumentSchema],
    ["experiment", ExperimentDocumentSchema],
    ["run", RunDocumentSchema],
    ["score", ScoreDocumentSchema],
  ] as const;

  it.each(cases)(
    "accepts the sanitized %s example without mutating it",
    (name, schema) => {
      const input = readExample("valid", name);
      const before = JSON.stringify(input);
      const result = v.safeParse(schema, input);

      expect(result.issues).toBeUndefined();
      expect(JSON.stringify(input)).toBe(before);
    },
  );

  it("rejects unknown schema versions and extra fields", () => {
    const suite = v.parse(SuiteDocumentSchema, readExample("valid", "suite"));
    const wrongVersion = { ...suite, schema_version: 2 };
    const extraField = { ...suite, invented_zero: 0 };

    expect(pathsFor(v.safeParse(SuiteDocumentSchema, wrongVersion))).toContain(
      "schema_version",
    );
    expect(pathsFor(v.safeParse(SuiteDocumentSchema, extraField))).toContain(
      "invented_zero",
    );
  });

  it("rejects malformed digests with an actionable field path", () => {
    const harness = v.parse(
      HarnessDocumentSchema,
      readExample("valid", "harness"),
    );
    const invalid = { ...harness, digest: "abc123" };
    const result = v.safeParse(HarnessDocumentSchema, invalid);

    expect(pathsFor(result)).toContain("digest");
    expect(result.issues?.[0]?.message).toContain("sha256");
  });

  it.each([0, 2])("rejects subscription concurrency %s", (requested) => {
    const stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));
    const invalid = {
      ...stack,
      runner: {
        ...stack.runner,
        concurrency: { ...stack.runner.concurrency, requested },
      },
    };

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      "runner.concurrency.requested",
    );
  });

  it("requires explicit owner opt-in when telemetry is effective", () => {
    const stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));
    const invalid = {
      ...stack,
      runner: {
        ...stack.runner,
        telemetry: {
          requested: "on" as const,
          effective: "on" as const,
          owner_opt_in: false,
        },
      },
    };
    const result = v.safeParse(StackDocumentSchema, invalid);

    expect(pathsFor(result)).toContain("runner.telemetry.owner_opt_in");
  });

  it("preserves unknown provider identity without inventing a value", () => {
    const stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));

    expect(stack.agent.observed_provider_identity).toEqual({
      status: "unknown",
      reason: "Provider does not expose a stable backend identity",
    });
  });

  it("rejects an incompatible API authentication mode", () => {
    const stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));
    const invalid = {
      ...stack,
      agent: {
        ...stack.agent,
        auth: { ...stack.agent.auth, mode: "api" },
      },
    };

    expect(pathsFor(v.safeParse(StackDocumentSchema, invalid))).toContain(
      "agent.auth.mode",
    );
  });

  it("allows an explicit not-applicable verifier network sidecar", () => {
    const task = v.parse(TaskDocumentSchema, readExample("valid", "task"));
    const withoutSidecar = {
      ...task,
      verifier: {
        ...task.verifier,
        network_enforcement_sidecar_digest: {
          status: "not_applicable" as const,
          reason: "No sidecar participates in this verifier network boundary",
        },
      },
    };

    expect(v.parse(TaskDocumentSchema, withoutSidecar).verifier).toEqual(
      withoutSidecar.verifier,
    );
  });

  it("rejects duplicate suite task identities", () => {
    const suite = v.parse(SuiteDocumentSchema, readExample("valid", "suite"));
    const invalid = { ...suite, tasks: [suite.tasks[0], suite.tasks[0]] };

    expect(pathsFor(v.safeParse(SuiteDocumentSchema, invalid))).toContain(
      "tasks",
    );
  });
});

describe("run completion integrity", () => {
  it.each([
    "task_success",
    "task_failure",
    "agent_failure",
    "provider_failure",
    "runner_failure",
    "verifier_failure",
    "infrastructure_failure",
    "cancellation",
  ] as const)("represents the %s terminal classification", (classification) => {
    expect(completionRecord(classification).classification).toBe(
      classification,
    );
  });

  it("retains timeout stage, limit, elapsed time, and observed cause", () => {
    const completion = completionRecord("runner_failure", false);
    const timeout = {
      ...completion,
      termination: {
        kind: "timeout" as const,
        stage: "collection" as const,
        limit_seconds: 60,
        elapsed_seconds: 61,
        observed_cause: "Collector did not quiesce",
      },
    };

    expect(v.parse(CompletionRunRecordSchema, timeout).termination).toEqual(
      timeout.termination,
    );
  });

  it("rejects a valid grade for a provider failure", () => {
    const completion = completionRecord();
    const invalid = {
      ...completion,
      classification: "provider_failure" as const,
    };
    const result = v.safeParse(CompletionRunRecordSchema, invalid);

    expect(pathsFor(result)).toContain("valid_grade");
    expect(
      result.issues?.some(({ message }) => message.includes("valid grade")),
    ).toBe(true);
  });

  it("rejects a task outcome without a valid grade", () => {
    const completion = completionRecord();
    const invalid = {
      ...completion,
      valid_grade: false,
      score_id: {
        status: "not_applicable" as const,
        reason: "Fixture removes the grade",
      },
    };

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      "valid_grade",
    );
  });

  it.each(["quiescence", "collection", "exact_manifest", "hashes"] as const)(
    "rejects a valid grade when %s evidence is missing",
    (field) => {
      const completion = completionRecord();
      const invalid = {
        ...completion,
        collection: {
          ...completion.collection,
          [field]: {
            status: "missing" as const,
            evidence_digest: { status: "unknown" as const, reason: "Missing" },
          },
        },
      };

      expect(
        pathsFor(v.safeParse(CompletionRunRecordSchema, invalid)),
      ).toContain("valid_grade");
    },
  );

  it("allows budget exhaustion to carry a task grade with complete evidence", () => {
    const completion = completionRecord("task_failure", true);
    const graded = {
      ...completion,
      termination: {
        kind: "budget_exhausted" as const,
        reason: "Wall-clock limit reached after collectable work",
      },
    };

    expect(v.parse(CompletionRunRecordSchema, graded).valid_grade).toBe(true);
  });

  it("accepts observed zero token usage without treating it as missing", () => {
    const completion = completionRecord();
    const zeroUsage = {
      ...completion,
      usage: {
        ...completion.usage,
        input_tokens: { status: "known" as const, value: 0 },
        output_tokens: { status: "known" as const, value: 0 },
      },
    };

    expect(v.parse(CompletionRunRecordSchema, zeroUsage).usage).toEqual(
      zeroUsage.usage,
    );
  });

  it("rejects a cancellation without a cancelled termination", () => {
    const completion = completionRecord("cancellation", false);
    const invalid = {
      ...completion,
      termination: { kind: "error" as const, reason: "Wrong terminal kind" },
    };

    expect(pathsFor(v.safeParse(CompletionRunRecordSchema, invalid))).toContain(
      "termination",
    );
  });
});

describe("score applicability", () => {
  it("preserves not-applicable and unknown facets without numeric zeroes", () => {
    const score = v.parse(ScoreDocumentSchema, readExample("valid", "score"));
    const unresolved = {
      ...score,
      valid_grade: false,
      gates: { ...score.gates, verifier_integrity_pass: false },
      facets: {
        ...score.facets,
        repository_contracts: {
          status: "not_applicable" as const,
          reason: "No evidence-backed repository obligation",
          evidence: [],
        },
        scope_integrity: {
          status: "unknown" as const,
          reason: "Verifier evidence unavailable",
          evidence: [],
        },
      },
      composite: {
        status: "not_applicable" as const,
        reason: "Required facets are not numeric",
      },
    };
    const parsed = v.parse(ScoreDocumentSchema, unresolved);

    expect(parsed.facets.repository_contracts.status).toBe("not_applicable");
    expect(parsed.facets.scope_integrity.status).toBe("unknown");
    expect(parsed.composite.status).toBe("not_applicable");
  });

  it("rejects a composite when an obligatory facet is not numeric", () => {
    const score = v.parse(ScoreDocumentSchema, readExample("valid", "score"));
    const invalid = {
      ...score,
      facets: {
        ...score.facets,
        repository_contracts: {
          status: "not_applicable" as const,
          reason: "No evidenced contracts",
          evidence: [],
        },
      },
    };

    expect(pathsFor(v.safeParse(ScoreDocumentSchema, invalid))).toContain(
      "composite",
    );
  });

  it("rejects a composite that differs from the frozen formula", () => {
    const score = v.parse(ScoreDocumentSchema, readExample("valid", "score"));
    const invalid = {
      ...score,
      composite: { status: "value" as const, value: 0.5 },
    };
    const result = v.safeParse(ScoreDocumentSchema, invalid);

    expect(pathsFor(result)).toContain("composite");
    expect(
      result.issues?.some(({ message }) =>
        message.includes("frozen v1 scoring formula"),
      ),
    ).toBe(true);
  });
});

describe("experiment blocks", () => {
  it("accepts the exact 24-hour deadline boundary", () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample("valid", "experiment"),
    );

    expect(experiment.blocks[0]?.contemporaneity.status).toBe("eligible");
  });

  it("rejects an eligible block completed one second after the deadline", () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample("valid", "experiment"),
    );
    const block = experiment.blocks[0];
    expect(block).toBeDefined();
    const invalidBlock = {
      ...block!,
      completed_at: { status: "known" as const, value: "2026-09-06T08:00:01Z" },
    };
    const invalid = { ...experiment, blocks: [invalidBlock] };

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      "blocks",
    );
  });

  it("requires execution order to cover the full block and arm matrix", () => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample("valid", "experiment"),
    );
    const invalid = {
      ...experiment,
      execution_order: experiment.execution_order.slice(0, -1),
    };

    expect(pathsFor(v.safeParse(ExperimentDocumentSchema, invalid))).toContain(
      "execution_order",
    );
  });

  it.each([
    "incomplete",
    "deadline_exceeded",
    "model_changed",
    "cli_changed",
    "provider_changed",
    "runner_changed",
    "harbor_config_changed",
    "harness_changed",
  ] as const)("retains %s as an ineligible block cause", (cause) => {
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample("valid", "experiment"),
    );
    const block = experiment.blocks[0];
    expect(block).toBeDefined();
    const invalidated = {
      ...block!,
      completion_status: "invalidated" as const,
      contemporaneity: {
        status: "ineligible" as const,
        cause,
        reason: `${cause} fixture`,
      },
    };

    expect(
      v.safeParse(ExperimentDocumentSchema, {
        ...experiment,
        blocks: [invalidated, ...experiment.blocks.slice(1)],
      }).issues,
    ).toBeUndefined();
  });
});

describe("cross-document relationships", () => {
  it("accepts a linked three-arm harness-effect document set", () => {
    const v1Harness = v.parse(
      HarnessDocumentSchema,
      readExample("valid", "harness"),
    );
    const v1Stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));
    const disabledHarness = v.parse(HarnessDocumentSchema, {
      ...v1Harness,
      harness_id: "harness-disabled",
      digest: patternedDigest("14"),
    });
    const v2Harness = v.parse(HarnessDocumentSchema, {
      ...v1Harness,
      harness_id: "harness-v2",
      digest: patternedDigest("16"),
    });
    const disabledStack = v.parse(StackDocumentSchema, {
      ...v1Stack,
      stack_id: "codex-low-disabled",
      digest: patternedDigest("13"),
      harness: {
        id: disabledHarness.harness_id,
        revision: disabledHarness.revision,
        digest: disabledHarness.digest,
      },
    });
    const v2Stack = v.parse(StackDocumentSchema, {
      ...v1Stack,
      stack_id: "codex-low-v2",
      digest: patternedDigest("15"),
      harness: {
        id: v2Harness.harness_id,
        revision: v2Harness.revision,
        digest: v2Harness.digest,
      },
    });
    const suite = v.parse(SuiteDocumentSchema, readExample("valid", "suite"));
    const task = v.parse(TaskDocumentSchema, readExample("valid", "task"));
    const experiment = v.parse(
      ExperimentDocumentSchema,
      readExample("valid", "experiment"),
    );
    const initialRun = v.parse(
      InitialRunRecordStructureSchema,
      readExample("valid", "run"),
    );
    const completionRun = completionRecord();
    const score = v.parse(ScoreDocumentSchema, readExample("valid", "score"));
    const issues = validateDocumentRelationships({
      stacks: [disabledStack, v1Stack, v2Stack],
      harnesses: [disabledHarness, v1Harness, v2Harness],
      suite,
      tasks: [task],
      experiment,
      initial_run: initialRun,
      initial_run_digest: digest("2"),
      completion_run: completionRun,
      score,
    });

    expect(issues).toEqual([]);

    const changedAgentRun = {
      ...initialRun,
      agent: { ...initialRun.agent, effort: "high" },
    };
    const incompatible = validateDocumentRelationships({
      stacks: [disabledStack, v1Stack, v2Stack],
      harnesses: [disabledHarness, v1Harness, v2Harness],
      suite,
      tasks: [task],
      experiment,
      initial_run: changedAgentRun,
      initial_run_digest: digest("2"),
      completion_run: completionRun,
      score,
    });
    expect(incompatible.map(({ path }) => path)).toContain("initial_run.agent");
  });

  it("reports immutable initial/completion linkage errors", () => {
    const initialRun = v.parse(
      InitialRunRecordStructureSchema,
      readExample("valid", "run"),
    );
    const completionRun = completionRecord();
    const mismatched = {
      ...completionRun,
      identity: { ...completionRun.identity, attempt_id: "attempt-2" },
    };
    const stack = v.parse(StackDocumentSchema, readExample("valid", "stack"));
    const harness = v.parse(
      HarnessDocumentSchema,
      readExample("valid", "harness"),
    );
    const issues = validateDocumentRelationships({
      stacks: [stack],
      harnesses: [harness],
      suite: v.parse(SuiteDocumentSchema, readExample("valid", "suite")),
      tasks: [v.parse(TaskDocumentSchema, readExample("valid", "task"))],
      experiment: v.parse(
        ExperimentDocumentSchema,
        readExample("valid", "experiment"),
      ),
      initial_run: initialRun,
      initial_run_digest: digest("9"),
      completion_run: mismatched,
    });

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining([
        "completion_run.identity.attempt_id",
        "completion_run.initial_manifest_digest",
      ]),
    );
  });

  it("reports completion chronology and score identity errors", () => {
    const initialRun = v.parse(
      InitialRunRecordStructureSchema,
      readExample("valid", "run"),
    );
    const completionRun = {
      ...completionRecord(),
      completed_at: "2026-09-05T07:59:59Z",
    };
    const score = v.parse(ScoreDocumentSchema, readExample("valid", "score"));
    const issues = validateDocumentRelationships({
      stacks: [v.parse(StackDocumentSchema, readExample("valid", "stack"))],
      harnesses: [
        v.parse(HarnessDocumentSchema, readExample("valid", "harness")),
      ],
      suite: v.parse(SuiteDocumentSchema, readExample("valid", "suite")),
      tasks: [v.parse(TaskDocumentSchema, readExample("valid", "task"))],
      experiment: v.parse(
        ExperimentDocumentSchema,
        readExample("valid", "experiment"),
      ),
      initial_run: initialRun,
      initial_run_digest: digest("2"),
      completion_run: completionRun,
      score: { ...score, score_id: "different-score" },
    });

    expect(issues.map(({ path }) => path)).toEqual(
      expect.arrayContaining(["completion_run.completed_at", "score.score_id"]),
    );
  });
});

describe("checked-in invalid examples", () => {
  it.each([
    ["stack-concurrency-two", StackDocumentSchema],
    ["run-missing-collector", RunDocumentSchema],
    ["unknown-schema-version", SuiteDocumentSchema],
  ] as const)("rejects %s", (name, schema) => {
    expect(
      v.safeParse(schema, readExample("invalid", name)).issues,
    ).toBeDefined();
  });
});
