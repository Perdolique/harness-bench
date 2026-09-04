import { createHash } from "node:crypto";
import { chmod, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

import { scanSecrets, type SecretFinding } from "./secret-scan.ts";

export interface ContentHashEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface FinalizationResult {
  readonly findings: readonly SecretFinding[];
  readonly finalized: boolean;
  readonly manifest: readonly ContentHashEntry[];
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizedRelativePath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

async function hashDirectory(
  root: string,
  directory: string,
  hashes: ContentHashEntry[],
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (entry.name === "sha256-manifest.json") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await hashDirectory(root, path, hashes);
      continue;
    }
    if (!entry.isFile()) {
      throw new Error(`Raw record contains unsupported entry ${path}`);
    }

    const content = await readFile(path);
    hashes.push({
      path: normalizedRelativePath(root, path),
      sha256: sha256(content),
      size: content.byteLength,
    });
  }
}

async function makeReadOnly(path: string): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await makeReadOnly(child);
      await chmod(child, 0o500);
    } else if (entry.isFile()) {
      await chmod(child, 0o400);
    }
  }
}

export async function finalizeRunRecord(
  runPath: string,
): Promise<FinalizationResult> {
  const root = resolve(runPath);
  const metadata = await lstat(root);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Run record must be a real directory");
  }

  const findings = await scanSecrets(root);
  if (findings.length > 0) {
    const quarantine = {
      findings,
      reason: "suspected-secret",
      schemaVersion: "spike-1",
    };
    await writeFile(
      join(root, "quarantine.json"),
      `${JSON.stringify(quarantine, null, 2)}\n`,
      { encoding: "utf8", mode: 0o400 },
    );
    return { findings, finalized: false, manifest: [] };
  }

  const manifest: ContentHashEntry[] = [];
  await hashDirectory(root, root, manifest);
  manifest.sort((left, right) => left.path.localeCompare(right.path));
  const record = { entries: manifest, schemaVersion: "spike-1" };
  await writeFile(
    join(root, "sha256-manifest.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    { encoding: "utf8", mode: 0o400 },
  );
  await makeReadOnly(root);
  await chmod(root, 0o500);

  return { findings: [], finalized: true, manifest };
}
