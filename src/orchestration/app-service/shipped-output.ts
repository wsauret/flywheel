import type { ToolStreamingText } from "../../infra/output-blocks.js"
import type { StreamingToolTextOp } from "../../infra/output/output-block-delta.js"
import { diffStreamingEntry, diffValues } from "../../infra/output/streaming-text-diff.js"
import type { FrontendOutputBlock } from "../../protocol/app-service-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { appendText, editableBlock } from "../../protocol/client/streaming-text-edits.js"
import { outputCursor, type OutputBlockDelta, type OutputDelta } from "../../protocol/output-protocol-types.js"
import type { HydratedOutputRange } from "../../protocol/transcript-protocol-types.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import { partitionStreamingTextDelta } from "./streaming-text-partition.js"
import { readGives, readsAsShipped } from "./transcript-queries.js"

/** A block change in wire form, before the owner measures it against the
 *  copy it last shipped. */
export type ProjectedBlockChange = Exclude<OutputBlockDelta, { readonly kind: "edit" }>

type StreamingToolTextMap = { readonly [toolUseId: string]: ToolStreamingText }

/** What one publisher drained for a session. `streamingToolText` is the live
 *  map read together with the drain, so a settle's removal ships in the same
 *  delta as its settled block. `streamingOutputChars` is the session's
 *  streamed character count, which only the session's runner states. A change
 *  to streaming text alone, from outside the session's runner, carries no
 *  block coordinates. */
type OutputUpdate = {
  readonly streamingToolText: StreamingToolTextMap
  readonly streamingOutputChars?: number
  /** The tools the drain names. A resync measures every tool instead. */
  readonly changedTools: ReadonlySet<string>
} & ({
  readonly visibleMessageCount: number
  /** The session's absolute block count after this update. */
  readonly blockCount: number
  readonly blocks:
    | { readonly kind: "changes"; readonly changes: readonly ProjectedBlockChange[] }
    | { readonly kind: "resync"; readonly sequenceStart: number; readonly blocks: readonly FrontendOutputBlock[] }
} | {
  readonly visibleMessageCount?: never
  readonly blockCount?: never
  readonly blocks?: never
})

/** The one publisher of each session's output cursor. Every output publisher
 *  of a session ships through the same instance, which owns the copy of each
 *  block and streaming entry that the session's clients last received. */
export interface ShippedOutput {
  /** Measures the update against the shipped copies, records the new copies,
   *  and publishes the result in one synchronous step, so the copies follow
   *  the cursor's order. */
  ship(sessionId: string, update: OutputUpdate): void
  /** Runs `read`, a read of the session's output whose blocks a client
   *  installs over the cursor position taken just before this call, and
   *  returns its result. `range` names the blocks and streaming text the read
   *  served. */
  serve<T>(sessionId: string, read: () => Promise<T>, range: (result: T) => HydratedOutputRange): Promise<T>
  /** Makes the session's clients reread their windows, and forgets the copies
   *  they held: the session's block coordinates changed, or a drained change
   *  could not ship. */
  rebase(sessionId: string): void
  /** Forgets the session's copies, because its output ended. */
  forget(sessionId: string): void
  /** Whether any client follows the session's live output: every session
   *  until the first `watch`, then the sessions it names. */
  watches(sessionId: string): boolean
  /** Replaces the set of sessions whose output ships with `sessionIds`, the
   *  union of what the clients watch, and returns the sessions it adds.
   *  `ship` drops the update of a session outside the set and `serve` keeps
   *  no copy of its reads, and a session that leaves the set forgets its
   *  copies. A client that watches it again reads it after the watch, so its
   *  next block upsert, resync, and streaming entry ship whole over that
   *  read, and an append continues from the content offset the read holds.
   *  `rebase` publishes for every session, watched or not. */
  watch(sessionIds: readonly string[]): readonly string[]
}

/** What the clients of one session hold, as far as this owner shipped it.
 *  Copies are the unfolded wire blocks, by absolute index; `indexById` maps
 *  each identity to its index, as a client's block index does. */
interface SessionCopies {
  readonly blocks: Map<number, FrontendOutputBlock>
  readonly indexById: Map<string, number>
  /** The end of the blocks the clients can hold, or undefined before an
   *  update. A read can raise it past the session's block count. */
  heldEnd: number | undefined
  visibleMessageCount: number | undefined
  /** The streamed character count the clients hold, or undefined when a
   *  read served them another. It starts at zero: a client holds no count of
   *  the session until it reads it, and the read reconciles this copy. */
  streamingOutputChars: number | undefined
  readonly streaming: Map<string, ToolStreamingText>
  /** The reads of this session in flight. */
  reads: number
}

