import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTrustedCapture } from './capture.ts'
import { PROTOCOL_REVISION } from './constants.ts'

async function directoryProbe(path: string) {
  if (!existsSync(path)) {
    return {
      empty: true,
      exists: false
    }
  }

  const entries = await readdir(path)

  return {
    empty: entries.length === 0,
    exists: true
  }
}

async function canaryProbe(name: string): Promise<boolean> {
  const path = join('/observed/harness-canary', name)

  if (!existsSync(path)) {
    return false
  }

  const value = await readFile(path, 'utf8')

  return value.trim() === 'ok'
}

const outputPath = '/evidence'

await createTrustedCapture({
  outputPath,
  trustedBasePath: '/trusted/base',
  workspacePath: '/workspace'
})

const status = {
  canary: {
    authReadable: await canaryProbe('auth-readable'),
    configBaseEffort: await canaryProbe('config-base-effort'),
    configChatgptOnly: await canaryProbe('config-chatgpt-only'),
    configEmptyMcp: await canaryProbe('config-empty-mcp'),
    configFileStore: await canaryProbe('config-file-store'),
    configWebSearchOff: await canaryProbe('config-web-search-off'),
    dockerSocketAbsent: await canaryProbe('docker-socket-absent'),
    hostHomeAbsent: await canaryProbe('host-home-absent'),
    sandboxBypass: await canaryProbe('sandbox-bypass'),
    skillLoaded: await canaryProbe('skill-loaded')
  },

  cleanup: {
    codexHome: await directoryProbe('/observed/codex-home'),
    codexSecrets: await directoryProbe('/observed/codex-secrets')
  },

  dockerSocketPresent: existsSync('/var/run/docker.sock'),
  phase: 'public',
  protocolRevision: PROTOCOL_REVISION,
  schemaVersion: 'spike-1'
}

const source = JSON.stringify(status, null, 2) + '\n'

await writeFile(join(outputPath, 'collector-status.json'), source, {
  encoding: 'utf8',
  mode: 0o444
})
