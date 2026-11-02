import { Schema } from "effect"
import { blockIdentity } from "../block-identity.js"
import type { FrontendOutputBlock } from "../app-service-types.js"
import { frontendOutputBlockBytes } from "../frontend-output-block-metrics.js"
import type { OutputDelta, OutputView } from "../output-protocol-types.js"
import { FrontendOutputBlockSchema } from "../transcript-protocol-schemas.js"
import { appendText, applyStreamingToolTextOps, applyValueEdits, editableBlock, streamingToolTextOpsBytes, valueEditsBytes, type StreamingTextRejection } from "./streaming-text-edits.js"

const isFrontendOutputBlock = Schema.is(FrontendOutputBlockSchema)

/** Fired for every block-slot write on the non-structural delta path, so the
 *  caller can maintain per-block derivations (row estimates, window sums)
 *  incrementally instead of rescanning the resident window. `appendedText` is
 *  the newly appended suffix for pure content appends and empty otherwise
 *  (idempotent redeliveries, whole-block upserts). */
export type BlockReplacedHook = (localIndex: number, prior: FrontendOutputBlock | undefined, next: FrontendOutputBlock, appendedText: string) => void

/** The mutable draft shape of an `OutputView` - the wire type declares `blocks`
 *  readonly, but a client applies deltas to a mutable resident draft (the TUI
 *  inside Solid's `produce`, the editor client on plain state). The delta helpers
 *  operate on this shape so every client and its tests share one implementation. */
export type MutableOutputView = {
  blocks: OutputView["blocks"] extends readonly (infer B)[] ? B[] : never
  streamingToolText: OutputView["streamingToolText"]
}

type OutputDeltaContent = Omit<OutputDelta, "visibleMessageCount">

/** Metadata for the rejected operation only. No content or raw operation is retained. */
export interface OutputDeltaRejection {
  readonly reason: "truncate-below-window" | "insert-outside-window" | "upsert-past-window" | "upsert-identity-mismatch" | "edit-missing-block" | "edit-rejected" | "edit-invalid-shape" | "append-missing-block" | "append-content-gap" | "append-content-mismatch" | "append-block-kind" | StreamingTextRejection["reason"]
  /** The rejected block operation; absent when the delta's truncation is rejected. */
  readonly operationIndex?: number
  readonly operationKind: string
  readonly index?: number
  readonly localIndex?: number
  readonly blockId?: string
  readonly expectedIdentity?: string
  readonly incomingIdentity?: string
  readonly residentCount?: number
  readonly blockKind?: FrontendOutputBlock["kind"]
  readonly contentOffset?: number
  readonly residentLength?: number
  readonly incomingLength?: number
  readonly toolUseId?: string
  readonly editIndex?: number
  readonly editKind?: string
}

/** At most eight nearby block identities and eight submission ids per message.
 * Coordinates refer to the supplied window, not a partially applied delta. */
export function transcriptIdentitySample(blocks: readonly FrontendOutputBlock[], start: number | null, near = 0) {
  const from = Math.max(0, Math.min(near - 4, blocks.length - 8))
  return blocks.slice(from, from + 8).map((block, i) => ({
    localIndex: from + i, index: start === null ? null : start + from + i,
    kind: block.kind, blockId: blockIdentity(block),
    ...(block.kind === "userMessage" ? { submissionIds: block.submissionIds?.slice(0, 8), submissionCount: block.submissionIds?.length, pending: block.pending, injected: block.injected, imageCount: block.imageCount } : {}),
  }))
}

interface RejectedDeltaWindow {
  readonly blocks: readonly FrontendOutputBlock[]
  readonly startBlockIndex: number | null
  readonly totalBlocks: number
  readonly visibleMessageCount: number
  readonly atTail: boolean
  readonly hasBefore: boolean
  readonly hasNewer: boolean
  readonly consistencyToken: string | null
  readonly appliedOutputPosition: number | null
}

/** Compile bounded evidence from the unchanged resident window, not the rejected draft.
 * This reads metadata only and does not apply or recover the delta. */
