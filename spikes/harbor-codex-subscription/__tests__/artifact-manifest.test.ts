import { describe, expect, it } from 'vitest'
import { validateArtifactManifest } from '../artifact-manifest.ts'

function validManifest(): unknown[] {
  return [
    {
      destination: 'artifacts/logs/artifacts',
      service: null,
      source: '/logs/artifacts',
      status: 'empty',
      type: 'directory'
    },
    {
      destination: 'artifacts/trusted-collector',
      service: 'collector',
      source: '/evidence',
      status: 'ok',
      type: 'directory'
    }
  ]
}

describe(validateArtifactManifest, () => {
  it('accepts the exact complete artifact contract', () => {
    expect(validateArtifactManifest(validManifest())).toHaveLength(2)
  })

  it.each(['failed', 'skipped', 'empty'])(
    'rejects collector status %s',
    (status) => {
      const manifest = validManifest()
      const collector = manifest[1] as Record<string, unknown>

      collector.status = status

      expect(() => validateArtifactManifest(manifest)).toThrow('is incomplete')
    }
  )

  it('rejects undeclared entries', () => {
    const manifest = validManifest()

    manifest.push({
      destination: 'artifacts/extra',
      service: null,
      source: '/extra',
      status: 'ok',
      type: 'file'
    })

    expect(() => validateArtifactManifest(manifest)).toThrow(
      'contains undeclared entries'
    )
  })

  it('rejects a changed destination or artifact type', () => {
    const changedDestination = validManifest()
    const collector = changedDestination[1] as Record<string, unknown>

    collector.destination = 'artifacts/other'

    expect(() => validateArtifactManifest(changedDestination)).toThrow(
      'is incomplete'
    )

    const changedType = validManifest()
    const typedCollector = changedType[1] as Record<string, unknown>

    typedCollector.type = 'file'

    expect(() => validateArtifactManifest(changedType)).toThrow(
      'is incomplete'
    )
  })

  it('rejects overlapping destinations', () => {
    const manifest = validManifest()
    const collector = manifest[1] as Record<string, unknown>

    collector.destination = 'artifacts/logs/artifacts/collector'

    expect(() => validateArtifactManifest(manifest)).toThrow(
      'destinations overlap'
    )
  })
})
