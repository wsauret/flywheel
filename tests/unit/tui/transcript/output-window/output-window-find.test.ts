import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { FrontendOutputBlock } from "../../../../../src/protocol/app-service-types.js"
import { compileFind, type FindMatcher } from "../../../../../src/protocol/transcript-find.js"
import type { FindLanding } from "../../../../../src/tui/transcript/output-window/create-find-bar.js"
import { createMountedRowRegistry, type TranscriptLayoutSlot } from "../../../../../src/tui/transcript/output-window/output-window-scroll.js"
import type { TranscriptSnapshot } from "../../../../../src/tui/transcript/transcript-store/output-transcript-cache-types.js"
import { asScrollBox, fakeScrollBox, mountController, snapshotFor } from "../../../../fixtures/output-scroll-harness.js"
import { makeView, snapshot, textBlock, windowOf } from "./_output-window-transcript.js"

function matcherFor(pattern: string): FindMatcher {
  const compiled = compileFind({ pattern, regex: false, matchCase: false })
  if (compiled.kind !== "ready") throw new Error("pattern does not compile")
  return compiled.matcher
}

async function renderFind(blocks: readonly FrontendOutputBlock[], height: number) {
  const [{ OutputWindow }, { ThemeProvider, useTheme }, { TickPoolProvider }] = await Promise.all([
    import("../../../../../src/tui/transcript/output-window/output-window.js"),
    import("../../../../../src/tui/context/theme.js"),
    import("../../../../../src/tui/context/tick-pool-context.js"),
  ])
  const { view, expandedToggles } = makeView(snapshot({ blocks, window: windowOf({ endBlockIndex: blocks.length - 1 }) }))
  const [landing, setLanding] = createSignal<FindLanding>()
  let theme!: ReturnType<typeof useTheme>["theme"]
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      theme = useTheme().theme
      return createComponent(TickPoolProvider, {
        get children() {
          return createComponent(OutputWindow, {
            layoutSlot: {}, transcript: view, running: false,
            find: { matcher: () => matcherFor("needle"), landing },
            sessionIntro: {
              moduleRows: () => [], runtimeIdentity: () => ({ version: "0.0.0-test", buildId: null }), showBuild: () => false,
              projectRoot: () => "/scratch/project", accountHome: "/scratch/home", userDataRoot: "/scratch/home/.flywheel",
              branchName: () => undefined, sessionKind: () => "workflow-agent", modelLabel: () => undefined, profileName: () => "default",
              fontTipDismissed: () => false, tabsHintDismissed: () => false, onDismissTabsHint: () => {}, availableWidth: () => 60, noProviderReady: () => false,
            },
          })
        },
      })
    },
  }), { width: 60, height })
  await result.flush()
  let id = 0
  return { result, theme, expandedToggles, land: (blockId: string, occurrence: number) => setLanding({ id: ++id, blockId, occurrence }), close: () => setLanding(undefined) }
}

describe("OutputWindow find landing", () => {
  it("scrolls the target match into view with the strong highlight and opens the block's collapsed regions", async () => {
    const blocks = Array.from({ length: 40 }, (_, index) => textBlock(`b${index}`, index === 3 ? "a needle and a needle" : `filler ${index}`))
    const { result, theme, expandedToggles, land } = await renderFind(blocks, 8)
    const strong = () => result.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.bg.equals(theme.warning)).map((span) => span.text)
    try {
      expect(result.captureCharFrame()).not.toContain("needle")
      land("text:b3", 1)
      for (let frame = 0; frame < 4; frame += 1) await result.renderOnce()
      expect(result.captureCharFrame()).toContain("a needle and a needle")
      expect(strong()).toEqual(["needle"])
      expect(expandedToggles).toEqual([])

      land("tool:t1", 0)
      for (let frame = 0; frame < 2; frame += 1) await result.renderOnce()
      expect(expandedToggles).toEqual(["tool:t1#body", "tool:t1#content", "tool:t1#output"])
    } finally { result.renderer.destroy() }
  })

  it("scrolls to a match on a later line of a reply taller than the viewport", async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `${index + 1}. line ${index + 1} needle`)
    const blocks = [textBlock("b0", "intro"), textBlock("b1", lines.join("\n")), textBlock("b2", "outro")]
    const { result, theme, land } = await renderFind(blocks, 20)
    const strongLines = () => result.captureSpans().lines.filter((line) => line.spans.some((span) => span.bg.equals(theme.warning)))
    try {
      land("text:b1", 99)
      for (let frame = 0; frame < 6; frame += 1) await result.renderOnce()
      expect(result.captureCharFrame()).toContain("line 100 needle")
      expect(strongLines().map((line) => line.spans.map((span) => span.text).join("").trim())).toEqual(["100. line 100 needle"])
    } finally { result.renderer.destroy() }
  })

  it("marks the whole block, and paints no other occurrence as current, when its rendered text cannot show the target occurrence", async () => {
    const blocks = [textBlock("b0", "a needle: see [the docs](https://needle.example)"), ...Array.from({ length: 10 }, (_, index) => textBlock(`f${index}`, `filler ${index}`))]
    const { result, theme, land } = await renderFind(blocks, 12)
    const spans = () => result.captureSpans().lines.flatMap((line) => line.spans)
    try {
      land("text:b0", 1)
      for (let frame = 0; frame < 4; frame += 1) await result.renderOnce()
      expect(spans().filter((span) => span.bg.equals(theme.backgroundElement)).map((span) => span.text).join("")).toContain("see the docs")
      expect(spans().filter((span) => span.bg.equals(theme.warning))).toEqual([])
    } finally { result.renderer.destroy() }
  })

  it("leaves the scroll position alone when the find closes while the target's page loads", async () => {
    const blocks = Array.from({ length: 40 }, (_, index) => textBlock(`b${index}`, index === 3 ? "a needle" : `filler ${index}`))
    const { result, land, close } = await renderFind(blocks, 8)
    try {
      land("text:b3", 0)
      close()
      for (let frame = 0; frame < 4; frame += 1) await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("needle")
    } finally { result.renderer.destroy() }
  })
})

describe("createOutputScrollController landing focus", () => {
  it("centres the row a landing names within its block, not the block", () => {
    // 20 blocks of 8 laid-out rows = 160 content rows; viewport 10.
    const slot: TranscriptLayoutSlot = {}
    const [snap] = createSignal<TranscriptSnapshot | undefined>(snapshotFor("gen-1", 20))
    createRoot((dispose) => {
      const controller = mountController(slot, snap, {
        mountedRows: { ...createMountedRowRegistry(), layoutRows: (blockIndex) => ({ top: blockIndex * 8, height: 8 }) },
      })
      const box = fakeScrollBox()
      controller.attach(asScrollBox(box))
      box.scrollHeight = 160
      box.frame(16)
      controller.toBlock(10)
      box.frame(16)
      expect(box.scrollTop).toBe(80 - 1) // the block's middle at the viewport's middle
      controller.toBlock(10, () => 6)
      box.frame(16)
      expect(box.scrollTop).toBe(80 + 6 - 5) // row 6 of the block at the viewport's middle
      dispose()
    })
  })
})
