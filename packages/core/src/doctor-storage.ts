import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { readStableRunFile, type RunTreeSnapshot } from './run.ts'
import { DoctorError } from './doctor-contracts.ts'

export function doctorDigest(value: Uint8Array | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export interface DoctorInventoryEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly executable: boolean;
  readonly size: number;
  readonly digest: string;
}

export function assertDoctorRelativePath(path: string): void {
  const parts = path.split('/')

  if (path.includes('\\') || parts.some((part) => ['', '.', '..', 'sha256-manifest.json'].includes(part))) {
    throw new DoctorError('UNSAFE_ARTIFACT_PATH', 'Evidence contains an unsafe or reserved path')
  }
}

/** Inventories every entry, including empty directories; no basename is silently skipped. */
export async function doctorInventory(root: string): Promise<DoctorInventoryEntry[]> {
  const entries: DoctorInventoryEntry[] = []

  async function visit(directory: string): Promise<void> {
    const rootMetadata = await lstat(directory)

    if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
      throw new DoctorError('UNSAFE_EVIDENCE', 'Evidence root must be a real directory')
    }

    const children = await readdir(directory)

    children.sort()

    for (const name of children) {
      const fullPath = resolve(directory, name)
      const path = relative(root, fullPath)

      assertDoctorRelativePath(path)

      const metadata = await lstat(fullPath)

      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1))) {
        throw new DoctorError('UNSAFE_EVIDENCE', 'Evidence contains a link or special file')
      }

      const directoryEntry = metadata.isDirectory()
      const contents = directoryEntry ? Buffer.alloc(0) : await readStableRunFile(fullPath)

      entries.push({
        path,
        kind: directoryEntry ? 'directory' : 'file',
        executable: !directoryEntry && (metadata.mode & 0o111) !== 0,
        size: contents.length,
        digest: doctorDigest(contents)
      })

      if (directoryEntry) await visit(fullPath)
    }
  }

  await visit(root)

  return entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
}

export async function verifyDoctorInventory(root: string, expected: readonly DoctorInventoryEntry[]): Promise<void> {
  const seen = new Set<string>()

  for (const entry of expected) {
    assertDoctorRelativePath(entry.path)

    if (seen.has(entry.path)) throw new DoctorError('INVENTORY_MISMATCH', 'Evidence manifest contains duplicate paths')

    seen.add(entry.path)
  }

  const actual = await doctorInventory(root)

  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new DoctorError('INVENTORY_MISMATCH', 'Complete evidence inventory differs from its manifest')
  }
}

export async function writeDoctorJson(path: string, value: unknown): Promise<string> {
  const contents = `${JSON.stringify(value, null, 2)}\n`

  await writeFile(path, contents, {
    flag: 'wx',
    mode: 0o600
  })

  return doctorDigest(contents)
}

export async function copyDoctorSnapshot(snapshot: RunTreeSnapshot, destination: string): Promise<void> {
  await mkdir(destination, {
    recursive: true,
    mode: 0o700
  })

  for (const entry of snapshot.entries) {
    assertDoctorRelativePath(entry.path)

    const path = resolve(destination, entry.path)
    const contents = snapshot.files.get(entry.path)

    if (contents === undefined) throw new DoctorError('INPUT_CHANGED', 'Input snapshot is incomplete')

    await mkdir(dirname(path), {
      recursive: true,
      mode: 0o700
    })

    await writeFile(path, contents, {
      flag: 'wx',
      mode: entry.executable ? 0o700 : 0o600
    })
  }
}

export async function sealDoctorTree(root: string): Promise<void> {
  const inventory = await doctorInventory(root)

  for (const entry of inventory.filter((entry) => entry.kind === 'file')) {
    await chmod(resolve(root, entry.path), entry.executable ? 0o500 : 0o400)
  }

  const directories = inventory.filter((entry) => entry.kind === 'directory')

  for (const entry of directories.reverse()) await chmod(resolve(root, entry.path), 0o500)

  await chmod(root, 0o500)
}

export async function readDoctorJson(path: string): Promise<unknown> {
  const contents = await readFile(path, 'utf8')

  return JSON.parse(contents)
}
