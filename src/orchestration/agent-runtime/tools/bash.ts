import { Schema } from "effect";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MutationDiffSchema } from "../../../infra/mutation-diff.js";
import { MutationEvidenceSchema } from "../../../infra/mutation-evidence-schema.js";
import { NotAppliedFilesSchema } from "../../../infra/not-applied-files.js";
import { Log } from "../../../infra/log.js";
import { processLoginShellPath } from "../../../infra/login-shell-path.js";
import { SCRATCH_MUTATIONS_DIR } from "../../../infra/paths.js";
import { interceptBashCommand, type BashPolicyOptions } from "./bash-command-policy.js";
import { recordShellFileReads } from "./bash-file-reads.js";
import { classifyShellDetachment } from "./bash-parser.js";
import { BASH_INPUT_SCHEMA, bashPromptFields, type FileEditToolName } from "./bash-guidance.js";
import { resolveToolPath, sessionPathInput } from "./tool-paths.js";
import { checkNumericRange } from "./numeric-input.js";
import type { BashOperations, RuntimeTool, RuntimeToolInput, ShellCommand, ToolAdmissionContext, ToolContext, ToolResult } from "./types.js";
import type { RuntimePlatform } from "./bash-script.js";
import { createBackgroundWorkRegistry } from "../background-work.js";
import { createShellRuntime, DEFAULT_TOTAL_YIELD_MS } from "./shell-runtime.js";
import { DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS, POST_EXIT_DRAIN_GRACE_MS } from "./shell-execution.js";
import { createToolEnvironmentFactory, refuseBackgroundCommand, runPersistentCommand } from "./shell-environment.js";
import { runInPrivateCopy, type MutationExecution } from "./bash-project-mutation.js";



interface BashInput {
  [key: string]: unknown;
}

const log = Log.create({ service: "agent-bash" });

const DEFAULT_TIMEOUT_SEC = 120;
const MAX_TIMEOUT_SEC = 3600;

/** Structured execution evidence carried on current Bash results. */
const SynchronousBashResultDetailsSchema = Schema.Struct({
  background: Schema.Literal(false),
  exitCode: Schema.Number,
  durationMs: Schema.Number,
  /** What a mutating command published to the project; absent for every other command. */
  mutation: Schema.optionalKey(MutationDiffSchema),
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  /** Files a mutating command landed with conflict markers where the project changed the same lines. */
  conflictMarkers: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Read-only history: files an earlier mutates command refused to publish. No producer writes it (see `withLegacyRefusals`). */
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Changes a mutating command made that Flywheel kept out of the project because the project also changed the file. */
  notApplied: Schema.optionalKey(NotAppliedFilesSchema),
});
/** Why a held command left its tool call while it still ran. A record written
 *  before a planned replacement could move a command (`replacement`) carries
 *  one of the other two values and parses unchanged. */
const BashReleaseReasonSchema = Schema.Literals(["runtime_cap", "user_detach", "replacement"]);
const ManagedBashResultDetailsSchema = Schema.Struct({
  background: Schema.Literal(true),
  releaseReason: BashReleaseReasonSchema,
  durationMs: Schema.Number,
});
const ExplicitBackgroundBashResultDetailsSchema = Schema.Struct({
  background: Schema.Literal(true),
});
const RetiredSynchronousBashResultDetailsSchema = Schema.Struct({
  exitCode: Schema.Number,
  durationMs: Schema.optionalKey(Schema.Number),
  background: Schema.optionalKey(Schema.Literal(false)),
});
const RetiredBackgroundBashResultDetailsSchema = Schema.Struct({
  background: Schema.Literal(true),
  durationMs: Schema.optionalKey(Schema.Number),
});
const HistoricalBashResultDetailsSchema = Schema.Union([
  SynchronousBashResultDetailsSchema,
  ManagedBashResultDetailsSchema,
  ExplicitBackgroundBashResultDetailsSchema,
  RetiredSynchronousBashResultDetailsSchema,
  RetiredBackgroundBashResultDetailsSchema,
]);

