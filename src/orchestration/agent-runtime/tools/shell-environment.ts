import { delimiter, join } from "node:path";
import process from "node:process";

import { backgroundShellModuleRequirements } from "../../module-requirements.js";
import { AGENT_SESSION_ENV, runsThroughBun } from "../../../infra/cli-subprocess.js";
import { buildBunShims, isWindows, shellCommandInvocation, type RuntimePlatform } from "./bash-script.js";
import { foregroundCommandLifetime } from "./bash-guidance.js";
import { installSearchShims } from "./search-shims.js";
import { grantCovers, NO_CAPABILITY_ACCESS, type BashOperations, type ToolContext, type ToolResult } from "./types.js";

/** Process environment passed to launched shell commands. */
export interface ShellEnvironment {
  [name: string]: string | undefined;
}

/** Windows preserves the inherited path key's casing; POSIX only recognizes PATH. */
export function shellPathKey(env: ShellEnvironment, platform: RuntimePlatform): string {
  return isWindows(platform)
    ? Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH"
    : "PATH";
}

/** Builds the per-call command environment shared by every shell dialect
 *  (bash and exec): a full inherit of this process's environment. PATH is the
 *  login shell's PATH once this process knows it, else the process's own, with
 *  the scratchpad bin directory prefixed when the bun shim is installed and,
 *  on macOS and Linux, the search shims after it (`search-shims.ts`).
 *  Containment is the user's job (ARCH-TOOLS-039); Flywheel does not strip the
 *  shell's environment. */
export function createToolEnvironmentFactory(options: {
  readonly operations: Pick<BashOperations, "ensureDir" | "writeExecutable">;
  readonly platform: RuntimePlatform;
  readonly execPath: string;
  /** The login shell's PATH, read per call because the probe settles after
   *  the tool is built. Undefined means the process's own PATH is the base. */
  readonly loginShellPath: () => string | undefined;
}): (context: ToolContext) => Promise<ShellEnvironment> {
  const { operations, platform, execPath, loginShellPath } = options;

  // Per-scratchpad one-time setup: create the directory and, in binary mode,
  // install the `bun` and `bunx` shims. Maps scratchDir -> in-flight/settled preparation
  // (PATH prefix dir, or null when running through bun already, where no shim
  // is needed). The promise is cached before awaiting so concurrent first
  // calls (parent and subagent loops share one scratchDir) install once; a
  // rejected preparation is evicted so the next call retries.
  const preparedScratch = new Map<string, Promise<string | null>>();

  function prepareScratch(scratchDir: string): Promise<string | null> {
    let prepared = preparedScratch.get(scratchDir);
    if (!prepared) {
      prepared = (async () => {
        operations.ensureDir(scratchDir);
        if (runsThroughBun(execPath)) return null;
        const binDir = join(scratchDir, "bin");
        operations.ensureDir(binDir);
        for (const shim of buildBunShims(execPath, platform)) await operations.writeExecutable(join(binDir, shim.file), shim.text);
        return binDir;
      })();
      preparedScratch.set(scratchDir, prepared);
      prepared.catch(() => preparedScratch.delete(scratchDir));
    }
    return prepared;
  }

  // Search shims per scratchpad and base PATH, which resolves the real
  // programs: the login shell's PATH settles after the first calls.
  const preparedSearchShims = new Map<string, Promise<string | undefined>>();

  function prepareSearchShims(scratchDir: string, base: string): Promise<string | undefined> {
    const key = `${scratchDir}${delimiter}${base}`;
    let prepared = preparedSearchShims.get(key);
    if (!prepared) {
      prepared = installSearchShims(operations, scratchDir, base);
      preparedSearchShims.set(key, prepared);
      prepared.catch(() => preparedSearchShims.delete(key));
    }
    return prepared;
  }

  return async (context) => {
    const binDir = context.scratchDir ? await prepareScratch(context.scratchDir) : null;
    const env: ShellEnvironment = { ...process.env, [AGENT_SESSION_ENV]: context.sessionId ?? "unknown" };
    // Windows spells the variable "Path" (names are case-insensitive there);
    // POSIX names are case-sensitive, so only exact "PATH" is the search path.
    const pathKey = shellPathKey(env, platform);
    const base = loginShellPath() ?? env[pathKey];
    // The search rules reach Windows commands only through the search and
    // list tools (ARCH-TOOLS-052).
    const searchShims = context.scratchDir && base && !isWindows(platform) ? await prepareSearchShims(context.scratchDir, base) : undefined;
    const path = [binDir, searchShims, base].filter(Boolean).join(delimiter);
    if (path) env[pathKey] = path;
    return env;
  };
}

/** Launches one command through the host's persistent-process authority so it
 *  can outlive Flywheel. Admission is the caller's job; this only launches. */
export async function runPersistentCommand(command: string, context: ToolContext, env: ShellEnvironment, platform: RuntimePlatform): Promise<ToolResult> {
  const client = context.persistentProcesses;
  if (!client) return { content: "Persistent execution is unavailable because this runtime has no host process manager.", outcome: "error" };
  const record = await client.launch(shellCommandInvocation(platform, command), { cwd: context.executionCwd, env });
  return {
    content: `Started persistent process ${record.id}. PID: ${record.pid}. stdout: ${record.spool.stdoutPath}. stderr: ${record.spool.stderrPath}.`,
    outcome: "ok",
    details: { background: true },
  };
}

/** Admission of one detached command (ARCH-RUNTIME-068), or the model-visible refusal.
 *
 *  Foreground shell execution is core and admits nothing. This branch admits
 *  before the tool reads its environment, prepares scratch, writes a script,
 *  spawns, or registers a task, so a refusal leaves no trace. An operation
 *  whose grant already covers Background Commands continues on that grant. */
export async function refuseBackgroundCommand(context: ToolContext): Promise<string | undefined> {
  const access = context.capabilityAccess ?? NO_CAPABILITY_ACCESS;
  if (grantCovers(access.grant, backgroundShellModuleRequirements())) return undefined;
  const admission = await access.admit({ operation: "a background shell command", required: backgroundShellModuleRequirements() });
  if (admission.ok) return undefined;
  return `${admission.reason}. Run the finite command in the foreground without background=true. ${foregroundCommandLifetime(access.unattended === true)}`;
}
