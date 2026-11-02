import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { OutputTranscriptView, TranscriptSnapshot, TranscriptWindow } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import type { MutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"
import { mutationEvidenceFixture } from "./output-blocks/_mutation-evidence-fixture.js"
import type { ScrollBoxRenderable } from "@opentui/core"
import type { ManualClock } from "@opentui/core/testing"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { OutputWindowCommand } from "../../../src/tui/output-window/output-window.js"
import type { TranscriptLayoutSlot } from "../../../src/tui/output-window/output-window-scroll.js"
import { heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import type { WheelProfile } from "../../../src/tui/output-window/output-window-wheel.js"

export function textBlock(id: string, content: string): FrontendOutputBlock {
  return { kind: "text", id, content, timestamp: 1 }
}

export function windowOf(over: Partial<TranscriptWindow> = {}): TranscriptWindow {
  return { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, estimatedRows: 1, contentBytes: 17, ...over }
}

export function snapshot(over: Partial<TranscriptSnapshot> & { blocks: readonly FrontendOutputBlock[]; consistencyToken?: string }): TranscriptSnapshot {
  const { consistencyToken = "g1", blocks, ...rest } = over
  return {
    status: { kind: "partial" },
    source: { kind: "historical", consistencyToken },
    totalBlocks: blocks.length,
    window: windowOf(),
    heightEstimates: heightEstimatesFromBlocks(blocks, over.window?.startBlockIndex ?? 0, false),
    blocks,
    historicalThroughIndex: -1,
    seedEpoch: 0,
    generation: 1,
    ...rest,
  }
}

export function makeView(initial: TranscriptSnapshot | undefined) {
  const [snap, set] = createSignal<TranscriptSnapshot | undefined>(initial)
  const disclosureState = new Map<string, boolean>()
  const expandedToggles: string[] = []
  const view: OutputTranscriptView = {
    mutationEvidence: () => undefined,
    reportProjectionFailure: (error): never => { throw error },
    visibleRange: () => snap(),
    visibleMessageCount: () => snap()?.totalBlocks ?? 0,
    jumpToLatest: async () => {},
    freshness: () => undefined,
    hydrateAnchor: async () => {},
    loadAround: async () => {},
    takeEstimateUpdates: () => [],
    evictBefore: () => {},
    protectReader: () => {},
    setDisclosure: (id, value) => { expandedToggles.push(id); disclosureState.set(id, value) },
    disclosure: (id) => disclosureState.get(id),
    hydrateBlockBody: () => {},
  }
  return { view, set, expandedToggles }
}

/** Renders the transcript with its production disclosure provider and scroll commands.
 * With a manual clock, the renderer schedules its frames on that clock and paints
 * only when the caller runs them through `renderScheduledFrame`; the mount returns
 * after the frames it scheduled have painted. */
export async function renderWindow(view: OutputTranscriptView, height = 8, width = 60, sessionKind: "chat" | "workflow-agent" = "chat", showThinking = false, clock?: ManualClock, wheel?: WheelProfile, slot: TranscriptLayoutSlot = {}) {
  const [{ OutputWindow }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
    import("../../../src/tui/context/tick-pool-context.js"),
  ])
  let scrollbox!: ScrollBoxRenderable
  const [command, setCommand] = createSignal<OutputWindowCommand>()
  const [thinking, setShowThinking] = createSignal(showThinking)
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(TickPoolProvider, {
          get children() {
            return createComponent(OutputWindow, {
              layoutSlot: slot,
              transcript: view,
              get command() { return command() },
              running: false,
              get showThinking() { return thinking() },
              wheel,
              captureScrollbox: (el: ScrollBoxRenderable) => { scrollbox = el },
              sessionIntro: {
                moduleRows: () => [],
                runtimeIdentity: () => ({ version: "0.0.0-test", buildId: null }), showBuild: () => false,
                projectRoot: () => "/scratch/project",
                accountHome: "/scratch/home",
                userDataRoot: "/scratch/home/.flywheel",
                branchName: () => undefined,
                sessionKind: () => sessionKind,
                modelLabel: () => undefined,
                profileName: () => "default",
                fontTipDismissed: () => false,
                tabsHintDismissed: () => false, onDismissTabsHint: () => {},
                availableWidth: () => 60,
                noProviderReady: () => false,
              },
            })
          },
        })
      },
    }),
    { width, height, clock },
  )
  if (!clock) await result.flush()
  else while (result.renderer.getSchedulerState().hasScheduledRender) await renderScheduledFrame(result, clock)
  return { scrollbox, result, slot, setCommand, setShowThinking }
}

