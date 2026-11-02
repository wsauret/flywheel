import type { FrontendOutputBlock, FrontendToolEntry } from "../../protocol/app-service-types.js"
import { blockIdentity } from "../../protocol/block-identity.js"
import { toolRunCategoryFor, type ToolRunCategory } from "../../protocol/client/tool-run-category.js"
import { foldTranscript, type ToolStretch, type TranscriptModel, type TranscriptWindow } from "../../protocol/client/transcript-model.js"
import { messageDisclosureEntry } from "../../protocol/client/message-sender.js"
import type { ToolRenderEntry } from "./tool-entry-helpers.js"

/** The terminal's presentation of the shared transcript model. The model
 *  decides what the transcript contains (`foldTranscript`); this file decides
 *  only how the terminal groups it: a stretch of tool work splits into
 *  Explored, Ran, and Executed runs by category, a call with no category is a
 *  row of its own, a visible thought inside the stretch is a row between runs,
 *  and queued messages are pinned under the timeline instead of drawn in it. */

/** Display-only fold of consecutive same-category calls inside one stretch,
 *  synthesized per frame. TUI-local view vocabulary, not a block: it never
 *  travels the wire, has no durable identity, and its status derives from its
 *  children. Contrast with the agent group, the durable block for a subagent. */
export interface ToolRun {
  readonly kind: "toolRun"
  readonly id: string
  readonly category: ToolRunCategory
  readonly status: ToolRunStatus
  readonly children: readonly ToolRenderEntry[]
  readonly timestamp: number
  readonly duration?: number
}

export type ToolRunStatus = "active" | "paused" | "completed"

/** The renderer's row vocabulary: every durable block plus the display fold. */
export type VisibleBlock = FrontendOutputBlock | ToolRun

declare const presented: unique symbol
export type PresentedTerminalRow = VisibleBlock & { readonly [presented]: true }

/** blockIdentity extended over the renderer's row vocabulary: the display fold
 *  keys by its window-stable synthetic id; every durable block keeps the shared
 *  identity so live and derived rows reconcile identically. */
export function visibleBlockIdentity(block: VisibleBlock): string {
  return block.kind === "toolRun" ? `toolRun:${block.id}` : blockIdentity(block)
}

/** The terminal rows of one model window, parallel arrays the way the output
 *  window mounts them. `zeroHeightBlockIndices` adds the calls a run absorbed
 *  (they never mount a row of their own) to the blocks no client renders. */
export interface TerminalTranscript {
  readonly timelineBlocks: readonly PresentedTerminalRow[]
  readonly pendingBlocks: readonly (PresentedTerminalRow & { kind: "userMessage" })[]
  readonly hasBoundaryBefore: readonly boolean[]
  readonly timelineBlockIndices: readonly number[]
  readonly zeroHeightBlockIndices: readonly number[]
}

function toolRunStatus(children: readonly FrontendToolEntry[]): ToolRunStatus {
  if (children.some((child) => child.status === "pending" || child.status === "streaming")) return "active"
  if (children.some((child) => child.status === "interrupted")) return "paused"
  return "completed"
}

// Streaming flushes re-present the window every frame while most tool runs are
// unchanged. Reusing the prior run object preserves row identity and avoids
// re-rendering group headers. The cache is keyed by the first child, whose
// identity changes with the run, and field checks invalidate real content or
// status changes. A run lives only as long as that child block.
const toolRunCache = new WeakMap<FrontendToolEntry, ToolRun>()
const messageEntryCache = new WeakMap<FrontendOutputBlock, ToolRenderEntry>()

