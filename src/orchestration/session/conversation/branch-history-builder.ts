import { isVisibleMessageBlock, type AnyBlock, type ToolEntry } from "../../../infra/output-blocks.js"
import type { ConversationTreeTranscriptEntry } from "./conversation-projection.js"
import { TreeBlockProjection, type ToolBlockReader, type TreeBlockProjectionOptions } from "./conversation-block-projection.js"
import type { ToolResultDisplayMeta } from "./tool-result-meta.js"
import type { ToolHistorySummary } from "../../module-seams.js"
import type { ToolExecutionEntry } from "../tool-execution-types.js"
import { blockEntryKeys, blockIdentity } from "../../../protocol/block-identity.js"

export interface BranchHistory {
  readonly blocks: readonly AnyBlock[]
  readonly consistencyToken: string
  readonly tipEntryId: string | null
}

/** Absolute display coordinates. Reading an identity or count never resolves tool content. */
export interface IndexedBlockReader {
  readonly blockCount: number
  readonly visibleMessageCount: number
  indexOf(blockId: string): number
  /** The first block a chat entry (or tool use) produced, or -1. */
  indexOfEntry(entryId: string): number
  readBlock(index: number): AnyBlock | Promise<AnyBlock>
}

/** The first index per entry key, from identities in display order. */
export function indexEntries(identities: readonly string[]): Map<string, number> {
  const entries = new Map<string, number>()
  for (const [index, identity] of identities.entries()) {
    for (const key of blockEntryKeys(identity)) if (!entries.has(key)) entries.set(key, index)
  }
  return entries
}

export interface IndexedGroupChildren {
  readonly totalCount: number
  readonly settledCount?: number
  readonly blockCount: number
  readBlock(index: number): ToolEntry | Promise<ToolEntry>
}

export interface IndexedTranscript extends IndexedBlockReader {
  readonly consistencyToken: string
  readonly tipEntryId: string | null
  /** The slots that the history of an agent of a workflow shows: every slot
   *  except a user message that no person or session wrote, which is a seeded
   *  brief. */
  readonly visibleUserFilteredIndices: readonly number[]
  /** The block ids of the calls of the conversation's open turn: each call
   *  that has no result and that no turn end closed. A conversation does not
   *  record whether its turn still runs, so these calls read interrupted; a
   *  reader that knows the turn runs shows them running. */
  readonly openCallIds: ReadonlySet<string>
  /** The operations of a card. A settled card's are its run's operations,
   *  counted by the run's measured figures, so they resolve when read. */
  groupChildren(blockId: string): Promise<IndexedGroupChildren>
}

/** Index an already-owned array, without copying its bodies. */
export function indexOutputBlocks(blocks: readonly AnyBlock[]): Omit<IndexedBlockReader, "readBlock"> & { readBlock(index: number): AnyBlock } {
  const identities = blocks.map((block) => blockIdentity(block))
  const indices = new Map(identities.map((identity, index) => [identity, index]))
  const entries = indexEntries(identities)
  for (const [index, block] of blocks.entries()) {
    if (block.kind === "agentGroup" && !entries.has(block.toolUseId)) entries.set(block.toolUseId, index)
  }
  return {
    blockCount: blocks.length,
    visibleMessageCount: blocks.filter(isVisibleMessageBlock).length,
    indexOf: (id) => indices.get(id) ?? -1,
    indexOfEntry: (entryId) => entries.get(entryId) ?? -1,
    readBlock(index) {
      const block = blocks[index]
      if (!block) throw new Error("Output block index is out of bounds")
      return block
    },
  }
}

export interface BranchHistoryTail {
  readonly blocks: readonly AnyBlock[]
  readonly blockCount: number
}

export type BranchHistoryBuilderOptions = TreeBlockProjectionOptions & {
  readonly runtimeInvocations?: ReadonlyMap<string, readonly ToolExecutionEntry[]>
}

export class BranchHistoryBuilder {
  private readonly projection: TreeBlockProjection
  private readonly runtimeInvocations: ReadonlyMap<string, readonly ToolExecutionEntry[]>
  private tipEntryId: string | null = null

  constructor(options: BranchHistoryBuilderOptions) {
    this.projection = new TreeBlockProjection(options)
    this.runtimeInvocations = options.runtimeInvocations ?? new Map()
  }

  add(entry: ConversationTreeTranscriptEntry): void {
    this.projection.add(entry)
    if (entry.kind !== "degraded") {
      for (const invocation of this.runtimeInvocations.get(entry.id) ?? []) {
        this.projection.addRuntimeWorkflowInvocation(invocation)
      }
    }
    if (entry.kind !== "degraded") this.tipEntryId = entry.id
  }

  updateToolResultMeta(toolUseId: string, meta: ToolResultDisplayMeta): void {
    this.projection.updateToolResultMeta(toolUseId, meta)
  }

  updateToolSummary(run: ToolHistorySummary): void {
    this.projection.updateToolSummary(run)
  }

  toolBlockReader(block: Extract<AnyBlock, { kind: "tool" | "agentGroup" }>): ToolBlockReader {
    return this.projection.toolBlockReader(block)
  }

  snapshot(): BranchHistory {
    return {
      blocks: this.projection.snapshot(),
      consistencyToken: branchHistoryConsistencyToken(this.tipEntryId),
      tipEntryId: this.tipEntryId,
    }
  }

  finish(): BranchHistory {
    return this.snapshot()
  }
}

export function buildBranchHistoryFromEntries(
  entries: readonly ConversationTreeTranscriptEntry[],
  options: BranchHistoryBuilderOptions,
): BranchHistory {
  const builder = new BranchHistoryBuilder(options)
  for (const entry of entries) builder.add(entry)
  return builder.finish()
}

/** Fold the branch once and slice the display tail. blockCount is the length
 * of the same fold the durable read path projects, so the reactivation seed's
 * absolute coordinate (blockCount - blocks.length) can never drift from the
 * durable transcript. */
export function buildBranchHistoryTailFromEntries(
  entries: readonly ConversationTreeTranscriptEntry[],
  options: BranchHistoryBuilderOptions,
  limit: number,
): BranchHistoryTail {
  const boundedLimit = Math.max(0, Math.floor(limit))
  const blocks = buildBranchHistoryFromEntries(entries, options).blocks
  return { blocks: blocks.slice(Math.max(0, blocks.length - boundedLimit)), blockCount: blocks.length }
}


function branchHistoryConsistencyToken(tipEntryId: string | null): string {
  return `chat-tree:v1:${tipEntryId ?? "root"}`
}