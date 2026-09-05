import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { PROTOCOL_REVISION, GOST_IMAGE, IMAGE_NAMES, NODE_IMAGE, REPOSITORY_ROOT, SPIKE_ROOT } from './constants.ts'

interface DockerImageInspection {
  readonly Architecture: string;
  readonly Id: string;
  readonly Os: string;
  readonly RepoDigests: readonly string[] | null;
  readonly RepoTags: readonly string[] | null;
}

export interface ImageIdentity {
  readonly architecture: string;
  readonly id: string;
  readonly name: string;
  readonly operatingSystem: string;
  readonly repositoryDigests: readonly string[];
}

export interface ImageLock {
  readonly baseImages: {
    readonly gost: string;
    readonly node: string;
  };
  readonly images: readonly ImageIdentity[];
  readonly schemaVersion: 'spike-1';
  readonly protocolRevision: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function runDocker(args: readonly string[]): string {
  return execFileSync('docker', [...args], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit']
  }).trim()
}

function buildImage(name: string, dockerfile: string, context: string): void {
  runDocker([
    'buildx',
    'build',
    '--platform',
    'linux/arm64',
    '--load',
    '--tag',
    name,
    '--file',
    dockerfile,
    context
  ])
}

export function inspectImage(name: string): ImageIdentity {
  const source = runDocker(['image', 'inspect', name])
  const inspections = JSON.parse(source) as DockerImageInspection[]
  const inspection = inspections[0]

  if (!inspection) {
    throw new Error(`Docker image ${name} is unavailable`)
  }

  if (inspection.Os !== 'linux' || inspection.Architecture !== 'arm64') {
    throw new Error(`Docker image ${name} is not linux/arm64`)
  }

  return {
    architecture: inspection.Architecture,
    id: inspection.Id,
    name,
    operatingSystem: inspection.Os,
    repositoryDigests: inspection.RepoDigests ?? []
  }
}

export async function buildAndLockImages(lockPath: string): Promise<ImageLock> {
  buildImage(
    IMAGE_NAMES.agent,
    join(SPIKE_ROOT, 'images', 'agent.Dockerfile'),
    SPIKE_ROOT
  )

  buildImage(
    IMAGE_NAMES.collector,
    join(SPIKE_ROOT, 'images', 'collector.Dockerfile'),
    SPIKE_ROOT
  )

  buildImage(
    IMAGE_NAMES.verifier,
    join(SPIKE_ROOT, 'images', 'verifier.Dockerfile'),
    SPIKE_ROOT
  )

  const egressContext = join(
    REPOSITORY_ROOT,
    '.venv',
    'lib',
    'python3.14',
    'site-packages',
    'harbor',
    'environments',
    'docker',
    'harbor-docker-egress-control-sidecar'
  )

  buildImage(
    IMAGE_NAMES.egress,
    join(SPIKE_ROOT, 'images', 'egress.Dockerfile'),
    egressContext
  )

  const images = Object.values(IMAGE_NAMES).map(inspectImage)

  const lock: ImageLock = {
    baseImages: {
      gost: GOST_IMAGE,
      node: NODE_IMAGE
    },

    images,
    schemaVersion: 'spike-1',
    protocolRevision: PROTOCOL_REVISION
  }

  await mkdir(dirname(lockPath), {
    mode: 0o700,
    recursive: true
  })

  try {
    const existing = JSON.parse(await readFile(lockPath, 'utf8')) as ImageLock

    if (JSON.stringify(existing) !== JSON.stringify(lock)) {
      throw new Error(
        'Docker image identity changed after the lock was written'
      )
    }

    return existing
  } catch (error) {
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error
    }
  }

  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o400
  })

  return lock
}

export async function verifyImageLock(lockPath: string): Promise<ImageLock> {
  const source = await readFile(lockPath, 'utf8')
  const lock = JSON.parse(source) as ImageLock
  const currentImages = Object.values(IMAGE_NAMES).map(inspectImage)

  const expectedBaseImages = {
    gost: GOST_IMAGE,
    node: NODE_IMAGE
  }

  if (
    lock.schemaVersion !== 'spike-1' ||
    lock.protocolRevision !== PROTOCOL_REVISION ||
    JSON.stringify(lock.baseImages) !== JSON.stringify(expectedBaseImages) ||
    JSON.stringify(lock.images) !== JSON.stringify(currentImages)
  ) {
    throw new Error('Docker image identity changed after preflight')
  }

  return lock
}