/** Paints the frame the renderer scheduled on its manual clock: it starts the frame,
 * then fires the clock, so the scheduled timer runs while that frame renders and
 * clears the request it stood for. `getSchedulerState().hasScheduledRender` then
 * says whether that frame, or work after it, asked for another one. A frame that
 * finished before the clock fired would let the timer paint a second frame; the
 * glide test checks the movement of every frame, so it fails if a call paints two. */
export async function renderScheduledFrame(result: Pick<Awaited<ReturnType<typeof testRender>>, "renderOnce">, clock: ManualClock) {
  const frame = result.renderOnce()
  clock.runAll()
  await frame
}

/** A complete, single-window transcript view over a fixed block list -- the test
 *  shape of a live session's adapter (whole conversation resident, both edges
 *  closed). OutputWindow tests drive the one transcript prop without standing up
 *  a cache. */
export function transcriptOf(blocks: readonly FrontendOutputBlock[]): OutputTranscriptView {
  const disclosureState = new Map<string, boolean>()
  const currentSnapshot: TranscriptSnapshot = {
    status: { kind: "complete" },
    source: { kind: "live" },
    totalBlocks: blocks.length,
    window: {
      startBlockIndex: blocks.length > 0 ? 0 : null,
      endBlockIndex: blocks.length > 0 ? blocks.length - 1 : null,
      hasBefore: false,
      hasAfter: false,
      estimatedRows: blocks.length,
      contentBytes: 0,
    },
    heightEstimates: blocks.map((_block, blockIndex) => ({ blockIndex, rows: 1 })),
    blocks,
    generation: 1,
    seedEpoch: 0,
    historicalThroughIndex: -1,
  }
  return {
    protectReader: () => {},
    mutationEvidence: () => undefined,
    reportProjectionFailure: (error): never => { throw error },
    visibleRange: () => currentSnapshot,
    visibleMessageCount: () => blocks.length,
    jumpToLatest: async () => {},
    freshness: () => undefined,
    hydrateAnchor: async () => {},
    loadAround: async () => {},
      takeEstimateUpdates: () => [],
      evictBefore: () => {},
    setDisclosure: (id, value) => { disclosureState.set(id, value) },
    disclosure: (id) => disclosureState.get(id),
    hydrateBlockBody: () => {},
  }
}

/** A diff-heavy transcript of `files` edits with independent lazy readers and unique
 * visible lines. The caller settles pending transport reads between frames and
 * disposes the readers. `readFiles` counts the edits whose patch bytes were read. */
export async function mutationTranscriptFixture(files: number) {
  const fixtures = await Promise.all(Array.from({ length: files }, (_file, file) => mutationEvidenceFixture([{
    path: `file${file}.ts`, lines: 32,
    patch: "@@ -1,16 +1,16 @@\n" + Array.from({ length: 16 }, (_line, line) => `-old F${file}L${line}\n+new F${file}L${line}`).join("\n"),
  }])))
  const owners = new Map<string, typeof fixtures[number]>()
  const blocks = fixtures.flatMap((fixture, index): FrontendOutputBlock[] => {
    const tool: FrontendOutputBlock = { kind: "tool", id: `edit${index}`, name: "edit", status: "completed", fileChangeKind: "patch",
      presentation: { name: "Edit", detail: `file${index}.ts` }, timestamp: 1, mutationEvidence: fixture.evidence }
    owners.set(blockIdentity(tool), fixture)
    return [{ kind: "text", id: `t${index}`, content: `MARKER-${index} prose`, timestamp: 1 }, tool]
  })
  const reader: MutationEvidenceReader = {
    get hasOwners() { return fixtures.some(fixture => fixture.reader.hasOwners) },
    get heldBytes() { return fixtures.reduce((sum, fixture) => sum + fixture.reader.heldBytes, 0) },
    open: (id, manifest, options) => {
      const fixture = owners.get(id)
      if (!fixture) throw new Error(`Unexpected evidence owner ${id}`)
      return fixture.reader.open(id, manifest, options)
    },
    openPatch: () => { throw new Error("Unexpected display-only patch") },
    release: id => { for (const fixture of fixtures) fixture.reader.release(id) },
    retainOwners: ids => { for (const fixture of fixtures) fixture.reader.retainOwners(ids) },
    onChange: listener => {
      const disposers = fixtures.map(fixture => fixture.reader.onChange(listener))
      return () => { for (const dispose of disposers) dispose() }
    },
    dispose: () => { for (const fixture of fixtures) fixture.reader.dispose() },
  }
  return {
    view: { ...transcriptOf(blocks), mutationEvidence: () => reader },
    settle: async () => { for (const fixture of fixtures) await fixture.settle() },
    patchReads: () => fixtures.reduce((sum, fixture) => sum + fixture.calls.filter(call => call.type === "mutationPatchWindow").length, 0),
    dispose: () => reader.dispose(),
  }
}
