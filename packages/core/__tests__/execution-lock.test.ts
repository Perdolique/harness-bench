import * as fs from 'node:fs/promises'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireExecutionLock } from '../src/execution-lock.ts'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()

  return {
    ...original,
    lstat: vi.fn(original.lstat),
    writeFile: vi.fn(original.writeFile)
  }
})

const roots: string[] = []

afterEach(async () => {
  vi.mocked(fs.lstat).mockReset()
  vi.mocked(fs.writeFile).mockReset()

  for (const path of roots.splice(0)) await fs.rm(path, {
    recursive: true,
    force: true
  })
})

describe('execution lease initialization', () => {
  it.each(['owner write', 'directory stat', 'partial owner write'])('rolls back a failed %s and permits the next acquisition', async (stage) => {
    const root = await fs.mkdtemp('/tmp/execution-lock-test-')

    roots.push(root)

    const path = resolve(root, 'lease')
    const failure = Object.assign(new Error(`Injected ${stage} failure`), { code: 'EIO' })

    if (stage === 'directory stat') vi.mocked(fs.lstat).mockRejectedValueOnce(failure)
    else if (stage === 'owner write') vi.mocked(fs.writeFile).mockRejectedValueOnce(failure)
    else {
      const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

      vi.mocked(fs.writeFile).mockImplementationOnce(async (file, _bytes, options) => {
        await original.writeFile(file, 'partial', options)

        throw failure
      })
    }

    await expect(acquireExecutionLock(path)).rejects.toBe(failure)
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })

    const release = await acquireExecutionLock(path)
    const ownerPath = resolve(path, 'owner.json')
    const ownerBytes = await fs.readFile(ownerPath, 'utf8')
    const owner = JSON.parse(ownerBytes)

    expect(owner.pid).toBe(process.pid)
    await expect(acquireExecutionLock(path)).rejects.toMatchObject({ code: 'EXECUTION_FAILED' })
    await release()
    await expect(fs.lstat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not remove a replacement lease after owner initialization fails', async () => {
    const root = await fs.mkdtemp('/tmp/execution-lock-replaced-')

    roots.push(root)

    const path = resolve(root, 'lease')
    const moved = resolve(root, 'original')
    const ownerPath = resolve(path, 'owner.json')
    const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

    vi.mocked(fs.writeFile).mockImplementationOnce(async () => {
      await fs.rename(path, moved)
      await fs.mkdir(path, { mode: 0o700 })
      await original.writeFile(ownerPath, 'replacement', { mode: 0o600 })

      throw new Error('Injected replacement during setup')
    })

    await expect(acquireExecutionLock(path)).rejects.toMatchObject({ code: 'EXECUTION_FAILED' })
    await expect(fs.readFile(ownerPath, 'utf8')).resolves.toBe('replacement')
  })
})
