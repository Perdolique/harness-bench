import { lstat, readFile, readdir } from 'node:fs/promises'
import { relative, resolve } from 'node:path'

export const CREDENTIAL_PATTERN_SCANNER_REVISION = 'credential-patterns-v3'

const PROVIDER_TOKEN_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/,
  /\bAIza[A-Za-z0-9_-]{30,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/
] as const

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

function hasCredentialAssignment(source: string): boolean {
  const assignments = /(?<![\w$])(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\1\s*([:=])\s*/giu

  for (const match of source.matchAll(assignments)) {
    const valueStart = match.index + match[0].length
    const remaining = source.slice(valueStart)
    const quoted = /^(["'`])((?:\\.|(?!\1)[^\r\n\\])*)\1/u.exec(remaining)

    if (quoted !== null) {
      const value = quoted[2] ?? ''
      const suffix = remaining.slice(quoted[0].length)

      const isJsonLabel = match[1] === '"' && match[2] === 'password' &&
        match[3] === ':' && quoted[1] === '"' && value === 'Password' &&
        /^\s*(?:[,}]|$)/u.test(suffix)

      if (!isJsonLabel && value.length >= 8) return true

      continue
    }

    const bare = /^[^\s"'`,;}\]]+/u.exec(remaining)?.[0] ?? ''
    const isMemberExpression = /^[$\p{ID_Start}][$\p{ID_Continue}]*(?:\??\.[$\p{ID_Start}][$\p{ID_Continue}]*)+$/u.test(bare)
    const isCallOrType = /^[$\p{ID_Start}][$\p{ID_Continue}]*(?:\s*\(|<)/u.test(bare)
    const isEmptyValue = /^(?:undefined|null|false|true)$/u.test(bare)
    const startsExpression = /^[([{/]/u.test(bare)

    if (bare.length >= 8 && !isMemberExpression && !isCallOrType && !isEmptyValue && !startsExpression) {
      return true
    }
  }

  return false
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

  if (PROVIDER_TOKEN_PATTERNS.some((pattern) => pattern.test(source))) {
    categories.add('provider_token')
  }

  if (
    /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(
      source
    )
  ) {
    categories.add('jwt')
  }

  if (hasCredentialAssignment(source)) {
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

  const exactMatchOptions = {
    ...(options.exactBytes === undefined
      ? {}
      : { exactBytes: options.exactBytes }),

    ...(options.exactTexts === undefined
      ? {}
      : { exactTexts: options.exactTexts })
  }

  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })

    entries.sort((left, right) => compareText(left.name, right.name))

    for (const entry of entries) {
      const path = resolve(directory, entry.name)
      const metadata = await lstat(path)
      const relativePath = relative(root, path).split('\\').join('/')

      const pathFindings = scanCredentialBytes(Buffer.from(relativePath), {
        ...exactMatchOptions,
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

      const contents = await readFile(path)

      const contentFindings = scanCredentialBytes(contents, {
        ...exactMatchOptions,
        path: reportedPath
      })

      findings.push(...contentFindings)
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
