import { isYieldPlaceholderToolCall } from "./tools/bash-command-policy.js";
import { DEFAULT_WAIT_SECONDS, formatWaitNoopNotification, isParkingWaitCall, processWaitSeconds } from "./tools/process.js";
import type { ToolCall } from "./llm/types.js";
import { agentLoopTransition, type AgentLoopState } from "./agent-loop-state.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { RestoredAgentWait } from "./agent-loop-types.js";
import type { ToolResultEntry } from "./agent-state.js";
import type { TurnOutcome } from "./assistant-turn-result.js";
import { createRepetitionGuard } from "./doom-loop.js";

/** Restores the original deadline only while work can still wake the turn.
 *  A park-only start (`RestoredAgentWait.parkOnly`) arms no deadline, since
 *  an expiry notice starts a request, and with no work left it delivers no
 *  nothing-pending notice either: the loop parks with nothing running, and
 *  work that registers later, a message, or Resume wakes it. */
export function restoreAgentLoopWait(
  state: AgentLoopState,
  wait: RestoredAgentWait,
  tasks: Pick<BackgroundWorkRegistry, "waitableTaskCount"> | undefined,
  enqueueRuntimeNotice: ((text: string) => void) | undefined,
): AgentLoopState {
  if ((tasks?.waitableTaskCount() ?? 0) > 0) return agentLoopTransition.waitRequested(state, wait.parkOnly ? undefined : Math.max(0, (wait.deadlineMs - Date.now()) / 1000));
  if (!wait.parkOnly) enqueueRuntimeNotice?.(formatWaitNoopNotification());
  return state;
}

export interface WaitToolPolicy {
  readonly isWaitCall: (call: ToolCall) => boolean;
  /** Returns whether the calls park the turn on live work. */
  readonly settleWaitCalls: (calls: readonly ToolCall[]) => boolean;
}

export function createWaitToolPolicy(
  hasLiveBackgroundWork: () => boolean,
  markWaitRequested: (seconds: number | undefined) => void,
  enqueueRuntimeNotice?: (content: string) => void,
  /** Whether a call opened a reply wait that is still open. Such a call is a
   *  wait: the turn parks after its batch until the reply or another end. */
  holdsWait?: (toolUseId: string) => boolean,
): WaitToolPolicy {
  return {
    isWaitCall: (call) => isParkingWaitCall(call)
      || isYieldPlaceholderToolCall(call, hasLiveBackgroundWork())
      || holdsWait?.(call.id) === true,
    settleWaitCalls: (calls) => {
      if (calls.length === 0) return false;
      if (hasLiveBackgroundWork()) {
        const seconds = calls.map((call) => isParkingWaitCall(call) ? processWaitSeconds(call.input) : undefined).find((duration) => duration !== undefined);
        markWaitRequested(seconds ?? (calls.some((call) => isYieldPlaceholderToolCall(call, true)) ? DEFAULT_WAIT_SECONDS : undefined));
        return true;
      }
      enqueueRuntimeNotice?.(formatWaitNoopNotification());
      return false;
    },
  };
}

export interface SettledBatchObservation {
  /** Settles the batch's successful wait calls, then, for a response that did
   *  not fail, shows the batch to the repetition guard and runs the batch
   *  hook. A notice enqueued here reaches the next request with this batch's
   *  results. A failed response settles first: a notice must never turn a
   *  request failure into another request. */
  readonly observe: (calls: readonly ToolCall[], results: readonly Pick<ToolResultEntry, "toolUseId" | "outcome">[], outcome: TurnOutcome["kind"]) => Promise<void>;
  /** Starts the repetition history again, at a person message or Resume. */
  readonly reset: () => void;
}

/** The loop's one observer of a settled tool batch. A wait that parked on
 *  live work is a wait by design, so it never counts as a repeated call. */
export function createSettledBatchObservation(
  waits: WaitToolPolicy,
  enqueueRuntimeNotice: (text: string) => void,
  onToolBatchSettled: () => void | Promise<void>,
): SettledBatchObservation {
  const repetitionGuard = createRepetitionGuard();
  return {
    observe: async (calls, results, outcome) => {
      const waitCalls = calls.filter((call) => waits.isWaitCall(call) && results.some((result) => result.toolUseId === call.id && result.outcome === "ok"));
      const parkedWaitIds = new Set(waits.settleWaitCalls(waitCalls) ? waitCalls.map((call) => call.id) : []);
      if (outcome === "stream_error" || outcome === "context_overflow") return;
      const repetitionNotice = repetitionGuard.observeBatch(calls, parkedWaitIds);
      if (repetitionNotice) enqueueRuntimeNotice(repetitionNotice);
      await onToolBatchSettled();
    },
    reset: () => { repetitionGuard.reset(); },
  };
}
