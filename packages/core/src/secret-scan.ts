import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export const CREDENTIAL_PATTERN_SCANNER_REVISION = 'credential-patterns-v1'

export const CREDENTIAL_PATTERN_CATEGORIES = [
  'exact_credential_bytes',
  'exact_credential_text',
  'private_key',
  'provider_token',
  'jwt',
  'credential_assignment'
] as const

export type CredentialPatternCategory =
  (typeof CREDENTIAL_PATTERN_CATEGORIES)[number]

export interface CredentialPatternFinding {
  readonly category: CredentialPatternCategory;
  readonly path: string;
}

export interface ScanCredentialBytesOptions {
  readonly exactBytes?: readonly Uint8Array[];
  readonly exactTexts?: readonly string[];
  readonly path: string;
}

export interface ScanCredentialTreeOptions {
  readonly exactBytes?: readonly Uint8Array[];
  readonly exactTexts?: readonly string[];
  readonly root: string;
}

export interface CredentialTreeScanResult {
  readonly credentialFound: boolean;
  readonly findings: readonly CredentialPatternFinding[];
  readonly invalidEntries: readonly string[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function includesBytes(contents: Buffer, value: Uint8Array): boolean {
  return value.byteLength > 0 && contents.includes(Buffer.from(value))
}

export function scanCredentialBytes(
  contents: Uint8Array,
  options: ScanCredentialBytesOptions
): readonly CredentialPatternFinding[] {
  const buffer = Buffer.from(contents)
  const source = buffer.toString('utf8')
  const categories = new Set<CredentialPatternCategory>()

  if (options.exactBytes?.some((value) => includesBytes(buffer, value))) {
    categories.add('exact_credential_bytes')
  }

  if (
    options.exactTexts?.some(
      (value) => value !== '' && source.includes(value)
    )
  ) {
    categories.add('exact_credential_text')
  }

  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(source)) {
    categories.add('private_key')
  }

  if (
    /\b(?:sk-[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/.test(
      source
    )
  ) {
    categories.add('provider_token')
  }

  if (
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(
      source
    )
  ) {
    categories.add('jwt')
  }

  if (
    /["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      source
    )
  ) {
    categories.add('credential_assignment')
  }

  return [...categories]
    .sort(compareText)
    .map((category) => ({
      category,
      path: options.path
    }))
}

export async function scanCredentialTree(
  options: ScanCredentialTreeOptions
): Promise<CredentialTreeScanResult> {
  const root = resolve(options.root)
  const findings: CredentialPatternFinding[] = []
  const invalidEntries: string[] = []

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    entries.sort((left, right) => compareText(left.name, right.name))

    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const metadata = await lstat(path)
      const relativePath = relative(root, path).split('\\').join('/')

      const pathFindings = scanCredentialBytes(Buffer.from(relativePath), {
        ...(options.exactBytes === undefined
          ? {}
          : { exactBytes: options.exactBytes }),

        ...(options.exactTexts === undefined
          ? {}
          : { exactTexts: options.exactTexts }),

        path: '[redacted-path]'
      })

      const reportedPath = pathFindings.length === 0
        ? relativePath
        : '[redacted-path]'

      findings.push(...pathFindings)

      if (
        metadata.isSymbolicLink() ||
        (!metadata.isDirectory() && !metadata.isFile())
      ) {
        invalidEntries.push(reportedPath)

        continue
      }

      if (metadata.isDirectory()) {
        await visit(path)

        continue
      }

      findings.push(
        ...scanCredentialBytes(await readFile(path), {
          ...(options.exactBytes === undefined
            ? {}
            : { exactBytes: options.exactBytes }),

          ...(options.exactTexts === undefined
            ? {}
            : { exactTexts: options.exactTexts }),

          path: reportedPath
        })
      )
    }
  }

  await visit(root)
  invalidEntries.sort(compareText)

  return {
    credentialFound: findings.length > 0,
    findings,
    invalidEntries
  }
}
