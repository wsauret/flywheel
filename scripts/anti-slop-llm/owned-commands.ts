import { ownedCommandRunner, type OwnedCommandRunner } from "../../src/infra/owned-command.js";
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../src/infra/process-supervisor.js";

/**
 * Lends `use` a runner whose commands live in containers that a guardian owns, so a timeout ends a
 * command's whole process tree before its result settles. Every command still held when `use`
 * settles is ended, and the guardian exits, before this returns.
 */
export async function withOwnedCommands<T>(use: (run: OwnedCommandRunner) => Promise<T>): Promise<T> {
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() });
  const scope = createLauncherScope(supervisor);
  try {
    return await use(ownedCommandRunner(scope));
  } finally {
    try {
      await scope.close();
    } finally {
      await supervisor.dispose();
    }
  }
}
