import type { RenderContext, ScrollBoxRenderable } from "@opentui/core"
import { createOutputScrollController, type OutputScrollController, type OutputScrollControllerDeps } from "../../src/tui/hooks/create-output-scroll-controller.js"
import type { TranscriptSnapshot } from "../../src/tui/transcript-store/output-transcript-cache-types.js"
import type { TranscriptWindowProjection } from "../../src/tui/output-window/output-window-projection.js"
import type { TranscriptLayoutSlot } from "../../src/tui/output-window/output-window-scroll.js"
import { LINE_WHEEL } from "../../src/tui/output-window/output-window-wheel.js"
import { fakeFrameHookHost, fakeScrollPart, type FakeScrollPart } from "../helpers/scroll-frame-hook.js"

// Distinct keys get distinct generations, matching the model's contract: a
// repave is a new generation, continuity keeps the resident one.
const generations = new Map<string, number>()

function generationOf(key: string): number {
  let generation = generations.get(key)
  if (generation === undefined) {
    generation = generations.size + 1
    generations.set(key, generation)
  }
  return generation
}

export function snapshotFor(generationKey: string, totalBlocks: number): TranscriptSnapshot {
  return {
    status: { kind: "complete" },
    source: { kind: "historical", consistencyToken: generationKey },
    generation: generationOf(generationKey),
    totalBlocks,
    window: { startBlockIndex: 0, endBlockIndex: totalBlocks - 1, hasBefore: false, hasAfter: false, estimatedRows: totalBlocks * 2, contentBytes: 0 },
    heightEstimates: Array.from({ length: totalBlocks }, (_value, blockIndex) => ({ blockIndex, rows: 2 })),
    blocks: [],
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
}

export const emptyProjection: TranscriptWindowProjection = {
  timelineBlocks: [],
  hasBoundaryBefore: [],
  timelineBlockIndices: [],
  zeroHeightBlockIndices: [],
  pendingBlocks: [],
}

export interface FakeScrollBox {
  scrollTop: number
  /** The native extent of the frame's layout. */
  scrollHeight: number
  viewport: FakeScrollPart<{ width: number; height: number }>
  /** Its resize listeners run in a frame whose extent changed. */
  content: FakeScrollPart<object>
  scrollTo(target: number): void
  updateAutoScroll(x: number, y: number): void
  stopAutoScroll(): void
  ctx: RenderContext
  /** Holds the frame hook node that patchScrollBoxLayoutHooks appends. */
  add(node: object): number
  refreshHooks(): void
  /** The box's own update hook, which patchScrollBoxLayoutHooks wraps. */
  onUpdate(dt: number): void
  /** Drives one frame in OpenTUI's order: the box's update hook, the content
   *  resize when the extent changed, then the update of the frame hook node. */
  frame(dt: number): void
  /** Installed by patchScrollBoxHooks; wheel events route here. */
  onMouseEvent?: (event: { type: string; scroll?: { direction: string; delta: number } }) => void
  requestRender(): void
}

export function fakeScrollBox(): FakeScrollBox {
  const host = fakeFrameHookHost()
  let lastScrollHeight = 0
  const box: FakeScrollBox = {
    scrollTop: 0,
    scrollHeight: 0,
    viewport: fakeScrollPart({ width: 80, height: 10 }),
    content: host.content,
    scrollTo(target: number) {
      box.scrollTop = Math.max(0, Math.min(target, Math.max(0, box.scrollHeight - box.viewport.height)))
    },
    updateAutoScroll() {},
    stopAutoScroll() {},
    requestRender() {},
    ctx: host.ctx,
    add: host.add,
    refreshHooks: host.refreshHooks,
    onUpdate() {},
    frame(deltaTime) {
      host.runFrame(deltaTime, () => {
        box.onUpdate(deltaTime)
        if (box.scrollHeight !== lastScrollHeight) {
          lastScrollHeight = box.scrollHeight
          box.content.emit("resize")
        }
      })
    },
  }
  return box
}

/** The fake as the controller receives it. The controller touches only the
 *  faked surface: scrollTop, scrollHeight, viewport, scrollTo, content, and
 *  the protected hooks it patches. */
// oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenTUI's ScrollBoxRenderable declares private and protected members, so only a real instance has its type, a real one cannot hold the frame and layout lag these tests set by hand, and a Pick cannot name the protected hooks the controller patches.
export const asScrollBox = (box: FakeScrollBox) => box as unknown as ScrollBoxRenderable

export function mountController(slot: TranscriptLayoutSlot, snapshot: () => TranscriptSnapshot | undefined, extra?: Partial<OutputScrollControllerDeps>): OutputScrollController {
  return createOutputScrollController({
    snapshot,
    projection: () => emptyProjection,
    showThinking: () => false,
    hydrateAnchor: () => Promise.resolve(),
    updateSelection: () => {},
    visibleMessageCount: () => 0,
    jumpToLatest: () => Promise.resolve(),
    slot,
    // Pinned so a wheel report is one row on every host: the wheel tests count
    // rows, and Windows Terminal reports notches.
    wheel: LINE_WHEEL,
    ...extra,
  })
}