const HistoricalBashResultDetailsProjectionSchema = Schema.Struct({
  exitCode: Schema.optionalKey(Schema.Number),
  durationMs: Schema.optionalKey(Schema.Number),
  background: Schema.optionalKey(Schema.Boolean),
  releaseReason: Schema.optionalKey(BashReleaseReasonSchema),
});
type HistoricalBashResultDetails = typeof HistoricalBashResultDetailsProjectionSchema.Type;

export function parseBashResultDetails(value: unknown): HistoricalBashResultDetails {
  if (typeof value === "object" && value !== null && Object.keys(value).length === 0) return {};
  const parsed = Schema.decodeUnknownSync(HistoricalBashResultDetailsSchema, { onExcessProperty: "error" })(value);
  return {
    ...("exitCode" in parsed ? { exitCode: parsed.exitCode } : {}),
    ...("durationMs" in parsed ? { durationMs: parsed.durationMs } : {}),
    ...("background" in parsed ? { background: parsed.background } : {}),
    ...("releaseReason" in parsed ? { releaseReason: parsed.releaseReason } : {}),
  };
}

/** The line that ends a completed foreground shell command result in an
 *  attempt whose handoff check reads command evidence. The model copies this id into the
 *  handoff's command records, and the check finds the call by it. Empty for every other call. */
function handoffCommandCitation(context: ToolContext, details: unknown): string {
  return context.handoff?.readCommandEvidence && context.toolUseId && parseBashResultDetails(details ?? {}).exitCode !== undefined
    ? `\n\n[toolUseId: ${context.toolUseId}]`
    : "";
}

const defaultBashOperations: BashOperations = {
  writeScript: (path, content) => Bun.write(path, content),
  deleteScript: (path) => Bun.file(path).delete(),
  ensureDir: (path) => { mkdirSync(path, { recursive: true }); },
  writeExecutable: async (path, content) => {
    await Bun.write(path, content);
    chmodSync(path, 0o755);
  },
};




/** The shell policy's view of one call that runs in `cwd`. The command
 *  inherits this process's environment (`createToolEnvironmentFactory`), so
 *  its variables expand the same way here. */
function shellPolicyOptions(context: ToolContext, cwd: string, platform: RuntimePlatform, readOnly = false): BashPolicyOptions {
  return {
    effectiveBundledSkillIds: context.effectiveBundledSkillIds,
    scope: { projectRoot: context.projectRoot, userDataRoot: context.userDataRoot, cwd, scratchDir: context.scratchDir, env: process.env, dialect: platform === "win32" ? "powershell" : "bash", readOnly },
    ids: { sessionId: context.sessionId, toolUseId: context.toolUseId, modelRequestId: context.modelRequestId },
  };
}

/** The refusal of an input that the bash schema advertises to every agent of a
 *  chat tree but that this agent cannot use now (ARCH-CONTEXT-018). */
function unavailableInput(input: "background" | "persist_after_exit"): ToolResult {
  return { content: `The ${input} input of bash is unavailable to this agent now. Do not send it again.`, outcome: "error" };
}

