import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'

import { basename, dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  captureHarnessBundle,
  diffHarnessBundles,
  HarnessError,
  materializeHarnessBundle,
  validateHarnessBundle
} from '../src/index.ts'

const VALID_CONFIG = `forced_login_method = "chatgpt"
cli_auth_credentials_store = "file"
model_reasoning_effort = "low"
web_search = "disabled"
`

const VALID_MCP = `${JSON.stringify({ mcp_servers: [] }, null, 2)}\n`

const STRICT_CONFIG_CONTROL_FIELD =
  'zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control'

const VALID_MCP_SERVERS = `${JSON.stringify(
  {
    mcp_servers: [
      {
        name: 'stdio-tool',
        transport: 'stdio',
        command: 'stdio-tool',
        args: ['serve']
      },
      {
        name: 'sse-tool',
        transport: 'sse',
        url: 'https://example.test/sse'
      },
      {
        name: 'streamable-tool',
        transport: 'streamable-http',
        url: 'https://example.test/mcp'
      }
    ]
  },
  null,
  2
)}\n`

let fakeCodexRoot: string
let fakeCodex: string
let testRoot: string

interface FakeCodexOptions {
  readonly cwdMarker?: string;
  readonly doctorMarker?: string;
  readonly rejectStrictConfig?: boolean;
  readonly version?: string;
}

interface MutableHarnessManifestEntry {
  readonly digest: string;
  readonly kind: string;
  readonly path: string;
}

interface MutableHarnessManifest {
  digest: string;
  readonly document_type: 'harness';
  entries: MutableHarnessManifestEntry[];
  readonly harness_id: string;
  revision: string;
  readonly schema_version: 1;
}

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

async function makeReadOnly(path: string): Promise<void> {
  const metadata = await lstat(path)

  if (metadata.isDirectory()) {
    for (const entry of await readdir(path)) {
      await makeReadOnly(resolve(path, entry))
    }

    await chmod(path, 0o555)
  } else {
    await chmod(path, 0o444)
  }
}

async function writeFakeCodex(
  options: FakeCodexOptions = {}
): Promise<void> {
  const version = options.version ?? '0.154.0'

  const markerCommand =
    options.doctorMarker === undefined
      ? ''
      : `touch '${options.doctorMarker}'\nsleep 0.2\n`

  const cwdMarkerCommand =
    options.cwdMarker === undefined
      ? ''
      : `pwd > '${options.cwdMarker}'\n`

  const strictConfigResult = options.rejectStrictConfig
    ? `printf 'strict config rejected\\n' >&2
exit 2`
    : `if grep -q 'unknown_issue_5_control' "$CODEX_HOME/config.toml"; then
  printf 'unknown configuration field\\n' >&2
  exit 2
fi
printf 'unknown configuration field ${STRICT_CONFIG_CONTROL_FIELD}\\n' >&2
exit 2`

  await writeFile(
    fakeCodex,
    `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf 'codex-cli ${version}\\n'
  exit 0
fi
if [ "$1" = "--strict-config" ] && [ "$2" = "doctor" ]; then
  ${markerCommand}printf '{"status":"failed","checks":{"config.load":{"status":"ok"}}}\\n'
  exit 1
fi
if [ "$1" = "exec" ] && [ "$2" = "--strict-config" ]; then
  ${cwdMarkerCommand}${strictConfigResult}
fi
if [ "$1" = "mcp" ] && [ "$2" = "list" ]; then
  printf '[]\\n'
  exit 0
fi
exit 9
`
  )

  await chmod(fakeCodex, 0o700)
}

async function waitForPath(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path)

      return
    } catch {
      await delay(10)
    }
  }

  throw new Error(`Timed out waiting for ${path}`)
}

async function waitForStagingDirectory(store: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const entries = await readdir(store)

      if (entries.some((entry) => entry.startsWith('.harness-staging-'))) {
        return
      }
    } catch {
      // The store is created by the capture under test.
    }

    await delay(5)
  }

  throw new Error(`Timed out waiting for a staging directory in ${store}`)
}

