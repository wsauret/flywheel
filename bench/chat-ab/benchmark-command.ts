import { ownedCommandRunner, type OwnedCommandRunner } from "../../src/infra/owned-command.js";
import type { LauncherScope } from "../../src/infra/process-supervisor.js";

/** Captures command output with live diagnostics. Git query stdout stays private data. */
export function benchmarkCommandRunner(scope: Pick<LauncherScope, "spawnOwned">): OwnedCommandRunner {
  return ownedCommandRunner({
    async spawnOwned(command, options) {
      const owned = await scope.spawnOwned(command, options);
      const machineOutput = command[0] === "git" &&
        ["rev-parse", "show", "ls-tree", "ls-files"].includes(gitSubcommand(command) ?? "");
      return {
        ...owned,
        stdout: machineOutput ? owned.stdout : owned.stdout?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { process.stdout.write(chunk); controller.enqueue(chunk); },
        })),
        stderr: owned.stderr?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { process.stderr.write(chunk); controller.enqueue(chunk); },
        })),
      };
    },
  });
}

/** Git's `-C <dir>` and `-c <key=value>` precede the subcommand and each take one value. */
function gitSubcommand(command: readonly string[]): string | undefined {
  let index = 1;
  while (command[index] === "-C" || command[index] === "-c") index += 2;
  return command[index];
}
