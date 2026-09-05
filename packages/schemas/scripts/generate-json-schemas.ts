import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import {
  assertSerializedJsonSchema,
  JSON_SCHEMA_DOCUMENTS,
  type JsonSchemaDocumentName,
  serializeJsonSchema
} from '../src/json-schema.ts'

const packageRoot = resolve(import.meta.dirname, '..')

const names = Object.keys(
  JSON_SCHEMA_DOCUMENTS
).sort() as JsonSchemaDocumentName[]

const expectedFileNames = names.map((name) => `${name}.schema.json`)
const args = process.argv.slice(2)
let checkOnly = false
let outputDirectory = resolve(packageRoot, 'generated')

for (let index = 0; index < args.length; index += 1) {
  const argument = args[index]

  if (argument === '--check') {
    checkOnly = true
    continue
  }

  if (argument === '--output-directory') {
    const path = args[index + 1]

    if (!path) {
      throw new Error(
        'Usage: generate-json-schemas.ts [--check] [--output-directory <path>]'
      )
    }

    outputDirectory = resolve(path)
    index += 1
    continue
  }

  throw new Error(
    'Usage: generate-json-schemas.ts [--check] [--output-directory <path>]'
  )
}

if (!checkOnly) {
  await mkdir(outputDirectory, { recursive: true })
}

let actualFileNames: string[]

try {
  actualFileNames = (await readdir(outputDirectory))
    .filter((name) => name.endsWith('.schema.json'))
    .sort()
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error)

  throw new Error(`Generated JSON schema directory is missing: ${reason}`)
}

const unexpectedFileNames = actualFileNames.filter(
  (name) => !expectedFileNames.includes(name)
)

if (unexpectedFileNames.length > 0) {
  throw new Error(
    `Generated JSON schema inventory contains unexpected files: ${unexpectedFileNames.join(', ')}`
  )
}

if (checkOnly) {
  const missingFileNames = expectedFileNames.filter(
    (name) => !actualFileNames.includes(name)
  )

  if (missingFileNames.length > 0) {
    throw new Error(
      `Generated JSON schema inventory is missing files: ${missingFileNames.join(', ')}`
    )
  }
}

for (const name of names) {
  const path = resolve(outputDirectory, `${name}.schema.json`)

  if (checkOnly) {
    let actual: string

    try {
      actual = await readFile(path, 'utf8')
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)

      throw new Error(`Generated JSON schema is missing: ${path}: ${reason}`)
    }

    assertSerializedJsonSchema(name, actual)

    continue
  }

  await writeFile(path, serializeJsonSchema(name), 'utf8')
}

console.log(
  checkOnly
    ? `Verified ${names.length} generated JSON schemas`
    : `Generated ${names.length} JSON schemas`
)
