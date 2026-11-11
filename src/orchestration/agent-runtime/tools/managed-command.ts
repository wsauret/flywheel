import type { CommandHandover } from "../../../infra/command-handover.js";
import { createStreamingSanitizer } from "../../../infra/control-characters.js";
import type { HandoverAnswer, OwnedProcess } from "../../../infra/owned-subprocess.js";
import { formatDuration } from "../../../protocol/client/format.js";
import { formatNotAppliedFiles } from "../../../infra/not-applied-files.js";
import type { BackgroundKillSource, BackgroundWorkRegistry, BackgroundWorkResult, SettledProjectMutation, ToolCallIdentity } from "../background-work.js";
import type { CommandExit } from "../background-work-processes.js";
import { boundedExecutionOutputTail, createShellOutputAccumulator, createTailEmitter, readBackgroundProcessOutput, readSpoolGrowth, type SettledShellOutput, shellObservation } from "./bash-output-tail.js";
import type { PrivateCopy, ProjectMutationLanding } from "./shell-runtime-types.js";
import { createStderrTail, drainStderr, silentFailureStderr } from "./shell-stderr.js";
import { armUnheldDeadline, NEVER_HELD, type HeldTime } from "./processor-claims.js";

/** How the owner of a managed command learned that it ended. `exited` carries
 *  the exit status as the platform reports it (an exit code, or the signal
 *  that ended the command, with a null code), and, when the command ended
 *  while no owner held it, the outcome its supervisor recorded. `unrecorded`:
 *  its supervisor ended without a readable record of the exit.
 *  `previous_runtime`: the command was never handed over, so it ended with
 *  the runtime that launched it. */
export type ManagedCommandEnd =
  | { readonly kind: "exited"; readonly code: number | null; readonly signal: NodeJS.Signals | null; readonly recorded?: { readonly deadlineExpired: boolean; readonly endedAtMs: number } }
  | { readonly kind: "unrecorded" | "previous_runtime" };

/** What this owner reaches of the command: its owned container, which it can
 *  stop and hand over, or only the end of a command it merely observes. */
type ManagedCommandSource =
  | { readonly owned: OwnedProcess }
  | { readonly observed: Promise<ManagedCommandEnd> };

interface ManagedCommandInput {
  readonly source: ManagedCommandSource;
  readonly processId: string;
  /** The command text, as the notification states it. */
  readonly description: string;
  readonly logPath: string;
  readonly startedAtMs: number;
  /** The hard deadline as epoch milliseconds. A deadline already past ends an
   *  owned command at once. */
  readonly deadlineAtMs?: number;
  /** The processor holds of the owned container, which move the deadline
   *  later by the time held (ARCH-TOOLS-033). Absent, the container is never
   *  held. */
  readonly heldTime?: HeldTime;
  readonly identity: ToolCallIdentity & { readonly toolUseId?: string };
  readonly registry?: BackgroundWorkRegistry;
  readonly emitLiveTail?: (text: string) => void;
  readonly tailStopSignal?: AbortSignal;
  readonly executionOutputThrottleMs: number;
  /** How long settlement waits after the exit for the parent-side stderr to end. */
  readonly postExitDrainGraceMs: number;
  /** Present for a command that runs in a private project copy, which lands
   *  once the command exits, before its result or completion exists. */
  readonly privateCopy?: PrivateCopy;
  /** Cancels the landing. The landing outlives the turn that launched the
   *  command, so this is the background-work lifetime. */
  readonly landingSignal?: AbortSignal;
}

interface ManagedSettlement {
  readonly end: ManagedCommandEnd;
  readonly output: SettledShellOutput;
  readonly durationMs: number;
  readonly landing?: ProjectMutationLanding;
}

/** The evidence a landing adds to a result's details or a completion. */
export function landingEvidence(landing: ProjectMutationLanding | undefined): SettledProjectMutation {
  return landing?.mutationEvidence ? { mutationEvidence: landing.mutationEvidence } : {};
}

/** Adds the recovery report to settled display output only when no published
 *  file evidence can render it. The original spool and model result stay separate. */
