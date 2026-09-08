import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  providerFreeEnvironment,
  runHarborProcess,
  type HarborExecutionContext,
  type HarborExecutionOutcome
} from './run-execution.ts'

import { DoctorError } from './doctor-contracts.ts'
import { assertDoctorRelativePath } from './doctor-storage.ts'

const execFileAsync = promisify(execFile)

export const DOCTOR_HARBOR = resolve(import.meta.dirname, '../../../.venv/bin/harbor')
export const REQUIRED_AGENT_ABSENCES = ['/solution', '/tests-hidden', '/opt/verifier', '/trusted', '/root/.codex/auth.json', '/app/auth.json', '/var/run/docker.sock']

export interface DoctorRuntime {
  readonly command: (executable: string, args: readonly string[], home: string, signal?: AbortSignal) => Promise<string>;
  readonly runHarbor: (context: HarborExecutionContext) => Promise<HarborExecutionOutcome>;
  readonly now: () => Date;
}

async function command(executable: string, args: readonly string[], home: string, signal?: AbortSignal): Promise<string> {
  try {
    const result = await execFileAsync(executable, [...args], {
      cwd: home,
      env: providerFreeEnvironment(home),
      maxBuffer: 64 * 1024 * 1024,
      timeout: 600_000,
      signal
    })

    return result.stdout.trim()
  } catch (cause) {
    if (signal?.aborted) throw new DoctorError('CANCELLED', 'Doctor was cancelled during local inspection', { cause })

    throw new DoctorError('HOST_COMMAND_FAILED', 'A required local inspection could not complete', { cause })
  }
}

export const doctorRuntime: DoctorRuntime = {
  command,
  runHarbor: (context) => runHarborProcess(context, DOCTOR_HARBOR),
  now: () => new Date()
}

export function doctorForbiddenPaths(paths: readonly string[]): readonly string[] {
  for (const path of paths) {
    if (!path.startsWith('/') || path.endsWith('/')) {
      throw new DoctorError('INVALID_DEFINITION', 'Forbidden image paths must be absolute file or directory paths')
    }

    assertDoctorRelativePath(path.slice(1))
  }

  return [...new Set([...REQUIRED_AGENT_ABSENCES, ...paths])].sort()
}

/** Inspect every saved image layer, so a later whiteout cannot hide forbidden material. */
export async function inspectDoctorImageLayers(
  image: string,
  forbidden: readonly string[],
  runtime: DoctorRuntime,
  home: string
): Promise<readonly string[]> {
  const temporary = await mkdtemp('/tmp/harness-bench-doctor-layers-')

  try {
    const archive = resolve(temporary, 'agent.tar')

    await runtime.command('docker', ['image', 'save', '--output', archive, image], home)

    const manifestSource = await runtime.command('tar', ['-xOf', archive, 'manifest.json'], home)
    const manifest: unknown = JSON.parse(manifestSource)

    if (!Array.isArray(manifest) || manifest.length !== 1 || !Array.isArray(manifest[0]?.Layers) || manifest[0].Layers.length === 0) {
      throw new DoctorError('IMAGE_LAYERS_INVALID', 'Saved agent image has no exact layer inventory')
    }

    const layers: string[] = []

    for (const candidate of manifest[0].Layers) {
      if (typeof candidate !== 'string') throw new DoctorError('IMAGE_LAYERS_INVALID', 'Saved image contains an invalid layer path')

      assertDoctorRelativePath(candidate)
      await runtime.command('tar', ['-xf', archive, '-C', temporary, '--', candidate], home)

      const layerPath = resolve(temporary, candidate)
      const listing = await runtime.command('tar', ['-tf', layerPath], home)
      const names = listing.split('\n').map((name) => `/${name.replace(/^\.\//, '').replace(/\/$/, '')}`)

      for (const name of names) {
        if (forbidden.some((path) => name === path || name.startsWith(`${path}/`))) {
          throw new DoctorError('HIDDEN_IMAGE_MATERIAL', 'An agent image layer contains forbidden material')
        }
      }

      layers.push(candidate)
    }

    return layers
  } finally {
    await rm(temporary, {
      recursive: true,
      force: true
    })
  }
}

/** The trusted nop-only hook writes into Harbor's mounted agent log directory. */
export function doctorAgentProbe(baseCommit: string, forbidden: readonly string[]): string {
  const program = `
const fs = require('node:fs');
const cp = require('node:child_process');
const git = (args) => cp.execFileSync('git', ['-c', 'safe.directory=/app', '-C', '/app', ...args], {encoding:'utf8', env:{PATH:process.env.PATH, GIT_CONFIG_NOSYSTEM:'1', GIT_CONFIG_GLOBAL:'/dev/null'}}).trim();
const absent = ${JSON.stringify(forbidden)}.every((path) => !fs.existsSync(path));
const credentialNames = Object.keys(process.env).filter((name) => /^(CODEX_AUTH_JSON_PATH|CODEX_ACCESS_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY)$/.test(name));
const cleanGit = git(['rev-parse','HEAD']) === ${JSON.stringify(baseCommit)} && git(['rev-list','--count','--all']) === '1' && git(['remote']) === '' && git(['fsck','--unreachable','--no-reflogs']) === '' && !fs.existsSync('/app/.git/objects/info/alternates') && (!fs.existsSync('/app/.git/hooks') || fs.readdirSync('/app/.git/hooks').length === 0);
const manifest = JSON.parse(fs.readFileSync('/app/package.json','utf8'));
const dependencies = Object.assign({}, manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies);
const installed = Object.entries(dependencies).every(([name, version]) => JSON.parse(fs.readFileSync('/app/node_modules/'+name+'/package.json','utf8')).version === version);
const manager = cp.execFileSync('pnpm',['--version'],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:'/tmp',COREPACK_ENABLE_NETWORK:'0'}}).trim();
const dependenciesPinned = installed && manifest.packageManager === 'pnpm@'+manager;
const result = {version:1, dependencies_pinned:dependenciesPinned, hidden_material_absent:absent, credentials_absent:credentialNames.length === 0, git_isolated:cleanGit};
fs.writeFileSync('/logs/agent/doctor-probe.json', JSON.stringify(result));
if (!absent || credentialNames.length > 0 || !cleanGit || !dependenciesPinned) process.exitCode = 1;
`

  const quoted = `'${program.replaceAll('\'', '\'\\\'\'')}'`

  return `node -e ${quoted}`
}

export async function readDoctorProbe(trial: string): Promise<boolean> {
  const source = await readFile(resolve(trial, 'agent/doctor-probe.json'), 'utf8')
  const value = JSON.parse(source)

  return value.version === 1 && value.hidden_material_absent === true && value.credentials_absent === true && value.git_isolated === true && value.dependencies_pinned === true
}
