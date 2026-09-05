import { EXPECTED_ARTIFACTS } from './constants.ts'

export interface ArtifactManifestEntry {
  readonly destination: string;
  readonly service: string | null;
  readonly source: string;
  readonly status: 'empty' | 'failed' | 'ok' | 'skipped';
  readonly type: 'directory' | 'file';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseEntry(value: unknown): ArtifactManifestEntry {
  if (!isRecord(value)) {
    throw new Error('Artifact manifest entry must be an object')
  }

  const { destination, service, source, status, type } = value

  const validStatus = ['empty', 'failed', 'ok', 'skipped'].includes(
    String(status)
  )

  const validType = type === 'directory' || type === 'file'
  const validService = service === null || typeof service === 'string'

  if (
    typeof destination !== 'string' ||
    !validService ||
    typeof source !== 'string' ||
    !validStatus ||
    !validType
  ) {
    throw new Error('Artifact manifest entry has an invalid shape')
  }

  return {
    destination,
    service,
    source,
    status: status as ArtifactManifestEntry['status'],
    type
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\/$/, '')
  const normalizedRight = right.replace(/\/$/, '')

  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`) ||
    normalizedRight.startsWith(`${normalizedLeft}/`)
  )
}

export function validateArtifactManifest(
  value: unknown
): ArtifactManifestEntry[] {
  if (!Array.isArray(value)) {
    throw new Error('Artifact manifest must be a JSON array')
  }

  const entries = value.map(parseEntry)

  if (entries.length !== EXPECTED_ARTIFACTS.length) {
    throw new Error('Artifact manifest contains undeclared entries')
  }

  for (const [index, entry] of entries.entries()) {
    for (const other of entries.slice(index + 1)) {
      if (pathsOverlap(entry.destination, other.destination)) {
        throw new Error('Artifact manifest destinations overlap')
      }
    }
  }

  for (const expected of EXPECTED_ARTIFACTS) {
    const matches = entries.filter(
      (entry) =>
        entry.destination === expected.destination &&
        entry.service === expected.service &&
        entry.source === expected.source &&
        entry.status === expected.status &&
        entry.type === expected.type
    )

    if (matches.length !== 1) {
      throw new Error(
        `Artifact ${expected.source} from ${String(expected.service)} is incomplete`
      )
    }
  }

  return entries
}
