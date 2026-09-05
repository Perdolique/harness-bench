import { toJsonSchema, type JsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

import {
  ExperimentDocumentStructureSchema,
  HarnessDocumentStructureSchema,
  RunDocumentStructureSchema,
  ScoreDocumentStructureSchema,
  StackDocumentStructureSchema,
  SuiteDocumentStructureSchema,
  TaskDocumentStructureSchema,
} from "./documents.ts";

export const JSON_SCHEMA_DOCUMENTS = {
  experiment: {
    description: "Immutable experiment plan and block-status contract",
    schema: ExperimentDocumentStructureSchema,
  },
  harness: {
    description: "Immutable declared harness input contract",
    schema: HarnessDocumentStructureSchema,
  },
  run: {
    description: "Initial and immutable completion run-record contract",
    schema: RunDocumentStructureSchema,
  },
  score: {
    description: "Evidence-backed score facet and applicability contract",
    schema: ScoreDocumentStructureSchema,
  },
  stack: {
    description: "Complete native agent stack configuration contract",
    schema: StackDocumentStructureSchema,
  },
  suite: {
    description: "Frozen benchmark suite identity contract",
    schema: SuiteDocumentStructureSchema,
  },
  task: {
    description: "Frozen task, verifier, rubric, and retention contract",
    schema: TaskDocumentStructureSchema,
  },
} as const satisfies Record<
  string,
  { readonly description: string; readonly schema: GenericSchema }
>;

export type JsonSchemaDocumentName = keyof typeof JSON_SCHEMA_DOCUMENTS;

export function generateJsonSchema(name: JsonSchemaDocumentName): JsonSchema {
  const definition = JSON_SCHEMA_DOCUMENTS[name];
  const schema = toJsonSchema(definition.schema, {
    errorMode: "throw",
    target: "draft-2020-12",
  });
  schema.$id = `https://schemas.agent-stack-benchmark.local/v1/${name}.schema.json`;
  schema.title = `${name[0]?.toUpperCase()}${name.slice(1)} document v1`;
  schema.description = definition.description;
  return schema;
}

export function serializeJsonSchema(name: JsonSchemaDocumentName): string {
  const schema = generateJsonSchema(name);
  return `${JSON.stringify(schema, null, 2)}\n`;
}

export function assertSerializedJsonSchema(
  name: JsonSchemaDocumentName,
  actual: string,
): void {
  const expected = serializeJsonSchema(name);
  if (actual !== expected) {
    throw new Error(`Generated JSON schema is stale: ${name}.schema.json`);
  }
}
