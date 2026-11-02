import type { AnyBlock } from "../../../infra/output-blocks.js"
import type { IdentifiedBlock } from "../../../protocol/block-identity.js"
import type { OutputRangeAnchor } from "../../../protocol/transcript-protocol-types.js"

export type BranchHistoryRangeAnchor = OutputRangeAnchor

export interface BranchHistoryRecord<B extends IdentifiedBlock = AnyBlock> {
  readonly blockIndex: number
  readonly block: B
}

/** Select absolute coordinates before any row bodies are materialized. */
export function threadHistoryRangeIndices(
  history: { readonly blockCount: number; indexOf(id: string): number; indexOfEntry(entryId: string): number },
  anchor: BranchHistoryRangeAnchor,
  limit: number,
) {
  const count = history.blockCount
  const bounded = Math.max(0, Math.min(limit, count))
  if (anchor.kind === "residentSpan") {
    const membership = [...anchor.blockIds, ...anchor.candidates].map((blockId) => {
      const index = history.indexOf(blockId)
      return { blockId, index: index < 0 ? null : index }
    })
    const surviving = membership.slice(0, anchor.blockIds.length).flatMap((member) => member.index === null ? [] : [member.index])
    const fallback = membership.slice(anchor.blockIds.length).find((member) => member.index !== null)?.index
    const first = surviving.length > 0 ? Math.min(...surviving) : fallback ?? Math.max(0, count - bounded)
    const last = surviving.length > 0 ? Math.max(...surviving) : first
    const span = count === 0 ? 0 : last - first + 1
    const size = Math.max(bounded, span)
    const end = Math.min(count, first + size)
    return { anchor, membership, minRecords: span, indices: Array.from({ length: end - first }, (_, offset) => first + offset) }
  }
  const index = anchor.kind === "tail" ? -1 : anchor.kind === "around" ? history.indexOfEntry(anchor.entryId) : history.indexOf(anchor.blockId)
  // An edge or centre that is gone has no window of its own; the newest
  // window is the resync every such caller wants, and the served anchor
  // reports the substitution.
  const served = (anchor.kind === "afterBlock" || anchor.kind === "around") && index < 0 ? { kind: "tail" as const } : anchor
  if (!bounded || (served.kind === "beforeBlock" && index < 0)) return { anchor: served, indices: [] }
  const start = served.kind === "tail" ? count - bounded
    : served.kind === "beforeBlock" ? Math.max(0, index - bounded + 1)
    : served.kind === "around" ? Math.max(0, Math.min(index - Math.floor(bounded / 2), count - bounded))
    : index
  const end = served.kind === "beforeBlock" ? index + 1 : Math.min(count, start + bounded)
  return { anchor: served, indices: Array.from({ length: end - start }, (_, offset) => start + offset) }
}
