/**
 * The two ways one shell command runs: as a managed process, which its tool
 * call can hold until it settles or transfer to the background, or, where no
 * session registry can take the command, held in the foreground until it exits
 * or times out. Each strategy owns its output streams and spool through
 * settlement, lands a private copy's edits through the command's landing hook
 * once it exits, and assembles the result from both.
 */
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";

import { errorMessage } from "../../../infra/error-message.js";
import { createStreamingSanitizer } from "../../../infra/control-characters.js";
import { Log } from "../../../infra/log.js";
import type { ForegroundBashReleaseReason } from "../foreground-bash-hold.js";
import { createShellOutputAccumulator, createTailEmitter, EXECUTION_OUTPUT_TAIL_CHARS, type ForegroundSpool, openForegroundSpool, settledForegroundResult, shellObservation } from "./bash-output-tail.js";
import { BACKGROUND_COMMAND_FILE_PREFIX, FOREGROUND_COMMAND_FILE_PREFIX, buildBackgroundScript, buildShellScript, isWindows, quoteBashSingle, quotePowerShell, scriptExtension, shellInvocation } from "./bash-script.js";
import { landingEvidence, settledLandingOutput, startManagedCommand } from "./managed-command.js";
import { toolCallIdentity, type ToolResult } from "./types.js";
import { createStderrTail } from "./shell-stderr.js";
import type { ForegroundShellExecutionOptions, ManagedShellExecutionOptions, OwnedSpawn, ProjectMutationLanding } from "./shell-runtime-types.js";
import { armUnheldDeadline, type ProcessorClaims } from "./processor-claims.js";

const log = Log.create({ service: "shell-runtime" });
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

/** The hold time of each container the execution's owner claimed for
 *  processor admission, by ownership token. */
interface ClaimedExecution {
  readonly heldTime: ProcessorClaims["heldTime"];
}

/** Runs one command in the foreground until it exits, times out, or the turn
 *  aborts. A timed-out command still lands its edits and reports an error. */