async function createHarnessSource(
  path: string,
  config = VALID_CONFIG,
  mcp = VALID_MCP
): Promise<void> {
  await mkdir(resolve(path, 'skills', 'sample', 'scripts'), { recursive: true })
  await mkdir(resolve(path, 'rules'), { recursive: true })
  await writeFile(resolve(path, 'mcp-tools.json'), mcp)
  await writeFile(resolve(path, 'AGENTS.md'), 'Use the sample skill.\n')
  await writeFile(resolve(path, 'config.toml'), config)

  await writeFile(
    resolve(path, 'skills', 'sample', 'SKILL.md'),
    '---\nname: sample\ndescription: Sample.\n---\n\nRun the script.\n'
  )

  await writeFile(
    resolve(path, 'skills', 'sample', 'scripts', 'sample.sh'),
    '#!/bin/sh\nprintf "sample\\n"\n'
  )

  await writeFile(
    resolve(path, 'rules', 'default.rules'),
    'prefix_rule(pattern=["git", "status"], decision="allow")\n'
  )
}

function captureOptions(source: string, store: string) {
  return {
    harnessId: 'daily-harness',
    revision: 'v1',
    source,
    store
  } as const
}

async function expectHarnessError(
  action: Promise<unknown>,
  code: HarnessError['code']
): Promise<HarnessError> {
  try {
    await action
  } catch (error) {
    expect(error).toBeInstanceOf(HarnessError)

    const harnessError = error as HarnessError

    expect(harnessError.code).toBe(code)

    return harnessError
  }

  throw new Error('Expected a HarnessError')
}

beforeAll(async () => {
  fakeCodexRoot = await mkdtemp('/tmp/harness-bench-fake-codex-')
  fakeCodex = resolve(fakeCodexRoot, 'codex')

  await writeFakeCodex()

  process.env.HARNESS_BENCH_TEST_CODEX_BINARY = fakeCodex
})

afterAll(async () => {
  delete process.env.HARNESS_BENCH_TEST_CODEX_BINARY

  await removeTree(fakeCodexRoot)
})

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-core-test-')
})

afterEach(async () => {
  await removeTree(testRoot)
})

