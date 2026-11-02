import type { IndexedBlockReader } from "../../src/orchestration/session/conversation/branch-history-builder.js"

/** Explicit complete-body read for equivalence assertions, not a production read path. */
export async function readAllOutputBlocks(history: IndexedBlockReader | null | undefined) {
  return history ? Promise.all(Array.from({ length: history.blockCount }, (_, index) => history.readBlock(index))) : []
}
