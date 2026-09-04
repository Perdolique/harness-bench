import { describe, expect, it } from "vitest";

import {
  assertExactVersion,
  EXPECTED_TOOLCHAIN,
  extractSemanticVersion,
  TOOL_COMMANDS,
} from "../toolchain.ts";

describe("toolchain version contract", () => {
  it("accepts every exact pinned version", () => {
    for (const [tool, version] of Object.entries(EXPECTED_TOOLCHAIN)) {
      expect(() =>
        assertExactVersion(tool as keyof typeof EXPECTED_TOOLCHAIN, version),
      ).not.toThrow();
    }
  });

  it("rejects a substituted patch version", () => {
    expect(() => assertExactVersion("node", "v26.8.0")).toThrow(
      "node version mismatch: expected 26.8.1, received 26.8.0",
    );
  });

  it("rejects output without a semantic version", () => {
    expect(() => extractSemanticVersion("version unavailable")).toThrow(
      "Version output did not contain a semantic version",
    );
  });

  it("limits Harbor and Codex verification to provider-free commands", () => {
    const harbor = TOOL_COMMANDS.find(({ tool }) => tool === "harbor");
    const codex = TOOL_COMMANDS.find(({ tool }) => tool === "codex");

    expect(harbor).toEqual({
      tool: "harbor",
      command: "uv",
      args: ["run", "harbor", "--version"],
      environment: { HARBOR_TELEMETRY: "off" },
    });
    expect(codex).toEqual({
      tool: "codex",
      command: "pnpm",
      args: ["exec", "codex", "--version"],
    });
  });
});