describe(captureHarnessBundle, () => {
  it('creates stable, idempotent content addresses from equivalent source roots', async () => {
    const firstSource = resolve(testRoot, 'first-source')
    const secondSource = resolve(testRoot, 'second-source')

    await createHarnessSource(firstSource)
    await createHarnessSource(secondSource)

    await utimes(
      resolve(secondSource, 'config.toml'),
      new Date('2030-01-01T00:00:00Z'),
      new Date('2030-01-01T00:00:00Z')
    )

    const first = await captureHarnessBundle(
      captureOptions(firstSource, resolve(testRoot, 'first-store'))
    )

    const second = await captureHarnessBundle(
      captureOptions(secondSource, resolve(testRoot, 'second-store'))
    )

    const repeated = await captureHarnessBundle(
      captureOptions(firstSource, resolve(testRoot, 'first-store'))
    )

    expect(second.manifest.digest).toBe(first.manifest.digest)
    expect(repeated.bundlePath).toBe(first.bundlePath)
    expect(repeated.manifest).toStrictEqual(first.manifest)
  })

  it('changes the bundle and entry digests when config or skill bytes change', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const original = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store-original'))
    )

    await writeFile(resolve(source, 'config.toml'), `${VALID_CONFIG}\n`)

    const configChanged = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store-config'))
    )

    await writeFile(
      resolve(source, 'skills', 'sample', 'SKILL.md'),
      '---\nname: sample\ndescription: Changed.\n---\n'
    )

    const skillChanged = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store-skill'))
    )

    const originalConfig = original.manifest.entries.find(
      ({ path }) => path === 'config.toml'
    )

    const changedConfig = configChanged.manifest.entries.find(
      ({ path }) => path === 'config.toml'
    )

    const changedSkill = skillChanged.manifest.entries.find(
      ({ path }) => path === 'skills/sample/SKILL.md'
    )

    const previousSkill = configChanged.manifest.entries.find(
      ({ path }) => path === 'skills/sample/SKILL.md'
    )

    expect(configChanged.manifest.digest).not.toBe(original.manifest.digest)
    expect(changedConfig?.digest).not.toBe(originalConfig?.digest)
    expect(skillChanged.manifest.digest).not.toBe(configChanged.manifest.digest)
    expect(changedSkill?.digest).not.toBe(previousSkill?.digest)
  })

  it('accepts every supported MCP transport', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source, VALID_CONFIG, VALID_MCP_SERVERS)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    const mcpEntry = captured.manifest.entries.find(
      ({ path }) => path === 'mcp-tools.json'
    )

    expect(mcpEntry).toMatchObject({ kind: 'mcp_tools' })
  })

  it('includes harness identity in the canonical digest', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const first = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store-first'))
    )

    const second = await captureHarnessBundle({
      ...captureOptions(source, resolve(testRoot, 'store-second')),
      harnessId: 'other-harness',
      revision: 'v2'
    })

    expect(second.manifest.digest).not.toBe(first.manifest.digest)
    expect(second.manifest.entries).toStrictEqual(first.manifest.entries)
  })

  it('requires the exact workspace-pinned Codex version', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)
    await writeFakeCodex({ version: '0.154.10' })

    try {
      await expectHarnessError(
        captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
        'CODEX_VALIDATION_FAILED'
      )
    } finally {
      await writeFakeCodex()
    }
  })

  it('requires a supported strict-config command to accept every config field', async () => {
    const source = resolve(testRoot, 'source')
    const config = `${VALID_CONFIG}unknown_issue_5_control = true\n`

    await createHarnessSource(source, config)

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      'CODEX_VALIDATION_FAILED'
    )
  })

  it('runs pinned Codex validation from an isolated temporary workspace', async () => {
    const source = resolve(testRoot, 'source')
    const cwdMarker = resolve(testRoot, 'codex-cwd')

    await createHarnessSource(source)
    await writeFakeCodex({ cwdMarker })

    try {
      await captureHarnessBundle(
        captureOptions(source, resolve(testRoot, 'store'))
      )

      const cwd = (await readFile(cwdMarker, 'utf8')).trim()

      expect(cwd).toMatch(/^\/(?:private\/)?tmp\/harness-bench-codex-.+\/workspace$/)
      expect(cwd).not.toBe(process.cwd())
    } finally {
      await writeFakeCodex()
    }
  })

  it('rejects content changed while the captured config is validated', async () => {
    const source = resolve(testRoot, 'source')
    const marker = resolve(testRoot, 'doctor-started')

    await createHarnessSource(source)
    await writeFakeCodex({ doctorMarker: marker })

    try {
      const capture = captureHarnessBundle(
        captureOptions(source, resolve(testRoot, 'store'))
      )

      await waitForPath(marker)
      await writeFile(resolve(source, 'config.toml'), `${VALID_CONFIG}\n`)
      await expectHarnessError(capture, 'SOURCE_CHANGED')
    } finally {
      await writeFakeCodex()
    }
  })

  it.each([
    ['unknown top-level entry', async (source: string) => writeFile(resolve(source, 'notes.md'), 'nope\n'), 'INVALID_SOURCE'],
    ['escaping symlink', async (source: string) => symlink('/tmp', resolve(source, 'skills', 'sample', 'escape')), 'FORBIDDEN_PATH'],
    ['missing skill entrypoint', async (source: string) => {
      await mkdir(resolve(source, 'skills', 'broken'))
    }, 'INVALID_SOURCE'],
    ['known auth path', async (source: string) => writeFile(resolve(source, 'auth.json'), '{}\n'), 'SECRET_DETECTED'],
    ['history directory', async (source: string) => mkdir(resolve(source, 'skills', 'sample', 'sessions')), 'FORBIDDEN_PATH'],
    ['Codex state database', async (source: string) => writeFile(resolve(source, 'skills', 'sample', 'state_5.sqlite'), ''), 'SECRET_DETECTED']
  ] as const)('rejects a %s', async (_name, mutate, code) => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)
    await mutate(source)

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      code
    )
  })

  it('rejects special files', async () => {
    const source = resolve(testRoot, 'source')
    const fifo = resolve(source, 'skills', 'sample', 'agent.fifo')

    await createHarnessSource(source)
    execFileSync('mkfifo', [fifo])

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      'INVALID_SOURCE'
    )
  })

  it('rejects secret content without exposing the matched value', async () => {
    const source = resolve(testRoot, 'source')
    const sentinel = `sk-${'x'.repeat(30)}`

    await createHarnessSource(source)

    await writeFile(
      resolve(source, 'skills', 'sample', 'SKILL.md'),
      `Use ${sentinel}\n`
    )

    const error = await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      'SECRET_DETECTED'
    )

    expect(error.message).not.toContain(sentinel)
    expect(error.message).toContain('[provider-token]')
  })

  it('rejects a secret-like path without exposing the matched value', async () => {
    const source = resolve(testRoot, 'source')
    const sentinel = `sk-${'p'.repeat(30)}`

    await createHarnessSource(source)

    await rename(
      resolve(source, 'skills', 'sample'),
      resolve(source, 'skills', sentinel)
    )

    const error = await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      'SECRET_DETECTED'
    )

    expect(error.message).toContain('[provider-token]')
    expect(error.message).not.toContain(sentinel)
    expect(error.path).toBeUndefined()
  })

  it.each([
    ['duplicate names', { mcp_servers: [
      {
        name: 'same',
        transport: 'stdio',
        command: 'one'
      },
      {
        name: 'same',
        transport: 'stdio',
        command: 'two'
      }
    ] }, 'INVALID_CONFIG'],
    ['auth field', { mcp_servers: [
      {
        name: 'tool',
        transport: 'stdio',
        command: 'tool',
        env: { TOKEN: 'value' }
      }
    ] }, 'INVALID_CONFIG'],
    ['credential argument', { mcp_servers: [
      {
        name: 'tool',
        transport: 'stdio',
        command: 'tool',
        args: ['--token=value']
      }
    ] }, 'SECRET_DETECTED'],
    ['plaintext environment assignment', { mcp_servers: [
      {
        name: 'tool',
        transport: 'stdio',
        command: 'env',
        args: ['API_KEY=supersecretvalue', 'tool']
      }
    ] }, 'SECRET_DETECTED'],
    ['credential URL', { mcp_servers: [
      {
        name: 'tool',
        transport: 'streamable-http',
        url: 'https://example.test/mcp?token=value'
      }
    ] }, 'SECRET_DETECTED']
  ] as const)('rejects MCP %s', async (_name, document, code) => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source, VALID_CONFIG, JSON.stringify(document))

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      code
    )
  })

  it.each([
    ['MCP table', '[mcp_servers.tool]\ncommand = "tool"\n', 'INVALID_CONFIG'],
    ['plugin state', '[plugins.sample]\nenabled = true\n', 'INVALID_CONFIG'],
    ['project state', '[projects."/tmp/project"]\ntrust_level = "trusted"\n', 'INVALID_CONFIG'],
    ['external file', 'experimental_instructions_file = "../AGENTS.md"\n', 'INVALID_CONFIG'],
    ['external notify', 'notify = ["/tmp/ambient-notify"]\n', 'INVALID_CONFIG'],
    ['auth header', '[model_providers.sample]\nhttp_headers = { Authorization = "value" }\n', 'INVALID_CONFIG'],
    ['credential URL', '[model_providers.sample]\nbase_url = "https://user:secret@example.test/v1?token=secret"\n', 'SECRET_DETECTED']
  ] as const)('rejects config with %s', async (_name, config, code) => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source, config)

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(testRoot, 'store'))),
      code
    )
  })

  it('does not allow the store to mutate the captured source', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, resolve(source, 'store'))),
      'INVALID_SOURCE'
    )
  })

  it('resolves existing symlink ancestors before checking source and store overlap', async () => {
    const source = resolve(testRoot, 'source')
    const sourceAlias = resolve(testRoot, 'source-alias')

    await createHarnessSource(source)
    await symlink(source, sourceAlias)

    await expectHarnessError(
      captureHarnessBundle(
        captureOptions(source, resolve(sourceAlias, 'store'))
      ),
      'INVALID_SOURCE'
    )
  })

  it('rejects an existing harness store that is not mode 0700', async () => {
    const source = resolve(testRoot, 'source')
    const store = resolve(testRoot, 'store')

    await createHarnessSource(source)
    await mkdir(store, { mode: 0o755 })
    await chmod(store, 0o755)

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, store)),
      'INVALID_SOURCE'
    )
  })

  it('handles a concurrent valid bundle finalization idempotently', async () => {
    const source = resolve(testRoot, 'source')
    const referenceStore = resolve(testRoot, 'reference-store')
    const targetStore = resolve(testRoot, 'target-store')

    await createHarnessSource(source)

    await writeFile(
      resolve(source, 'skills', 'sample', 'large.txt'),
      Buffer.alloc(4 * 1024 * 1024, 'x')
    )

    const reference = await captureHarnessBundle(
      captureOptions(source, referenceStore)
    )

    const capture = captureHarnessBundle(captureOptions(source, targetStore))

    await waitForStagingDirectory(targetStore)

    const targetBundle = resolve(targetStore, basename(reference.bundlePath))

    await chmod(reference.bundlePath, 0o755)
    await rename(reference.bundlePath, targetBundle)
    await chmod(targetBundle, 0o555)
    await expect(capture).resolves.toMatchObject({ bundlePath: targetBundle })

    await expect(validateHarnessBundle(targetBundle)).resolves.toMatchObject({
      manifest: { digest: reference.manifest.digest }
    })
  })
})