/** Owns the shipped copies of every session's output and publishes each
 *  delta as the smallest change from them:
 *
 *  - A block upsert equal to its copy is dropped.
 *  - A changed block ships as an `edit` against its copy when every read of
 *    both versions gives the block itself, so a client that installed the
 *    block from a read holds the same base. It ships whole when it is new,
 *    when another identity held its index, when the change is a rewrite, or
 *    when it is a subagent card, which clients fold by child.
 *  - A full resync keeps the longest prefix that matches the copies by
 *    identity and changes only that prefix's blocks in place; it truncates at
 *    the first index without a matching copy, or at the new end.
 *  - A streaming entry ships whole when it first appears or changes kind, as
 *    its edits while it grows, and as a removal when it ends.
 *  - The streamed character count ships when it differs from the count the
 *    clients hold. A count change alone ships with no block coordinates.
 *
 *  A read serves the session's store, which can hold changes no delta has
 *  shipped yet, and a client installs it over a cursor position taken before
 *  it. While a read is in flight, every change ships whole and a resync
 *  repaves the whole tail, so whatever the read holds, the deltas that follow
 *  it replace. When the read ends, the owner drops each copy that the read
 *  disagrees with and counts the read's blocks as held, so the next change
 *  there ships whole and the next resync truncates what the read added. */
export function createShippedOutput(deps: { readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch }): ShippedOutput {
  const sessions = new Map<string, SessionCopies>()
  // Undefined until the first statement: an executor that no account
  // serves, such as a headless run, ships every session.
  let watched: ReadonlySet<string> | undefined
  const watches = (sessionId: string): boolean => watched === undefined || watched.has(sessionId)
  const copiesOf = (sessionId: string): SessionCopies => {
    let copies = sessions.get(sessionId)
    if (!copies) {
      copies = { blocks: new Map(), indexById: new Map(), heldEnd: undefined, visibleMessageCount: undefined, streamingOutputChars: 0, streaming: new Map(), reads: 0 }
      sessions.set(sessionId, copies)
    }
    return copies
  }
  return {
    ship(sessionId, update) {
      if (!watches(sessionId)) return
      const delta = measure(copiesOf(sessionId), update)
      if (delta) for (const part of partitionStreamingTextDelta(delta)) deps.publish({ cursor: outputCursor(sessionId), payload: { kind: "output.delta", delta: part } })
    },
    async serve(sessionId, read, range) {
      // Nothing ships for an unwatched session, so no copy measures against
      // this read; a client that watches it later reads again after its watch.
      if (!watches(sessionId)) return read()
      const copies = copiesOf(sessionId)
      copies.reads += 1
      try {
        const result = await read()
        // A rebase or the end of the output during the read voided these
        // copies, and with them what the read served.
        if (sessions.get(sessionId) === copies) reconcile(copies, range(result))
        return result
      } finally {
        copies.reads -= 1
        // A read of a session that never shipped leaves nothing to keep.
        if (copies.reads === 0 && copies.blocks.size === 0 && copies.streaming.size === 0 && copies.heldEnd === undefined && copies.streamingOutputChars === 0 && sessions.get(sessionId) === copies) sessions.delete(sessionId)
      }
    },
    rebase(sessionId) {
      deps.publish({ cursor: outputCursor(sessionId), payload: { kind: "runtime.invalidate", reason: "rebase" } })
      sessions.delete(sessionId)
    },
    forget(sessionId) {
      sessions.delete(sessionId)
    },
    watches,
    watch(sessionIds) {
      const next = new Set(sessionIds)
      const added = watched === undefined ? [] : sessionIds.filter((sessionId) => !watched?.has(sessionId))
      for (const sessionId of sessions.keys()) if (!next.has(sessionId)) sessions.delete(sessionId)
      watched = next
      return added
    },
  }
}

