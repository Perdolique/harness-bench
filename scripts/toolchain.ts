export const EXPECTED_TOOLCHAIN = {
  node: "26.8.1",
  pnpm: "11.25.0",
  python: "3.14.7",
  uv: "0.12.9",
  harbor: "0.22.0",
  codex: "0.153.2",
} as const;

export type ToolName = keyof typeof EXPECTED_TOOLCHAIN;

export type ToolCommand = {
  readonly tool: Exclude<ToolName, "node">;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
};

export const TOOL_COMMANDS: readonly ToolCommand[] = [
  { tool: "pnpm", command: "pnpm", args: ["--version"] },
  { tool: "python", command: "python3", args: ["--version"] },
  { tool: "uv", command: "uv", args: ["--version"] },
  {
    tool: "harbor",
    command: "uv",
    args: ["run", "harbor", "--version"],
    environment: { HARBOR_TELEMETRY: "off" },
  },
  { tool: "codex", command: "pnpm", args: ["exec", "codex", "--version"] },
];

export function extractSemanticVersion(output: string): string {
  const match = output.match(/\d+\.\d+\.\d+\b/);
  if (!match) {
    throw new Error(
      `Version output did not contain a semantic version: ${JSON.stringify(output)}`,
    );
  }
  return match[0];
}

export function assertExactVersion(tool: ToolName, output: string): void {
  const expected = EXPECTED_TOOLCHAIN[tool];
  const actual = extractSemanticVersion(output);
  if (actual !== expected) {
    throw new Error(
      `${tool} version mismatch: expected ${expected}, received ${actual}`,
    );
  }
}
