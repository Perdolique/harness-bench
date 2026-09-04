import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { REPOSITORY_ROOT } from "./constants.ts";

interface DockerPlatform {
  readonly Name: string;
}

interface DockerServer {
  readonly Arch: string;
  readonly KernelVersion: string;
  readonly Os: string;
  readonly Platform: DockerPlatform;
  readonly Version: string;
}

interface DockerClient {
  readonly Arch: string;
  readonly Context: string;
  readonly Os: string;
  readonly Version: string;
}

interface DockerVersion {
  readonly Client: DockerClient;
  readonly Server: DockerServer;
}

interface DockerInfo {
  readonly Architecture: string;
  readonly CgroupVersion: string;
  readonly KernelVersion: string;
  readonly NCPU: number;
  readonly OSType: string;
  readonly OperatingSystem: string;
  readonly ServerVersion: string;
}

interface MacHardwareProfile {
  readonly SPHardwareDataType: readonly {
    readonly chip_type: string;
    readonly machine_model: string;
    readonly machine_name: string;
  }[];
}

export interface HostIdentity {
  readonly appleChip: string;
  readonly architecture: string;
  readonly dockerArchitecture: string;
  readonly dockerCgroupVersion: string;
  readonly dockerClientVersion: string;
  readonly dockerContext: string;
  readonly dockerCpuCount: number;
  readonly dockerDesktop: string;
  readonly dockerEngineVersion: string;
  readonly dockerKernel: string;
  readonly dockerOperatingSystem: string;
  readonly hardwareModel: string;
  readonly hardwareName: string;
  readonly macosVersion: string;
  readonly operatingSystem: string;
}

export interface AuthMetadata {
  readonly createdAt: string;
  readonly directoryMode: string;
  readonly directoryPathSha256: string;
  readonly mode: string;
  readonly modifiedAt: string;
  readonly pathSha256: string;
  readonly size: number;
  readonly sourceSha256: string;
}

function command(commandName: string, args: readonly string[]): string {
  return execFileSync(commandName, [...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function isWithinRepository(path: string): boolean {
  const pathFromRoot = relative(REPOSITORY_ROOT, path);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot))
  );
}

export function assertNoAmbientProviderCredentials(
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const forbidden = ["CODEX_ACCESS_TOKEN", "OPENAI_API_KEY"];
  const present = forbidden.filter((name) => Boolean(environment[name]));
  if (present.length > 0) {
    throw new Error(
      `Ambient provider credentials are forbidden: ${present.join(", ")}`,
    );
  }
}

export async function inspectAuthFile(path: string): Promise<AuthMetadata> {
  if (!isAbsolute(path)) {
    throw new Error("CODEX_AUTH_JSON_PATH must be absolute");
  }
  const resolvedPath = resolve(path);
  if (isWithinRepository(resolvedPath)) {
    throw new Error("CODEX_AUTH_JSON_PATH must be outside the repository");
  }
  const metadata = await lstat(resolvedPath);
  const parentPath = dirname(resolvedPath);
  const parentMetadata = await lstat(parentPath);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) {
    throw new Error("CODEX_AUTH_JSON_PATH parent must be a real directory");
  }
  if ((parentMetadata.mode & 0o077) !== 0) {
    throw new Error(
      "CODEX_AUTH_JSON_PATH parent must not be accessible to group or others",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("CODEX_AUTH_JSON_PATH must name a regular file");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error(
      "CODEX_AUTH_JSON_PATH must not be accessible to group or others",
    );
  }
  const content = await readFile(resolvedPath);
  return {
    createdAt: metadata.birthtime.toISOString(),
    directoryMode: (parentMetadata.mode & 0o777).toString(8).padStart(3, "0"),
    directoryPathSha256: sha256(parentPath),
    mode: (metadata.mode & 0o777).toString(8).padStart(3, "0"),
    modifiedAt: metadata.mtime.toISOString(),
    pathSha256: sha256(resolvedPath),
    size: metadata.size,
    sourceSha256: sha256(content),
  };
}

export function assertExternalRunRoot(path: string): string {
  if (!isAbsolute(path)) {
    throw new Error("BENCH_RUN_ROOT must be absolute");
  }
  const resolvedPath = resolve(path);
  if (isWithinRepository(resolvedPath)) {
    throw new Error("BENCH_RUN_ROOT must be outside the repository");
  }
  return resolvedPath;
}

export function collectHostIdentity(): HostIdentity {
  if (platform() !== "darwin" || arch() !== "arm64") {
    throw new Error("Issue 2 requires macOS on Apple Silicon");
  }
  const dockerVersion = JSON.parse(
    command("docker", ["version", "--format", "{{json .}}"]),
  ) as DockerVersion;
  const dockerInfo = JSON.parse(
    command("docker", ["info", "--format", "{{json .}}"]),
  ) as DockerInfo;
  const hardware = JSON.parse(
    command("system_profiler", ["SPHardwareDataType", "-json"]),
  ) as MacHardwareProfile;
  const hardwareIdentity = hardware.SPHardwareDataType[0];
  if (!hardwareIdentity) {
    throw new Error("macOS hardware identity is unavailable");
  }
  if (
    dockerVersion.Server.Os !== "linux" ||
    dockerVersion.Server.Arch !== "arm64" ||
    dockerInfo.OSType !== "linux" ||
    dockerInfo.Architecture !== "aarch64"
  ) {
    throw new Error("Docker must run Linux/arm64 containers");
  }

  return {
    appleChip: hardwareIdentity.chip_type,
    architecture: command("uname", ["-m"]),
    dockerArchitecture: dockerInfo.Architecture,
    dockerCgroupVersion: dockerInfo.CgroupVersion,
    dockerClientVersion: dockerVersion.Client.Version,
    dockerContext: dockerVersion.Client.Context,
    dockerCpuCount: dockerInfo.NCPU,
    dockerDesktop: dockerVersion.Server.Platform.Name,
    dockerEngineVersion: dockerInfo.ServerVersion,
    dockerKernel: dockerInfo.KernelVersion,
    dockerOperatingSystem: dockerInfo.OperatingSystem,
    hardwareModel: hardwareIdentity.machine_model,
    hardwareName: hardwareIdentity.machine_name,
    macosVersion: command("sw_vers", ["-productVersion"]),
    operatingSystem: platform(),
  };
}
