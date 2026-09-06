import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanCredentialBytes, scanCredentialTree } from '../src/secret-scan.ts'

let testRoot: string

beforeEach(async () => {
  testRoot = await mkdtemp('/tmp/harness-bench-secret-scan-')
})

afterEach(async () => {
  await rm(testRoot, {
    force: true,
    recursive: true
  })
})

describe('shared credential pattern scanner', () => {
  it('returns only safe categories and relative paths', async () => {
    const sentinel = 'sk-sharedCredentialSentinel1234567890'

    await mkdir(resolve(testRoot, 'nested'))
    await writeFile(resolve(testRoot, 'nested/evidence.txt'), sentinel)

    const result = await scanCredentialTree({ root: testRoot })

    expect(result).toEqual({
      credentialFound: true,

      findings: [{
        category: 'provider_token',
        path: 'nested/evidence.txt'
      }],

      invalidEntries: []
    })

    expect(JSON.stringify(result)).not.toContain(sentinel)
  })

  it('supports exact runner-only material without returning the value', () => {
    const sentinel = Buffer.from('selected credential bytes')

    const result = scanCredentialBytes(
      Buffer.from(`prefix ${sentinel.toString()} suffix`),
      {
        exactBytes: [sentinel],
        path: 'agent/output.txt'
      }
    )

    expect(result).toEqual([{
      category: 'exact_credential_bytes',
      path: 'agent/output.txt'
    }])

    expect(JSON.stringify(result)).not.toContain(sentinel.toString())
  })

  it('reports symlinks as invalid without following them', async () => {
    await writeFile(resolve(testRoot, 'target.txt'), 'safe\n')
    await symlink('target.txt', resolve(testRoot, 'unsafe-link'))

    const result = await scanCredentialTree({ root: testRoot })

    expect(result.invalidEntries).toEqual(['unsafe-link'])
    expect(result.credentialFound).toBe(false)
  })

  it('redacts a credential-like filename while preserving its category', async () => {
    const sentinel = 'sk-pathCredentialSentinel1234567890'

    await writeFile(resolve(testRoot, sentinel), 'safe contents\n')

    const result = await scanCredentialTree({ root: testRoot })

    expect(result.findings).toEqual([{
      category: 'provider_token',
      path: '[redacted-path]'
    }])

    expect(JSON.stringify(result)).not.toContain(sentinel)
  })
})
