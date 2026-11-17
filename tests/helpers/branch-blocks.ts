import type { AnyBlock } from "../../src/infra/output-blocks.js"
import { BranchHistoryBuilder, type BranchHistoryBuilderOptions } from "../../src/orchestration/session/conversation/branch-history-builder.js"
import type { ConversationTreeTranscriptEntry } from "../../src/orchestration/session/conversation/conversation-projection.js"

/** The history of a stored branch, folded entry by entry through the builder
 *  that the transcript projection uses. */
export function branchHistory(entries: readonly ConversationTreeTranscriptEntry[], options: BranchHistoryBuilderOptions): ReturnType<BranchHistoryBuilder["snapshot"]> {
  const builder = new BranchHistoryBuilder(options)
  for (const entry of entries) builder.add(entry)
  return builder.snapshot()
}

/** The transcript blocks of a stored branch, as `branchHistory` folds them. */
export function branchBlocks(entries: readonly ConversationTreeTranscriptEntry[], options: BranchHistoryBuilderOptions): AnyBlock[] {
  return [...branchHistory(entries, options).blocks]
}