export function settledLandingOutput(output: string, landing: ProjectMutationLanding | undefined): string {
  if (!landing || (!landing.retainReport && (landing.mutationEvidence?.retainedFiles ?? 0) > 0)) return output;
  const report = landing.notAppliedSummary?.total
    ? landing.report.replace(`${formatNotAppliedFiles(landing.notAppliedSummary)}. `, "").trim()
    : landing.report;
  if (!report) return output;
  return boundedExecutionOutputTail(output ? `${output}${output.endsWith("\n") ? "\n" : "\n\n"}${report}` : report);
}

/** A running managed command's presence in its session: the tail of its log,
 *  its hard deadline, its settlement text, and its registry entry with Stop
 *  and output reads. A launch and an adoption build the same presence, so a
 *  command a later build adopted behaves as one it launched. */
export interface ManagedCommand {
  readonly meta: {
    readonly id: string;
    readonly type: "background_command";
    readonly description: string;
    readonly toolUseId?: string;
    readonly parentToolUseId?: string;
    readonly modelRequestId?: string;
    readonly notificationKey: string;
  };
  readonly owned?: OwnedProcess;
  readonly logPath: string;
  readonly startedAtMs: number;
  /** The hard deadline, moved later by the time the container was held, which
   *  a handover carries to the next owner. */
  readonly deadlineAtMs?: number;
  readonly settlement: Promise<ManagedSettlement>;
  readonly done: Promise<BackgroundWorkResult>;
  /** The home of the private project copy the command runs in, if any, for
   *  the command's handover row. A later build can land the copy from that
   *  home, so from this call on the copy never goes back to its session's pool. */
  copyHomeForHandover(): string | undefined;
  deadlineExpired(): boolean;
  /** Who asked the registry to end the command, if anyone did. */
  stoppedBy(): BackgroundKillSource | undefined;
  stderrTail(): string;
  isTracked(): boolean;
  /** Ends a command its tool call still holds, for a turn that was
   *  interrupted, and resolves once it has exited. Its landing, if any,
   *  discards its changes. */
  interrupt(): Promise<void>;
  /** Registers the command with its registry once. A registry that refuses
   *  it leaves nothing to own the command, so the command ends first. */
  track(): Promise<void>;
  /** Hands the command to a later owner. On `handed_over` the deadline,
   *  the tail, the landing, and the registry entry are this owner's no more,
   *  and nothing here kills the command, lands or deletes its copy, or
   *  publishes its completion. */
  handOver(request: CommandHandover): Promise<HandoverAnswer>;
  /** Ends a tracked command as the runtime does. Its landing, if any,
   *  discards its changes. */
  stop(): void;
  /** Gives the running command to the presence another host in this process
   *  builds, and answers its container: the deadline, the tail, the landing,
   *  and the registry entry are this presence's no more, and it publishes
   *  nothing. Nothing for a command it only observes. */
  release(): OwnedProcess | undefined;
}

