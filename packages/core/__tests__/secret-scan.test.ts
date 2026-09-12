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
  it.each([
    'hasPassword: account.hasPassword',
    'const passwordHint = "Use a long password"',
    'password: source.password',
    'password: source?.password',
    'const password = source.password',
    'password: validator.string()',
    'password: service.getSecret()',
    'const accessToken = (/#access_token=(?<value>.*)/u).exec(location.hash)',
    'interface Form { password: string; accessToken: string | null }',
    'interface Form { password: PasswordValue }',
    'interface Form { accessToken: AccessToken | null }',
    'function accept(accessToken: string) {}',
    'type Callback = (accessToken: string) => void',
    'const accessToken = await client.authenticate()',
    'password: /secret-pattern/u',
    'password: undefined',
    '"password": "Password"',
    '"password": "Password",\n"heading": "Sign in"'
  ])('ignores a non-secret expression or exact JSON label: %s', (source) => {
    const result = scanCredentialBytes(Buffer.from(source), { path: 'sample.txt' })

    expect(result).toEqual([])
  })

  it.each([
    'password=long-test-secret',
    'PASSWORD = long-test-secret',
    '"password": "long-test-secret"',
    'password: \'long-test-secret\'',
    'const password = "long-test-secret"',
    'config.password = "long-test-secret"',
    'password: "two words"',
    'password: "Password"',
    '"password" = "Password"',
    '"password": "Password123"',
    'api_key=long-test-secret',
    'accessToken: "long-test-secret"',
    'refresh-token = long-test-secret',
    'CLIENT_SECRET=long-test-secret',
    'password=12345678',
    'password=literal.with.dots!',
    'PASSWORD=correct.horse.battery.staple',
    'password=/a-very-long-secret',
    'password=longsecret<suffix',
    'const password: string = "long-test-secret"'
  ])('detects a concrete credential assignment: %s', (source) => {
    const result = scanCredentialBytes(Buffer.from(source), { path: 'sample.txt' })

    expect(result).toEqual([{
      category: 'credential_assignment',
      path: 'sample.txt'
    }])

    expect(JSON.stringify(result)).not.toContain('long-test-secret')
  })

  it('continues scanning after a safe expression and a JSON label', () => {
    const source = 'password: source.password\n"password": "Password",\napi_key="long-test-secret"'
    const result = scanCredentialBytes(Buffer.from(source), { path: 'sample.txt' })

    expect(result).toEqual([{
      category: 'credential_assignment',
      path: 'sample.txt'
    }])
  })

  it.each([
    ['private_key', '-----BEGIN PRIVATE KEY-----'],
    ['provider_token', 'sk-isolatedTestSentinel1234567890'],
    ['jwt', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJzZW50aW5lbCJ9.c2ltdWxhdGVkU2lnbmF0dXJl']
  ])('scans %s independently of assignment exclusions', (category, sentinel) => {
    const source = `"password": "Password"\nhasPassword: "${sentinel}"`
    const result = scanCredentialBytes(Buffer.from(source), { path: 'sample.txt' })

    expect(result).toContainEqual({
      category,
      path: 'sample.txt'
    })

    expect(JSON.stringify(result)).not.toContain(sentinel)
  })

  it.each([
    '"password": "Password",',
    'password: source.password'
  ])('scans exact credential bytes beside an excluded assignment: %s', (safeAssignment) => {
    const sentinel = Buffer.from('selected credential bytes')

    const contents = Buffer.concat([
      Buffer.from(`${safeAssignment}\n`),
      sentinel
    ])

    const result = scanCredentialBytes(contents, {
      exactBytes: [sentinel],
      path: 'agent/output.txt'
    })

    expect(result).toEqual([{
      category: 'exact_credential_bytes',
      path: 'agent/output.txt'
    }])

    expect(JSON.stringify(result)).not.toContain(sentinel.toString())
  })

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
