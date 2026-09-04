import { spawnSync } from "node:child_process";

import { assertExactVersion, TOOL_COMMANDS } from "./toolchain.ts";

function readCommandVersion(command: (typeof TOOL_COMMANDS)[number]): string {
  const environment = Object.assign({}, process.env, command.environment);
  const result = spawnSync(command.command, command.args, {
    encoding: "utf8",
    env: environment,
  });

  if (result.error) {
    throw new Error(
      `Could not execute ${command.tool}: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const detail = `${result.stdout}${result.stderr}`.trim();
    throw new Error(
      `${command.tool} version command exited ${result.status}: ${detail}`,
    );
  }
  return `${result.stdout}${result.stderr}`.trim();
}

assertExactVersion("node", process.version);
console.log(`node ${process.version.slice(1)}`);

for (const command of TOOL_COMMANDS) {
  const output = readCommandVersion(command);
  assertExactVersion(command.tool, output);
  console.log(`${command.tool} ${output}`);
}
