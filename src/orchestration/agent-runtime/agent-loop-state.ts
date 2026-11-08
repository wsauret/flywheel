import type { AssistantTurnResult } from "./assistant-turn-result.js";

/** Two automatic continuations are allowed; the third consecutive overflow stops. */
export const OUTPUT_OVERFLOW_CONTINUATION_LIMIT = 2;

export interface AgentLoopState {
  readonly turn: number;
  readonly llmCalls: number;
  readonly overflowRecoveryAttempted: boolean;
  /** Settled output overflows since the last successful response or new user request. */
  readonly consecutiveOutputOverflows: number;
  /** The loop's one explicit wait, independent of model requests. */
  readonly wait?: OpenWait;
  /** Present while the turn is the person's (`PersonWait`). */
  readonly personWait?: PersonWait;
}

/** The turn waits for the person: an interrupt handed it back, or a
 *  maintenance start found the last turn so (an interrupt, an unexpected
 *  exit, or a stall). Only their message or Resume authorizes the next
 *  request; every other input folds into history, and a compaction parks
 *  for them again and records nothing new. `turnEnd` says whether a
 *  recorded turn end carries the wait, which every compaction reset carries
 *  past itself (ARCH-SESSIONS-035); a stall, an Escape on a park whose turn
 *  already ended, or a loop that cannot record one records none. */
export interface PersonWait {
  readonly turnEnd: "recorded" | "unrecorded";
}

/** An explicit wait that parked on live work: a `process` wait, a yield
 *  placeholder, a call that holds a reply wait, the runtime's own wait for
 *  pending work, or a wait restored after a restart. It outlives the model
 *  requests that follow it (a runtime notice, the reply nudge, a compaction),
 *  so the turn end that follows parks on it. Only a wake from the work, its
 *  expiry, a person's message or Resume, or an interrupt ends it, and a later
 *  wait replaces it. `expiry` holds the requested duration, which the expiry
 *  notice states, and the deadline that each park arms the rest of; it is
 *  absent for a park-only wait. `replyWaitIds` names the reply waits it
 *  holds: their reply, a message from another session, is its wake. */
export interface OpenWait {
  readonly expiry?: WaitExpiry;
  readonly replyWaitIds: readonly string[];
}

export interface WaitExpiry {
  readonly seconds: number;
  readonly deadlineMs: number;
}

/** A wait of `seconds` from now, or park-only when `seconds` is undefined. */
export function openWaitFor(seconds: number | undefined, replyWaitIds: readonly string[] = []): OpenWait {
  return { ...(seconds === undefined ? {} : { expiry: { seconds, deadlineMs: Date.now() + seconds * 1000 } }), replyWaitIds };
}

export const initialAgentLoopState: AgentLoopState = {
  turn: 0,
  llmCalls: 0,
  overflowRecoveryAttempted: false,
  consecutiveOutputOverflows: 0,
};

/** Pure state transitions shared by every loop iteration. */
export const agentLoopTransition = {
  turnStarted: (state: AgentLoopState): AgentLoopState => ({ ...state, turn: state.turn + 1 }),
  /** The open wait meets the input that starts the turn on its own rule (`endsOpenWait`). A
   *  turn that starts is no longer the person's: only their message or Resume starts one then. */
  logicalTurnStarted: (state: AgentLoopState, origin: "user" | "background"): AgentLoopState => ({
    ...state,
    personWait: undefined,
    overflowRecoveryAttempted: false,
    consecutiveOutputOverflows: origin === "user" ? 0 : state.consecutiveOutputOverflows,
  }),
  llmCallStarted: (state: AgentLoopState): AgentLoopState => ({ ...state, llmCalls: state.llmCalls + 1 }),
  responseSettled: (state: AgentLoopState, outcome: AssistantTurnResult["outcome"]): AgentLoopState => ({
    ...state,
    // A served response is progress, so a later overflow earns a fresh compaction.
    overflowRecoveryAttempted: outcome.kind === "ok" ? false : state.overflowRecoveryAttempted,
    consecutiveOutputOverflows: outcome.kind === "ok" ? 0 : state.consecutiveOutputOverflows + (outcome.kind === "output_overflow" ? 1 : 0),
  }),
  overflowRecoveryStarted: (state: AgentLoopState): AgentLoopState => ({ ...state, overflowRecoveryAttempted: true }),
  waitOpened: (state: AgentLoopState, wait: OpenWait): AgentLoopState => ({ ...state, wait }),
  waitClosed: (state: AgentLoopState): AgentLoopState => ({ ...state, wait: undefined }),
  /** An interrupt gives the person the turn and ends the open wait in one step. */
  turnHandedBack: (state: AgentLoopState): AgentLoopState => ({ ...state, wait: undefined, personWait: state.personWait ?? { turnEnd: "unrecorded" } }),
  /** The interrupt's turn end landed in the tree and in the loop's history. */
  turnEndRecorded: (state: AgentLoopState): AgentLoopState => ({ ...state, personWait: { turnEnd: "recorded" } }),
};

/** What one run did, for the one record of its completion. The loop keeps it
 *  current; the runner reads it once, when the run ends. */
export interface AgentRunTally {
  turns: number;
  requests: number;
  toolCalls: number;
  failedToolCalls: number;
  /** Times the run parked for input: one for each turn a chat finished. */
  parks: number;
  /** Model requests whose response the provider delivered (outcome `ok`). */
  served: number;
  /** The provider's stop reason for the run's last response. */
  stopReason: string | undefined;
}

export function createAgentRunTally(): AgentRunTally {
  return { turns: 0, requests: 0, toolCalls: 0, failedToolCalls: 0, parks: 0, served: 0, stopReason: undefined };
}

/** Counts one batch of tool results into the tally. */
export function tallyToolResults(tally: AgentRunTally, results: readonly { readonly outcome: string }[]): void {
  tally.toolCalls += results.length;
  tally.failedToolCalls += results.filter((result) => result.outcome === "error").length;
}
