import type { FrontendOutputBlock } from "../app-service-types.js"
import { blockIdentity } from "../block-identity.js"
import type { HydratedOutputRange, OutputRangeAnchor } from "../transcript-protocol-types.js"
import type { OutputDelta } from "../output-protocol-types.js"
import { foldAgentGroupBlock, totalBlocksAfterDelta } from "./transcript-delta.js"
import type { TranscriptReader, TranscriptView } from "./transcript-store.js"
import type { RuntimePosition } from "../runtime-ui-protocol-types.js"

/** Insert identity can refresh without growing the window, so its applied
 * end, not its operation count, determines the total. */
export function totalAfterDelta(view: TranscriptView, delta: OutputDelta, appliedLength: number): number {
  return delta.blocks.some((change) => change.kind === "insert")
    ? Math.max(view.totalBlocks, (view.startBlockIndex ?? 0) + appliedLength)
    : totalBlocksAfterDelta(view.totalBlocks, delta)
}

/** Retains fetched children when a bounded wire tail updates their owner. */
export function foldHydratedGroups(groups: TranscriptView["groups"], next: FrontendOutputBlock): TranscriptView["groups"] {
  const hydrated = next.kind === "agentGroup" ? groups[next.id] : undefined
  if (next.kind !== "agentGroup" || hydrated === undefined) return groups
  const folded = foldAgentGroupBlock({ ...next, children: [...hydrated.children] }, next)
  return folded.kind === "agentGroup" ? { ...groups, [next.id]: { children: folded.children, total: next.totalToolCount } } : groups
}

/** Builds the same bounded request for tail, anchor, and paging reads. */
export function transcriptRangeRequest(anchor: OutputRangeAnchor, maxBlocks: number, maxBytes: number, includeThinkingContent: (() => boolean) | undefined) {
  return { anchor, maxBlocks, maxBytes, ...(includeThinkingContent === undefined ? {} : { includeThinkingContent: includeThinkingContent() }) }
}

/** The window of a store that holds nothing yet. */
export const EMPTY_TRANSCRIPT_VIEW: TranscriptView = {
  appliedOutputPosition: null,
  atTail: true,
  hasNewer: false,
  blocks: [],
  streamingToolText: {},
  bodies: {},
  groups: {},
  groupRequests: {},
  startBlockIndex: null,
  totalBlocks: 0,
  visibleMessageCount: 0,
  streamingOutputChars: 0,
  hasBefore: false,
  consistencyToken: null,
  historicalThroughIndex: -1,
}

/** An authoritative window with its causal position and optional tail proof. */
export interface ReadWindow {
  readonly range: Extract<HydratedOutputRange, { readonly kind: "ok" }>
  readonly totalBlocks: number
  readonly visibleMessageCount: number
  readonly snapshotPosition: RuntimePosition
  readonly settlementRecovery: string | undefined
}

/** Convert one authoritative read into current coordinates, retaining only
 * unchanged body owners. Cursor seeding remains the store's responsibility. */
export function windowFromRead(tail: ReadWindow, previous: TranscriptView, index: ReadonlyMap<string, number>): TranscriptView {
  const blocks = tail.range.blocks
  const unchangedGroups = new Set(blocks.filter((block) => block.kind === "agentGroup" && unchangedOwner(previous, index, block)).map(bodyId))
  return {
    appliedOutputPosition: tail.snapshotPosition,
    atTail: !tail.range.window.hasAfter,
    hasNewer: tail.range.window.hasAfter,
    blocks,
    streamingToolText: tail.range.streamingToolText,
    bodies: previous.bodies,
    groups: retainPayloads(previous.groups, (id) => unchangedGroups.has(id)),
    groupRequests: previous.groupRequests,
    startBlockIndex: tail.range.window.startBlockIndex,
    totalBlocks: tail.totalBlocks,
    visibleMessageCount: tail.visibleMessageCount,
    streamingOutputChars: tail.range.streamingOutputChars,
    hasBefore: tail.range.window.hasBefore,
    consistencyToken: tail.range.consistencyToken,
    historicalThroughIndex: historicalThrough(tail.range, -1),
  }
}

/** A read around an entry that does not reach the live end, as a page of
 *  history: it proves no live coverage and keeps every fetched payload. */
