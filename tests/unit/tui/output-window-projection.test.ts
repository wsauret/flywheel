import { describe, expect, it } from "bun:test"
import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { createTranscriptWindowProjector, targetTimelineBlockIndex } from "../../../src/tui/output-window/output-window-projection.js"

function text(id: string, content: string, timestamp = 1): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp }
}

function tool(id: string, timestamp: number): FrontendToolEntry {
  return { kind: "tool", id, name: "read", action: "file_read", presentation: { name: "Read", detail: id }, status: "completed", timestamp }
}

function pendingMessage(id: string): FrontendOutputBlock {
  return { kind: "userMessage", id, content: id, timestamp: 1, pending: true, injected: false }
}

function agent(id: string, agentType: string, status: "active" | "completed" = "completed"): FrontendOutputBlock {
  return { kind: "agentGroup", containerKind: "subagent", id, toolUseId: `tool-${id}`, label: agentType, description: id, agentType, status, children: [], totalToolCount: 0, timestamp: 1 }
}

function snapshotOf(blocks: readonly FrontendOutputBlock[], seedEpoch = 1, startBlockIndex = 0): TranscriptSnapshot {
  return {
    status: { kind: "complete" },
    source: { kind: "live" },
    totalBlocks: startBlockIndex + blocks.length,
    window: {
      startBlockIndex: blocks.length > 0 ? startBlockIndex : null,
      endBlockIndex: blocks.length > 0 ? startBlockIndex + blocks.length - 1 : null,
      hasBefore: startBlockIndex > 0,
      hasAfter: false,
      estimatedRows: blocks.length,
      contentBytes: 0,
    },
    heightEstimates: [],
    blocks,
    generation: 1,
    seedEpoch,
    historicalThroughIndex: -1,
  }
}

/** A window exercising every projection concern: tool runs (grouped, with a
 *  duration-stamping terminator), hidden thinking, pending user messages, and
 *  a trailing open run at the live tail. */
function mixedBlocks(): FrontendOutputBlock[] {
  return [
    text("t0", "hello", 100),
    tool("r1", 110),
    tool("r2", 120),
    text("t1", "after run", 200),
    pendingMessage("q1"),
    text("t2", "more prose", 300),
    tool("r3", 310),
  ]
}