export function createBashDefinition(options?: {
  operations?: BashOperations;
  platform?: RuntimePlatform;
  tmpDir?: string;
  executionOutputThrottleMs?: number;
  execPath?: string;
  postExitDrainGraceMs?: number;
  totalYieldMs?: number;
  backgroundCommands?: boolean;
  persistentProcesses?: boolean;
  /** The file edit tool this request offers, so the shell prompt names it. */
  fileEditTool?: FileEditToolName;
  backgroundTasks?: ToolContext["backgroundTasks"];
  foregroundBashHold?: ToolContext["foregroundBashHold"];
  requireManagedExecution?: boolean;
  /** The login shell PATH source; this process's probe result by default. */
  loginShellPath?: () => string | undefined;
  /** A read-only persona admits recognized writes only in its scratchpad
   * or to device sinks, and refuses `mutates: true`. */
  readOnly?: boolean;
}): RuntimeTool {
  const ops = options?.operations ?? defaultBashOperations;
  const platform = options?.platform ?? process.platform;
  const tempDir = options?.tmpDir ?? tmpdir();
  const execPath = options?.execPath ?? process.execPath;
  const executionOutputThrottleMs = options?.executionOutputThrottleMs
    ?? DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS;
  const postExitDrainGraceMs = options?.postExitDrainGraceMs ?? POST_EXIT_DRAIN_GRACE_MS;
  const totalYieldMs = options?.totalYieldMs ?? DEFAULT_TOTAL_YIELD_MS;
  const backgroundCommands = options?.backgroundCommands ?? true;
  const persistentProcesses = options?.persistentProcesses ?? false;
  const requireManagedExecution = options?.requireManagedExecution ?? false;
  const readOnly = options?.readOnly === true;

  const toolEnvironment = createToolEnvironmentFactory({
    operations: ops, platform, execPath,
    loginShellPath: options?.loginShellPath ?? (() => processLoginShellPath.current()),
  });


  async function runCommandInner(command: string, background: boolean, persistence: "required" | "when-admitted" | false, context: ToolContext, timeoutSec: number | undefined, raw: boolean, mutates: boolean): Promise<ToolResult> {
    if (context.signal?.aborted) {
      return { content: "The bash invocation was aborted before it started. The signal was already triggered; likely the user interrupted the previous turn. Wait for the user's next instruction before retrying.", outcome: "interrupted" };
    }

    const timeout = timeoutSec ?? DEFAULT_TIMEOUT_SEC;


    // Detachment and persistence admission happen before environment, scratch,
    // script, spool, log, launch, registry, or success-audit effects.
    const detachment = classifyShellDetachment(command, background);
    if (detachment !== "none") {
      return {
        content: "Shell-level backgrounding was not executed.\nSubmit only the server or service command with background=true. After it starts as a managed process, use the process tool for lifecycle operations.",
        outcome: "error",
      };
    }
    if (persistence) {
      let admitted = false;
      try {
        admitted = await context.admitPersistentProcess?.() === true;
      } catch {
        admitted = false;
      }
      if (admitted) {
        const env = await toolEnvironment(context);
        return runPersistentCommand(command, context, env, platform);
      }
      if (persistence === "required") {
        return {
          content: "Persistent execution is disabled. Enable allow_persistent_processes or start the runtime with --allow-persistent-processes.",
          outcome: "error",
        };
      }
    }
    const spawnOwned = context.spawnOwned;
    if (!spawnOwned) {
      log.error("bash was called without a process-ownership context");
      return { content: "bash cannot run here: this runtime has no process-ownership context, so no command can be launched. Report this as an infrastructure failure.", outcome: "error" };
    }
    if (background && context.backgroundTasks === undefined) {
      return {
        content: "Background execution is unavailable because this runtime has no session process registry. Run the command in the foreground without background=true.",
        outcome: "error",
      };
    }
    if (background) {
      const refusal = await refuseBackgroundCommand(context);
      if (refusal) return { content: refusal, outcome: "error" };
    }

    // A context that can take a command out of its tool call holds every
    // foreground command for its whole run, so Detach and a planned
    // replacement's move to the background reach it whatever its deadline.
    // The runtime cap runs only when the deadline leaves room for it.
    const held = !background
      && context.backgroundTasks !== undefined
      && context.foregroundBashHold !== undefined;
    const deadlineAllowsYield = timeoutSec === undefined || timeoutSec * 1000 > totalYieldMs;

    const env = await toolEnvironment(context);
    const execution = {
      command,
      context,
      spawnOwned,
      env,
      operations: ops,
      platform,
      tempDir,
      executionOutputThrottleMs,
      rawOutput: raw,
    };
    const shell = context.shell ?? createShellRuntime(context.backgroundTasks ?? createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
    })).client;
    const launch = (isolated?: MutationExecution): Promise<ToolResult> => background || held
      ? shell.runBackground({
          ...execution,
          ...isolated,
          foreground: held,
          postExitDrainGraceMs,
          ...(held && deadlineAllowsYield ? { totalYieldMs } : {}),
          ...(timeoutSec !== undefined ? { timeoutSec } : {}),
        })
      : shell.runForeground({
          ...execution,
          ...isolated,
          timeoutSec: timeout,
          postExitDrainGraceMs,
        });
    const scratchDir = context.scratchDir ?? tempDir;
    const result = mutates
      ? await runInPrivateCopy({ context, spawnOwned, command, env, platform, execPath, pool: context.shell?.privateCopies, scratchDir, home: join(scratchDir, SCRATCH_MUTATIONS_DIR, randomUUID()), run: launch })
      : await launch();
    // A private copy's reads are of the copy, not the project file.
    if (!mutates) await recordShellFileReads(command, parseBashResultDetails(result.details ?? {}).exitCode, context);
    return { ...result, content: `${result.content}${handoffCommandCitation(context, result.details)}` };
  }

  return withShellInputRepair({
    name: "bash",
    action: "shell_exec",
    ...bashPromptFields(options?.fileEditTool),
    promptSnippet: "Run shell commands and scripts (tests, builds, git, servers, package managers, scratch scripts)",
    inputSchema: BASH_INPUT_SCHEMA,
    // bash already escalates its own kill timer up to MAX_TIMEOUT_SEC; the
    // dispatcher's generic watchdog would either race that mechanism or
    // fire first on a legitimately long (up to 3600s) foreground command.
    unboundedDuration: true,
    // Each call is a fresh isolated owned process with no shared session
    // state; same-batch commands are self-selected independent by the model,
    // and residual conflicts fail loudly in the command's own output.
    isConcurrencySafe: true,
    async execute(input: BashInput, context: ToolContext) {
      if (requireManagedExecution && (!options?.backgroundTasks || !options.foregroundBashHold)) {
        throw new Error("Foreground Bash requires a session-owned background execution registry and hold controller");
      }
      if (typeof input.command !== "string" || input.command.trim().length === 0) {
        return { content: "bash was called without a 'command' string. Provide the shell command you want to run as the 'command' parameter, e.g. { command: \"bun run test\" }.", outcome: "error" };
      }
      if (input.mutates !== undefined && typeof input.mutates !== "boolean") return { content: "Error: 'mutates' must be a boolean", outcome: "error" };
      if (input.persist_after_exit !== undefined && typeof input.persist_after_exit !== "boolean") return { content: "Error: 'persist_after_exit' must be a boolean", outcome: "error" };
      const mutates = input.mutates === true;
      if (mutates && readOnly) return { content: "Error: this agent is read-only and may not change project files, so it cannot run a command with 'mutates=true'.", outcome: "error" };
      if (mutates && input.persist_after_exit === true) return { content: "Error: 'mutates=true' cannot be combined with 'persist_after_exit=true': a command that outlives the runtime has no exit at which its changes could land in the project. Run the edit as its own foreground command.", outcome: "error" };
      const timeoutCheck = checkNumericRange(input.timeout, "timeout", { exclusiveMin: 0, max: MAX_TIMEOUT_SEC });
      if ("error" in timeoutCheck) return { content: timeoutCheck.error, outcome: "error" };
      const timeout = timeoutCheck.value;
      const background = input.background === true;
      const persistent = input.persist_after_exit === true;
      if (persistent && !background) return { content: "Error: 'persist_after_exit=true' requires 'background=true'", outcome: "error" };
      if (persistent && timeout !== undefined) return { content: "Error: 'persist_after_exit=true' cannot be combined with 'timeout' because the runtime cannot enforce the deadline after it exits", outcome: "error" };
      if (persistent && !persistentProcesses) return unavailableInput("persist_after_exit");
      if (background && !backgroundCommands) return unavailableInput("background");
      const effectiveContext = {
        ...context,
        ...(options?.backgroundTasks ? { backgroundTasks: options.backgroundTasks } : {}),
        ...(options?.foregroundBashHold ? { foregroundBashHold: options.foregroundBashHold } : {}),
        executionCwd: bashCommandCwd(input, context.executionCwd),
      };
      return runCommandInner(input.command, background, persistent ? "required" : false, effectiveContext, timeout, input.raw_output === true, mutates);
    },
    async executionPolicy(input, context) {
      const shell = bashShellCommand(input, context.executionCwd);
      return shell ? (await interceptBashCommand(shell.command, shellPolicyOptions(context, shell.cwd, platform, readOnly)))?.message : undefined;
    },
  });
}