export function detachedWindowFromRead(read: ReadWindow, previous: TranscriptView): TranscriptView {
  const { range } = read
  return {
    appliedOutputPosition: null,
    atTail: false,
    hasNewer: true,
    blocks: range.blocks,
    streamingToolText: range.streamingToolText,
    bodies: previous.bodies,
    groups: previous.groups,
    groupRequests: previous.groupRequests,
    startBlockIndex: range.window.startBlockIndex,
    totalBlocks: read.totalBlocks,
    visibleMessageCount: read.visibleMessageCount,
    streamingOutputChars: range.streamingOutputChars,
    hasBefore: range.window.hasBefore,
    consistencyToken: range.consistencyToken,
    historicalThroughIndex: historicalThrough(range, -1),
  }
}

/** Whether the view shows no blocks while its counts say the session has
 *  output: an empty pane that a person would read as a lost transcript. */
export function showsNothingOfOutput(view: TranscriptView): boolean {
  return view.blocks.length === 0 && (view.totalBlocks > 0 || view.visibleMessageCount > 0)
}

/** Exact identities, not the old coordinate revision, choose recovery. */
export function recoveryAnchor(view: TranscriptView, index: ReadonlyMap<string, number>, reader: TranscriptReader | undefined, latest: boolean): OutputRangeAnchor {
  if (latest || view.blocks.length === 0 || reader?.following !== false || reader.blockIds.length === 0) return { kind: "tail" }
  const first = reader.blockIds.map((id) => index.get(id)).find((offset) => offset !== undefined)
  const candidates = first === undefined ? [] : view.blocks.slice(Math.max(0, first - 8), first).toReversed().map(blockIdentity)
  return { kind: "residentSpan", blockIds: reader.blockIds, candidates }
}

/** A reader can move while a read is pending. Only its current destination may
 * replace the presentation that is still on screen. */
export function readerAccepts(read: ReadWindow, view: TranscriptView, index: ReadonlyMap<string, number>, reader: TranscriptReader | undefined, latest: boolean): boolean {
  const anchor = recoveryAnchor(view, index, reader, latest)
  return anchor.kind === "residentSpan" ? coversResidentSpan(read.range, anchor) : read.range.anchor.kind !== "residentSpan"
}

/** Explicit eviction is subject to the same reader protection as a page commit. */
export function protectedCut(cut: number, start: number | null, index: ReadonlyMap<string, number>, reader: TranscriptReader | undefined): number {
  if (reader?.following !== false || start === null) return cut
  let protectedIndex = cut
  for (const id of reader.blockIds) {
    const local = index.get(id)
    if (local !== undefined) protectedIndex = Math.min(protectedIndex, start + local)
  }
  return protectedIndex
}

/** Detached windows apply retained-owner updates, not new off-screen members.
 * A changed coordinate inside the span needs authoritative identity recovery. */
export function detachedDelta(delta: OutputDelta, view: TranscriptView, index: ReadonlyMap<string, number>): OutputDelta | undefined {
  const start = view.startBlockIndex ?? 0
  const end = start + view.blocks.length
  if ((delta.truncateTo !== undefined && delta.truncateTo < end)
    || delta.blocks.some((change) => change.index < end && (change.kind === "insert" || change.index >= start) && !index.has(change.blockId))) return undefined
  return {
    visibleMessageCount: delta.visibleMessageCount ?? view.visibleMessageCount,
    blocks: delta.blocks.filter((change) => index.has(change.blockId)),
    streamingToolTextOps: delta.streamingToolTextOps?.filter((change) => index.has(`tool:${change.toolUseId}`)),
  }
}

interface BoundedTranscriptWindow {
  readonly view: TranscriptView
  readonly droppedHead: number
}

/** History ends at the furthest derived read; a live window has no settled rows. */
export function historicalThrough(range: Extract<HydratedOutputRange, { readonly kind: "ok" }>, previous: number): number {
  return range.consistencyToken === null ? -1 : Math.max(previous, range.window.endBlockIndex ?? -1)
}

/** The fetched-body key, including questions whose owner is a tool call. */
export function bodyId(block: FrontendOutputBlock): string {
  return block.kind === "question" ? block.toolUseId : "id" in block ? block.id : ""
}

