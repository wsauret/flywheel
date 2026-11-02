import { mergeAbortSignals } from "../../../infra/abort.js";
import type { OwnedProcess } from "../../../infra/owned-subprocess.js";
import type { CommandHandoverRow } from "../../session/command-handover.js";
import type { BackgroundWorkRegistry } from "../background-work.js";
import { adoptHandedOverCommands, handedOverCommandInput, handOverCommands, type CommandHandoverScope } from "../command-handover.js";
import type { ToolContext, ToolResult } from "./types.js";
import { createPrivateCopyPool, type PrivateCopyPool } from "./bash-private-copy-pool.js";
import { startManagedCommand, type ManagedCommand } from "./managed-command.js";
import { DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS, POST_EXIT_DRAIN_GRACE_MS, runForegroundShell, runManagedShell } from "./shell-execution.js";
import type { ForegroundShellExecutionOptions, ManagedShellExecutionOptions, ShellRuntime, ShellRuntimeClient } from "./shell-runtime-types.js";
import { sharedProcessorClaims, type ProcessorClaims } from "./processor-claims.js";

/** Default foreground hold before an auto-yield transfers a still-running
 *  command to a managed process. Shared by every shell dialect; the
 *  configured foreground_bash_hold_seconds overrides it per request. */
export const DEFAULT_TOTAL_YIELD_MS = 240_000;

export interface ShellRuntimeDependencies {
  /** Ends every launch of this runtime, with the host that owns it. */
  readonly signal?: AbortSignal;
  /** A chat's own turn runs this runtime's commands, so processor admission
   *  never holds them (ARCH-TOOLS-051). */
  readonly processorExempt?: boolean;
  /** Replaces the executor's claims, for a test. */
  readonly processorClaims?: ProcessorClaims;
  /** Replaces the pool of idle private copies, for a test whose processes the
   *  host's process table cannot answer for. */
  readonly privateCopies?: PrivateCopyPool;
}

interface ShellExecutionOwnerInput {
  readonly context: ToolContext;
  readonly spawnOwned: NonNullable<ToolContext["spawnOwned"]>;
}

/** Owns shell execution state for one background-execution host generation,
 *  including the pool of idle private copies its mutating commands reuse. */
export function createShellRuntime(tasks: BackgroundWorkRegistry, dependencies: ShellRuntimeDependencies = {}): ShellRuntime {
  let closed = false;
  const abort = new AbortController();
  const ownerSignal = mergeAbortSignals(dependencies.signal, abort.signal);
  const claims = dependencies.processorClaims ?? sharedProcessorClaims();
  const exempt = dependencies.processorExempt === true;
  /** Binds each launch to this host's cancellation, and claims its container
   *  for processor admission until the container settles or is handed to a
   *  later owner. Returning a tool result or transferring the command to the
   *  registry does not end the claim. */
  const executionOwner = (input: ShellExecutionOwnerInput) => {
    const context = { ...input.context, backgroundTasks: tasks, signal: mergeAbortSignals(input.context.signal, ownerSignal) };
    return {
      context,
      spawnOwned: async (...launch: Parameters<ShellExecutionOwnerInput["spawnOwned"]>) => {
        context.signal.throwIfAborted();
        const owned = await input.spawnOwned(...launch);
        return claims.claim(owned, {
          order: Date.now(), exempt,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
          ...(context.toolUseId === undefined ? {} : { toolUseId: context.toolUseId }),
        });
      },
      heldTime: claims.heldTime,
    };
  };
  const active = new Set<Promise<ToolResult>>();
  const privateCopies = dependencies.privateCopies ?? createPrivateCopyPool();
  /** A command a previous build handed to `host`, as this runtime presents
   *  one it launched, before its registry tracks it. Its claim keeps the
   *  command's launch time as its place in the processor queue. */
  const startHandedOver = (host: CommandHandoverScope, row: CommandHandoverRow, adopted: OwnedProcess): ManagedCommand => {
    const input = handedOverCommandInput(host, row);
    const { toolUseId } = row;
    const owned = claims.claim(adopted, { order: row.startedAtMs, exempt, sessionId: row.sessionId, ...(toolUseId === undefined ? {} : { toolUseId }) });
    return startManagedCommand({
      ...input,
      source: { owned },
      heldTime: claims.heldTime(owned.token),
      registry: tasks,
      ...(toolUseId ? { emitLiveTail: (text: string) => tasks.streamExecutionOutput(toolUseId, text, input.identity) } : {}),
      tailStopSignal: abort.signal,
      landingSignal: abort.signal,
      executionOutputThrottleMs: DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS,
      postExitDrainGraceMs: POST_EXIT_DRAIN_GRACE_MS,
    });
  };
  const run = (operation: () => Promise<ToolResult>): Promise<ToolResult> => {
    if (closed) throw new Error("shell runtime is closed");
    const result = operation();
    active.add(result);
    void result.then(() => active.delete(result), () => active.delete(result));
    return result;
  };
  const client: ShellRuntimeClient = Object.freeze({
    hasActiveCommands: () => active.size > 0 || tasks.processRecords().some((process) =>
      process.kind === "background_command" && (process.status === "running" || process.status === "stopping")),
    runForeground: (options: ForegroundShellExecutionOptions) => run(() => runForegroundShell({ ...options, ...executionOwner(options) })),
    runBackground: (options: ManagedShellExecutionOptions) => run(() => runManagedShell({ ...options, ...executionOwner(options) })),
    privateCopies,
  });
  return {
    client,
    // The running commands are read here, when the handover begins, so a
    // command that settles from now on is the handover's to account for.
    handOver: (host) => handOverCommands(host, tasks.handoverCandidates()),
    adopt: (host, quiet) => adoptHandedOverCommands(host, {
      stream: (toolUseId, text) => tasks.streamExecutionOutput(toolUseId, text),
      start: (row, owned) => startHandedOver(host, row, owned),
      holds: (processId) => tasks.processCommand(processId) !== undefined,
      record: (command, result, settledAtMs) => tasks.recordSettlement(command.meta, result, { startedAtMs: command.startedAtMs, settledAtMs }),
    }, quiet),
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled(active);
      // A command that lands after this finds the pool closed and discards its copy.
      privateCopies.close();
    },
  };
}