describe(validateHarnessBundle, () => {
  it('revalidates effective config with the pinned Codex CLI', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    await writeFakeCodex({ rejectStrictConfig: true })

    try {
      await expectHarnessError(
        validateHarnessBundle(captured.bundlePath),
        'CODEX_VALIDATION_FAILED'
      )

      await expectHarnessError(
        materializeHarnessBundle({
          bundle: captured.bundlePath,
          destination: resolve(testRoot, 'run')
        }),
        'CODEX_VALIDATION_FAILED'
      )
    } finally {
      await writeFakeCodex()
    }
  })

  it.each([
    ['bundle root', (bundle: string) => bundle, 0o500],
    ['content directory', (bundle: string) => resolve(bundle, 'content'), 0o500],
    ['manifest', (bundle: string) => resolve(bundle, 'manifest.json'), 0o400],
    ['content file', (bundle: string) => resolve(bundle, 'content', 'config.toml'), 0o500]
  ] as const)('rejects a noncanonical %s mode', async (_name, selectPath, mode) => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    await chmod(selectPath(captured.bundlePath), mode)

    await expectHarnessError(
      validateHarnessBundle(captured.bundlePath),
      'INVALID_BUNDLE'
    )
  })

  it('rejects manifest identity changes that retain the old digest and address', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    const manifestPath = resolve(captured.bundlePath, 'manifest.json')

    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as MutableHarnessManifest

    manifest.revision = 'forged-revision'

    await chmod(captured.bundlePath, 0o700)
    await chmod(manifestPath, 0o600)
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await chmod(manifestPath, 0o444)
    await chmod(captured.bundlePath, 0o555)

    await expectHarnessError(
      validateHarnessBundle(captured.bundlePath),
      'INVALID_BUNDLE'
    )
  })

  it('rejects a canonically rehashed skill tree without SKILL.md', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    await makeWritable(captured.bundlePath)

    const manifestPath = resolve(captured.bundlePath, 'manifest.json')

    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as MutableHarnessManifest

    manifest.entries = manifest.entries.filter(
      ({ path }) => path !== 'skills/sample/SKILL.md'
    )

    const preimage = {
      document_type: manifest.document_type,
      schema_version: manifest.schema_version,
      harness_id: manifest.harness_id,
      revision: manifest.revision,
      entries: manifest.entries
    }

    const hex = createHash('sha256')
      .update(JSON.stringify(preimage))
      .digest('hex')

    manifest.digest = `sha256:${hex}`

    await rm(
      resolve(captured.bundlePath, 'content', 'skills', 'sample', 'SKILL.md')
    )

    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const forgedPath = resolve(dirname(captured.bundlePath), hex)

    await rename(captured.bundlePath, forgedPath)
    await makeReadOnly(forgedPath)

    const error = await expectHarnessError(
      validateHarnessBundle(forgedPath),
      'INVALID_BUNDLE'
    )

    expect(error.message).toContain('SKILL.md')
  })

  it('rejects mutated content and refuses to overwrite it on recapture', async () => {
    const source = resolve(testRoot, 'source')
    const store = resolve(testRoot, 'store')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(captureOptions(source, store))

    const skill = resolve(
      captured.bundlePath,
      'content',
      'skills',
      'sample',
      'SKILL.md'
    )

    await chmod(skill, 0o600)
    await writeFile(skill, 'mutated\n')
    await chmod(skill, 0o444)

    await expectHarnessError(
      validateHarnessBundle(captured.bundlePath),
      'INVALID_BUNDLE'
    )

    await expectHarnessError(
      captureHarnessBundle(captureOptions(source, store)),
      'INVALID_BUNDLE'
    )

    expect(await readFile(skill, 'utf8')).toBe('mutated\n')
  })

  it('rejects an extra file and a mismatched address directory', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    const content = resolve(captured.bundlePath, 'content')

    await chmod(content, 0o755)
    await writeFile(resolve(content, 'extra.txt'), 'extra\n', { mode: 0o444 })
    await chmod(content, 0o555)

    await expectHarnessError(
      validateHarnessBundle(captured.bundlePath),
      'INVALID_BUNDLE'
    )

    await chmod(content, 0o755)
    await rm(resolve(content, 'extra.txt'))
    await chmod(content, 0o555)

    const wrongAddress = resolve(dirname(captured.bundlePath), '0'.repeat(64))

    await rename(captured.bundlePath, wrongAddress)
    await expectHarnessError(validateHarnessBundle(wrongAddress), 'INVALID_BUNDLE')
  })
})