/** Whether a fetched payload's owner still has the same wire content. */
export function unchangedOwner(view: TranscriptView, index: ReadonlyMap<string, number>, next: FrontendOutputBlock): boolean {
  const offset = index.get(blockIdentity(next))
  const prior = offset === undefined ? undefined : view.blocks[offset]
  return prior !== undefined && (prior === next || JSON.stringify(prior) === JSON.stringify(next))
}

/** Bound one window and retain only payloads still owned by its resident blocks. */
export function boundedWindow(
  next: TranscriptView,
  previous: TranscriptView,
  previousIndex: ReadonlyMap<string, number>,
  maxResident: number,
  keep: "newest" | "oldest",
  protectedIds: readonly string[] = [],
): BoundedTranscriptWindow {
  const protectedSet = new Set(protectedIds)
  const protectedIndices = next.blocks.flatMap((block, index) => protectedSet.has(blockIdentity(block)) ? [index] : [])
  const first = protectedIndices[0]
  const last = protectedIndices.at(-1)
  const size = first === undefined || last === undefined ? maxResident : Math.max(maxResident, last - first + 1)
  const excess = Math.max(0, next.blocks.length - size)
  const desiredStart = keep === "newest" ? excess : 0
  const droppedHead = first === undefined || last === undefined ? desiredStart : Math.max(0, last - size + 1, Math.min(desiredStart, first))
  const blocks = excess === 0 ? next.blocks : next.blocks.slice(droppedHead, Math.max(droppedHead + size, (last ?? -1) + 1))
  const resident = new Map(blocks.map((block) => [bodyId(block), block]))
  const bodies = retainPayloads(next.bodies, (id) => {
    const block = resident.get(id)
    return block !== undefined && unchangedOwner(previous, previousIndex, block)
  })
  const groups = retainPayloads(next.groups, (id) => resident.get(id)?.kind === "agentGroup")
  const groupRequests = retainPayloads(next.groupRequests, (id) => resident.get(id)?.kind === "agentGroup")
  const trimmedEnd = droppedHead + blocks.length < next.blocks.length
  const atTail = next.atTail && !trimmedEnd
  return {
    view: {
      ...next, blocks, bodies, groups, groupRequests,
      appliedOutputPosition: atTail ? next.appliedOutputPosition : null,
      startBlockIndex: blocks.length === 0 ? null : (next.startBlockIndex ?? 0) + droppedHead,
      hasBefore: next.hasBefore || droppedHead > 0,
      atTail,
      hasNewer: next.hasNewer || trimmedEnd,
    },
    droppedHead,
  }
}

/** Recovery is adoptable only when exact membership covers every surviving
 * protected identity in one contiguous page. A soft page omission is not deletion. */
export function coversResidentSpan(range: ReadWindow["range"], anchor: Extract<OutputRangeAnchor, { kind: "residentSpan" }>): boolean {
  if (range.anchor.kind !== "residentSpan" || range.membership === undefined) return false
  const membership = new Map(range.membership.map((member) => [member.blockId, member.index]))
  const start = range.window.startBlockIndex
  const end = range.window.endBlockIndex
  if (range.blocks.length > 0 && (start === null || end === null || end - start + 1 !== range.blocks.length)) return false
  for (const id of [...anchor.blockIds, ...anchor.candidates]) if (!membership.has(id)) return false
  const surviving = anchor.blockIds.filter((id) => membership.get(id) !== null)
  const required = surviving.length > 0 ? surviving : anchor.candidates.filter((id) => membership.get(id) !== null).slice(0, 1)
  return required.every((id) => {
    const index = membership.get(id)
    const block = index === undefined || index === null || start === null ? undefined : range.blocks[index - start]
    return block !== undefined && blockIdentity(block) === id
  })
}

/** The window after a delta that only rewrote resident slots, without the
 *  whole-window pass of `boundedWindow`. The window keeps its length, so the
 *  bound trims nothing, and every slot the delta did not touch still holds the
 *  block its payloads were admitted for. So only a fetched body whose owner
 *  slot changed can lose its owner. Groups need no pass: an agent group folds
 *  its fetched children as its slot changes, and group payloads exist only for
 *  resident groups. Answers undefined when a rewrite changed a slot's identity
 *  or kind; the caller then bounds the window whole, as for any other delta. */