export function outputDeltaRejectionEvidence(view: RejectedDeltaWindow, delta: OutputDelta, position: number, previousPosition: number, rejection: OutputDeltaRejection | undefined) {
  return {
    rejection,
    cursor: { applied: view.appliedOutputPosition, incoming: position, incomingPrevious: previousPosition },
    resident: { start: view.startBlockIndex, end: view.startBlockIndex === null ? null : view.startBlockIndex + view.blocks.length - 1, count: view.blocks.length, total: view.totalBlocks, visibleMessageCount: view.visibleMessageCount, atTail: view.atTail, hasBefore: view.hasBefore, hasNewer: view.hasNewer, consistencyToken: view.consistencyToken },
    delta: { blockOperations: delta.blocks.length, streamingOperations: delta.streamingToolTextOps?.length ?? 0, truncateTo: delta.truncateTo, visibleMessageCount: delta.visibleMessageCount },
    nearby: transcriptIdentitySample(view.blocks, view.startBlockIndex, rejection?.localIndex ?? 0),
  }
}

/** Whether a delta only rewrites resident slots: edits and content appends,
 *  with no truncation. Such a delta never moves a block index, and
 *  `applyOutputDelta` only reads the index for it, so a caller can apply it
 *  with its live index instead of a copy. Most live deltas are of this kind:
 *  streaming text and tool output grow one block at a time. */
export function rewritesSlotsOnly(delta: OutputDeltaContent): boolean {
  return delta.truncateTo === undefined && delta.blocks.every((change) => change.kind === "edit" || change.kind === "append-content")
}

/** Apply one ordered output delta's content to a resident view, maintaining the
 *  blockId->local-index map in lockstep. Delta indexes are absolute session block
 *  indexes; `startBlockIndex` maps them into the resident paged window. Returns
 *  false on a divergence so the caller can recover from the bounded cursor
 *  authority rather than guess. The optional rejection hook fires once, only
 *  on failure, with metadata from the draft at the rejected operation. */
