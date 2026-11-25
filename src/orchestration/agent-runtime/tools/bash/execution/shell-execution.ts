/**
 * How one shell command runs: as a managed process of the session registry,
 * which its tool call can hold until it settles or transfer to the background.
 * The managed command owns its output streams and spool through settlement,
 * lands a private copy's edits through the command's landing hook once it
 * exits, and the result is assembled from both.
 */
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "../../../../../infra/error-message.js";
import { Log } from "../../../../../infra/diagnostics/log.js";
import type { BackgroundWorkRegistry } from "../../../../session/control/background-work/background-work.js";
import type { ForegroundBashReleaseReason } from "../../../../session/control/background-work/foreground-bash-hold.js";
import { settledForegroundResult } from "./bash-output-tail.js";
import { BACKGROUND_COMMAND_FILE_PREFIX, buildBackgroundScript, scriptExtension, shellInvocation } from "../bash-script.js";
import { landingEvidence, settledLandingOutput, startManagedCommand } from "./managed-command.js";
import { toolCallIdentity, type ToolResult } from "../../types.js";
import type { ManagedShellExecutionOptions, OwnedSpawn, ProjectMutationLanding } from "./shell-runtime-types.js";
import type { ProcessorClaims } from "./processor-claims.js";

const log = Log.create({ service: "shell-runtime" });
const watchLog = Log.create({ service: "watch" });
/** How long a settled command waits for output its pipes still carry. */
export const POST_EXIT_DRAIN_GRACE_MS = 2_000;
/** How often a running command's live tail is read and published. */
export const DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS = 80;

async function removeSpoolFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (cleanupError) {
    if (!(typeof cleanupError === "object" && cleanupError !== null && "code" in cleanupError && cleanupError.code === "ENOENT")) {
      log.warn("failed to cleanup shell output spool", { path, error: errorMessage(cleanupError) });
    }
  }
}

/** A landing's report follows the command's own result text, and its evidence
 *  rides the result details the transcript and per-file undo read. */
function withLanding(result: ToolResult, landing: ProjectMutationLanding | undefined): ToolResult {
  if (!landing) return result;
  const evidence = landingEvidence(landing);
  const executionOutputTail = settledLandingOutput(result.executionOutputTail ?? "", landing);
  return {
    ...result,
    content: `${result.content}\n\n${landing.report}`,
    ...(executionOutputTail ? { executionOutputTail } : {}),
    ...(Object.keys(evidence).length > 0 ? { details: { ...(typeof result.details === "object" && result.details !== null ? result.details : {}), ...evidence } } : {}),
  };
}

/** What the runtime that owns a launch binds to it: the session registry
 *  that tracks the command, and the hold time of each container the runtime
 *  claimed for processor admission, by ownership token. */
interface ExecutionOwnership {
  readonly registry: BackgroundWorkRegistry;
  readonly heldTime: ProcessorClaims["heldTime"];
}

/** Why a held command left its tool call while it still runs, as the model reads it. */
const TRANSFER_REASONS = {
  runtime_cap: "because it reached the runtime cap",
  user_detach: "after the user selected Detach",
  replacement: "because the runtime was replaced",
} as const satisfies { readonly [reason in "runtime_cap" | ForegroundBashReleaseReason]: string };

/** Runs one command as a managed process. A foreground call holds the turn
 *  until the command exits, reaches the runtime cap when it has one, the user
 *  detaches it, a planned replacement moves it, or the turn aborts; a command
 *  still running then continues as tracked background work. */
