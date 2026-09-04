import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertExternalRunRoot,
  assertNoAmbientProviderCredentials,
  inspectAuthFile,
} from "../host.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("subscription preflight inputs", () => {
  it("rejects ambient provider credentials", () => {
    expect(() =>
      assertNoAmbientProviderCredentials({ OPENAI_API_KEY: "dummy" }),
    ).toThrow(/Ambient provider credentials/);
    expect(() => assertNoAmbientProviderCredentials({})).not.toThrow();
  });

  it("accepts only a private regular external auth file", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-2-auth-test-"));
    temporaryPaths.push(root);
    const authPath = join(root, "auth.json");
    await writeFile(authPath, "{}\n", { mode: 0o600 });

    await expect(inspectAuthFile(authPath)).resolves.toMatchObject({
      mode: "600",
      size: 3,
    });
    await chmod(authPath, 0o644);
    await expect(inspectAuthFile(authPath)).rejects.toThrow(/group or others/);
    await chmod(authPath, 0o600);
    await chmod(root, 0o755);
    await expect(inspectAuthFile(authPath)).rejects.toThrow(/parent/);
  });

  it("rejects relative and repository run roots", () => {
    expect(() => assertExternalRunRoot("relative")).toThrow(/absolute/);
    expect(() => assertExternalRunRoot(process.cwd())).toThrow(
      /outside the repository/,
    );
  });
});
