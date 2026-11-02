import { truncateUnifiedDiff } from "../../infra/mutation-diff.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../infra/output-blocks.js"
import { getToolDisplay } from "../../infra/tools/tool-display-registry.js"
import { compactGroupChild, projectFrontendOutputBlocks } from "./frontend-output-blocks.js"
import { frontendOutputBlockBytes } from "../../protocol/frontend-output-block-metrics.js"
import { minOutputRangeRecords, projectRecordsWithinRangeBudget, trimOutputRangeFromTail } from "./output-range-budget.js"
import { threadHistoryRangeIndices, type BranchHistoryRecord } from "../session/conversation/branch-history-pagination.js"
import type { IndexedBlockReader, IndexedGroupChildren } from "../session/conversation/branch-history-builder.js"
import type {
  HydratedOutputGroupChildren,
  HydratedOutputGroupChildrenBatch,
  HydratedOutputRange,
  HydratedOutputBlockBody,
  OutputGroupChildrenRequest,
  TranscriptUnavailable,
  RuntimeTranscriptWindow,
  OutputRangeAnchor,
  OutputRangeRequest,
  OutputBlockBodyRequest,
} from "../../protocol/transcript-protocol-types.js"

export interface DerivedOutputHistory extends IndexedBlockReader {
  readonly consistencyToken: string
}



export function unavailableHydratedOutputRange(anchor: OutputRangeAnchor, unavailable: TranscriptUnavailable): HydratedOutputRange {
  return { kind: "unavailable", consistencyToken: null, anchor, window: emptyWindow(), unavailable }
}



export async function hydrateDerivedOutputRange(history: DerivedOutputHistory, request: OutputRangeRequest): Promise<HydratedOutputRange> {
  const options = rangeHydrationOptions(request)
  const page = threadHistoryRangeIndices(history, request.anchor, request.maxBlocks)
  const aroundIndex = page.anchor.kind === "around" ? history.indexOfEntry(page.anchor.entryId) : undefined
  // Budget the target first, then contiguous neighbours. Spending from the
  // oldest edge can exhaust the byte budget before the requested entry.
  const indices = aroundIndex === undefined ? page.indices : page.indices.toSorted((left, right) => Math.abs(left - aroundIndex) - Math.abs(right - aroundIndex))
  const records = await projectRecordsWithinRangeBudget({
    records: indices,
    maxBytes: request.maxBytes,
    fromTail: trimOutputRangeFromTail(page.anchor),
    minRecords: page.minRecords ?? minOutputRangeRecords(page.anchor, page.indices.length),
    project: async (blockIndex) => projectDerivedRecord({ blockIndex, block: await history.readBlock(blockIndex) }, options),
    measure: (record) => frontendOutputBlockBytes(record.block),
  })
  if (aroundIndex !== undefined) records.sort((left, right) => left.blockIndex - right.blockIndex)
  return {
    kind: "ok",
    consistencyToken: history.consistencyToken,
    anchor: page.anchor,
    window: windowFromDerivedRecords(records, history.blockCount),
    blocks: records.map((record) => record.block),
    streamingToolText: {},
    streamingOutputChars: 0,
    ...(page.membership === undefined ? {} : { membership: page.membership }),
  }
}

export function hydrateDerivedOutputGroupChildren(
  groupBlockId: string,
  children: IndexedGroupChildren,
) {
  if (children.settledCount !== undefined && children.settledCount !== children.totalCount) {
    throw new Error(`derived output group ${groupBlockId} expected ${children.settledCount} operations, found ${children.totalCount}`)
  }
  return {
    groupBlockId,
    totalChildren: children.blockCount,
    readBlock: children.readBlock,
  }
}