export function applyOutputDelta(view: MutableOutputView, delta: OutputDeltaContent, blockIndex: Map<string, number>, startBlockIndex: number | null = 0, onBlockReplaced?: BlockReplacedHook, onRejected?: (failure: OutputDeltaRejection) => void): boolean {
  const offset = startBlockIndex ?? 0
  if (delta.truncateTo !== undefined) {
    // A cut below the window start drops every resident block. Only a delta
    // that supplies the window again from its start, such as a resync measured
    // from blocks no client copy holds, leaves something true to show.
    if (delta.truncateTo < offset && !delta.blocks.some((change) => change.kind === "upsert" && change.index === offset)) {
      onRejected?.({ reason: "truncate-below-window", operationKind: "truncate", index: delta.truncateTo, localIndex: delta.truncateTo - offset, residentCount: view.blocks.length })
      return false
    }
    truncateBlockIndex(view, blockIndex, Math.max(0, delta.truncateTo - offset))
  }
  for (const [operationIndex, change] of delta.blocks.entries()) {
    if (change.kind === "insert") {
      const identity = blockIdentity(change.block)
      const residentIndex = blockIndex.get(identity)
      // Redelivered insert (recovery-seam replay): the block is already
      // resident, so degrade to an in-place refresh. Identity, not index, is
      // the idempotency key - the same contract appendText applies to
      // redelivered content.
      if (residentIndex !== undefined) {
        const prior = view.blocks[residentIndex]
        const next = foldAgentGroupBlock(prior, change.block)
        view.blocks[residentIndex] = next
        onBlockReplaced?.(residentIndex, prior, next, "")
        continue
      }
      const localIndex = change.index - offset
      // Inserts land in the live tail region, which a seeded window contains.
      // A below-window or past-end coordinate means the delta disagrees with
      // the resident window, so the caller recovers from the bounded authority.
      if (localIndex < 0 || localIndex > view.blocks.length) {
        onRejected?.({ reason: "insert-outside-window", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, incomingIdentity: identity, residentCount: view.blocks.length })
        return false
      }
      view.blocks.splice(localIndex, 0, change.block)
      for (const [id, index] of blockIndex) { if (index >= localIndex) blockIndex.set(id, index + 1) }
      blockIndex.set(identity, localIndex)
      onBlockReplaced?.(localIndex, undefined, change.block, "")
      continue
    }
    if (change.kind === "upsert") {
      const localIndex = change.index - offset
      // The delta may describe a block before the resident page; it is durable
      // history outside this window, so it does not affect the current render.
      if (localIndex < 0) continue
      // An upsert past the window end would leave a sparse hole that the renderer
      // reads as `undefined.kind` and crashes on. That is a gap - missing
      // intermediate blocks - so fail the delta and let the caller recover.
      // localIndex === length is a normal append; < length is a replace.
      if (localIndex > view.blocks.length) {
        onRejected?.({ reason: "upsert-past-window", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, incomingIdentity: blockIdentity(change.block), residentCount: view.blocks.length })
        return false
      }
      const prior = view.blocks[localIndex]
      const next = foldAgentGroupBlock(prior, change.block)
      const nextIdentity = blockIdentity(next)
      if (prior) {
        const priorIdentity = blockIdentity(prior)
        if (priorIdentity !== nextIdentity) {
          // Divergence verdict: every identity-destroying write arrives as an
          // insert (displacement) or a truncate repave. A bare upsert that
          // would overwrite a different resident identity is a coordinate-space
          // disagreement (an unannounced rebase or a server fault), so the
          // caller recovers from the bounded authority instead of silently
          // dropping a resident block.
          if (delta.truncateTo === undefined) {
            onRejected?.({ reason: "upsert-identity-mismatch", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, expectedIdentity: priorIdentity, incomingIdentity: nextIdentity, residentCount: view.blocks.length })
            return false
          }
          if (blockIndex.get(priorIdentity) === localIndex) blockIndex.delete(priorIdentity)
        }
      }
      view.blocks[localIndex] = next
      blockIndex.set(nextIdentity, localIndex)
      onBlockReplaced?.(localIndex, prior, next, "")
      continue
    }
    if (change.kind === "edit") {
      // The block is found by identity: a read can run ahead of the cursor
      // and hold an insert that is not published yet, which moves the block
      // past its published index.
      const localIndex = blockIndex.get(change.blockId)
      const prior = localIndex === undefined ? undefined : view.blocks[localIndex]
      if (localIndex === undefined || !prior) {
        // A block before the resident page is durable history outside it.
        if (change.index < offset) continue
        onRejected?.({ reason: "edit-missing-block", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, residentCount: view.blocks.length })
        return false
      }
      const edited = applyValueEdits(editableBlock(prior), change.edits)
      if (!edited.ok) {
        onRejected?.({ reason: "edit-rejected", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, editIndex: edited.editIndex, editKind: change.edits[edited.editIndex]?.kind })
        return false
      }
      // The edits rebuilt a copy of the block; it is adopted only in a shape
      // the block schema accepts, like every block this client holds.
      if (!isFrontendOutputBlock(edited.value)) {
        onRejected?.({ reason: "edit-invalid-shape", operationIndex, operationKind: change.kind, index: change.index, localIndex, blockId: change.blockId, blockKind: prior.kind })
        return false
      }
      view.blocks[localIndex] = edited.value
      onBlockReplaced?.(localIndex, prior, edited.value, "")
      continue
    }
    const index = blockIndex.get(change.blockId)
    const block = index === undefined ? undefined : view.blocks[index]
    if (index === undefined || !block) {
      onRejected?.({ reason: "append-missing-block", operationIndex, operationKind: change.kind, index: change.index, localIndex: index, blockId: change.blockId, residentCount: view.blocks.length })
      return false
    }
    if (block.kind === "text" || block.kind === "thinking") {
      const content = appendText(block.content, change.contentOffset, change.text)
      if (content === null) {
        onRejected?.({ reason: block.content.length < change.contentOffset ? "append-content-gap" : "append-content-mismatch", operationIndex, operationKind: change.kind, index: change.index, localIndex: index, blockId: change.blockId, contentOffset: change.contentOffset, residentLength: block.content.length, incomingLength: change.text.length })
        return false
      }
      const next = { ...block, content }
      view.blocks[index] = next
      onBlockReplaced?.(index, block, next, content.length > block.content.length ? change.text : "")
    } else {
      onRejected?.({ reason: "append-block-kind", operationIndex, operationKind: change.kind, index: change.index, localIndex: index, blockId: change.blockId, blockKind: block.kind })
      return false
    }
  }
  if (delta.streamingToolTextOps !== undefined) {
    const next = applyStreamingToolTextOps(view.streamingToolText, delta.streamingToolTextOps, onRejected)
    if (next === null) return false
    view.streamingToolText = next
  }
  return true
}

