import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { toJsonSchema } from "@valibot/to-json-schema";
import { describe, expect, it } from "vitest";
import * as v from "valibot";

import {
  assertSerializedJsonSchema,
  generateJsonSchema,
  JSON_SCHEMA_DOCUMENTS,
  type JsonSchemaDocumentName,
  serializeJsonSchema,
} from "../src/json-schema.ts";

const generatedRoot = resolve(import.meta.dirname, "../generated");
const names = Object.keys(
  JSON_SCHEMA_DOCUMENTS,
).sort() as JsonSchemaDocumentName[];

describe("serialized JSON schemas", () => {
  it.each(names)(
    "keeps the generated %s schema deterministic and current",
    (name) => {
      const path = resolve(generatedRoot, `${name}.schema.json`);
      const saved = readFileSync(path, "utf8");

      expect(serializeJsonSchema(name)).toBe(serializeJsonSchema(name));
      expect(() => assertSerializedJsonSchema(name, saved)).not.toThrow();
      const generated = generateJsonSchema(name);
      expect(generated).toMatchObject({
        $id: `https://schemas.agent-stack-benchmark.local/v1/${name}.schema.json`,
        $schema: "https://json-schema.org/draft/2020-12/schema",
      });
      if (name === "run") {
        expect(generated.anyOf).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ additionalProperties: false }),
          ]),
        );
      } else {
        expect(generated.additionalProperties).toBe(false);
      }
    },
  );

  it("fails when a checked-in artifact is stale", () => {
    const stale = serializeJsonSchema("suite").replace(
      "Frozen benchmark suite identity contract",
      "stale description",
    );

    expect(() => assertSerializedJsonSchema("suite", stale)).toThrow(
      "Generated JSON schema is stale: suite.schema.json",
    );
  });

  it("throws instead of weakening an unsupported schema", () => {
    expect(() =>
      toJsonSchema(v.file(), {
        errorMode: "throw",
        target: "draft-2020-12",
      }),
    ).toThrow();
  });
});
