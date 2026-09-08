import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { doctorDigest, writeDoctorJson } from '../../packages/core/src/doctor-storage.ts'
import { inspectHarnessBundleForRun } from '../../packages/core/src/harness.ts'

/** Synthetic content-integrity fixture, not a claim of captured/effective native configuration. */
export async function makeDoctorHarness(root: string): Promise<string> {
  const config = '# Content-only diagnostic fixture. No native client is invoked.\n'
  const tools = '{"mcp_servers":[]}\n'

  const entries = [
    {
      kind: 'codex_config',
      path: 'config.toml',
      digest: doctorDigest(config)
    },
    {
      kind: 'mcp_tools',
      path: 'mcp-tools.json',
      digest: doctorDigest(tools)
    }
  ]

  const preimage = {
    document_type: 'harness',
    schema_version: 1,
    harness_id: 'doctor-fixture',
    revision: '1',
    entries
  }

  const digest = doctorDigest(JSON.stringify(preimage))
  const path = resolve(root, digest.slice('sha256:'.length))

  await mkdir(resolve(path, 'content'), {
    recursive: true,
    mode: 0o700
  })

  await writeFile(resolve(path, 'content/config.toml'), config, {
    flag: 'wx',
    mode: 0o444
  })

  await writeFile(resolve(path, 'content/mcp-tools.json'), tools, {
    flag: 'wx',
    mode: 0o444
  })

  await writeDoctorJson(resolve(path, 'manifest.json'), {
    document_type: 'harness',
    schema_version: 1,
    harness_id: 'doctor-fixture',
    revision: '1',
    digest,
    entries
  })

  await chmod(resolve(path, 'manifest.json'), 0o444)
  await chmod(resolve(path, 'content'), 0o555)
  await chmod(path, 0o555)
  await inspectHarnessBundleForRun(path)

  return path
}
