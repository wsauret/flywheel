/** @jsxImportSource @opentui/solid */
import { describe, expect, it, spyOn } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { marked } from "marked"
import { createComponent } from "solid-js/web"
import type { AnyBlock, TextBlock, ToolEntry, ToolStreamingText } from "../../../src/infra/output-blocks.js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import type { OutputTranscriptView, TranscriptSnapshot } from "../../../src/tui/transcript-store/output-transcript-cache-types.js"
import { renderWindow, transcriptOf } from "./_output-window-transcript.js"
import { heightEstimatesFromBlocks } from "../../../src/tui/hooks/output-height-estimates.js"
import flywheelTheme from "../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../src/tui/context/theme/resolve.js"
import { twoColorPng } from "../../helpers/image.js"
import { ImageRenderable, NativeImage, ScrollBoxRenderable, type BaseRenderable, type TextRenderable } from "@opentui/core"
import { captureNativeOutput } from "./_native-output.js"
import { ImageClip } from "../../../src/tui/components/image-clip.js"
import { ImageClipBottomProvider } from "../../../src/tui/context/attachment-images.js"

interface StreamingText {
  readonly [toolUseId: string]: ToolStreamingText
}

async function mountOutputWindow(
  outputBlocks: readonly AnyBlock[],
  height = 20,
  streamingToolText?: () => StreamingText,
  sessionKind: "chat" | "subagent" | "workflow-agent" = "chat",
  hydrateBlockBody?: OutputTranscriptView["hydrateBlockBody"],
  transcriptOverride?: OutputTranscriptView,
  running = false,
) {
  const [{ OutputWindow }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
    import("../../../src/tui/context/tick-pool-context.js"),
  ])

  return testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(TickPoolProvider, { get children() { return createComponent(OutputWindow, {
          layoutSlot: {},
          sessionIntro: {
            moduleRows: () => [],
            runtimeIdentity: () => ({ version: "0.0.1", buildId: null }), showBuild: () => false,
            projectRoot: () => "/Users/test/project",
            accountHome: "/Users/test",
            userDataRoot: "/Users/test/.flywheel",
            branchName: () => undefined,
            sessionKind: () => sessionKind,
            modelLabel: () => "gpt-5.5 xhigh",
            profileName: () => "default",
            fontTipDismissed: () => false,
            tabsHintDismissed: () => false, onDismissTabsHint: () => {},
            availableWidth: () => 80,
            noProviderReady: () => false,
          },
          transcript: transcriptOverride ?? { ...transcriptOf(outputBlocks), ...(hydrateBlockBody ? { hydrateBlockBody } : {}) },
          get streamingToolText() {
            return streamingToolText?.()
          },
          running,
        }) } })
      },
    }),
    { width: 100, height },
  )
}

