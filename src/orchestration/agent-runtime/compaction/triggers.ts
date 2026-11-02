// Every path by which the agent loop triggers compaction: the manual /compact
// command, the proactive token-cap threshold, and context-overflow recovery.
// Each one resets the context through applyCompaction after the agent has
// saved a session checkpoint.
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { applyCompaction, type ApplyCompactionInput, type ApplyCompactionResult } from "./apply.js";
import type { ConversationMessage } from "../llm/types.js";
import type { CompactionAfter } from "../agent-loop-types.js";

const log = Log.create({ service: "agent-loop" });

export type PlannedCompactionOperation =
  | { kind: "automatic"; after: "continue" }
  | { kind: "idle"; after: "park"; saved?: boolean }
  | { kind: "manual"; after: CompactionAfter };

export function runProactiveCompaction(input: ApplyCompactionInput & { contextLimit: number }): Promise<ApplyCompactionResult> {
  log.info("proactive compaction triggered", {
    contextTokens: input.tokensBefore,
    contextLimit: input.contextLimit,
  });
  return applyCompaction(input);
}

export async function runManualVisibleCompaction(input: ApplyCompactionInput): Promise<ConversationMessage[] | null> {
  if (input.messages.length === 0) return null;
  log.info("manual compaction requested");
  try {
    const result = await applyCompaction(input);
    return result.applied ? result.newMessages : null;
  } catch (err) {
    log.error("manual compaction failed", { error: errorMessage(err) });
    return null;
  }
}

export type ReactiveOverflowAttempt =
  | { kind: "exhausted" }
  | { kind: "recovered"; result: ApplyCompactionResult };

/** One reactive context-overflow recovery attempt: acquire the one-shot guard,
 *  then reset the context. The caller owns the loop's state mutations. */
export async function attemptContextOverflowRecovery(input: ApplyCompactionInput & {
  guard: { tryAcquire(): boolean };
  contextLimit: number;
  turnCount: number;
}): Promise<ReactiveOverflowAttempt> {
  if (!input.guard.tryAcquire()) {
    log.warn("context length exceeded again after recovery this turn; failing typed instead of churning", {
      contextLimit: input.contextLimit,
      turnCount: input.turnCount,
    });
    return { kind: "exhausted" };
  }
  log.warn("context length exceeded, resetting context", {
    tokensBefore: input.tokensBefore,
    contextLimit: input.contextLimit,
  });
  return { kind: "recovered", result: await applyCompaction(input) };
}