/** Waits for `work`, but no longer than `ms`. */
async function settleWithin(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

function endLine(end: ManagedCommandEnd, durationMs: number, description: string): string {
  if (end.kind !== "exited") {
    return end.kind === "unrecorded"
      ? `Background command ended without a recorded exit status: ${description}`
      : `Background command ended with the previous runtime: ${description}`;
  }
  const how = end.code !== null ? `exited with code ${end.code}` : `ended by ${end.signal === null ? "a signal" : `signal ${end.signal}`}`;
  return `Background command ${how} after ${formatDuration(durationMs)}: ${description}`;
}

/** The exit of a command whose end was observed. A command that a signal
 *  ended has no exit code, so it states the signal and never a code. */
function commandExit(end: Extract<ManagedCommandEnd, { kind: "exited" }>): CommandExit {
  return end.code !== null ? { code: end.code } : { signal: end.signal };
}

export function startManagedCommand(input: ManagedCommandInput): ManagedCommand {
  const { source, processId, description, logPath, startedAtMs, deadlineAtMs, registry } = input;
  const owned = "owned" in source ? source.owned : undefined;
  // Set before every termination Flywheel requests for its own reasons (an
  // interrupt, a stop, teardown, a refused registration), so the landing that
  // follows the exit discards the command's edits. A hard deadline is not an
  // interrupt: its partial edits land, as a foreground timeout's do.
  let interrupted = false;
  let stoppedBy: BackgroundKillSource | undefined;
  // Set once another presence holds the command, in this process or in a
  // later build, so this one lands nothing either.
  let released = false;
  const stderrTail = createStderrTail();
  const stderrDrained = drainStderr(owned, stderrTail.push);
  let deadlineExpired = false;
  const clearDeadline = owned && deadlineAtMs !== undefined
    ? armUnheldDeadline(deadlineAtMs, input.heldTime ?? NEVER_HELD, () => {
      deadlineExpired = true;
      void owned.terminate();
    })
    : () => {};
  const emitTail = input.emitLiveTail ? createTailEmitter(input.emitLiveTail) : undefined;
  let tailTimer: ReturnType<typeof setTimeout> | undefined;
  let pollInFlight: Promise<void> | undefined;
  let observedBytes = 0;
  let decoder = new TextDecoder();
  const settlementOutput = createShellOutputAccumulator();
  let sanitizer = createStreamingSanitizer((text) => settlementOutput.push(text));
  let tailerStopped = false;
  let tailerFinishing = false;
  const pollLog = async (settling = false): Promise<void> => {
    if (tailerStopped && !settling) return;
    try {
      const file = Bun.file(logPath);
      const size = file.size;
      if (size < observedBytes) {
        observedBytes = 0;
        settlementOutput.reset();
        decoder = new TextDecoder();
        sanitizer = createStreamingSanitizer((text) => settlementOutput.push(text));
      }
      observedBytes = await readSpoolGrowth({ size, slice: (start, end) => file.slice(start, end) }, observedBytes, (bytes) => {
        settlementOutput.addBytes(bytes);
        sanitizer.push(decoder.decode(bytes, { stream: true }));
      });
      if (!tailerStopped) emitTail?.(settlementOutput.displayTail());
    } catch {
      // The process can race creation of its spool.
    }
  };
  const scheduleTailPoll = (): void => {
    if (tailerStopped || tailerFinishing) return;
    tailTimer = setTimeout(() => {
      tailTimer = undefined;
      const poll = pollLog();
      pollInFlight = poll;
      void poll.finally(() => {
        if (pollInFlight === poll) pollInFlight = undefined;
        scheduleTailPoll();
      });
    }, input.executionOutputThrottleMs);
  };
  const stopTailer = (): void => {
    tailerStopped = true;
    tailerFinishing = true;
    if (tailTimer) clearTimeout(tailTimer);
    tailTimer = undefined;
    input.tailStopSignal?.removeEventListener("abort", stopTailer);
  };
  let finishTailerPromise: Promise<void> | undefined;
  const finishTailer = (): Promise<void> => {
    finishTailerPromise ??= (async () => {
      tailerFinishing = true;
      if (tailTimer) clearTimeout(tailTimer);
      tailTimer = undefined;
      await pollInFlight;
      await pollLog(true);
      sanitizer.push(decoder.decode());
      sanitizer.finish();
      if (!released) emitTail?.(settlementOutput.displayTail());
      stopTailer();
    })();
    return finishTailerPromise;
  };
  const ended: Promise<ManagedCommandEnd> = "owned" in source
    ? source.owned.exited.then((exit) => ({ kind: "exited", code: exit.code, signal: exit.signal }))
    : source.observed;
  const settlement = (async (): Promise<ManagedSettlement> => {
    const end = await ended;
    clearDeadline();
    // A launch that died before the script ran leaves its reason on the
    // parent-side stderr, which can still be in the pipe after the exit.
    await settleWithin(stderrDrained, input.postExitDrainGraceMs);
    await finishTailer();
    const endedAtMs = end.kind === "exited" && end.recorded ? end.recorded.endedAtMs : Date.now();
    const output = settlementOutput.finalize(logPath);
    // A command whose own exit no one recorded ended with a runtime that
    // died, as a crash ends one, so its changes are discarded as an
    // interrupt's are.
    const landing = released ? undefined : await input.privateCopy?.land({ interrupted: interrupted || end.kind !== "exited", signal: input.landingSignal, output: shellObservation(description, output.foreground, true).text });
    const displayOutput = settledLandingOutput(output.executionOutputTail, landing);
    if (!released && displayOutput !== output.executionOutputTail) emitTail?.(displayOutput);
    return { end, output, durationMs: endedAtMs - startedAtMs, ...(landing ? { landing } : {}) };
  })();
  let done: Promise<BackgroundWorkResult> | undefined;
  const completion = async (): Promise<BackgroundWorkResult> => {
    try {
      const { end, output, durationMs, landing } = await settlement;
      const { notificationTail } = output;
      const executionOutputTail = settledLandingOutput(output.executionOutputTail, landing);
      const exit = end.kind === "exited" ? commandExit(end) : undefined;
      const expired = deadlineExpired || (end.kind === "exited" && end.recorded?.deadlineExpired === true);
      const content = [
        expired && deadlineAtMs !== undefined ? `Background command reached its ${(deadlineAtMs - startedAtMs) / 1000}s hard deadline and was terminated.` : undefined,
        endLine(end, durationMs, description),
        notificationTail ? `Log tail (full log: ${logPath}):\n${notificationTail}` : `(log is empty; full log: ${logPath})`,
        // A launch that failed before the script ran exits with a code. A
        // signal comes from outside the command, so its stderr explains nothing.
        exit !== undefined && "code" in exit ? silentFailureStderr(exit.code, notificationTail.trim(), stderrTail.text()) : undefined,
      ].filter((part) => part !== undefined).join("\n");
      return {
        status: exit !== undefined && "code" in exit && exit.code === 0 ? "completed" : "failed",
        content: landing ? `${content}\n\n${landing.report}` : content,
        ...(exit !== undefined ? { exit } : {}),
        ...(executionOutputTail ? { executionOutputTail } : {}),
        ...landingEvidence(landing),
      };
    } finally {
      clearDeadline();
    }
  };
  let tracked = false;
  const meta: ManagedCommand["meta"] = {
    id: processId,
    type: "background_command",
    description,
    ...input.identity,
    // One key per command, so a repeat of its completion, from this build or
    // the next, commits once.
    notificationKey: `command:${processId}`,
  };
  const command: ManagedCommand = {
    meta,
    ...(owned ? { owned } : {}),
    logPath,
    startedAtMs,
    // A getter, because the time held grows until the command is handed over.
    get deadlineAtMs() { return deadlineAtMs === undefined ? undefined : deadlineAtMs + (input.heldTime?.heldMs() ?? 0); },
    settlement,
    get done() { done ??= completion(); return done; },
    copyHomeForHandover() {
      input.privateCopy?.withhold?.();
      return input.privateCopy?.home;
    },
    deadlineExpired: () => deadlineExpired,
    stoppedBy: () => stoppedBy,
    stderrTail: () => stderrTail.text(),
    isTracked: () => tracked,
    async track() {
      if (tracked || !registry) return;
      try {
        registry.track({
          done: command.done,
          meta,
          startedAtMs,
          command,
          // A command this owner only observes belongs to its supervisor, so
          // host teardown drops the observer without waiting for its end. An
          // owned one is this host's to stop and to hand over.
          ...(owned ? { kill: { run: (killedBy: BackgroundKillSource) => { stoppedBy = killedBy; interrupted = true; stopTailer(); void owned.terminate(); } } } : { hostClose: "detach" as const }),
          readOutput: (request) => readBackgroundProcessOutput(logPath, request),
        });
        tracked = true;
      } catch (error) {
        interrupted = true;
        stopTailer();
        if (owned) {
          try {
            await owned.terminate();
          } finally {
            await owned.exited;
          }
        }
        await command.done;
        throw error;
      }
    },
    async handOver(request) {
      const handOver = owned?.handOver;
      if (handOver === undefined) return { kind: "unacknowledged" };
      const answer = await handOver(request);
      if (answer.kind === "handed_over") {
        released = true;
        clearDeadline();
        stopTailer();
        registry?.detach(processId);
      }
      return answer;
    },
    async interrupt() {
      interrupted = true;
      if (!owned) return;
      try {
        await owned.terminate();
      } finally {
        await owned.exited;
      }
    },
    stop() {
      registry?.terminateProcess(processId, "runtime");
    },
    release() {
      if (!owned) return undefined;
      released = true;
      clearDeadline();
      stopTailer();
      registry?.detach(processId);
      return owned;
    },
  };
  scheduleTailPoll();
  if (input.tailStopSignal?.aborted) stopTailer();
  else input.tailStopSignal?.addEventListener("abort", stopTailer, { once: true });
  return command;
}
