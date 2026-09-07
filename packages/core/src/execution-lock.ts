import { lstat, mkdir, rmdir, writeFile, unlink } from 'node:fs/promises'
import { resolve } from 'node:path'
import { RunError } from './run-errors.ts'

export function subscriptionLockPath(): string {
  const uid = process.getuid?.()

  if (uid === undefined) throw new RunError('HOST_UNSUPPORTED', 'Subscription locking requires a local Unix user')

  return `/tmp/harness-bench-subscription-${uid}.lock`
}

// A directory lease survives process death: stale leases require trusted recovery.
export async function acquireExecutionLock(path: string): Promise<() => Promise<void>> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (cause) {
    throw new RunError('EXECUTION_FAILED', 'Execution lock exists or cannot be acquired; inspect active processes before trusted recovery', { cause })
  }

  const ownerPath = resolve(path, 'owner.json')

  const owner = `${JSON.stringify({
    pid: process.pid,
    uid: process.getuid?.()
  })}\n`

  await writeFile(ownerPath, owner, {
    flag: 'wx',
    mode: 0o600
  })

  const identity = await lstat(path)

  return async () => {
    const current = await lstat(path)

    if (current.ino !== identity.ino || current.isSymbolicLink()) {
      throw new RunError('INVALID_EVIDENCE', 'Execution lease was replaced')
    }

    await unlink(ownerPath)
    await rmdir(path)
  }
}