async function renderOutputWindow(
  outputBlocks: readonly AnyBlock[],
  height = 20,
  streamingToolText?: StreamingText,
  sessionKind: "chat" | "subagent" | "workflow-agent" = "chat",
  hydrateBlockBody?: OutputTranscriptView["hydrateBlockBody"],
): Promise<string> {
  const result = await mountOutputWindow(outputBlocks, height, streamingToolText ? () => streamingToolText : undefined, sessionKind, hydrateBlockBody)
  try {
    // Two passes with a task-queue flush between: the first layout reports row
    // measurements (coalesced into a microtask batch), the follow-up pass applies
    // the resulting bottom pin. The live TUI renders continuously, so a one-shot
    // capture would race the pin.
    await result.renderOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
    await result.renderOnce()
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}

function pendingBash(id = "bash-live"): ToolEntry {
  return {
    kind: "tool",
    id,
    name: "bash",
    presentation: { name: "Bash", detail: "bun run test" },
    status: "pending",
    timestamp: 1,
  }
}

describe("OutputWindow", () => {
  it("clips a growing image sibling in the first painted frame without losing transcript extent", async () => {
    const { chunks, stdout, nativeSession } = captureNativeOutput(20, 12)
    const [height, setHeight] = createSignal(2)
    const pixels = NativeImage.fromRgba(new Uint8Array(80 * 80 * 4).fill(255), 80, 80)
    let scrollbox: ScrollBoxRenderable | undefined
    let first: ImageRenderable | undefined
    let second: ImageRenderable | undefined
    let following: TextRenderable | undefined
    const result = await testRender(() => <scrollbox ref={(node) => { scrollbox = node }} width={20} height={12} viewportCulling={false}>
      <ImageClipBottomProvider value={() => 6}>
        <ImageClip>
          <image ref={(node) => { first = node }} source={pixels} width={10} height={height()} flexShrink={0} protocol="kitty" fit="fill" />
        </ImageClip>
        <ImageClip>
          <image ref={(node) => { second = node }} source={pixels} width={10} height={6} flexShrink={0} protocol="kitty" fit="fill" />
        </ImageClip>
        <text ref={(node) => { following = node }} height={1} flexShrink={0}>FOLLOWING</text>
        <box height={40} flexShrink={0} />
      </ImageClipBottomProvider>
    </scrollbox>, { width: 20, height: 12, stdout, nativeSession, bufferedOutput: "stdout", exitSignals: [], useMouse: false })
    try {
      await result.renderer.setupTerminal()
      if (!first || !second || !following || !scrollbox) throw new Error("Missing transcript images")
      await Promise.all([first.loadPromise, second.loadPromise])
      await result.renderOnce()
      await result.renderOnce()
      const before = { following: following.y, extent: scrollbox.scrollHeight }
      expect(before).toEqual({ following: 8, extent: 49 })
      chunks.length = 0
      setHeight(5)
      await result.renderOnce()
      await nativeSession.idle()
      const placements = Buffer.concat(chunks).toString().split("\x1b_G")
        .filter((command) => command.startsWith("a=p,"))
        .map((command) => Number(/(?:^|,)r=(\d+)/.exec(command)?.[1]))
      expect(placements).toEqual([5, 1])
      expect(second.y).toBe(5)
      expect(following.y).toBe(before.following + 3)
      expect(scrollbox.scrollHeight).toBe(before.extent + 3)
    } finally {
      await result.dispose()
      pixels.dispose()
    }
  })

  it("keeps loaded queued images scrollable without covering the timeline", async () => {
    const blocks: readonly AnyBlock[] = [
      { kind: "text", id: "timeline", content: Array.from({ length: 50 }, (_, index) => `timeline line ${index + 1}`).join("\n"), timestamp: 1 },
      { kind: "userMessage", id: "queued-pictures", content: "Queued [Image #1] [Image #2] [Image #3]", pending: true, injected: false, timestamp: 2,
        images: Array.from({ length: 3 }, () => ({ mediaType: "image/png", data: twoColorPng(128, 96) })) },
    ]
    const result = await mountOutputWindow(blocks, 30)
    const descendants = (node: BaseRenderable): BaseRenderable[] => [node, ...node.getChildren().flatMap(descendants)]
    try {
      await result.renderOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const images = descendants(result.renderer.root).filter((node): node is ImageRenderable => node instanceof ImageRenderable)
      await Promise.all(images.map((image) => image.loadPromise))
      for (let pass = 0; pass < 4; pass++) await result.renderOnce()
      expect(images).toHaveLength(3)
      expect(result.captureCharFrame()).toContain("timeline line 50")
      const boxes = descendants(result.renderer.root).filter((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)
      expect(boxes).toHaveLength(2)
      const dock = boxes[1]!
      expect(dock.height).toBeLessThanOrEqual(15)
      expect(dock.scrollHeight).toBeGreaterThan(dock.height)
      dock.scrollTo({ x: 0, y: 0 })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Queued [Image #1]")
    } finally { result.renderer.destroy() }
  })
  // Every estimate says one row per block while each paragraph block lays out
  // in six. A window the landing reads is a new generation, so every row above
  // the card corrects while it mounts, over many frames; a window that already
  // holds the card keeps its measured rows. A session over the resident budget
  // mounts only the neighbourhood of the view, whose rows off screen lay out
  // without reporting their heights. A diff card takes its production estimate
  // and adds its truncation note in a layout round after its first one, so the
  // rows above the card move once more before the frame paints.
  const wide = `bun run target ${Array.from({ length: 60 }, (_, i) => `arg${i}`).join(" ")}`
  it.each([
    { placement: "in the middle", total: 150, target: 100, opened: [140, 149], read: [0, 149], command: "bun run target", height: 24, row: 12 },
    { placement: "in the middle of the window that holds it", total: 150, target: 100, opened: [0, 149], read: undefined, command: "bun run target", height: 24, row: 12 },
    { placement: "from its top when it is taller than the view", total: 150, target: 100, opened: [140, 149], read: [0, 149], command: wide, height: 8, row: 2 },
    { placement: "as near the middle as the end allows", total: 150, target: 148, opened: [140, 149], read: [0, 149], command: "bun run target", height: 24, row: 15 },
    { placement: "in the middle of a long session's window that holds it", total: 1500, target: 1000, opened: [900, 1100], read: undefined, command: "bun run target", height: 24, row: 12 },
    { placement: "in the middle of a long session's window read around it", total: 1500, target: 1000, opened: [1300, 1499], read: [900, 1100], command: "bun run target", height: 24, row: 12 },
    { placement: "in the middle of a long session's tail window that holds it far above its mounted rows, among diff cards", total: 3001, target: 2291, opened: [2001, 3000], read: undefined, command: "bun run target", height: 24, row: 12, diffEvery: 8, paragraphs: 5 },
  ])("lands a card $placement on the first painted frame and holds it there while the rows above it measure", async ({ total, target, opened, read, command, height, row, diffEvery, paragraphs = 3 }) => {
    const blocks = Array.from({ length: total }, (_, index): FrontendOutputBlock => index === target
      ? { ...pendingBash("target-process"), action: "shell_exec", presentation: { name: "Bash", detail: command }, status: "completed" }
      : diffEvery !== undefined && index % diffEvery === 0
        ? { kind: "tool", id: `diff${index}`, name: "subagent", status: "completed", presentation: { name: "Subagent", detail: `diff ${index}` }, timestamp: 1,
          diff: `@@ -1,20 +1,20 @@\n${Array.from({ length: 20 }, (_line, line) => `-old ${index} ${line}\n+new ${index} ${line}`).join("\n")}` }
        : { kind: "text", id: `t${index}`, content: Array.from({ length: paragraphs }, (_paragraph, paragraph) => `para ${index} part ${paragraph}`).join("\n\n"), timestamp: 1 })
    const whole = transcriptOf(blocks).visibleRange()!
    const window = ([start, end]: readonly number[], generation: number): TranscriptSnapshot => ({
      ...whole,
      generation,
      blocks: blocks.slice(start, end! + 1),
      window: { ...whole.window, startBlockIndex: start!, endBlockIndex: end!, hasBefore: start! > 0, hasAfter: end! < total - 1 },
      heightEstimates: heightEstimatesFromBlocks(blocks.slice(start, end! + 1), start!, false)
        .map((estimate) => {
          const block = blocks[estimate.blockIndex]
          return block?.kind === "tool" && block.diff !== undefined ? estimate : { ...estimate, rows: 1 }
        }),
    })
    const [snapshot, setSnapshot] = createSignal(window(opened, 1))
    const { result, setCommand } = await renderWindow({
      ...transcriptOf(blocks),
      visibleRange: snapshot,
      async loadAround() { if (read) setSnapshot(window(read, 2)) },
    }, height, 60)
    try {
      setCommand({ id: 1, type: "block", entryId: "target-process" })
      await Promise.resolve()
      await Promise.resolve()
      const commandRows: number[] = []
      for (let frame = 0; frame < 12; frame++) {
        await result.renderOnce()
        const lines = result.captureCharFrame().split("\n")
        commandRows.push(lines.findIndex((line) => line.includes("└ bun run target")))
        // The person asked to be at the card, so a land that reaches the end
        // does not resume following the live end.
        expect(lines.join("\n")).toContain("Latest ↓")
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
      }
      // The card opens with a blank row, then its title, then the command.
      expect(commandRows).toEqual(Array.from({ length: 12 }, () => row))
    } finally {
      result.renderer.destroy()
    }
  })

  it("highlights only the landed call of a tool run until a later landing replaces it or three seconds pass", async () => {
    const ranBash = (id: string, command: string): FrontendOutputBlock => ({
      ...pendingBash(id),
      action: "shell_exec",
      presentation: { name: "Bash", detail: command },
      status: "completed",
    })
    const { result, setCommand } = await renderWindow(transcriptOf([
      ranBash("first-process", "bun run first"),
      ranBash("target-process", "bun run target"),
    ]), 12, 60)
    const theme = resolveTheme(flywheelTheme, "dark")
    // The detail splits into highlighted spans; its last word names the call.
    const background = (text: string) => result.captureSpans().lines
      .flatMap((line) => line.spans)
      .find((span) => span.text.includes(text))?.bg
    // The renderer runs on real timers; only the three-second highlight timers
    // are held, by handle, so the test can expire them without waiting and see
    // which ones the window cancelled.
    const heldTimers = new Map<unknown, () => void>()
    const realSetTimeout = globalThis.setTimeout
    const realClearTimeout = globalThis.clearTimeout
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(realSetTimeout, {
      apply(target, _receiver, args: Parameters<typeof setTimeout>) {
        if (args[1] !== 3000) return target(...args)
        const [callback] = args
        const handle = target(() => {}, 0)
        heldTimers.set(handle, () => callback())
        return handle
      },
    }))
    const clears = spyOn(globalThis, "clearTimeout").mockImplementation(new Proxy(realClearTimeout, {
      apply(target, _receiver, args: Parameters<typeof clearTimeout>) {
        heldTimers.delete(args[0])
        return target(...args)
      },
    }))
    const land = async (id: number, entryId: string) => {
      setCommand({ id, type: "block", entryId })
      await Promise.resolve()
      await Promise.resolve()
      await result.renderOnce()
    }
    const expireHeldTimers = () => {
      const due = [...heldTimers.values()]
      heldTimers.clear()
      for (const expire of due) expire()
    }
    let destroyed = false
    try {
      expect(result.captureCharFrame()).toMatch(/Ran[^]*bun run first[^]*bun run target/)
      await land(1, "target-process")
      expect(background("target")?.equals(theme.backgroundElement)).toBe(true)
      expect(background("first")?.equals(theme.backgroundElement)).toBe(false)
      expect(heldTimers.size).toBe(1)

      // The replacement cancels the first deadline, so passing it keeps the
      // new highlight; only the replacement's own deadline clears it.
      await land(2, "first-process")
      expect(background("first")?.equals(theme.backgroundElement)).toBe(true)
      expect(background("target")?.equals(theme.backgroundElement)).toBe(false)
      expect(heldTimers.size).toBe(1)
      expireHeldTimers()
      await result.renderOnce()
      expect(background("first")?.equals(theme.backgroundElement)).toBe(false)

      await land(3, "target-process")
      expect(heldTimers.size).toBe(1)
      result.renderer.destroy()
      destroyed = true
      expect(heldTimers.size).toBe(0)
    } finally {
      timers.mockRestore()
      clears.mockRestore()
      if (!destroyed) result.renderer.destroy()
    }
  })

  it("renders the session intro before real output without putting it in outputBlocks", async () => {
    const outputBlocks: readonly TextBlock[] = [{
      kind: "text",
      id: "assistant-1",
      content: "Assistant response",
      timestamp: 1,
    }]

    const frame = await renderOutputWindow(outputBlocks)

    expect(frame).toContain(">_ Flywheel (v0.0.1)")
    expect(frame).not.toContain("session:   chat")
    expect(frame).toContain("Assistant response")
    expect(outputBlocks).toHaveLength(1)
  })

  it("renders the intro for a known-empty new chat without weakening the reopened-session loading gate", async () => {
    const complete = transcriptOf([]).visibleRange()!
    const [snapshot, setSnapshot] = createSignal<TranscriptSnapshot>({
      ...complete,
      status: { kind: "loading" },
      source: { kind: "loading" },
      generation: 0,
    })
    const transcript = { ...transcriptOf([]), visibleRange: snapshot }
    const result = await mountOutputWindow([], 20, undefined, "chat", undefined, transcript)

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain(">_ Flywheel")

      setSnapshot(complete)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(">_ Flywheel (v0.0.1)")
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows Starting worker for a running empty session only after its transcript has loaded", async () => {
    const complete = transcriptOf([]).visibleRange()!
    const [snapshot, setSnapshot] = createSignal<TranscriptSnapshot>({
      ...complete,
      status: { kind: "loading" },
      source: { kind: "loading" },
      generation: 0,
    })
    const transcript = { ...transcriptOf([]), visibleRange: snapshot }
    const result = await mountOutputWindow([], 20, undefined, "chat", undefined, transcript, true)

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Starting worker...")

      setSnapshot(complete)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Starting worker...")
    } finally {
      result.renderer.destroy()
    }
  })

  it.each([
    { status: { kind: "recovery-failed" as const, message: "offline", updatedAt: 0 }, says: "Output recovery failed. The transcript may be stale." },
    { status: { kind: "unavailable" as const, notice: { id: "n", scope: "output", presentation: "transcript.unavailable", severity: "error", title: "Session history unavailable", message: "Its history cannot be read.", startedAt: 0, updatedAt: 0 } as const, diagnostic: "no metadata" }, says: "Session history unavailable. Its history cannot be read." },
  ])("says why an empty $status.kind transcript shows nothing, as a warning", async ({ status, says }) => {
    const complete = transcriptOf([]).visibleRange()!
    const transcript = { ...transcriptOf([]), visibleRange: () => ({ ...complete, status }) }
    const result = await mountOutputWindow([], 20, undefined, "subagent", undefined, transcript)
    const theme = resolveTheme(flywheelTheme, "dark")

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(says)
      const first = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => says.startsWith(span.text.trim()) && span.text.trim().length > 0)
      expect(first?.fg.equals(theme.warning)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it.each(["workflow-agent", "subagent"] as const)("starts %s transcripts with their first entry", async (sessionKind) => {
    const frame = await renderOutputWindow([{
      kind: "userMessage",
      id: "user-1",
      content: "Inspect the session",
      timestamp: 1,
      pending: false,
      injected: false,
    }], 20, undefined, sessionKind)

    expect(frame).not.toContain(">_ Flywheel")
    expect(frame).toContain("Inspect the session")
  })

  it("delivers live execution output to already-mounted grouped bash rows", async () => {
    const toolUseId = "bash-live"
    const [streaming, setStreaming] = createSignal<StreamingText>({})
    const result = await mountOutputWindow([pendingBash(toolUseId)], 20, streaming)

    try {
      await result.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("bun run test ▸")

      setStreaming({ [toolUseId]: { content: "live line" } })
      await result.renderOnce()
      const frame = result.captureCharFrame()

      expect(frame).toContain("bun run test ▸")
      expect(frame).not.toContain("live line")
    } finally {
      result.renderer.destroy()
    }
  })

  it.each([false, true])("renders a content-sized queue below a full scrollback (image: %s)", async (hasImage) => {
    const requested: string[] = []
    const queued = {
      kind: "userMessage" as const,
      id: "queued-image",
      content: hasImage ? "queued first line [Image #1]\nqueued second line" : "queued first line\nqueued second line",
      timestamp: 2,
      pending: true,
      injected: false,
      imageCount: hasImage ? 1 : 0,
    }
    const outputBlocks: readonly AnyBlock[] = [
      {
        kind: "text",
        id: "assistant-1",
        content: Array.from({ length: 50 }, (_, i) => `timeline line ${i + 1}`).join("\n"),
        timestamp: 1,
      },
      queued,
    ]

    const frame = await renderOutputWindow(outputBlocks, 12, undefined, "chat", async (id) => { requested.push(id) })

    expect(frame).toContain("queued first line")
    expect(frame).toContain("queued second line")
    expect(frame).toContain("(queued)")
    expect(requested).toEqual(hasImage ? ["userMessage:queued-image"] : [])
    const rows = frame.split("\n")
    const queuedSecondLineIndex = rows.findIndex((line) => line.includes("queued second line"))
    const queuedMarkerIndex = rows.findIndex((line) => line.includes("(queued)"))
    expect(queuedMarkerIndex).toBe(queuedSecondLineIndex)
    expect(rows[queuedMarkerIndex]).toContain("queued second line (queued)")
    expect(queuedMarkerIndex).toBe(10)
    // The trailing spacer keeps the tail above the overlaid queue dock while
    // the scrollbar retains the full transcript height.
    const timelineTailIndex = rows.findIndex((line) => line.includes("timeline line 50"))
    expect(timelineTailIndex).toBeGreaterThanOrEqual(0)
    expect(queuedMarkerIndex).toBeGreaterThan(timelineTailIndex)
    expect(rows.some((line) => /[▀▄█]/.test(line.slice(-4)))).toBe(true)
  })

  it("lexes only the growing end of a streamed reply in a window read with a consistency token", async () => {
    // Hot-path work count. Every runtime read carries a consistency token, so
    // the token cannot mark a window as history: the last block still grows
    // and must take the incremental lex, whose work per delta stays bounded.
    const reply = (paragraphs: number): TranscriptSnapshot => ({
      ...transcriptOf([{ kind: "text", id: "reply", content: Array.from({ length: paragraphs }, (_, i) => `Paragraph ${String(i).padStart(4, "0")} of the streamed reply.`).join("\n\n"), timestamp: 1 } satisfies TextBlock]).visibleRange()!,
      source: { kind: "historical", consistencyToken: "durable:runtime:7" },
    })
    const [snapshot, setSnapshot] = createSignal(reply(1))
    const result = await mountOutputWindow([], 20, undefined, "chat", undefined, { ...transcriptOf([]), visibleRange: () => snapshot() })
    const lexer = spyOn(marked, "lexer")
    try {
      await result.renderOnce()
      const lexedPerDelta: number[] = []
      for (let paragraphs = 2; paragraphs <= 120; paragraphs++) {
        lexer.mockClear()
        setSnapshot(reply(paragraphs))
        lexedPerDelta.push(lexer.mock.calls.reduce((sum, [input]) => sum + input.length, 0))
      }
      const early = Math.max(...lexedPerDelta.slice(10, 30))
      expect(early).toBeGreaterThan(0)
      expect(Math.max(...lexedPerDelta.slice(98))).toBeLessThanOrEqual(early)
      await result.renderOnce()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Paragraph 0119 of the streamed reply.")
    } finally {
      lexer.mockRestore()
      result.renderer.destroy()
    }
  })
})