function sameChildren(a: readonly FrontendToolEntry[], b: readonly FrontendToolEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function createToolRun(children: readonly ToolRenderEntry[], category: ToolRunCategory, endTimestamp: number | undefined): ToolRun {
  const first = children[0]
  if (!first) throw new Error("Cannot create an empty tool run")
  const status = toolRunStatus(children)
  const id = `tools:${category}:${first.disclosureId ?? blockIdentity(first)}`
  const duration = endTimestamp !== undefined && status !== "active" ? Math.max(0, endTimestamp - first.timestamp) : undefined
  const cached = toolRunCache.get(first)
  if (cached && cached.id === id && cached.status === status && cached.duration === duration && sameChildren(cached.children, children)) return cached
  const run: ToolRun = {
    kind: "toolRun",
    id,
    category,
    status,
    children,
    timestamp: first.timestamp,
    ...(duration !== undefined ? { duration } : {}),
  }
  toolRunCache.set(first, run)
  return run
}

/** An interrupted script trails its calls as a blank carrier row: it has no
 *  detail of its own, and its status is what flips the run's heading. */
function carrierOf(member: FrontendToolEntry): FrontendToolEntry {
  return member.name === "code" ? { ...member, presentation: { name: "", detail: "" } } : member
}

export function presentTerminalTranscript(model: TranscriptModel): TerminalTranscript {
  const timelineBlocks: PresentedTerminalRow[] = []
  const hasBoundaryBefore: boolean[] = []
  const timelineBlockIndices: number[] = []
  const zeroHeightBlockIndices: number[] = [...model.zeroHeightBlockIndices]

  const push = (block: VisibleBlock, sourceBlockIndex: number, boundary: boolean): void => {
    // SAFETY: the marker records admission through this presenter and adds no runtime fields.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: only presentation admits raw blocks to the renderer.
    timelineBlocks.push(block as PresentedTerminalRow)
    timelineBlockIndices.push(sourceBlockIndex)
    hasBoundaryBefore.push(boundary)
  }

  const presentStretch = (stretch: ToolStretch): void => {
    let run: { category: ToolRunCategory; children: ToolRenderEntry[]; indices: number[] } | null = null
    const flushRun = (endTimestamp: number | undefined): void => {
      if (run === null) return
      const firstIndex = run.indices[0]
      if (firstIndex === undefined) return
      push(createToolRun(run.children, run.category, endTimestamp), firstIndex, false)
      zeroHeightBlockIndices.push(...run.indices.slice(1))
      run = null
    }
    for (const [i, member] of stretch.members.entries()) {
      // SAFETY: memberBlockIndices is parallel to members by construction.
      const index = stretch.memberBlockIndices[i]!
      if (member.kind === "thinking") {
        flushRun(member.timestamp)
        push(member, index, false)
        continue
      }
      let child: ToolRenderEntry
      if (member.kind === "userMessage") {
        child = messageEntryCache.get(member) ?? { ...messageDisclosureEntry(member, member.from), disclosureId: blockIdentity(member) }
        messageEntryCache.set(member, child)
      } else {
        child = carrierOf(member)
      }
      const category = toolRunCategoryFor(child)
      if (category === null) {
        flushRun(child.timestamp)
        push(child, index, false)
        continue
      }
      if (run !== null && run.category !== category) flushRun(child.timestamp)
      run ??= { category, children: [], indices: [] }
      run.children.push(child)
      run.indices.push(index)
    }
    flushRun(stretch.endTimestamp)
  }

  for (const [i, row] of model.rows.entries()) {
    // SAFETY: the model's arrays are parallel by construction.
    const sourceBlockIndex = model.sourceBlockIndices[i]!
    const boundary = model.boundaryBefore[i] ?? false
    if (row.kind === "toolStretch") { presentStretch(row); continue }
    push(row, sourceBlockIndex, boundary)
  }
  // SAFETY: queued messages pass through the same presentation boundary as timeline rows.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: queued messages are presented in the pinned transcript region.
  const pendingBlocks = model.pendingBlocks as readonly (PresentedTerminalRow & { kind: "userMessage" })[]
  return { timelineBlocks, pendingBlocks, hasBoundaryBefore, timelineBlockIndices, zeroHeightBlockIndices: zeroHeightBlockIndices.sort((a, b) => a - b) }
}

/** Fold a raw transcript window and present its terminal rows. */
export function terminalTranscript(blocks: readonly FrontendOutputBlock[], showThinking: boolean | undefined, window?: TranscriptWindow) {
  const model = foldTranscript(blocks, showThinking, window)
  return { ...presentTerminalTranscript(model), model }
}