function measure(copies: SessionCopies, update: OutputUpdate): OutputDelta | undefined {
  const chars = measureChars(copies, update.streamingOutputChars)
  if (update.blocks === undefined) {
    const streamingToolTextOps = measureStreaming(copies, update.streamingToolText, update.changedTools)
    return streamingOnly(streamingToolTextOps, chars)
  }
  const { blocks, truncateTo } = update.blocks.kind === "resync"
    ? measureResync(copies, update.blocks.sequenceStart, update.blocks.blocks)
    : { blocks: measureChanges(copies, update.blocks.changes), truncateTo: undefined }
  copies.heldEnd = update.blockCount
  const streamingToolTextOps = measureStreaming(copies, update.streamingToolText, update.blocks.kind === "resync" ? undefined : update.changedTools)
  // A count that changed alone still ships: a reseed can move it while every
  // block matches. The first count seen is what the clients' reads hold.
  const countChanged = copies.visibleMessageCount !== undefined && copies.visibleMessageCount !== update.visibleMessageCount
  copies.visibleMessageCount = update.visibleMessageCount
  if (blocks.length === 0 && truncateTo === undefined && !countChanged && streamingToolTextOps.length === 0) return streamingOnly([], chars)
  return {
    visibleMessageCount: update.visibleMessageCount,
    blocks,
    ...(truncateTo === undefined ? {} : { truncateTo }),
    ...(streamingToolTextOps.length > 0 ? { streamingToolTextOps } : {}),
    ...(chars === undefined ? {} : { streamingOutputChars: chars }),
  }
}

/** The streamed character count to ship, or undefined when the clients'
 *  copy already holds it; a shipped count becomes their copy. While
 *  a read is in flight every count ships, because the read can serve another
 *  count than the copy and a client installs it before the deltas after it. */
function measureChars(copies: SessionCopies, streamingOutputChars: number | undefined): number | undefined {
  if (streamingOutputChars === undefined || (copies.reads === 0 && copies.streamingOutputChars === streamingOutputChars)) return undefined
  copies.streamingOutputChars = streamingOutputChars
  return streamingOutputChars
}

function streamingOnly(streamingToolTextOps: readonly StreamingToolTextOp[], chars: number | undefined): OutputDelta | undefined {
  if (streamingToolTextOps.length > 0) return { blocks: [], streamingToolTextOps, ...(chars === undefined ? {} : { streamingOutputChars: chars }) }
  return chars === undefined ? undefined : { blocks: [], streamingOutputChars: chars }
}

/** Drops each copy that a read served differently, and counts the read's
 *  blocks as held. */
function reconcile(copies: SessionCopies, range: HydratedOutputRange): void {
  if (range.kind !== "ok") return
  if (copies.streamingOutputChars !== range.streamingOutputChars) copies.streamingOutputChars = undefined
  const start = range.window.startBlockIndex ?? 0
  for (const [offset, served] of range.blocks.entries()) {
    const copy = copies.blocks.get(start + offset)
    if (copy && !readGives(copy, served)) dropCopy(copies, start + offset)
  }
  if (copies.heldEnd !== undefined) copies.heldEnd = Math.max(copies.heldEnd, start + range.blocks.length)
  for (const [toolUseId, served] of Object.entries(range.streamingToolText)) {
    if (!Bun.deepEquals(copies.streaming.get(toolUseId), served)) copies.streaming.delete(toolUseId)
  }
}

function measureChanges(copies: SessionCopies, changes: readonly ProjectedBlockChange[]): OutputBlockDelta[] {
  const shipped: OutputBlockDelta[] = []
  for (const change of changes) {
    if (change.kind === "upsert") {
      const measured = measureBlock(copies, change.index, change.block)
      if (measured) shipped.push(measured)
      continue
    }
    if (change.kind === "insert") insertCopy(copies, change.index, change.block)
    else appendToCopy(copies, change)
    shipped.push(change)
  }
  return shipped
}

/** The block changes of a resync, and where the clients cut their tail. */
interface MeasuredResync {
  readonly blocks: OutputBlockDelta[]
  readonly truncateTo: number | undefined
}

function measureResync(copies: SessionCopies, sequenceStart: number, blocks: readonly FrontendOutputBlock[]): MeasuredResync {
  // A read in flight can hold any block of the tail, so the tail repaves.
  for (const index of copies.blocks.keys()) if (index < sequenceStart || copies.reads > 0) dropCopy(copies, index)
  const shipped: OutputBlockDelta[] = []
  let mismatch: number | undefined
  for (const [offset, block] of blocks.entries()) {
    const index = sequenceStart + offset
    if (mismatch === undefined) {
      const copy = copies.blocks.get(index)
      if (copy && blockIdentity(copy) === blockIdentity(block)) {
        const measured = measureBlock(copies, index, block)
        if (measured) shipped.push(measured)
        continue
      }
      // An index without a matching copy may hold anything in a client, so
      // the clients cut there and take the rest whole.
      mismatch = index
      truncateCopies(copies, index)
    }
    setCopy(copies, index, block)
    shipped.push({ kind: "upsert", index, blockId: blockIdentity(block), block })
  }
  const end = sequenceStart + blocks.length
  if (mismatch !== undefined) return { blocks: shipped, truncateTo: mismatch }
  // Every block matched. The clients still hold blocks past the new end when
  // the array got shorter or a read ran ahead, or may hold them when no
  // count was ever seen.
  if (copies.heldEnd !== undefined && copies.heldEnd <= end) return { blocks: shipped, truncateTo: undefined }
  truncateCopies(copies, end)
  return { blocks: shipped, truncateTo: end }
}

