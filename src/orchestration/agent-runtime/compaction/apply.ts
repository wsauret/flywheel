import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import type { AgentLoopOptions, CompactionAfter, CompactionInstallation } from "../agent-loop-types.js";
import type { ConversationMessage, StreamEvent } from "../llm/types.js";

const log = Log.create({ service: "agent-loop" });

export interface ApplyCompactionInput {
  messages: ConversationMessage[];
  onEvent: (event: StreamEvent) => void;
  /** Pre-compaction context-token estimate captured by the caller before
   *  any mutation to `messages`, recorded in the durable compaction entry. */
  tokensBefore: number;
  /** Prepare the exact post-commit content and accounting without changing live history. */
  prepareCompactedHistory: () => CompactionInstallation | Promise<CompactionInstallation>;
  /** What follows the reset, which the durable record states. */
  after: CompactionAfter;
  /** The loop waits for the person on the last turn's recorded turn end, so
   *  the reset carries that record past itself (`RecordCompaction`). */
  carryTurnEnd: boolean;
  emitContextUpdate: () => void;
  options: AgentLoopOptions;
  /** Voluntary resets can be withdrawn until the durable writer accepts them. */
  signal?: AbortSignal;
}

export interface ApplyCompactionResult {
  applied: boolean;
  newMessages: ConversationMessage[];
}

/** Resets the context and, on success, threads the durable record through the
 *  optional chat boundary. Single shared shape for the three agent-loop call
 *  sites (manual `/compact`, proactive compaction, context-overflow recovery)
 *  so persistence ordering cannot drift between paths. The caller saved a
 *  session checkpoint first; the reset carries no prior messages. */
export async function applyCompaction(input: ApplyCompactionInput): Promise<ApplyCompactionResult> {
  const startedAt = Date.now();
  input.onEvent({ kind: "compaction_start" });
  let newMessages: ConversationMessage[] = [];
  let recorded = false;
  const installation = await input.prepareCompactedHistory();
  const persistence = input.options.persistence;
  if (persistence.recordCompaction) {
    try {
      const rebuiltMessages = await persistence.recordCompaction({
        tokensBefore: input.tokensBefore,
        additions: installation.additions,
        after: input.after,
        carryTurnEnd: input.carryTurnEnd,
        measureTokensAfter: installation.measure,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (rebuiltMessages) {
        newMessages = [...rebuiltMessages];
        recorded = true;
      }
    } catch (err) {
      if (!input.signal?.aborted) log.warn("durable compaction record failed", { error: errorMessage(err) });
      input.onEvent({ kind: "compaction_done", success: false, durationMs: Date.now() - startedAt });
      return { applied: false, newMessages: input.messages };
    }
  }
  const tokensAfter = await installation.install(newMessages, recorded);
  // Done-before-context_update: consumers treat the context measurement as
  // the first post-compaction reading.
  input.onEvent({
    kind: "compaction_done",
    success: true,
    durationMs: Date.now() - startedAt,
    tokensBefore: input.tokensBefore,
    tokensAfter,
  });
  input.emitContextUpdate();
  return {
    applied: true,
    newMessages,
  };
}