describe("createTranscriptWindowProjector (transcript prefix cache)", () => {
  it("maps a grouped command target to its visible run row", () => {
    const blocks: FrontendToolEntry[] = [
      { ...tool("command-a", 1), name: "bash", action: "shell_exec" },
      { ...tool("command-b", 2), name: "bash", action: "shell_exec" },
    ]
    const snapshot = snapshotOf(blocks, 1, 20)
    const projection = createTranscriptWindowProjector()(snapshot, false)

    expect(targetTimelineBlockIndex(projection, "command-b")).toBe(20)
  })
  it("equals the whole-window projection for a mixed window", () => {
    const project = createTranscriptWindowProjector()
    const snap = snapshotOf(mixedBlocks())
    expect(project(snap, false)).toEqual(createTranscriptWindowProjector()(snap, false))
    expect(project(snap, true)).toEqual(createTranscriptWindowProjector()(snap, true))
  })

  it("keeps settled prefix rows identity-stable across tail growth and matches the full pass at every step", () => {
    const project = createTranscriptWindowProjector()
    const blocks = mixedBlocks()
    const first = project(snapshotOf(blocks), false)

    // The live tail grows: identical prefix block objects, new tail blocks.
    const grown = [...blocks, tool("r4", 320), text("t3", "tail paragraph", 400)]
    const second = project(snapshotOf(grown), false)
    expect(second).toEqual(createTranscriptWindowProjector()(snapshotOf(grown), false))

    // The settled prefix (everything up to the second-to-last terminator) was
    // reused by object identity -- the reference property that makes the per-flush
    // cost O(volatile suffix).
    for (let i = 0; i < first.timelineBlocks.length - 2; i += 1) {
      expect(second.timelineBlocks[i]).toBe(first.timelineBlocks[i]!)
    }

    const third = project(snapshotOf([...grown, text("t4", "again", 500)]), false)
    expect(third).toEqual(createTranscriptWindowProjector()(snapshotOf([...grown, text("t4", "again", 500)]), false))
  })

  it("hands back the same arrays while only a streaming block's text changes", () => {
    const project = createTranscriptWindowProjector()
    const blocks = mixedBlocks()
    const before = project(snapshotOf(blocks), false)
    const streamed = [...blocks.slice(0, -1), text("t3", "streaming", 400)]
    const first = project(snapshotOf(streamed), false)
    const second = project(snapshotOf([...streamed.slice(0, -1), text("t3", "streaming more", 400)]), false)
    // The live tail's text moved, so its row object differs, but every index,
    // flag and pending list is the same instance the caches key on.
    expect(second.zeroHeightBlockIndices).toBe(first.zeroHeightBlockIndices)
    expect(second.timelineBlockIndices).toBe(first.timelineBlockIndices)
    expect(second.hasBoundaryBefore).toBe(first.hasBoundaryBefore)
    expect(second.pendingBlocks).toBe(first.pendingBlocks)
    expect(second.timelineBlocks).not.toBe(first.timelineBlocks)
    expect(before.zeroHeightBlockIndices).not.toBe(first.zeroHeightBlockIndices)
  })

  it("mints a new indices array when a zero-height block joins the tail", () => {
    const project = createTranscriptWindowProjector()
    const blocks = mixedBlocks()
    const first = project(snapshotOf(blocks), false)
    const second = project(snapshotOf([...blocks, pendingMessage("q2")]), false)
    expect(second.zeroHeightBlockIndices).not.toBe(first.zeroHeightBlockIndices)
    expect(second.zeroHeightBlockIndices).toEqual([...first.zeroHeightBlockIndices, blocks.length])
    expect(second.pendingBlocks).toHaveLength(first.pendingBlocks.length + 1)
  })

  it("keeps only narration dividers across cache growth and implementer dispatches", () => {
    const project = createTranscriptWindowProjector()
    const initial = [
      agent("phase-1", "implementer"),
      agent("parallel", "implementer"),
      agent("review", "reviewer-code-quality"),
      tool("parent-check", 100),
    ]
    expect(project(snapshotOf(initial), false)).toEqual(createTranscriptWindowProjector()(snapshotOf(initial), false))

    const grown = [
      ...initial,
      agent("phase-2", "implementer"),
      tool("parent-review", 200),
      text("narration", "parent narration", 300),
      agent("phase-3", "implementer", "active"),
      text("tail", "tail", 400),
    ]
    const incremental = project(snapshotOf(grown), false)
    expect(incremental).toEqual(createTranscriptWindowProjector()(snapshotOf(grown), false))

    const phaseTwoIndex = incremental.timelineBlocks.findIndex((block) => block.kind === "agentGroup" && block.id === "phase-2")
    const narrationIndex = incremental.timelineBlocks.findIndex((block) => block.kind === "text" && block.id === "narration")
    const phaseThreeIndex = incremental.timelineBlocks.findIndex((block) => block.kind === "agentGroup" && block.id === "phase-3")
    expect(incremental.hasBoundaryBefore[phaseTwoIndex]).toBe(false)
    expect(incremental.hasBoundaryBefore[narrationIndex]).toBe(true)
    expect(incremental.hasBoundaryBefore[phaseThreeIndex]).toBe(false)
  })

  it("a replaced prefix block object drops the cache and re-projects correctly", () => {
    const project = createTranscriptWindowProjector()
    const blocks = mixedBlocks()
    project(snapshotOf([...blocks, text("t3", "tail", 400), text("t4", "more", 500)]), false)

    // Replace an early block (identity change, e.g. a delta upsert): the
    // projection must reflect it, never a stale cached prefix.
    const replaced = [text("t0", "hello EDITED", 100), ...blocks.slice(1), text("t3", "tail", 400), text("t4", "more", 500)]
    const result = project(snapshotOf(replaced), false)
    expect(result).toEqual(createTranscriptWindowProjector()(snapshotOf(replaced), false))
    const firstRow = result.timelineBlocks[0]
    if (firstRow?.kind !== "text") throw new Error("expected a text row")
    expect(firstRow.content).toBe("hello EDITED")
  })

  it("a seedEpoch bump invalidates the cache even when block identities are unchanged", () => {
    // Solid's reconcile can mutate a block IN PLACE under a stable identity
    // (seed paths); the epoch is the signal identity scans cannot provide.
    const project = createTranscriptWindowProjector()
    const blocks = [...mixedBlocks(), text("t3", "tail", 400), text("t4", "more", 500)]
    const before = project(snapshotOf(blocks, 1), false)
    expect(before.pendingBlocks).toHaveLength(1)

    // Simulate an in-place merge: the SAME object's pending flag flips.
    const q1 = blocks[4]
    if (q1?.kind !== "userMessage") throw new Error("expected the pending message")
    Object.assign(q1, { pending: false })

    const after = project(snapshotOf(blocks, 2), false)
    expect(after).toEqual(createTranscriptWindowProjector()(snapshotOf(blocks, 2), false))
    expect(after.pendingBlocks).toHaveLength(0)
    const deliveredIndex = after.timelineBlocks.findIndex((block) => block.kind === "userMessage" && block.id === "q1")
    expect(deliveredIndex).toBeGreaterThan(-1)
    expect(after.hasBoundaryBefore[deliveredIndex]).toBe(false)
  })

  it("a window-origin change (older prepend) drops the cache", () => {
    const project = createTranscriptWindowProjector()
    const blocks = mixedBlocks()
    project(snapshotOf(blocks, 1, 10), false)
    const prepended = [text("p0", "older page", 50), ...blocks]
    const result = project(snapshotOf(prepended, 1, 9), false)
    expect(result).toEqual(createTranscriptWindowProjector()(snapshotOf(prepended, 1, 9), false))
  })

  it("stamps tool-run durations identically across the prefix seam", () => {
    // The seam must never split a run from its terminating block: the group's
    // duration comes from the terminator's timestamp.
    const project = createTranscriptWindowProjector()
    const blocks = [text("t0", "a", 100), tool("r1", 110), tool("r2", 130), text("t1", "b", 250), text("t2", "c", 300), text("t3", "d", 350)]
    const incremental = project(snapshotOf(blocks), false)
    const full = createTranscriptWindowProjector()(snapshotOf(blocks), false)
    expect(incremental).toEqual(full)
    const group = incremental.timelineBlocks.find((block) => block.kind === "toolRun")
    if (group?.kind !== "toolRun") throw new Error("expected a tools run")
    expect(group.duration).toBe(140)
  })
})
