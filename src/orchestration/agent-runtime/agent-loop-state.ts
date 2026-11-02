import type { AssistantTurnResult } from "./assistant-turn-result.js";

/** Two automatic continuations are allowed; the third consecutive overflow stops. */
export const OUTPUT_OVERFLOW_CONTINUATION_LIMIT = 2;

export interface AgentLoopState {
  readonly turn: number;
  readonly llmCalls: number;
  readonly overflowRecoveryAttempted: boolean;
  /** Settled output overflows since the last successful response or new user request. */
  readonly consecutiveOutputOverflows: number;
  readonly waitRequested: boolean;
  readonly waitTimeoutSeconds?: number;
}

export const initialAgentLoopState: AgentLoopState = {
  turn: 0,
  llmCalls: 0,
  overflowRecoveryAttempted: false,
  consecutiveOutputOverflows: 0,
  waitRequested: false,
};

/** Pure state transitions shared by every loop iteration. */
export const agentLoopTransition = {
  turnStarted: (state: AgentLoopState): AgentLoopState => ({ ...state, turn: state.turn + 1, waitRequested: false, waitTimeoutSeconds: undefined }),
  logicalTurnStarted: (state: AgentLoopState, origin: "user" | "background"): AgentLoopState => ({
    ...state,
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
  waitRequested: (state: AgentLoopState, seconds: number | undefined): AgentLoopState => ({ ...state, waitRequested: true, waitTimeoutSeconds: seconds }),
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
