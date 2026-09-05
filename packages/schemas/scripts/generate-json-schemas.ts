import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  assertSerializedJsonSchema,
  JSON_SCHEMA_DOCUMENTS,
  type JsonSchemaDocumentName,
  serializeJsonSchema,
} from "../src/json-schema.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(packageRoot, "generated");
const names = Object.keys(
  JSON_SCHEMA_DOCUMENTS,
).sort() as JsonSchemaDocumentName[];
const checkOnly = process.argv.includes("--check");

if (process.argv.length > (checkOnly ? 3 : 2)) {
  throw new Error("Usage: generate-json-schemas.ts [--check]");
}

if (!checkOnly) {
  await mkdir(outputDirectory, { recursive: true });
}

for (const name of names) {
  const path = resolve(outputDirectory, `${name}.schema.json`);
  if (checkOnly) {
    let actual: string;
    try {
      actual = await readFile(path, "utf8");
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Generated JSON schema is missing: ${path}: ${reason}`);
    }
    assertSerializedJsonSchema(name, actual);
    continue;
  }
  await writeFile(path, serializeJsonSchema(name), "utf8");
}

console.log(
  checkOnly
    ? `Verified ${names.length} generated JSON schemas`
    : `Generated ${names.length} JSON schemas`,
);
