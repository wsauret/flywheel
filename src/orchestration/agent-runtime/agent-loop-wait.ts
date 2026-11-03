import { isYieldPlaceholderToolCall } from "./tools/bash-command-policy.js";
import { DEFAULT_WAIT_SECONDS, formatWaitNoopNotification, isParkingWaitCall, processWaitSeconds } from "./tools/process.js";
import type { ToolCall } from "./llm/types.js";
import { agentLoopTransition, type AgentLoopState } from "./agent-loop-state.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { RestoredAgentWait } from "./agent-loop-types.js";
import type { ToolResultEntry } from "./agent-state.js";
import type { TurnOutcome } from "./assistant-turn-result.js";
import { createRepetitionGuard } from "./doom-loop.js";

/** The tag of the notice that a wait's expiry delivers, which ends the wait. */
export const WAIT_EXPIRED_TAG = "wait_expired";

/** Whether a stored message's content is the notice of a wait's expiry. */
function isWaitExpiredNotice(content: unknown): boolean {
  return typeof content === "string" && content.startsWith(`<${WAIT_EXPIRED_TAG}>`);
}

/** One input that an open wait meets: a Resume, or a message in the live
 *  loop's input shape (`origin` `human`, `session`, or `silent-system`) or in
 *  its stored shape (`origin` `human` or `system`; a notification keeps
 *  `replyRequired` where the ids it carried live are gone). */
export type OpenWaitInput =
  | { readonly kind: "resume"; readonly continuesWait: boolean }
  | {
      readonly kind: "message";
      readonly origin?: string;
      readonly producer?: { readonly kind: string };
      readonly backgroundNotificationIds?: readonly string[];
      readonly replyRequired?: true;
      readonly content?: unknown;
    };

/** Whether one input ends the open wait that holds `replyWaitIds`: a
 *  background notification, the notice of the wait's expiry, a person's
 *  message, a Resume that does not continue a planned cut's wait, or, for a
 *  message from another session, the reply that ends a reply wait the open
 *  wait holds (the registry ends that reply wait before the message
 *  commits, so `holdsWait` no longer names it). Every other input, such as a
 *  runtime or module notice, the reply nudge, or an unrelated session's
 *  message, only re-drives the turn. The live loop and the restore reader
 *  both decide by this rule, so a restart restores the wait the live loop
 *  held. */
export function endsOpenWait(input: OpenWaitInput, replyWaitIds: readonly string[], holdsWait: (toolUseId: string) => boolean): boolean {
  if (input.kind === "resume") return !input.continuesWait;
  if ((input.backgroundNotificationIds?.length ?? 0) > 0 || input.replyRequired === true || isWaitExpiredNotice(input.content)) return true;
  if (input.producer?.kind === "session") return replyWaitIds.some((id) => !holdsWait(id));
  return input.origin !== "system" && input.origin !== "silent-system";
}

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
  if ((tasks?.waitableTaskCount() ?? 0) > 0) return agentLoopTransition.waitOpened(state, { ...(wait.parkOnly || !wait.expiry ? {} : { expiry: wait.expiry }), replyWaitIds: wait.replyWaitIds });
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
  markWaitRequested: (seconds: number | undefined, replyWaitIds: readonly string[]) => void,
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
        markWaitRequested(
          seconds ?? (calls.some((call) => isYieldPlaceholderToolCall(call, true)) ? DEFAULT_WAIT_SECONDS : undefined),
          // A process wait or a placeholder is a wait by its own input; asking
          // whether it holds a reply wait would cost a restore a read.
          calls.flatMap((call) => !isParkingWaitCall(call) && !isYieldPlaceholderToolCall(call, true) && holdsWait?.(call.id) === true ? [call.id] : []),
        );
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
   *  request failure into another request. Returns whether the batch's own
   *  wait calls parked on live work, so the turn parks after the batch. */
  readonly observe: (calls: readonly ToolCall[], results: readonly Pick<ToolResultEntry, "toolUseId" | "outcome">[], outcome: TurnOutcome["kind"]) => Promise<boolean>;
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
      const parks = waits.settleWaitCalls(waitCalls);
      if (outcome === "stream_error" || outcome === "context_overflow") return parks;
      const repetitionNotice = repetitionGuard.observeBatch(calls, new Set(parks ? waitCalls.map((call) => call.id) : []));
      if (repetitionNotice) enqueueRuntimeNotice(repetitionNotice);
      await onToolBatchSettled();
      return parks;
    },
    reset: () => { repetitionGuard.reset(); },
  };
}