function bashCommandCwd(input: Readonly<BashInput>, executionCwd: string): string {
  return typeof input.cwd === "string" ? resolveToolPath(executionCwd, input.cwd) : executionCwd;
}

/** The `bash` registration's shell facet: its `command`, run in its `cwd`
 *  resolved against the execution directory. */
export function bashShellCommand(input: Readonly<BashInput>, executionCwd: string): ShellCommand | undefined {
  return typeof input.command === "string" ? { command: input.command, cwd: bashCommandCwd(input, executionCwd) } : undefined;
}

/** Interprets timeout units, a home-relative `cwd`, and an implied background before the shell owner's admission. */
function repairShellInput(input: Readonly<RuntimeToolInput>, context: ToolAdmissionContext): { readonly input: RuntimeToolInput; readonly notice: string } | undefined {
  const notices: string[] = [];
  const paths: RuntimeToolInput = {};
  const cwd = input.cwd;
  if (typeof cwd === "string" && cwd.startsWith("~")) {
    const home = sessionPathInput({ path: cwd }, context, "directory");
    if (home.repair) {
      paths.cwd = home.repair.input.path;
      notices.push(home.repair.notice);
    }
  }
  let timeout = input.timeout;
  if (typeof timeout === "number" && Number.isFinite(timeout)) {
    if (timeout >= 10000) {
      const seconds = timeout / 1000;
      timeout = Math.min(seconds, MAX_TIMEOUT_SEC);
      notices.push(`Note: timeout ${input.timeout} was read as milliseconds: ${seconds} seconds${seconds > MAX_TIMEOUT_SEC ? `; capped at ${MAX_TIMEOUT_SEC} seconds` : ""}.`);
    } else if (timeout > MAX_TIMEOUT_SEC) {
      timeout = MAX_TIMEOUT_SEC;
      notices.push(`Note: timeout was capped at ${MAX_TIMEOUT_SEC} seconds.`);
    }
  }
  const implicitBackground = input.persist_after_exit === true && input.background === undefined;
  if (implicitBackground) notices.push("Note: persist_after_exit=true implies background=true.");
  if (notices.length === 0) return undefined;
  return { input: { ...input, ...paths, ...(timeout !== input.timeout ? { timeout } : {}), ...(implicitBackground ? { background: true } : {}) }, notice: notices.join("\n") };
}

/** Repairs scheduling before dispatch policy. Direct callers get the same notes and admission. */
function withShellInputRepair(tool: RuntimeTool): RuntimeTool {
  return {
    ...tool,
    prepareAdmission: async (input, context) => ({ repair: repairShellInput(input, context) }),
    async execute(input, context) {
      const repair = repairShellInput(input, context);
      const result = await tool.execute(repair?.input ?? input, context);
      if (!repair) return result;
      return { ...result, content: typeof result.content === "string" ? `${repair.notice}\n${result.content}` : [{ type: "text", text: repair.notice }, ...result.content] };
    },
  };
}
