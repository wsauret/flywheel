/**
 * Tracks the agent loop's running estimate of the prompt-token cost the next
 * turn will incur. Two values cooperate:
 *
 *   - the current prepared outbound snapshot: exact request messages after
 *     egress transforms plus that candidate's system prompt and tool schemas.
 *   - provider prompt usage and the snapshot captured for the same sent
 *     request, so later estimates measure only prepared-request growth.
 *
 * The anchor resets to zero on compaction. Until the next API call lands, the
 * prepared outbound snapshot is the estimate.
 */

import type { ServingAttempt, StreamEvent } from "./llm/types.js";

export interface OutgoingContextSnapshot {
  /** Heuristic cost of the messages that this request sends after egress transforms. */
  readonly messageTokens: number;
  /** Heuristic cost of the exact system prompt and tools prepared for this candidate. */
  readonly staticTokens: number;
  /** Stable identity of the provider candidate and prepared static prefix. */
  readonly anchorKey: string;
}

interface ContextTokenAnchorInput {
  /** Provider facts of the request currently being estimated. */
  attempt: () => ServingAttempt;
  /** Derived active request; the sent usage baseline remains immutable. */
  current: () => OutgoingContextSnapshot;
  onEvent: (event: StreamEvent) => void;
}

interface InputTokenClasses {
  readonly uncachedInputTokens: number;
  readonly cacheTokens: number;
}

interface ContextTokenAnchor {
  /** Estimated prompt-token count for the next prepared provider request. */
  estimate(): number;
  /** Estimated provider billing classes for the next prepared request. */
  estimateInputTokenClasses(): InputTokenClasses;
  /** Emit a `context_update` event with the current estimate. */
  emit(): void;
  /** Called once per stream completion with the usage anchor from the `done`
   *  event. The next estimate measures the delta from these values. */
  observeApiUsage(
    anchor: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
    sentRequest: OutgoingContextSnapshot,
  ): void;
  /** Compaction reset: discards the anchor so the next estimate falls back
   *  to the static + heuristic baseline. */
  reset(): void;
}

export function createContextTokenAnchor(input: ContextTokenAnchorInput): ContextTokenAnchor {
  let lastApiInputTokens: {
    readonly inputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  } | undefined;
  let sentRequestAtLastApiCall: OutgoingContextSnapshot | undefined;

  function estimateInputTokenClasses(): InputTokenClasses {
    const snapshot = input.current();
    if (lastApiInputTokens !== undefined && sentRequestAtLastApiCall?.anchorKey === snapshot.anchorKey) {
      const cacheTokens = lastApiInputTokens.cacheReadTokens + lastApiInputTokens.cacheWriteTokens;
      const preparedGrowth = snapshot.staticTokens - sentRequestAtLastApiCall.staticTokens
        + snapshot.messageTokens - sentRequestAtLastApiCall.messageTokens;
      const totalTokens = Math.max(0, lastApiInputTokens.inputTokens + cacheTokens + preparedGrowth);
      const remainingCacheTokens = Math.min(cacheTokens, totalTokens);
      return {
        uncachedInputTokens: totalTokens - remainingCacheTokens,
        cacheTokens: remainingCacheTokens,
      };
    }
    return { uncachedInputTokens: snapshot.staticTokens + snapshot.messageTokens, cacheTokens: 0 };
  }

  function estimate(): number {
    const classes = estimateInputTokenClasses();
    return classes.uncachedInputTokens + classes.cacheTokens;
  }

  return {
    estimate,
    estimateInputTokenClasses,
    emit() {
      input.onEvent({
        kind: "context_update",
        promptTokens: estimate(),
        contextWindow: input.attempt().contextLimit,
      });
    },
    observeApiUsage(anchor, sentRequest) {
      lastApiInputTokens = anchor;
      sentRequestAtLastApiCall = sentRequest;
    },
    reset() {
      lastApiInputTokens = undefined;
      sentRequestAtLastApiCall = undefined;
    },
  };
}