describe(materializeHarnessBundle, () => {
  it('creates isolated fresh non-auth homes without changing the bundle', async () => {
    const source = resolve(testRoot, 'source')

    await createHarnessSource(source, VALID_CONFIG, VALID_MCP_SERVERS)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    const first = await materializeHarnessBundle({
      bundle: captured.bundlePath,
      destination: resolve(testRoot, 'first-run')
    })

    await mkdir(resolve(first.codexHome, 'sessions'))
    await writeFile(resolve(first.codexHome, 'sessions', 'fake.jsonl'), '{}\n')

    const second = await materializeHarnessBundle({
      bundle: captured.bundlePath,
      destination: resolve(testRoot, 'second-run')
    })

    const secondRootEntries = await readdir(second.codexHome)
    const configMode = (await lstat(resolve(second.codexHome, 'config.toml'))).mode
    const agentsMode = (await lstat(resolve(second.codexHome, 'AGENTS.md'))).mode

    const rulesMode = (
      await lstat(resolve(second.codexHome, 'rules', 'default.rules'))
    ).mode

    const mcpMode = (await lstat(second.mcpToolsPath)).mode

    const skillMode = (
      await lstat(resolve(second.home, '.agents', 'skills', 'sample', 'SKILL.md'))
    ).mode

    const nestedDirectoryMode = (
      await lstat(resolve(second.home, '.agents', 'skills', 'sample'))
    ).mode

    expect(secondRootEntries).not.toContain('auth.json')
    expect(secondRootEntries).not.toContain('sessions')
    expect(configMode & 0o777).toBe(0o600)
    expect(agentsMode & 0o777).toBe(0o600)
    expect(rulesMode & 0o777).toBe(0o600)
    expect(mcpMode & 0o777).toBe(0o600)
    expect(skillMode & 0o777).toBe(0o500)
    expect(nestedDirectoryMode & 0o777).toBe(0o700)
    expect(await readdir(second.workspace)).toEqual([])

    await expect(readFile(resolve(second.codexHome, 'AGENTS.md'), 'utf8')).resolves.toBe(
      'Use the sample skill.\n'
    )

    await expect(
      readFile(resolve(second.codexHome, 'rules', 'default.rules'), 'utf8')
    ).resolves.toContain('prefix_rule')

    await expect(readFile(second.mcpToolsPath, 'utf8')).resolves.toBe(
      VALID_MCP_SERVERS
    )

    await expect(
      materializeHarnessBundle({
        bundle: captured.bundlePath,
        destination: second.root
      })
    ).rejects.toMatchObject({ code: 'DESTINATION_EXISTS' })

    await expect(validateHarnessBundle(captured.bundlePath)).resolves.toMatchObject({
      manifest: { digest: captured.manifest.digest }
    })
  })

  it('never removes a destination created by a concurrent materialization', async () => {
    const source = resolve(testRoot, 'source')
    const destination = resolve(testRoot, 'run')

    await createHarnessSource(source)

    const captured = await captureHarnessBundle(
      captureOptions(source, resolve(testRoot, 'store'))
    )

    const results = await Promise.allSettled([
      materializeHarnessBundle({
        bundle: captured.bundlePath,
        destination
      }),
      materializeHarnessBundle({
        bundle: captured.bundlePath,
        destination
      })
    ])

    const fulfilled = results.filter(({ status }) => status === 'fulfilled')
    const rejected = results.filter(({ status }) => status === 'rejected')

    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    expect(rejected[0]).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'DESTINATION_EXISTS' })
    })

    await expect(readFile(resolve(destination, 'codex-home', 'config.toml'))).resolves.toBeInstanceOf(
      Buffer
    )
  })
})

