import { mergeAbortSignals } from "../../../infra/timing/abort.js";
import type { OwnedProcess } from "../../../infra/supervision/launch/owned-subprocess.js";
import type { CommandHandoverRow } from "../../session/command-handover.js";
import type { BackgroundWorkRegistry } from "../../session/control/background-work/background-work.js";
import { adoptHandedOverCommands, handedOverCommandInput, handOverCommands, type CommandHandoverScope } from "./command-handover.js";
import { adoptCreatedWorktrees, handOverCreatedWorktrees } from "./worktree-handover.js";
import type { ToolContext, ToolResult } from "../tools/types.js";
import { createPrivateCopyPool, type PrivateCopyPool } from "../tools/bash/private-copy/bash-private-copy-pool.js";
import { startManagedCommand, type ManagedCommand } from "../tools/bash/execution/managed-command.js";
import { createCreatedWorktrees } from "../tools/bash/git/created-worktrees.js";
import { DEFAULT_EXECUTION_OUTPUT_THROTTLE_MS, POST_EXIT_DRAIN_GRACE_MS, runManagedShell } from "../tools/bash/execution/shell-execution.js";
import type { ManagedShellExecutionOptions, ShellRuntime, ShellRuntimeClient } from "../tools/bash/execution/shell-runtime-types.js";
import { sharedProcessorClaims, type ProcessorClaims } from "../tools/bash/execution/processor-claims.js";

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
  /** Binds each launch to this host's registry and cancellation, and claims
   *  its container for processor admission until the container settles or is
   *  handed to a later owner. Returning a tool result or transferring the
   *  command to the registry does not end the claim. */
  const executionOwner = (input: ShellExecutionOwnerInput) => {
    const context = { ...input.context, signal: mergeAbortSignals(input.context.signal, ownerSignal) };
    return {
      context,
      registry: tasks,
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
    const input = handedOverCommandInput(host, row, privateCopies);
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
  const launch = (options: ManagedShellExecutionOptions): Promise<ToolResult> => {
    if (closed) throw new Error("shell runtime is closed");
    const result = runManagedShell({ ...options, ...executionOwner(options) });
    active.add(result);
    void result.then(() => active.delete(result), () => active.delete(result));
    return result;
  };
  const worktrees = createCreatedWorktrees();
  const client: ShellRuntimeClient = Object.freeze({
    hasActiveCommands: () => active.size > 0 || tasks.processRecords().some((process) =>
      process.kind === "background_command" && (process.status === "running" || process.status === "stopping")),
    run: launch,
    privateCopies,
    worktrees,
  });
  return {
    client,
    // The running commands are read here, when the handover begins, so a
    // command that settles from now on is the handover's to account for.
    handOver: async (host) => {
      await Promise.all([handOverCommands(host, tasks.handoverCandidates()), handOverCreatedWorktrees(host, worktrees.entries())]);
    },
    adopt: async (host, quiet) => {
      await adoptCreatedWorktrees(host, worktrees.adopt);
      return adoptHandedOverCommands(host, {
        privateCopies,
        stream: (toolUseId, text) => tasks.streamExecutionOutput(toolUseId, text),
        start: (row, owned) => startHandedOver(host, row, owned),
        holds: (processId) => tasks.processCommand(processId) !== undefined,
        record: (command, result, settledAtMs) => tasks.recordSettlement(command.meta, result, { startedAtMs: command.startedAtMs, settledAtMs }),
      }, quiet);
    },
    async close() {
      closed = true;
      abort.abort();
      await Promise.allSettled(active);
      // A command that lands after this lands on a Worker of its own, and the
      // closed pool takes no copy back.
      await privateCopies.close();
    },
  };
}
