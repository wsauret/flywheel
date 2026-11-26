import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { processLoginShellPath } from "../../../../infra/environment/login-shell-path.js";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../infra/owned-command.js";


/** How long a fixture command is given. A fixture install or an archive
 *  extraction takes minutes; the guardian ends the container after this. */
const SANDBOX_COMMAND_TIMEOUT_MS = 20 * 60_000;

/** The home directory of every sandbox command, inside the sandbox it serves.
 *  It is gitignored and excluded from captured Git pathspecs, so it never
 *  reaches a baseline commit or a report. */
export const SANDBOX_HOME_DIR = ".bench-home";

/** How much output a failure file keeps: the newest bytes, where a command usually states its error. */
const FAILURE_OUTPUT_TAIL_BYTES = 64 * 1024;

/** Where one cell keeps its diagnostics: a folder in the run's local, gitignored results directory. */
export interface CellEvidence {
  readonly directory: string;
  /** The run's results directory. Error messages name evidence files relative to it. */
  readonly resultsDir: string;
}

export interface SandboxCommandOptions {
  /** Where the command runs. Not always the sandbox: a commit snapshot is
   *  archived out of the benchmarked project. */
  readonly cwd: string;
  /** The sandbox this command serves. It owns the command's home directory. */
  readonly sandboxDir: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
  /** Names the command in its failure, such as "Baseline commit". */
  readonly step?: string;
  /** Where a failure keeps its output. Without it a failure keeps nothing but its exit metadata. */
  readonly evidence?: CellEvidence | undefined;
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
 *  bun need is named here, and HOME points at a directory inside the sandbox.
 *  PATH is the person's login-shell PATH when the service has learned it, as
 *  for agent commands, because a service manager starts the service with a
 *  minimal PATH that lacks tools such as bun; until then it is the process's
 *  own PATH. */
async function sandboxCommandEnv(sandboxDir: string): Promise<SandboxCommandEnvironment> {
  const home = join(sandboxDir, SANDBOX_HOME_DIR);
  const temp = join(home, "tmp");
  await mkdir(temp, { recursive: true });
  return {
    PATH: processLoginShellPath.current() ?? process.env.PATH ?? "/usr/bin:/bin",
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
    // The `cargo` and `rustc` on PATH are usually rustup proxies, which find
    // their installed toolchains and the default one under RUSTUP_HOME, by
    // default `~/.rustup`. The sandbox HOME would hide them, so the person's
    // toolchain directory is named. It holds compilers, not credentials.
    RUSTUP_HOME: process.env.RUSTUP_HOME ?? join(homedir(), ".rustup"),
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

function outputTail(text: string) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= FAILURE_OUTPUT_TAIL_BYTES) return { text, cut: false };
  // The cut can fall inside a multibyte character; the lossy decode replaces what remains of it.
  return { text: new TextDecoder().decode(bytes.subarray(bytes.length - FAILURE_OUTPUT_TAIL_BYTES)), cut: true };
}

/** Write `failure-<step>.txt` into the cell's evidence folder and return its path, or undefined when the
 *  results volume refuses it: the file is diagnostic only and never changes the command's outcome.
 *
 *  It holds the step, the program name (the base name of argv[0], never the arguments), the exit code or the
 *  timeout, and the last 64 KB of standard error, or of standard output when standard error is empty. */
async function retainCommandFailure(evidence: CellEvidence, step: string, command: readonly string[], result: OwnedCommandResult): Promise<string | undefined> {
  const file = join(evidence.directory, `failure-${step.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.txt`);
  const stream = result.stderr.length > 0 ? "stderr" : "stdout";
  const tail = outputTail(result[stream]);
  const retainedOnlyHead = stream === "stderr" ? result.stderrTruncated : result.stdoutTruncated;
  try {
    await mkdir(evidence.directory, { recursive: true });
    await Bun.write(file, [
      `step: ${step}`,
      `program: ${basename(command[0] ?? "")}`,
      `result: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}`,
      `${stream} (${tail.cut ? "last 64 KB" : "complete"}${retainedOnlyHead ? " of the first 1 MB; later output was not retained" : ""}):`,
      tail.text,
    ].join("\n"));
    return file;
  } catch {
    return undefined;
  }
}

/** Throw when a sandbox command failed or timed out.
 *
 * The error names the step, the exit code or the timeout, and, when `evidence` is given, the failure file
 * relative to the results directory. Fixture output and argv are untrusted text that can hold secrets, so
 * neither enters the error, which logs and persisted records carry; the output stays in the local file. */
export async function requireSandboxSuccess(
  command: readonly string[],
  result: OwnedCommandResult,
  options: Pick<SandboxCommandOptions, "step" | "evidence">,
): Promise<void> {
  if (result.exitCode === 0 && !result.timedOut) return;
  const step = options.step ?? "Sandbox command";
  const file = options.evidence ? await retainCommandFailure(options.evidence, step, command, result) : undefined;
  const location = options.evidence && file ? `; evidence: ${relative(options.evidence.resultsDir, file)}` : "";
  throw new Error(`${step} failed: ${result.timedOut ? "timed out" : `exit code ${result.exitCode}`}${location}`);
}

/** Run one benchmark sandbox command and require it to succeed with complete output (see requireSandboxSuccess). */
export async function runCheckedSandboxCommand(
  run: OwnedCommandRunner,
  command: readonly string[],
  options: SandboxCommandOptions,
): Promise<string> {
  const result = await runSandboxCommand(run, command, options);
  await requireSandboxSuccess(command, result, options);
  return requireCompleteSandboxOutput(options.step ?? "Sandbox command", result).stdout;
}

/** Initialize the Git repository of a sandbox. Its commits never start Git's detached background maintenance:
 *  that process repacks loose objects and deletes them after the commit returned, and when it races the removal
 *  of the sandbox, the recursive remove stops early with no error and leaves most of the tree behind. */
export async function initSandboxRepository(run: OwnedCommandRunner, options: SandboxCommandOptions): Promise<void> {
  await runCheckedSandboxCommand(run, ["git", "init", "-q"], options);
  await runCheckedSandboxCommand(run, ["git", "config", "maintenance.auto", "false"], options);
}
