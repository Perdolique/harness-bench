import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessError } from './errors.ts'

const PINNED_CODEX_VERSION = '0.154.0'
const MAX_COMMAND_OUTPUT_BYTES = 4 * 1024 * 1024
const COMMAND_TIMEOUT_MS = 60_000

const STRICT_CONFIG_CONTROL_FIELD =
  'zzzzzzzzzzzzzzzzzzzzzzzzzzzz_harness_bench_strict_config_control'

interface CommandOutcome {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;
}

interface DoctorCheck {
  readonly status?: unknown;
}

interface DoctorDocument {
  readonly checks?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveCodexBinary(): string {
  const testBinary = process.env.HARNESS_BENCH_TEST_CODEX_BINARY

  if (process.env.NODE_ENV === 'test' && testBinary !== undefined) {
    return resolve(testBinary)
  }

  return resolve(import.meta.dirname, '../../../node_modules/.bin/codex')
}

function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  workingDirectory: string
): Promise<CommandOutcome> {
  return new Promise((resolveOutcome) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        cwd: workingDirectory,
        env: environment,
        maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
        timeout: COMMAND_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        const exitCode =
          error === null
            ? 0
            : typeof error.code === 'number'
              ? error.code
              : null

        resolveOutcome({
          exitCode,
          stderr,
          stdout
        })
      }
    )
  })
}

function safeCommandFailure(
  commandName: string,
  outcome: CommandOutcome
): HarnessError {
  const exitDescription =
    outcome.exitCode === null ? 'could not start' : `exited ${outcome.exitCode}`

  const diagnostics = new Error(
    `${commandName} ${exitDescription}\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`
  )

  return new HarnessError(
    'CODEX_VALIDATION_FAILED',
    `Pinned Codex ${commandName} validation failed`,
    {
      cause: diagnostics,
      path: 'config.toml'
    }
  )
}

function parseJsonOutput(commandName: string, outcome: CommandOutcome): unknown {
  try {
    return JSON.parse(outcome.stdout)
  } catch (error) {
    const diagnostics = new Error(
      `${commandName} emitted invalid JSON\nstdout:\n${outcome.stdout}\nstderr:\n${outcome.stderr}`,
      { cause: error }
    )

    throw new HarnessError(
      'CODEX_VALIDATION_FAILED',
      `Pinned Codex ${commandName} returned invalid JSON`,
      {
        cause: diagnostics,
        path: 'config.toml'
      }
    )
  }
}

function getConfigLoadCheck(document: unknown): DoctorCheck | undefined {
  if (!isRecord(document)) {
    return
  }

  const doctor = document as DoctorDocument

  if (!isRecord(doctor.checks)) {
    return
  }

  const dotted = doctor.checks['config.load']

  if (isRecord(dotted)) {
    return dotted
  }

  const config = doctor.checks.config

  if (isRecord(config) && isRecord(config.load)) {
    return config.load
  }
}

function isolatedEnvironment(codexHome: string, home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    CODEX_HOME: codexHome,
    HOME: home,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    NO_COLOR: '1',
    PATH: process.env.PATH,
    TERM: 'dumb',
    TMPDIR: '/tmp',
    XDG_CACHE_HOME: resolve(home, '.cache'),
    XDG_CONFIG_HOME: resolve(home, '.config'),
    XDG_DATA_HOME: resolve(home, '.local/share'),
    XDG_STATE_HOME: resolve(home, '.local/state')
  }

  return environment
}

function strictConfigControlContents(configContents: Uint8Array): Buffer {
  const control = `\n[${STRICT_CONFIG_CONTROL_FIELD}]\nenabled = true\n`
  const configBuffer = Buffer.from(configContents)
  const controlBuffer = Buffer.from(control)

  return Buffer.concat([configBuffer, controlBuffer])
}

/** Validates captured config with the selected workspace-pinned Codex CLI. */
export async function validateWithPinnedCodex(
  configContents: Uint8Array
): Promise<void> {
  const temporaryRoot = await mkdtemp('/tmp/harness-bench-codex-')
  const codexHome = resolve(temporaryRoot, 'codex-home')
  const home = resolve(temporaryRoot, 'home')
  const workspace = resolve(temporaryRoot, 'workspace')
  const binary = resolveCodexBinary()

  try {
    await mkdir(codexHome, { mode: 0o700 })
    await mkdir(home, { mode: 0o700 })
    await mkdir(workspace, { mode: 0o700 })

    await writeFile(resolve(codexHome, 'config.toml'), configContents, {
      mode: 0o600
    })

    await chmod(resolve(codexHome, 'config.toml'), 0o600)

    const environment = isolatedEnvironment(codexHome, home)

    const version = await runCommand(
      binary,
      ['--version'],
      environment,
      workspace
    )

    const escapedVersion = PINNED_CODEX_VERSION.replaceAll('.', '\\.')
    const versionPattern = new RegExp(`(?:^|\\s)${escapedVersion}(?:$|\\s)`)

    if (version.exitCode !== 0 || !versionPattern.test(version.stdout)) {
      throw safeCommandFailure('version', version)
    }

    const doctor = await runCommand(
      binary,
      ['--strict-config', 'doctor', '--json'],
      environment,
      workspace
    )

    const doctorDocument = parseJsonOutput('doctor', doctor)
    const configLoad = getConfigLoadCheck(doctorDocument)

    if (configLoad?.status !== 'ok') {
      throw safeCommandFailure('doctor', doctor)
    }

    await writeFile(
      resolve(codexHome, 'config.toml'),
      strictConfigControlContents(configContents),
      { mode: 0o600 }
    )

    const strictConfig = await runCommand(
      binary,
      [
        'exec',
        '--strict-config',
        '--skip-git-repo-check',
        '--json',
        'Provider-free config rejection control'
      ],
      environment,
      workspace
    )

    await writeFile(resolve(codexHome, 'config.toml'), configContents, {
      mode: 0o600
    })

    const strictDiagnostics = `${strictConfig.stdout}\n${strictConfig.stderr}`
    const reachedAgentExecution = strictConfig.stdout.includes('thread.started')

    const rejectedControlField = strictDiagnostics.includes(
      STRICT_CONFIG_CONTROL_FIELD
    )

    if (
      strictConfig.exitCode === 0 ||
      reachedAgentExecution ||
      !rejectedControlField
    ) {
      throw safeCommandFailure('strict config', strictConfig)
    }

    const mcpList = await runCommand(
      binary,
      ['mcp', 'list', '--json'],
      environment,
      workspace
    )

    if (mcpList.exitCode !== 0) {
      throw safeCommandFailure('mcp list', mcpList)
    }

    const mcpDocument = parseJsonOutput('mcp list', mcpList)

    if (!Array.isArray(mcpDocument) || mcpDocument.length !== 0) {
      throw new HarnessError(
        'INVALID_CONFIG',
        'config.toml must not contain MCP server declarations',
        { path: 'config.toml' }
      )
    }
  } finally {
    await rm(temporaryRoot, {
      force: true,
      recursive: true
    })
  }
}