/** Fold an agent-group upsert into the resident block of the same identity.
 *  The wire ships only a bounded tail of children, so a plain replace would
 *  drop hydrated or previously streamed children. Resident children whose ids
 *  are absent from the incoming tail keep their position ahead of it (the
 *  resident list is a prefix of the true run order); incoming children win on
 *  id match, since they carry the newest status. Child ids are provider
 *  toolUseIds and always present. */
export function mergeAgentGroupChildren<T extends { readonly id: string }>(resident: readonly T[], incoming: readonly T[]): T[] {
  if (resident.length === 0) return [...incoming]
  const incomingIds = new Set(incoming.map((child) => child.id))
  return [...resident.filter((child) => !incomingIds.has(child.id)), ...incoming]
}

/** Fold two views of the same agent group into one: children merge by id, and
 *  a terminal incoming status settles resident stragglers. A child that
 *  settled while older than the wire tail never ships its settle patch, so
 *  the client mirrors the builder's resolveUnresolvedChildren rule: once the
 *  group itself is settled, no child can still be running. */
export function foldAgentGroupBlock(prior: FrontendOutputBlock | undefined, next: FrontendOutputBlock): FrontendOutputBlock {
  if (prior?.kind !== "agentGroup" || next.kind !== "agentGroup" || prior.id !== next.id) return next
  const children = mergeAgentGroupChildren(prior.children, next.children)
  if (next.status !== "completed" && next.status !== "error") return { ...next, children }
  return {
    ...next,
    children: children.map((child) => child.status === "pending" || child.status === "streaming" ? { ...child, status: "completed" as const } : child),
  }
}

// Rebuild from the surviving prefix in O(length), not O(map-size): truncation runs
// on the live append path (~50k events/step), and deleting past-the-end entries one
// by one walks the whole map even when truncating to zero.
function truncateBlockIndex(view: MutableOutputView, blockIndex: Map<string, number>, length: number): void {
  view.blocks.length = length
  blockIndex.clear()
  for (const [i, block] of view.blocks.entries()) blockIndex.set(blockIdentity(block), i)
}

export function buildBlockIndex(blocks: OutputView["blocks"]): Map<string, number> {
  const map = new Map<string, number>()
  for (const [index, block] of blocks.entries()) map.set(blockIdentity(block), index)
  return map
}

export function outputDeltaBytes(delta: OutputDeltaContent): number {
  let bytes = delta.truncateTo === undefined ? 0 : 8
  for (const change of delta.blocks) {
    bytes += change.kind === "append-content" ? change.text.length : change.kind === "edit" ? valueEditsBytes(change.edits) : frontendOutputBlockBytes(change.block)
  }
  if (delta.streamingToolTextOps !== undefined) bytes += streamingToolTextOpsBytes(delta.streamingToolTextOps)
  return bytes
}

/** Truncates and upserts move the total; inserts never reach this function.
 *  Their caller derives the total from the applied view because an insert can
 *  append a new identity or refresh a redelivered one without growing anything. */
export function totalBlocksAfterDelta(totalBlocks: number, delta: OutputDeltaContent): number {
  let next = totalBlocks
  if (delta.truncateTo !== undefined) next = Math.min(next, delta.truncateTo)
  for (const change of delta.blocks) if (change.kind === "upsert") next = Math.max(next, change.index + 1)
  return next
}
