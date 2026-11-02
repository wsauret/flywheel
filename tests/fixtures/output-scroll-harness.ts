import type { RenderContext, ScrollBoxRenderable } from "@opentui/core"
import { createOutputScrollController, type OutputScrollController, type OutputScrollControllerDeps } from "../../src/tui/hooks/create-output-scroll-controller.js"
import type { TranscriptSnapshot } from "../../src/tui/transcript-store/output-transcript-cache-types.js"
import type { TranscriptWindowProjection } from "../../src/tui/output-window/output-window-projection.js"
import type { TranscriptLayoutSlot } from "../../src/tui/output-window/output-window-scroll.js"
import { LINE_WHEEL } from "../../src/tui/output-window/output-window-wheel.js"
import { fakeFrameHookHost } from "../helpers/scroll-frame-hook.js"

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
  scrollHeight: number
  /** The frame's freshly computed yoga extent; syncScrollExtent adopts it into
   *  scrollHeight each onUpdate. NaN = "between layouts" (sync skipped), which
   *  lets tests drive scrollHeight by hand to simulate the element lag. */
  contentHeight: number
  viewport: { width: number; height: number }
  scrollTo(target: number): void
  updateAutoScroll(x: number, y: number): void
  stopAutoScroll(): void
  verticalScrollBar: { slider: FakeSlider; scrollSize: number }
  content: { getLayout(): { height: number }; onUpdate?: (dt: number) => void }
  ctx: RenderContext
  /** Holds the frame hook node that patchScrollBoxLayoutHooks appends. */
  wrapper: { add(node: object): void }
  /** Drives one frame: the update hook of the appended frame hook node. */
  onUpdate(dt: number): void
  /** Installed by patchScrollBoxHooks; wheel events route here. */
  onMouseEvent?: (event: { type: string; scroll?: { direction: string; delta: number } }) => void
  requestRender(): void
  /** Wrapped by patchScrollBoxHooks; simulates OpenTUI's bar-recalc cascade. */
  recalculateBarProps?: () => void
}

/** Enough of SliderRenderable's virtual-thumb geometry for tests to read the
 *  painted thumb: a 10-cell track (20 virtual units) with a 2-unit thumb, so
 *  maxStartVirtual = 18. getVirtualThumbStart computes the TRUE start from the
 *  box's scroll state, exactly like OpenTUI's slider. */
export interface FakeSlider {
  height: number
  getVirtualThumbSize(): number
  getVirtualThumbStart(): number
}

export function fakeScrollBox(): FakeScrollBox {
  const host = fakeFrameHookHost()
  let lastContentHeight = Number.NaN
  const box: FakeScrollBox = {
    scrollTop: 0,
    scrollHeight: 0,
    contentHeight: Number.NaN,
    viewport: { width: 80, height: 10 },
    scrollTo(target: number) {
      box.scrollTop = Math.max(0, Math.min(target, Math.max(0, box.scrollHeight - box.viewport.height)))
    },
    updateAutoScroll() {},
    stopAutoScroll() {},
    requestRender() {},
    ctx: host.ctx,
    wrapper: host.wrapper,
    onUpdate(deltaTime) {
      host.runFrame(deltaTime, () => {
        box.content.onUpdate?.(deltaTime)
        if (!Object.is(box.contentHeight, lastContentHeight)) {
          lastContentHeight = box.contentHeight
          box.recalculateBarProps?.()
        }
      })
    },
    verticalScrollBar: {
      slider: {
        height: 10,
        getVirtualThumbSize: () => 2,
        getVirtualThumbStart: () => {
          const range = Math.max(0, box.scrollHeight - box.viewport.height)
          return range === 0 ? 0 : Math.round((box.scrollTop / range) * 18)
        },
      },
      get scrollSize() {
        return box.scrollHeight
      },
      set scrollSize(v: number) {
        box.scrollHeight = v
      },
    },
    content: { getLayout: () => ({ height: box.contentHeight }) },
  }
  return box
}

/** The fake as the controller receives it. The controller touches only the
 *  faked surface: scrollTop, scrollHeight, viewport, scrollTo, content,
 *  verticalScrollBar, and the protected hooks it patches. */
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