export function rewrittenWindow(
  next: TranscriptView,
  previous: TranscriptView,
  previousIndex: ReadonlyMap<string, number>,
  rewrites: readonly { readonly localIndex: number; readonly prior: FrontendOutputBlock | undefined }[],
): TranscriptView | undefined {
  let bodies = next.bodies
  for (const { localIndex, prior } of rewrites) {
    const block = next.blocks[localIndex]
    if (block === undefined || prior?.kind !== block.kind || blockIdentity(prior) !== blockIdentity(block)) return undefined
    const id = bodyId(block)
    if (bodies[id] !== undefined && !unchangedOwner(previous, previousIndex, block)) bodies = retainPayloads(bodies, (key) => key !== id)
  }
  return bodies === next.bodies ? next : { ...next, bodies }
}

export function retainPayloads<T>(payloads: { readonly [id: string]: T }, keep: (id: string) => boolean): { readonly [id: string]: T } {
  let retained: { [id: string]: T } | undefined
  for (const id of Object.keys(payloads)) {
    if (keep(id)) continue
    retained ??= { ...payloads }
    // oxlint-disable-next-line typescript/no-dynamic-delete -- payloads are an ID-keyed dictionary; copy-on-first-eviction preserves unchanged view identity.
    delete retained[id]
  }
  return retained ?? payloads
}

/** Whether one page meets the resident window, and which of its blocks are
 *  new. Live writes can evict the requested anchor during the read, so only
 *  the response's overlap with the current window is a duplicate, and every
 *  overlapping identity must agree with the resident one: a page whose
 *  indexes disagree with the window would put a hole in every index-aligned
 *  consumer downstream. Answers the reason it does not meet, for the
 *  diagnostic sink, instead of the splice. */
export function pageSplice(
  direction: "older" | "newer",
  page: Extract<HydratedOutputRange, { readonly kind: "ok" }>,
  resident: { readonly startBlockIndex: number | null; readonly blocks: readonly FrontendOutputBlock[] },
  residentIndex: ReadonlyMap<string, number>,
): { readonly kind: "splice"; readonly blocks: readonly FrontendOutputBlock[]; readonly pageStart: number; readonly pageEnd: number } | { readonly kind: "refused"; readonly reason: string } {
  const start = resident.startBlockIndex
  const { startBlockIndex: pageStart, endBlockIndex: pageEnd } = page.window
  if (page.blocks.length === 0) return { kind: "refused", reason: `${direction} transcript page came back empty` }
  if (start === null || pageStart === null || pageEnd === null || pageEnd - pageStart + 1 !== page.blocks.length) {
    return { kind: "refused", reason: `${direction} transcript page does not meet the resident window` }
  }
  const end = start + resident.blocks.length - 1
  if (direction === "older") {
    if (pageStart > start || pageEnd < start - 1) return { kind: "refused", reason: "older transcript page does not meet the resident window" }
    const prefixLength = start - pageStart
    const disagrees = page.blocks.some((block, offset) => {
      const index = residentIndex.get(blockIdentity(block))
      return offset < prefixLength ? index !== undefined : index !== offset - prefixLength
    })
    if (disagrees) return { kind: "refused", reason: "older transcript page identities disagree with the resident window" }
    const prefix = page.blocks.slice(0, prefixLength)
    if (prefix.length === 0) return { kind: "refused", reason: "older transcript page held no earlier blocks" }
    return { kind: "splice", blocks: prefix, pageStart, pageEnd }
  }
  if (pageEnd < end || pageStart > end + 1) return { kind: "refused", reason: "newer transcript page does not meet the resident window" }
  const overlap = end + 1 - pageStart
  const disagrees = page.blocks.some((block, offset) => {
    const index = residentIndex.get(blockIdentity(block))
    return offset < overlap ? index !== pageStart + offset - start : index !== undefined
  })
  if (disagrees) return { kind: "refused", reason: "newer transcript page identities disagree with the resident window" }
  const suffix = page.blocks.slice(overlap)
  if (suffix.length === 0) return { kind: "refused", reason: "newer transcript page held no later blocks" }
  return { kind: "splice", blocks: suffix, pageStart, pageEnd }
}