export async function runForegroundShell(options: ForegroundShellExecutionOptions & ClaimedExecution): Promise<ToolResult> {
  const { command, context, spawnOwned, timeoutSec, rawOutput, env, operations, platform, tempDir, executionOutputThrottleMs, postExitDrainGraceMs, privateCopy, heldTime } = options;
  const scriptId = randomUUID().slice(0, 8);
  const scriptPath = join(tempDir, `flywheel-agent-${scriptId}.${scriptExtension(platform)}`);
  let spoolPath = join(context.scratchDir ?? tempDir, `${FOREGROUND_COMMAND_FILE_PREFIX}${scriptId}.log`);
  let spoolWriter: ForegroundSpool | undefined;
  let retainSpool = false;
  const closeSpool = async (): Promise<void> => {
    const writer = spoolWriter;
    if (!writer) return;
    await writer.close();
    if (spoolWriter === writer) spoolWriter = undefined;
  };
  const trace = Boolean(context.onExecutionOutput) && !isWindows(platform);

  try {
    await operations.writeScript(scriptPath, buildShellScript(command, platform, trace));
    try {
      spoolWriter = await openForegroundSpool(spoolPath);
    } catch (error) {
      if (!context.scratchDir || !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
      spoolPath = join(tempDir, `${FOREGROUND_COMMAND_FILE_PREFIX}${scriptId}.log`);
      spoolWriter = await openForegroundSpool(spoolPath);
    }

    const owned = await spawnOwned(shellInvocation(platform, scriptPath), { cwd: context.executionCwd, env, stdin: "ignore" });
    const startedAt = Date.now();
    let timedOut = false;
    let aborted = false;
    const outputSpool = spoolWriter;
    const settlementOutput = createShellOutputAccumulator();
    let displayOutput = "";
    const appendDisplayOutput = (text: string): void => {
      displayOutput = (displayOutput + text.slice(-EXECUTION_OUTPUT_TAIL_CHARS)).slice(-EXECUTION_OUTPUT_TAIL_CHARS);
    };
    const stdoutSanitizer = createStreamingSanitizer((text) => {
      appendDisplayOutput(text);
      settlementOutput.push(text);
    });
    const stderrTail = createStderrTail();
    const stderrReader = createStreamingSanitizer((text) => {
      appendDisplayOutput(text);
      stderrTail.push(text);
    });
    let lastExecutionOutputAt = 0;
    let executionOutputTimer: ReturnType<typeof setTimeout> | undefined;
    const cancelExecutionOutputTimer = (): void => {
      if (!executionOutputTimer) return;
      clearTimeout(executionOutputTimer);
      executionOutputTimer = undefined;
    };
    const emitTail = context.onExecutionOutput ? createTailEmitter(context.onExecutionOutput) : undefined;
    const emitExecutionOutput = (): void => {
      if (!emitTail || aborted) return;
      if (emitTail(displayOutput)) lastExecutionOutputAt = Date.now();
    };
    const scheduleExecutionOutput = (): void => {
      if (!emitTail || aborted) return;
      if (executionOutputThrottleMs <= 0) {
        emitExecutionOutput();
        return;
      }
      const elapsedMs = lastExecutionOutputAt === 0 ? executionOutputThrottleMs : Date.now() - lastExecutionOutputAt;
      if (elapsedMs >= executionOutputThrottleMs) {
        cancelExecutionOutputTimer();
        emitExecutionOutput();
        return;
      }
      executionOutputTimer ??= setTimeout(() => {
        executionOutputTimer = undefined;
        emitExecutionOutput();
      }, executionOutputThrottleMs - elapsedMs);
    };
    const flushExecutionOutput = (): void => {
      cancelExecutionOutputTimer();
      emitExecutionOutput();
    };
    const readers: ReadableStreamDefaultReader<Uint8Array>[] = [];
    const readStream = async (
      stream: ReadableStream<Uint8Array> | undefined,
      sanitizer: ReturnType<typeof createStreamingSanitizer>,
      onBytes?: (bytes: Uint8Array) => void | Promise<void>,
    ): Promise<void> => {
      if (!stream) return;
      const decoder = new TextDecoder();
      const reader = stream.getReader();
      readers.push(reader);
      try {
        for (;;) {
          const result = await reader.read();
          if (result.done) break;
          if (onBytes) await onBytes(result.value);
          const text = decoder.decode(result.value, { stream: true });
          if (text) {
            sanitizer.push(text);
            scheduleExecutionOutput();
          }
        }
        const text = decoder.decode();
        if (text) sanitizer.push(text);
        sanitizer.finish();
        scheduleExecutionOutput();
      } finally {
        reader.releaseLock();
      }
    };
    const cancelReaders = (): void => {
      for (const reader of readers) {
        void reader.cancel().catch((error) => log.debug("failed to cancel shell output reader", { error: errorMessage(error) }));
      }
    };
    const cancelDeadline = armUnheldDeadline(startedAt + timeoutSec * 1000, heldTime(owned.token), () => {
      timedOut = true;
      log.warn("command timed out, terminating the container", { timeoutSec });
      void owned.terminate();
    });
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    const abortHandler = (): void => {
      aborted = true;
      cancelExecutionOutputTimer();
      cancelReaders();
      void owned.terminate();
    };
    if (context.signal?.aborted) abortHandler();
    else context.signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const [settled] = await Promise.all([
        owned.exited.then((exit) => {
          drainTimer = setTimeout(cancelReaders, postExitDrainGraceMs);
          return { exit, durationMs: Date.now() - startedAt };
        }),
        readStream(owned.stdout, stdoutSanitizer, async (bytes) => {
          await outputSpool.write(bytes);
          settlementOutput.addBytes(bytes);
        }),
        // Always read: the script merges the payload's stderr into recorded
        // stdout, so what arrives here is trace output, the death cry of a
        // launch that never reached the script, and the supervisor's records.
        readStream(owned.stderr, stderrReader),
      ]);
      if (aborted) {
        const landing = await privateCopy?.land({ interrupted: true, signal: context.signal, output: "" });
        const result = withLanding({ content: "The bash invocation was aborted by the user before it could complete. No output was captured. If the user is asking you to continue, retry with whatever scope they request; do not assume the previous command's effects landed.", outcome: "interrupted" }, landing);
        if (result.executionOutputTail) emitTail?.(result.executionOutputTail);
        return result;
      }
      flushExecutionOutput();
      const settledOutput = settlementOutput.finalize(spoolPath);
      retainSpool = settledOutput.foreground.kind === "bounded";
      await closeSpool();
      const landing = await privateCopy?.land({ interrupted: false, signal: context.signal, output: shellObservation(command, settledOutput.foreground, true).text });
      const result = withLanding(settledForegroundResult({ command, rawOutput, settled: { ...settled, output: settledOutput }, stderrTail: stderrTail.text(), expiredDeadlineSec: timedOut ? timeoutSec : undefined }), landing);
      if (result.executionOutputTail && result.executionOutputTail !== settledOutput.executionOutputTail) emitTail?.(result.executionOutputTail);
      return result;
    } catch (error) {
      cancelReaders();
      try {
        await owned.terminate();
      } catch (settlementError) {
        log.warn("failed to terminate shell process after output handling failure", { error: errorMessage(settlementError) });
      }
      try {
        await owned.exited;
      } catch (settlementError) {
        log.warn("failed to join shell process after output handling failure", { error: errorMessage(settlementError) });
      }
      throw error;
    } finally {
      cancelDeadline();
      if (drainTimer) clearTimeout(drainTimer);
      cancelExecutionOutputTimer();
      context.signal?.removeEventListener("abort", abortHandler);
    }
  } finally {
    try {
      await closeSpool();
    } catch (cleanupError) {
      log.warn("failed to close foreground output spool", { path: spoolPath, error: errorMessage(cleanupError) });
    }
    if (!retainSpool) await removeSpoolFile(spoolPath);
    try {
      await operations.deleteScript(scriptPath);
    } catch (cleanupError) {
      log.warn("failed to cleanup shell script", { path: scriptPath, error: errorMessage(cleanupError) });
    }
  }
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
export async function runManagedShell(options: ManagedShellExecutionOptions & ClaimedExecution): Promise<ToolResult> {
  const { command, context, spawnOwned, env, operations, platform, tempDir, executionOutputThrottleMs, totalYieldMs, foreground, rawOutput, timeoutSec, onForegroundSettled, privateCopy } = options;
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
  const foregroundHold = foreground && context.toolUseId ? context.foregroundBashHold?.register(context.toolUseId) : undefined;
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
  const registry = context.backgroundTasks;
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
    ...(registry ? { registry } : {}),
    ...(registry && toolUseId
      ? { emitLiveTail: (text: string) => registry.streamExecutionOutput(toolUseId, text, toolCallIdentity(context)) }
      : context.onExecutionOutput ? { emitLiveTail: context.onExecutionOutput } : {}),
    ...(registry && toolUseId ? { tailStopSignal: context.backgroundSignal ?? context.disposalSignal } : context.disposalSignal ? { tailStopSignal: context.disposalSignal } : {}),
    executionOutputThrottleMs,
    postExitDrainGraceMs: options.postExitDrainGraceMs ?? POST_EXIT_DRAIN_GRACE_MS,
    ...(privateCopy ? { privateCopy } : {}),
    // The landing outlives the turn that launched the command, so only the
    // background-work lifetime cancels it.
    ...(context.backgroundSignal ?? context.disposalSignal ? { landingSignal: context.backgroundSignal ?? context.disposalSignal } : {}),
  });
  if (!foreground || !foregroundHold) await managed.track();
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
  if (!registry) {
    const checkHint = isWindows(platform) ? `Get-Content -Path ${quotePowerShell(logPath)} -Tail 40` : `tail -40 ${quoteBashSingle(logPath)}`;
    const stopHint = isWindows(platform) ? `Stop-Process -Id ${owned.pid}` : `kill ${owned.pid}`;
    return {
      content: `Started in background. PID: ${owned.pid}. Log: ${logPath}.\nCheck progress: ${checkHint}\nStop: ${stopHint}`,
      outcome: "ok",
      details: { background: true },
    };
  }
  const hold = releaseReason === "runtime_cap" ? heldTime.hold() : undefined;
  return {
    content: [
      releaseReason
        ? `Command is still running and transferred to managed process ${processId} ${TRANSFER_REASONS[releaseReason]}.`
        : `Running in background as managed process ${processId}.`,
      // The cap passed because the command waits its turn, not because it is
      // slow, so the agent learns how long the wait can be (PI-AGENT-052).
      ...(hold ? [`It waits for processor time, with ${hold.ahead} ${hold.ahead === 1 ? "command" : "commands"} ahead of it.`] : []),
      "A background_command_notification with the exit code and log tail will arrive when it exits.",
      // The session waits on every tracked command (ARCH-TOOLS-031). A server
      // that dies with the runtime, or a pattern kill that also matches the
      // runtime's own command line, ends work the agent needs.
      `It keeps this session working until it ends or you stop it, and it ends when the runtime exits. Stop it with process action stop and process_id ${processId} (PID ${owned.pid}), not with a pattern kill.${options.persistable && !releaseReason ? " If it is a server that must keep running after you stop waiting, stop it and wait for its confirmed exit, then launch it again with persist_after_exit=true." : ""}`,
    ].join("\n"),
    outcome: "ok",
    details: releaseReason ? { background: true, durationMs: Date.now() - startedAtMs, releaseReason } : { background: true },
  };
}