describe(diffHarnessBundles, () => {
  it('reports identity, additions, removals, and modifications without contents', async () => {
    const leftSource = resolve(testRoot, 'left-source')
    const rightSource = resolve(testRoot, 'right-source')

    await createHarnessSource(leftSource)
    await createHarnessSource(rightSource)

    await writeFile(
      resolve(rightSource, 'AGENTS.override.md'),
      'Override instructions.\n'
    )

    await writeFile(
      resolve(rightSource, 'skills', 'sample', 'SKILL.md'),
      '---\nname: sample\ndescription: Different.\n---\n'
    )

    const left = await captureHarnessBundle(
      captureOptions(leftSource, resolve(testRoot, 'left-store'))
    )

    const right = await captureHarnessBundle({
      ...captureOptions(rightSource, resolve(testRoot, 'right-store')),
      harnessId: 'daily-harness-v2',
      revision: 'v2'
    })

    const difference = await diffHarnessBundles(left.bundlePath, right.bundlePath)
    const reverse = await diffHarnessBundles(right.bundlePath, left.bundlePath)
    const identical = await diffHarnessBundles(left.bundlePath, left.bundlePath)

    expect(difference.different).toBe(true)
    expect(difference.identityDifferences).toHaveLength(2)

    expect(difference.entryDifferences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'added' }),
        expect.objectContaining({ kind: 'modified' })
      ])
    )

    expect(reverse.entryDifferences).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'removed' })])
    )

    expect(identical).toMatchObject({
      different: false,
      entryDifferences: [],
      identityDifferences: []
    })
  })
})
