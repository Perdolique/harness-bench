export const EXPECTED_TOOLCHAIN = {
  node: '26.8.1',
  pnpm: '11.25.0',
  vp: '0.3.0',
  python: '3.14.7',
  uv: '0.12.9',
  harbor: '0.22.0',
  codex: '0.153.2'
} as const

export type ToolName = keyof typeof EXPECTED_TOOLCHAIN

export type ToolCommand = {
  readonly tool: Exclude<ToolName, 'node'>;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
}

export const TOOL_COMMANDS: readonly ToolCommand[] = [
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
]

const semanticVersionPattern =
  /(?<![0-9A-Za-z])v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?![0-9A-Za-z.+-])/g

export function extractSemanticVersion(output: string): string {
  const matches = [...output.matchAll(semanticVersionPattern)]

  if (matches.length === 0) {
    throw new Error(
      `Version output did not contain a semantic version: ${JSON.stringify(output)}`
    )
  }

  if (matches.length > 1) {
    throw new Error(
      `Version output contained multiple semantic versions: ${JSON.stringify(output)}`
    )
  }

  const version = matches[0]?.[1]

  if (!version) {
    throw new Error(
      `Version output did not contain a semantic version: ${JSON.stringify(output)}`
    )
  }

  return version
}

export function assertExactVersion(tool: ToolName, output: string): void {
  const expected = EXPECTED_TOOLCHAIN[tool]
  const versionOutput = tool === 'vp' ? output.split(/\r?\n/, 1)[0] ?? '' : output
  const actual = extractSemanticVersion(versionOutput)

  if (actual !== expected) {
    throw new Error(
      `${tool} version mismatch: expected ${expected}, received ${actual}`
    )
  }
}