/** The change that brings the clients' copy of the block at `index` to
 *  `block`, or undefined when they already hold it. */
function measureBlock(copies: SessionCopies, index: number, block: FrontendOutputBlock): OutputBlockDelta | undefined {
  const blockId = blockIdentity(block)
  const copy = copies.blocks.get(index)
  setCopy(copies, index, block)
  // A read in flight can hold any version of the block, so it ships whole.
  if (!copy || blockIdentity(copy) !== blockId || copies.reads > 0) return { kind: "upsert", index, blockId, block }
  const edits = diffValues(editableBlock(copy), editableBlock(block))
  if (edits?.length === 0) return undefined
  if (edits === undefined || block.kind === "agentGroup" || !readsAsShipped(copy) || !readsAsShipped(block)) return { kind: "upsert", index, blockId, block }
  return { kind: "edit", index, blockId, edits }
}

/** Measures every tool the drain names, or, for a resync, every tool shipped
 *  or live. A runner that replaced another never held the old runner's tools,
 *  so only the resync can name them. A removed tool always ships its removal:
 *  a client that never held the entry ignores it. */
function measureStreaming(copies: SessionCopies, current: StreamingToolTextMap, changed: ReadonlySet<string> | undefined): StreamingToolTextOp[] {
  const ops: StreamingToolTextOp[] = []
  for (const toolUseId of changed ?? new Set([...copies.streaming.keys(), ...Object.keys(current)])) {
    const shipped = copies.streaming.get(toolUseId)
    const entry = current[toolUseId]
    if (entry === undefined) {
      ops.push({ toolUseId, kind: "remove" })
      copies.streaming.delete(toolUseId)
      continue
    }
    if (entry === shipped) continue
    const edits = shipped === undefined || copies.reads > 0 ? undefined : diffStreamingEntry(shipped, entry)
    if (edits === undefined) ops.push({ toolUseId, kind: "set", entry })
    else if (edits.length > 0) ops.push({ toolUseId, kind: "edit", edits })
    copies.streaming.set(toolUseId, entry)
  }
  return ops
}

function setCopy(copies: SessionCopies, index: number, block: FrontendOutputBlock): void {
  const prior = copies.blocks.get(index)
  if (prior) dropIdentity(copies, prior, index)
  copies.blocks.set(index, block)
  copies.indexById.set(blockIdentity(block), index)
}

/** Mirrors a client: a redelivered identity refreshes in place, and a new one
 *  shifts every later copy up one index. */
function insertCopy(copies: SessionCopies, index: number, block: FrontendOutputBlock): void {
  const resident = copies.indexById.get(blockIdentity(block))
  if (resident !== undefined) {
    copies.blocks.set(resident, block)
    return
  }
  const shifted = [...copies.blocks].filter(([at]) => at >= index)
  for (const [at] of shifted) copies.blocks.delete(at)
  for (const [at, copy] of shifted) {
    copies.blocks.set(at + 1, copy)
    copies.indexById.set(blockIdentity(copy), at + 1)
  }
  setCopy(copies, index, block)
}

/** Extends a text copy as a client does. A copy that the append does not fit
 *  is no base for later edits, so it is dropped and its next change ships whole. */
function appendToCopy(copies: SessionCopies, change: Extract<ProjectedBlockChange, { kind: "append-content" }>): void {
  const index = copies.indexById.get(change.blockId)
  const copy = index === undefined ? undefined : copies.blocks.get(index)
  if (index === undefined || (copy?.kind !== "text" && copy?.kind !== "thinking")) return
  const content = appendText(copy.content, change.contentOffset, change.text)
  if (content === null) dropCopy(copies, index)
  else copies.blocks.set(index, { ...copy, content })
}

function truncateCopies(copies: SessionCopies, end: number): void {
  for (const index of copies.blocks.keys()) if (index >= end) dropCopy(copies, index)
}

function dropCopy(copies: SessionCopies, index: number): void {
  const copy = copies.blocks.get(index)
  if (!copy) return
  dropIdentity(copies, copy, index)
  copies.blocks.delete(index)
}

function dropIdentity(copies: SessionCopies, copy: FrontendOutputBlock, index: number): void {
  const identity = blockIdentity(copy)
  if (copies.indexById.get(identity) === index) copies.indexById.delete(identity)
}
