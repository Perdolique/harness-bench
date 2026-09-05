import { readFile, readdir } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

export interface SecretFinding {
  readonly path: string;
  readonly rule: string;
}

interface SecretRule {
  readonly name: string;
  readonly pattern: RegExp;
}

const rules: readonly SecretRule[] = [
  {
    name: 'openai-api-key',
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/
  },
  {
    name: 'bearer-token',
    pattern: /\bBearer\s+[A-Za-z0-9._~-]{16,}\b/i
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/
  },
  {
    name: 'oauth-token-field',
    pattern: /["'](?:access_token|refresh_token)["']\s*:/i
  }
]

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

async function scanDirectory(
  root: string,
  directory: string,
  findings: SecretFinding[]
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })

  for (const entry of entries) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      await scanDirectory(root, path, findings)

      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const content = await readFile(path)
    const text = content.toString('utf8')

    for (const rule of rules) {
      if (rule.pattern.test(text)) {
        findings.push({
          path: normalizedRelativePath(root, path),
          rule: rule.name
        })
      }
    }
  }
}

export async function scanSecrets(rootPath: string): Promise<SecretFinding[]> {
  const root = resolve(rootPath)
  const findings: SecretFinding[] = []

  await scanDirectory(root, root, findings)

  findings.sort((left, right) => {
    const pathOrder = left.path.localeCompare(right.path)

    return pathOrder === 0 ? left.rule.localeCompare(right.rule) : pathOrder
  })

  return findings
}
