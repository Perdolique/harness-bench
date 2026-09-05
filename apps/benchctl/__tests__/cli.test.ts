import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runCli, type CliIo } from '../src/cli.ts'

let fakeCodexRoot: string
let testRoot: string

async function makeWritable(path: string): Promise<void> {
  let metadata

  try {
    metadata = await lstat(path)
  } catch {
    return
  }

  if (metadata.isSymbolicLink()) {
    return
  }

  if (metadata.isDirectory()) {
    await chmod(path, 0o700)

    for (const entry of await readdir(path)) {
      await makeWritable(resolve(path, entry))
    }
  } else {
    await chmod(path, 0o600)
  }
}

async function removeTree(path: string): Promise<void> {
  await makeWritable(path)

  await rm(path, {
    force: true,
    recursive: true
  })
}

async function createSource(path: string): Promise<void> {
  await mkdir(resolve(path, 'skills', 'sample'), { recursive: true })

  await writeFile(
    resolve(path, 'config.toml'),
    'forced_login_method = "chatgpt"\nweb_search = "disabled"\n'
  )

  await writeFile(
    resolve(path, 'mcp-tools.json'),
    '{"mcp_servers":[]}\n'
  )

  await writeFile(resolve(path, 'AGENTS.md'), 'Original instructions.\n')

  await writeFile(
    resolve(path, 'skills', 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Sample.\n---\n'
  )
}

function captureArguments(
  source: string,
  store: string,
  revision = 'v1'
): string[] {
  return [
    '--',
    'harness',
    'capture',
    '--source',
    source,
    '--store',
    store,
    '--id',
    'cli-harness',
    '--revision',
    revision
  ]
}

function createIo(): {
  readonly io: CliIo;
  readonly stderr: string[];
  readonly stdout: string[];
} {
  const stderr: string[] = []
  const stdout: string[] = []

  const io: CliIo = {
    stderr: (value) => stderr.push(value),
    stdout: (value) => stdout.push(value)
  }

  return {
    io,
    stderr,
    stdout
  }
}

beforeAll(async () => {
  fakeCodexRoot = await mkdtemp('/tmp/harness-bench-cli-codex-')

  const fakeCodex = resolve(fakeCodexRoot, 'codex')

  await writeFile(
    fakeCodex,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli 0.153.2\\n'
elif [ "$1" = "--strict-config" ] && [ "$2" = "doctor" ]; then
  printf '{"checks":{"config.load":{"status":"ok"}}}\\n'
elif [ "$1" = "exec" ] && [ "$2" = "--strict-config" ]; then
  printf 'unknown configuration field zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control\\n' >&2
  exit 2
elif [ "$1" = "mcp" ]; then
  printf '[]\\n'
else
  exit 9
fi
`
  )

  await chmod(fakeCodex, 0o700)

  process.env.HARNESS_BENCH_TEST_CODEX_BINARY = fakeCodex
})

afterAll(async () => {
  delete process.env.HARNESS_BENCH_TEST_CODEX_BINARY

  await removeTree(fakeCodexRoot)
})

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-cli-test-')
})

afterEach(async () => {
  await removeTree(testRoot)
})

describe(runCli, () => {
  it('captures, validates, materializes, and diffs bundles with stable output', async () => {
    const source = resolve(testRoot, 'source')
    const firstStore = resolve(testRoot, 'first-store')

    await createSource(source)

    const capturedIo = createIo()

    const captureExit = await runCli(
      captureArguments(source, firstStore),
      capturedIo.io
    )

    const captureOutput = JSON.parse(capturedIo.stdout.join('')) as Record<
      string,
      unknown
    >

    const bundlePath = captureOutput.bundle_path

    expect(captureExit).toBe(0)
    expect(capturedIo.stderr).toEqual([])
    expect(bundlePath).toEqual(expect.any(String))

    expect(captureOutput).toMatchObject({
      harness_id: 'cli-harness',
      revision: 'v1'
    })

    if (typeof bundlePath !== 'string') {
      throw new Error('capture did not return a bundle path')
    }

    const validatedIo = createIo()

    const validateExit = await runCli(
      ['harness', 'validate', bundlePath],
      validatedIo.io
    )

    const validateOutput = JSON.parse(validatedIo.stdout.join('')) as Record<
      string,
      unknown
    >

    expect(validateExit).toBe(0)
    expect(validateOutput.entry_count).toBe(4)

    const materializedIo = createIo()
    const destination = resolve(testRoot, 'run')

    const materializeExit = await runCli(
      [
        'harness',
        'materialize',
        bundlePath,
        '--destination',
        destination
      ],
      materializedIo.io
    )

    const materializeOutput = JSON.parse(
      materializedIo.stdout.join('')
    ) as Record<string, unknown>

    expect(materializeExit).toBe(0)

    expect(materializeOutput).toMatchObject({
      root: destination,
      workspace: resolve(destination, 'workspace')
    })

    await writeFile(resolve(source, 'AGENTS.md'), 'Changed instructions.\n')

    const secondIo = createIo()

    await runCli(
      captureArguments(source, resolve(testRoot, 'second-store')),
      secondIo.io
    )

    const secondOutput = JSON.parse(secondIo.stdout.join('')) as Record<
      string,
      unknown
    >

    const secondBundle = secondOutput.bundle_path

    if (typeof secondBundle !== 'string') {
      throw new Error('second capture did not return a bundle path')
    }

    const diffIo = createIo()

    const diffExit = await runCli(
      ['harness', 'diff', bundlePath, secondBundle],
      diffIo.io
    )

    const renderedDiff = diffIo.stdout.join('')

    expect(diffExit).toBe(1)
    expect(renderedDiff).toContain('~ agents_md AGENTS.md')
    expect(renderedDiff).not.toContain('Changed instructions')

    const identicalIo = createIo()

    const identicalExit = await runCli(
      ['harness', 'diff', bundlePath, bundlePath],
      identicalIo.io
    )

    expect(identicalExit).toBe(0)
    expect(identicalIo.stdout.join('')).toContain('identical')
  })

  it('returns exit 2 and never prints a rejected secret value', async () => {
    const source = resolve(testRoot, 'source')
    const sentinel = `sk-${'z'.repeat(30)}`

    await createSource(source)

    await writeFile(
      resolve(source, 'skills', 'sample', 'SKILL.md'),
      `Do not expose ${sentinel}\n`
    )

    const output = createIo()

    const exitCode = await runCli(
      captureArguments(source, resolve(testRoot, 'store')),
      output.io
    )

    expect(exitCode).toBe(2)
    expect(output.stderr.join('')).toContain('SECRET_DETECTED')
    expect(output.stderr.join('')).not.toContain(sentinel)
    expect(output.stdout).toEqual([])
  })

  it('returns exit 2 with usage for an invalid command', async () => {
    const output = createIo()
    const exitCode = await runCli(['harness', 'smoke'], output.io)

    expect(exitCode).toBe(2)
    expect(output.stderr.join('')).toContain('USAGE_ERROR')
    expect(output.stderr.join('')).toContain('benchctl harness capture')
  })

  it('classifies unexpected runtime failures without printing raw diagnostics', async () => {
    const source = resolve(testRoot, 'source')

    await createSource(source)

    const capturedIo = createIo()

    await runCli(
      captureArguments(source, resolve(testRoot, 'store')),
      capturedIo.io
    )

    const captured = JSON.parse(capturedIo.stdout.join('')) as Record<
      string,
      unknown
    >

    const bundle = captured.bundle_path

    if (typeof bundle !== 'string') {
      throw new Error('capture did not return a bundle path')
    }

    const destination = resolve(testRoot, 'missing-parent', 'run')
    const output = createIo()

    const exitCode = await runCli(
      ['harness', 'materialize', bundle, '--destination', destination],
      output.io
    )

    const errorOutput = output.stderr.join('')

    expect(exitCode).toBe(2)
    expect(errorOutput).toBe('UNEXPECTED_ERROR: harness command failed\n')
    expect(errorOutput).not.toContain(destination)
    expect(errorOutput).not.toContain('ENOTDIR')
    expect(errorOutput).not.toContain('ENOENT')
  })

  it('escapes control characters in human-readable diff identities', async () => {
    const source = resolve(testRoot, 'source')
    const firstIo = createIo()
    const secondIo = createIo()

    await createSource(source)

    await runCli(
      captureArguments(
        source,
        resolve(testRoot, 'first-store'),
        'v1\nforged'
      ),
      firstIo.io
    )

    await runCli(
      captureArguments(source, resolve(testRoot, 'second-store'), 'v2'),
      secondIo.io
    )

    const firstOutput = JSON.parse(firstIo.stdout.join('')) as Record<
      string,
      unknown
    >

    const secondOutput = JSON.parse(secondIo.stdout.join('')) as Record<
      string,
      unknown
    >

    const left = firstOutput.bundle_path
    const right = secondOutput.bundle_path

    if (typeof left !== 'string' || typeof right !== 'string') {
      throw new Error('capture did not return both bundle paths')
    }

    const diffIo = createIo()
    const exitCode = await runCli(['harness', 'diff', left, right], diffIo.io)
    const output = diffIo.stdout.join('')

    expect(exitCode).toBe(1)
    expect(output).toContain('v1\\nforged')
    expect(output).not.toContain('v1\nforged')
  })
})
