import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { withRunResultLocks } from '../src/storage.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp('/tmp/harness-bench-result-locks-')
})

afterEach(async () => {
  await rm(root, {
    force: true,
    recursive: true
  })
})

describe('withRunResultLocks', () => {
  it('acquires inverse input in canonical order', async () => {
    const acquired: string[] = []

    await withRunResultLocks(
      root,
      ['run-b', 'run-a'],
      async () => {
        expect(acquired).toStrictEqual(['run-a', 'run-b'])
      },
      {
        afterAcquire: async (runId) => {
          acquired.push(runId)
        }
      }
    )

    expect(acquired).toStrictEqual(['run-a', 'run-b'])
  })

  it('releases earlier locks when a later acquisition conflicts', async () => {
    const lockRoot = resolve(root, '.results/.locks')
    const laterLock = resolve(lockRoot, 'run-b.lock')

    await mkdir(lockRoot, {
      recursive: true,
      mode: 0o700
    })

    await writeFile(laterLock, 'occupied\n', { mode: 0o600 })

    await expect(
      withRunResultLocks(root, ['run-b', 'run-a'], async () => {
        throw new Error('Conflicting lock should prevent the operation')
      })
    ).rejects.toMatchObject({ code: 'RECORD_CONFLICT' })

    await expect(
      readFile(resolve(lockRoot, 'run-a.lock'))
    ).rejects.toMatchObject({ code: 'ENOENT' })

    await expect(readFile(laterLock, 'utf8')).resolves.toBe('occupied\n')
  })
})