export async function runManagedShell(options: ManagedShellExecutionOptions & ExecutionOwnership): Promise<ToolResult> {
  const { command, context, spawnOwned, env, operations, platform, tempDir, executionOutputThrottleMs, totalYieldMs, foreground, rawOutput, timeoutSec, onForegroundSettled, privateCopy, registry } = options;
  const scriptId = randomUUID().slice(0, 8);
  const backgroundDir = context.scratchDir ?? tempDir;
  const logPath = join(backgroundDir, `${BACKGROUND_COMMAND_FILE_PREFIX}${scriptId}.log`);
  const scriptPath = join(backgroundDir, `${BACKGROUND_COMMAND_FILE_PREFIX}${scriptId}.${scriptExtension(platform)}`);
  const stripped = command.trim();
  const releaseSpool = async (keepLog: boolean): Promise<void> => {
    if (!keepLog) await removeSpoolFile(logPath);
    try {
      await operations.deleteScript(scriptPath);
    } catch (cleanupError) {
      log.warn("failed to cleanup shell script", { path: scriptPath, error: errorMessage(cleanupError) });
    }
  };
  const foregroundHold = options.foreground && context.toolUseId ? options.foregroundBashHold.register(context.toolUseId) : undefined;
  let owned: Awaited<ReturnType<OwnedSpawn>>;
  try {
    await operations.writeScript(scriptPath, buildBackgroundScript(stripped, logPath, platform));
    // Every managed command can cross a planned replacement without a stdin producer.
    owned = await spawnOwned(shellInvocation(platform, scriptPath), { cwd: context.executionCwd, env, handover: true, stdin: "ignore" });
  } catch (error) {
    foregroundHold?.cleanup();
    await releaseSpool(false);
    throw error;
  }
  foregroundHold?.running();
  const processId = `bash-bg-${scriptId}`;
  const startedAtMs = Date.now();
  const toolUseId = context.toolUseId;
  const heldTime = options.heldTime(owned.token);
  // The registry's live channel outlives the turn, so the tail keeps streaming
  // through the foreground hold, a transfer to the background, and later turns.
  const managed = startManagedCommand({
    source: { owned },
    processId,
    description: stripped,
    logPath,
    startedAtMs,
    ...(timeoutSec === undefined ? {} : { deadlineAtMs: startedAtMs + Math.round(timeoutSec * 1000) }),
    heldTime,
    identity: { ...(toolUseId ? { toolUseId } : {}), ...toolCallIdentity(context) },
    registry,
    ...(toolUseId
      ? { emitLiveTail: (text: string) => registry.streamExecutionOutput(toolUseId, text, toolCallIdentity(context)) }
      : context.onExecutionOutput ? { emitLiveTail: context.onExecutionOutput } : {}),
    ...(toolUseId ? { tailStopSignal: context.backgroundSignal ?? context.disposalSignal } : context.disposalSignal ? { tailStopSignal: context.disposalSignal } : {}),
    executionOutputThrottleMs,
    postExitDrainGraceMs: options.postExitDrainGraceMs ?? POST_EXIT_DRAIN_GRACE_MS,
    ...(privateCopy ? { privateCopy } : {}),
    ...(options.watch ? { watch: { position: 0, events: 0 } } : {}),
    // The landing outlives the turn that launched the command, so only the
    // background-work lifetime cancels it.
    ...(context.backgroundSignal ?? context.disposalSignal ? { landingSignal: context.backgroundSignal ?? context.disposalSignal } : {}),
  });
  if (!foreground || !foregroundHold) await managed.track();
  // A new watch only: an adopted one continues the watch this record started.
  if (options.watch) watchLog.info("watch started", { processId, ...(timeoutSec === undefined ? {} : { deadlineMs: Math.round(timeoutSec * 1000) }) });
  let releaseReason: keyof typeof TRANSFER_REASONS | undefined;
  if (foreground) {
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    const clearTransferWait = (): void => {
      if (capTimer) clearTimeout(capTimer);
      capTimer = undefined;
      if (abortHandler) context.signal?.removeEventListener("abort", abortHandler);
    };
    const aborted = new Promise<"aborted">((resolve) => {
      abortHandler = () => resolve("aborted");
      if (context.signal?.aborted) abortHandler();
      else context.signal?.addEventListener("abort", abortHandler, { once: true });
    });
    let processExited = false;
    const exited = owned.exited.then(() => { processExited = true; return "exited" as const; });
    const candidates: Promise<"exited" | "aborted" | keyof typeof TRANSFER_REASONS>[] = [exited, aborted];
    if (totalYieldMs !== undefined) candidates.push(new Promise<"runtime_cap">((resolve) => { capTimer = setTimeout(() => resolve("runtime_cap"), totalYieldMs); }));
    if (foregroundHold) candidates.push(foregroundHold.released);
    let first = await Promise.race(candidates);
    // An expired deadline owns settlement: it already requested termination,
    // so a runtime-cap win in that window would report a running transfer for
    // a process that is being killed. Wait for the exit instead.
    if (first === "runtime_cap" && managed.deadlineExpired()) first = await exited;
    clearTransferWait();
    await Promise.resolve();
    if (processExited) first = "exited";
    else if (context.signal?.aborted) first = "aborted";
    // A transfer reports through the hold's cleanup only once the registry
    // tracks the command, because a replacement interrupts the turn as soon
    // as each moved command reports, and that interrupt ends a held command.
    if (first === "aborted" || first === "exited") foregroundHold?.cleanup();
    if (first === "aborted") {
      await managed.interrupt();
      await managed.done;
      if (!managed.isTracked()) await releaseSpool(false);
      return withLanding({ content: "The bash invocation was interrupted before it transferred to the background.", outcome: "interrupted" }, (await managed.settlement).landing);
    }
    if (first === "exited") {
      const settled = await managed.settlement;
      const foregroundOutput = settled.output.foreground;
      onForegroundSettled?.({ foreground: foregroundOutput, executionOutputTail: settledLandingOutput(settled.output.executionOutputTail, settled.landing) });
      if (!managed.isTracked()) await releaseSpool(foregroundOutput.kind === "bounded");
      return withLanding(settledForegroundResult({ command, rawOutput, settled: { ...settled, exit: await owned.exited }, stderrTail: managed.stderrTail(), expiredDeadlineSec: managed.deadlineExpired() ? timeoutSec : undefined }), settled.landing);
    }
    releaseReason = first;
    await managed.track().finally(() => foregroundHold?.cleanup());
  }
  const hold = releaseReason === "runtime_cap" ? heldTime.hold() : undefined;
  return {
    content: [
      releaseReason
        ? `Command is still running and transferred to managed process ${processId} ${TRANSFER_REASONS[releaseReason]}.`
        : options.watch
          ? `Running in background as watch ${processId}. Each line it writes arrives as a watch_event notification while it runs, and a watch_ended notification says how it ended.`
          : `Running in background as managed process ${processId}.`,
      // The cap passed because the command waits its turn, not because it is
      // slow, so the agent learns how long the wait can be (PI-AGENT-052).
      ...(hold ? [`It waits for processor time, with ${hold.ahead} ${hold.ahead === 1 ? "command" : "commands"} ahead of it.`] : []),
      ...(options.watch ? [] : ["A background_command_notification with the exit code and log tail will arrive when it exits."]),
      // The session waits on every tracked command (ARCH-TOOLS-031). A server
      // that dies with the runtime, or a pattern kill that also matches the
      // runtime's own command line, ends work the agent needs.
      `It keeps this session working until it ends or you stop it, and it ends when the runtime exits. Stop it with process action stop and process_id ${processId} (PID ${owned.pid}), not with a pattern kill.${options.persistable && !releaseReason ? " If it is a server that must keep running after you stop waiting, stop it and wait for its confirmed exit, then launch it again with persist_after_exit=true." : ""}`,
    ].join("\n"),
    outcome: "ok",
    details: releaseReason ? { background: true, durationMs: Date.now() - startedAtMs, releaseReason } : { background: true },
  };
}
