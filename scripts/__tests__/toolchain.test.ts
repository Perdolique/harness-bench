import { describe, expect, it } from 'vitest'
import { assertExactVersion, EXPECTED_TOOLCHAIN, extractSemanticVersion, TOOL_COMMANDS } from '../toolchain.ts'

describe('toolchain version contract', () => {
  it('accepts every exact pinned version', () => {
    for (const [tool, version] of Object.entries(EXPECTED_TOOLCHAIN)) {
      expect(() =>
        assertExactVersion(tool as keyof typeof EXPECTED_TOOLCHAIN, version)
      ).not.toThrow()
    }
  })

  it('rejects a substituted patch version', () => {
    expect(() => assertExactVersion('node', 'v26.8.0')).toThrow(
      'node version mismatch: expected 26.8.1, received 26.8.0'
    )
  })

  it('rejects output without a semantic version', () => {
    expect(() => extractSemanticVersion('version unavailable')).toThrow(
      'Version output did not contain a semantic version'
    )
  })

  it.each(['codex-cli 0.153.2-beta.1', 'codex-cli 0.153.2+local.1'])(
    'rejects a non-stable exact version in %s',
    (output) => {
      expect(() => assertExactVersion('codex', output)).toThrow(
        'codex version mismatch: expected 0.153.2'
      )
    }
  )

  it('rejects ambiguous output containing multiple semantic versions', () => {
    const output = 'warning: expected 0.153.2; codex-cli 0.152.0'

    expect(() => extractSemanticVersion(output)).toThrow(
      'Version output contained multiple semantic versions'
    )
  })

  it('reads the vp version from its first diagnostic line', () => {
    const output = [
      'vp v0.3.0',
      'Package manager  pnpm v11.25.0',
      'Node.js          v26.8.1 (.node-version)'
    ].join('\n')

    expect(() => assertExactVersion('vp', output)).not.toThrow()
  })

  it('limits every tool verification to the pinned provider-free commands', () => {
    expect(TOOL_COMMANDS).toEqual([
      {
        tool: 'pnpm',
        command: 'pnpm',
        args: ['--version']
      },
      {
        tool: 'vp',
        command: 'vp',
        args: ['--version']
      },
      {
        tool: 'python',
        command: 'python3',
        args: ['--version']
      },
      {
        tool: 'uv',
        command: 'uv',
        args: ['--version']
      },
      {
        tool: 'harbor',
        command: 'uv',
        args: ['run', 'harbor', '--version'],
        environment: { HARBOR_TELEMETRY: 'off' }
      },
      {
        tool: 'codex',
        command: 'vp',
        args: ['exec', 'codex', '--version']
      }
    ])
  })
})
