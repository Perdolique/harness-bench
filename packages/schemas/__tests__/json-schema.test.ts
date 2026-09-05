import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as v from 'valibot'

import {
  assertSerializedJsonSchema,
  generateJsonSchema,
  generateJsonSchemaFromDefinition,
  JSON_SCHEMA_DOCUMENTS,
  type JsonSchemaDocumentName,
  serializeJsonSchema
} from '../src/json-schema.ts'

const generatedRoot = resolve(import.meta.dirname, '../generated')

const generatorPath = resolve(
  import.meta.dirname,
  '../scripts/generate-json-schemas.ts'
)

const names = Object.keys(
  JSON_SCHEMA_DOCUMENTS
).sort() as JsonSchemaDocumentName[]

function createGeneratedCopy(): string {
  const directory = mkdtempSync('/tmp/harness-bench-schemas-')

  cpSync(generatedRoot, directory, { recursive: true })

  return directory
}

function runGenerator(directory: string, checkOnly = true) {
  const args = [
    '--experimental-strip-types',
    generatorPath,
    ...(checkOnly ? ['--check'] : []),
    '--output-directory',
    directory
  ]

  return spawnSync(process.execPath, args, { encoding: 'utf8' })
}

describe('serialized JSON schemas', () => {
  it.each(names)(
    'keeps the generated %s schema deterministic and current',
    (name) => {
      const path = resolve(generatedRoot, `${name}.schema.json`)
      const saved = readFileSync(path, 'utf8')

      expect(serializeJsonSchema(name)).toBe(serializeJsonSchema(name))
      expect(() => assertSerializedJsonSchema(name, saved)).not.toThrow()

      const generated = generateJsonSchema(name)

      expect(generated).toMatchObject({
        $id: `https://schemas.agent-stack-benchmark.local/v1/${name}.schema.json`,
        $schema: 'https://json-schema.org/draft/2020-12/schema'
      })

      if (name === 'run') {
        expect(generated.anyOf).toHaveLength(2)

        expect(
          generated.anyOf?.every(
            (branch) =>
              typeof branch === 'object' &&
              branch !== null &&
              branch.additionalProperties === false
          )
        ).toBe(true)
      } else {
        expect(generated.additionalProperties).toBe(false)
      }
    }
  )

  it('fails when a checked-in artifact is stale', () => {
    const stale = serializeJsonSchema('suite').replace(
      'Frozen benchmark suite identity contract',
      'stale description'
    )

    expect(() => assertSerializedJsonSchema('suite', stale)).toThrow(
      'Generated JSON schema is stale: suite.schema.json'
    )
  })

  it('throws instead of weakening an unsupported schema', () => {
    expect(() =>
      generateJsonSchemaFromDefinition('unsupported', {
        description: 'Unsupported test schema',
        schema: v.file()
      })
    ).toThrow()
  })

  it('keeps check mode read-only for current, stale, and missing artifacts', () => {
    const directory = createGeneratedCopy()

    try {
      const before = readdirSync(directory)
        .sort()
        .map((name) => [name, readFileSync(resolve(directory, name), 'utf8')])

      const current = runGenerator(directory)

      expect(current.status).toBe(0)

      expect(
        readdirSync(directory)
          .sort()
          .map((name) => [
            name,
            readFileSync(resolve(directory, name), 'utf8')
          ])
      ).toEqual(before)

      const stalePath = resolve(directory, 'suite.schema.json')

      writeFileSync(stalePath, 'stale\n', 'utf8')

      const stale = runGenerator(directory)

      expect(stale.status).not.toBe(0)
      expect(readFileSync(stalePath, 'utf8')).toBe('stale\n')
      rmSync(stalePath)

      const missing = runGenerator(directory)

      expect(missing.status).not.toBe(0)
      expect(readdirSync(directory)).not.toContain('suite.schema.json')
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true
      })
    }
  })

  it('rejects unexpected generated artifacts in check and generate modes', () => {
    const directory = createGeneratedCopy()

    try {
      const obsoletePath = resolve(directory, 'obsolete.schema.json')

      writeFileSync(obsoletePath, 'malformed\n', 'utf8')

      const checked = runGenerator(directory)
      const generated = runGenerator(directory, false)

      expect(checked.status).not.toBe(0)
      expect(checked.stderr).toContain('unexpected files')
      expect(generated.status).not.toBe(0)
      expect(readFileSync(obsoletePath, 'utf8')).toBe('malformed\n')
    } finally {
      rmSync(directory, {
        recursive: true,
        force: true
      })
    }
  })
})