export async function paginateOutputGroupChildren(
  groups: readonly ReturnType<typeof hydrateDerivedOutputGroupChildren>[],
  request: OutputGroupChildrenRequest,
): Promise<HydratedOutputGroupChildrenBatch> {
  const startGroupIndex = request.cursor
    ? groups.findIndex((group) => group.groupBlockId === request.cursor?.groupBlockId)
    : 0
  if (startGroupIndex < 0) throw new Error(`output group continuation ${request.cursor?.groupBlockId ?? ""} is not in the request`)
  const page: HydratedOutputGroupChildren[] = groups.map((group) => ({ groupBlockId: group.groupBlockId, totalChildren: group.totalChildren, contentBytes: 0, children: [] }))
  let contentBytes = 0
  for (let groupIndex = startGroupIndex; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]
    if (!group) continue
    const childStart = groupIndex === startGroupIndex ? request.cursor?.childIndex ?? 0 : 0
    if (childStart > group.totalChildren) throw new Error(`output group continuation index ${childStart} exceeds ${group.groupBlockId}`)
    for (let childIndex = childStart; childIndex < group.totalChildren; childIndex += 1) {
      const child = compactGroupChild(await group.readBlock(childIndex))
      const childBytes = frontendOutputBlockBytes(child)
      if (childBytes > request.maxBytes) throw new Error(`output group child ${child.id} exceeds the ${request.maxBytes}-byte response budget`)
      if (contentBytes + childBytes > request.maxBytes) {
        return { groups: page, contentBytes, nextCursor: { groupBlockId: group.groupBlockId, childIndex } }
      }
      const pageGroup = page[groupIndex]
      if (!pageGroup) continue
      page[groupIndex] = {
        ...pageGroup,
        contentBytes: pageGroup.contentBytes + childBytes,
        children: [...pageGroup.children, child],
      }
      contentBytes += childBytes
    }
  }
  return { groups: page, contentBytes }
}

/** Read retained tool, notice, or user-image bodies without the row's wire omissions. */
export async function hydrateDerivedOutputBlockBody(history: IndexedBlockReader, request: OutputBlockBodyRequest): Promise<HydratedOutputBlockBody> {
  const index = history.indexOf(request.blockId)
  if (index < 0 && request.blockId.startsWith("userMessage:")) return { blockId: request.blockId, missing: true }
  if (index < 0) throw new Error(`output block ${request.blockId} is missing from derived history`)
  const block = await history.readBlock(index)
  if (block.kind === "userMessage") {
    return { blockId: request.blockId, ...(block.images !== undefined ? { images: block.images } : {}) }
  }
  if (block.kind === "system") {
    return {
      blockId: request.blockId,
      ...(block.mutationEvidence !== undefined ? { mutationEvidence: block.mutationEvidence } : {}),
    }
  }
  if (block.kind !== "tool") throw new Error(`output block ${request.blockId} is missing from derived history`)
  return {
    blockId: request.blockId,
    ...(block.invocationBody !== undefined ? { invocationBody: block.invocationBody } : {}),
    ...(block.mutationEvidence === undefined && block.diff !== undefined ? { diff: block.diff } : {}),
    ...(block.content !== undefined ? { content: block.content } : {}),
    ...(block.filetype !== undefined ? { filetype: block.filetype } : {}),
    ...(block.mutationEvidence !== undefined ? { mutationEvidence: block.mutationEvidence } : {}),
    ...(block.mutationEvidence === undefined && block.proposedDiff !== undefined ? { proposedDiff: block.proposedDiff } : {}),
  }
}

interface RangeHydrationOptions {
  readonly includeThinkingContent: boolean
}

function rangeHydrationOptions(request: { readonly includeThinkingContent?: boolean }): RangeHydrationOptions {
  return {
    includeThinkingContent: request.includeThinkingContent !== false,
  }
}

type DerivedFrontendRecord = {
  readonly blockIndex: number
  readonly block: ReturnType<typeof projectFrontendOutputBlocks>[number]
}


function projectDerivedRecord(record: BranchHistoryRecord, options: RangeHydrationOptions): DerivedFrontendRecord {
  const [block] = projectFrontendOutputBlocks([record.block])
  if (!block) throw new Error("Derived output block projection returned no block")
  return {
    blockIndex: record.blockIndex,
    block: visibleDerivedBlock(block, options),
  }
}

