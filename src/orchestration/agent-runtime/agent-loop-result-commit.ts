import { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import { asRecord } from "../../infra/record.js";
import { finalizedToolResultCheckpointSwaps } from "../session/finalized-tool-result-checkpoint.js";
import type { AgentLoopOptions } from "./agent-loop-types.js";
import type { ToolResultEntry } from "./agent-state.js";
import type { TurnSettlementRequest } from "./agent-turn-settlement.js";

/**
 * The canonical append of one settled tool batch (`TurnSettlementRequest.commitResults`). `deliver` appends a batch
 * that has results; the host's durability barrier then runs for every turn. A barrier write that the store refuses
 * for a batch with mutation evidence fails at the `final-result` stage.
 */
export function createToolResultCommit(
  deliver: (results: readonly ToolResultEntry[]) => Promise<void>,
  flushCanonicalMessages: AgentLoopOptions["flushCanonicalMessages"],
): TurnSettlementRequest<unknown>["commitResults"] {
  return async (results, calls) => {
    if (results.length > 0) await deliver(results);
    // The barrier is owed by every turn, not only a turn with results:
    // an assistant-only turn still enqueued a canonical message, and
    // publication or re-raise must wait for it to be durable.
    try { await flushCanonicalMessages?.(undefined, finalizedToolResultCheckpointSwaps(calls)); }
    catch (error) {
      if (error instanceof PersistenceWriteRefused && calls.some((call) => asRecord(call.details)?.mutationEvidence)) error.stage = "final-result";
      throw error;
    }
  };
}
