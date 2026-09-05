import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeRunRecord } from '../records.ts'
import { scanSecrets } from '../secret-scan.ts'

const temporaryRoots: string[] = []

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-bench-secret-test-'))

  temporaryRoots.push(root)

  return root
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await chmod(root, 0o700).catch(() => {})
      await chmod(join(root, 'harbor'), 0o700).catch(() => {})

      await rm(root, {
        force: true,
        recursive: true
      })
    })
  )
})

describe(scanSecrets, () => {
  it('reports only rule and path for dummy secret sentinels', async () => {
    const root = await createTemporaryRoot()
    const dummyKey = `sk-proj-${'A'.repeat(32)}`
    const dummyJwt = `eyJ${'a'.repeat(12)}.${'b'.repeat(12)}.${'c'.repeat(12)}`

    await writeFile(
      join(root, 'events.jsonl'),
      `${dummyKey}\nBearer ${'z'.repeat(24)}\n${dummyJwt}\n`,
      'utf8'
    )

    const findings = await scanSecrets(root)

    expect(findings).toStrictEqual([
      {
        path: 'events.jsonl',
        rule: 'bearer-token'
      },
      {
        path: 'events.jsonl',
        rule: 'jwt'
      },
      {
        path: 'events.jsonl',
        rule: 'openai-api-key'
      }
    ])

    expect(JSON.stringify(findings)).not.toContain(dummyKey)
    expect(JSON.stringify(findings)).not.toContain(dummyJwt)
  })

  it('quarantines a run before durable finalization when a secret is found', async () => {
    const root = await createTemporaryRoot()

    await writeFile(
      join(root, 'raw.log'),
      `{"refresh_token":"${'r'.repeat(32)}"}\n`,
      'utf8'
    )

    const result = await finalizeRunRecord(root)

    expect(result.finalized).toBe(false)

    expect(result.findings).toStrictEqual([
      {
        path: 'raw.log',
        rule: 'oauth-token-field'
      }
    ])
  })

  it('hashes and locks a clean run record', async () => {
    const root = await createTemporaryRoot()

    await mkdir(join(root, 'harbor'))
    await writeFile(join(root, 'run-intent.json'), '{}\n', 'utf8')
    await writeFile(join(root, 'harbor', 'result.json'), '{}\n', 'utf8')

    const result = await finalizeRunRecord(root)

    expect(result.finalized).toBe(true)

    expect(result.manifest.map((entry) => entry.path)).toStrictEqual([
      'harbor/result.json',
      'run-intent.json'
    ])
  })
})
