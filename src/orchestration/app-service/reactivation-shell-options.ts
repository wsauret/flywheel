import type { AnyBlock } from "../../infra/output-blocks.js"
import type { ChatSessionView } from "../session-store/view.js"
import type { SessionRuntimeOptions } from "../session-store/types.js"

/** Shell options for re-activating a durable chat. priorBlocks seeds the
 * DISPLAY with a bounded tail of durable history (never the whole history).
 * outputSequenceStart and visibleMessageCountPrefix are the absolute block and
 * visible-message coordinates represented by priorBlocks[0].
 * Model context never flows through here - it comes from seedContext plus
 * the SQLite chat tree. Numeric fields pass through unchanged. */
export function reactivationShellOptions(
  view: ChatSessionView,
  priorBlocks: AnyBlock[],
  durableBlockCount: number,
  durableVisibleMessageCount: number,
): SessionRuntimeOptions {
  return {
    sessionId: view.id,
    conversationId: view.conversationId,
    description: view.description,
    shortDescription: view.shortDescription,
    initialCost: view.cost,
    initialBilledCost: view.billedCost,
    initialTokens: view.tokens,
    startedAt: view.startedAt,
    contextPercent: view.contextPercent,
    accumulatedActiveMs: view.accumulatedActiveMs,
    providerConversationId: view.providerConversationId,
    seedContext: view.seedContext,
    ...(priorBlocks.length > 0 ? { priorBlocks } : {}),
    outputSequenceStart: durableBlockCount - priorBlocks.length,
    visibleMessageCountPrefix: durableVisibleMessageCount,
  }
}