/** Whether every read of the block gives the block itself, with settled
 *  thinking shown and with it omitted. Only such a block can change by edits:
 *  a client that installed it from a read holds the same copy the delta path
 *  last shipped, so edits measured from that copy apply to what it holds. */
export function readsAsShipped(block: ReturnType<typeof projectFrontendOutputBlocks>[number]): boolean {
  return visibleDerivedBlock(block, { includeThinkingContent: true }) === block && visibleDerivedBlock(block, { includeThinkingContent: false }) === block
}

/** Whether a read of `copy`, with settled thinking shown or omitted, serves
 *  `served`: a client that installed `served` holds what the copy shows. */
export function readGives(copy: ReturnType<typeof projectFrontendOutputBlocks>[number], served: ReturnType<typeof projectFrontendOutputBlocks>[number]): boolean {
  return Bun.deepEquals(visibleDerivedBlock(copy, { includeThinkingContent: true }), served) || Bun.deepEquals(visibleDerivedBlock(copy, { includeThinkingContent: false }), served)
}

/** Shapes ordinary bodies for ranges. Mutation rows already carry bounded roots. */
function visibleDerivedBlock(block: ReturnType<typeof projectFrontendOutputBlocks>[number], options: RangeHydrationOptions): ReturnType<typeof projectFrontendOutputBlocks>[number] {
  // Only settled thought is omitted. A thought still streaming keeps its text,
  // because its live appends continue from the offset it has reached; a blank
  // copy would make every one of them disagree with the window.
  if (block.kind === "thinking" && block.status === "completed" && !options.includeThinkingContent) return { ...block, content: "" }
  if (block.kind !== "tool") return block
  const toolAction = getToolDisplay(block.name).action
  let tool = block
  if (tool.mutationEvidence !== undefined && tool.diff !== undefined) {
    const { diff: _legacyDiff, ...canonical } = tool
    tool = canonical
  }
  if (tool.invocationBody !== undefined) {
    const omittedBytes = Buffer.byteLength(tool.invocationBody.content, "utf8")
    const { invocationBody: _invocationBody, ...shell } = tool
    tool = { ...shell, invocationBodyOmittedBytes: omittedBytes }
  }
  if (tool.diff !== undefined) {
    const preview = truncateUnifiedDiff(tool.diff, TOOL_PREVIEW_LINE_LIMIT)
    if (preview.omitted > 0) {
      tool = { ...tool, diff: preview.text, diffOmission: { kind: "aggregate", omittedLines: preview.omitted } }
    }
  }
  if (tool.content === undefined) return tool
  if (toolAction === "file_write" || toolAction === "handoff_write") {
    // Artifact content (file writes, handoffs) previews like a diff.
    const preview = headLines(tool.content, TOOL_PREVIEW_LINE_LIMIT)
    return preview.omitted > 0 ? { ...tool, content: preview.text, contentOmittedLines: preview.omitted } : tool
  }
  const { content, ...shell } = tool
  return { ...shell, contentOmittedLines: countLines(content) }
}

function headLines(text: string, limit: number) {
  const lines = text.split("\n")
  if (lines.length <= limit) return { text, omitted: 0 }
  return { text: lines.slice(0, limit).join("\n"), omitted: lines.length - limit }
}


function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1
  }
  return lines
}



function windowFromDerivedRecords(
  records: readonly DerivedFrontendRecord[],
  totalBlocks: number,
): RuntimeTranscriptWindow {
  const first = records[0]
  const last = records.at(-1)
  return {
    startBlockIndex: first?.blockIndex ?? null,
    endBlockIndex: last?.blockIndex ?? null,
    hasBefore: first ? first.blockIndex > 0 : false,
    hasAfter: last ? last.blockIndex < totalBlocks - 1 : false,
    contentBytes: records.reduce((sum, record) => sum + frontendOutputBlockBytes(record.block), 0),
  }
}


function emptyWindow(): RuntimeTranscriptWindow {
  return { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 }
}
