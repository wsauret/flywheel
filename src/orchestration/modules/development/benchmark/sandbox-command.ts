import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../infra/owned-command.js";


/** How long a fixture command is given. A fixture install or an archive
 *  extraction takes minutes; the guardian ends the container after this. */
const SANDBOX_COMMAND_TIMEOUT_MS = 20 * 60_000;

/** The home directory of every sandbox command, inside the sandbox it serves.
 *  It is gitignored and excluded from captured Git pathspecs, so it never
 *  reaches a baseline commit or a report. */
export const SANDBOX_HOME_DIR = ".bench-home";

export interface SandboxCommandOptions {
  /** Where the command runs. Not always the sandbox: a commit snapshot is
   *  archived out of the benchmarked project. */
  readonly cwd: string;
  /** The sandbox this command serves. It owns the command's home directory. */
  readonly sandboxDir: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}

interface SandboxCommandEnvironment {
  [name: string]: string;
}

/** The whole environment of one sandbox command.
 *
 *  It is built rather than inherited. Flywheel's own environment carries
 *  provider API keys, OAuth tokens and the account home that holds more of
 *  both, and none of that is a benchmark fixture's to read: a fixture is
 *  untrusted work whose commands run as the operator. So only what git, tar and
 *  bun need is named here, and HOME points at a directory inside the sandbox. */
async function sandboxCommandEnv(sandboxDir: string): Promise<SandboxCommandEnvironment> {
  const home = join(sandboxDir, SANDBOX_HOME_DIR);
  const temp = join(home, "tmp");
  await mkdir(temp, { recursive: true });
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    TMPDIR: temp,
    // Adapter imports must not mutate the fixture tree and change its resume identity.
    PYTHONDONTWRITEBYTECODE: "1",
    // Deterministic command output, and no locale data read from the account home.
    LANG: "C",
    LC_ALL: "C",
    // git reads its configuration and its credential helpers out of HOME and
    // out of the system config. Both are named inside the sandbox so a fixture
    // command sees neither, and no prompt can ask for a credential.
    GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
    GIT_CONFIG_SYSTEM: join(home, "gitconfig-system"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

/** Run one benchmark sandbox command in that environment. */
export async function runSandboxCommand(
  run: OwnedCommandRunner,
  command: readonly string[],
  options: SandboxCommandOptions,
): Promise<OwnedCommandResult> {
  return await run(command, {
    cwd: options.cwd,
    env: await sandboxCommandEnv(options.sandboxDir),
    timeoutMs: options.timeoutMs ?? SANDBOX_COMMAND_TIMEOUT_MS,
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
}

/** Refuse command output that cannot support complete evidence capture. */
export function requireCompleteSandboxOutput(label: string, result: OwnedCommandResult): OwnedCommandResult {
  if (result.stdoutTruncated || result.stderrTruncated) throw new Error(`${label} output was truncated`);
  return result;
}

/** Run one benchmark sandbox command and require it to succeed.
 *
 * The failure carries exit metadata only. Fixture output and argv are untrusted
 * text and can contain secrets, so neither enters logs or persisted errors. */
export async function runCheckedSandboxCommand(
  run: OwnedCommandRunner,
  command: readonly string[],
  options: SandboxCommandOptions,
): Promise<string> {
  const result = await runSandboxCommand(run, command, options);
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error(`Sandbox command failed in ${options.cwd}: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`);
  }
  return requireCompleteSandboxOutput("Sandbox command", result).stdout;
}
