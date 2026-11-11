/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"

const { testRender } = await import("@opentui/solid")
const { createSignal, Show } = await import("solid-js")
const { ThinkingBlock } = await import("../../../../src/tui/output-blocks/thinking-block.js")
const { ThemeProvider, useTheme } = await import("../../../../src/tui/context/theme.js")
const { BlockDisclosureProvider, createBlockDisclosureChannel } = await import("../../../../src/tui/context/block-disclosure.js")
const { TickPoolProvider } = await import("../../../../src/tui/context/tick-pool-context.js")
const { OutputProjector } = await import("../../../../src/infra/output/output-projector.js")
const { RuntimeEventProjector } = await import("../../../../src/infra/output/runtime-event-projector.js")
const { handleStreamEvent } = await import("../../../../src/orchestration/agent-runtime/assistant-turn-result.js")
const { emitAgentStreamEvent } = await import("../../../../src/orchestration/agent-runtime/runner-stream-events.js")
const { createThinkingAccumulator, emitTurnAssistant } = await import("../../../../src/orchestration/agent-runtime/emit.js")
const { createTurnUsageTracker } = await import("../../../../src/orchestration/agent-runtime/turn-usage-tracker.js")
const { RequestToolMap } = await import("../../../helpers/request-tool-surface.js")
import type { ThinkingBlock as ThinkingBlockType } from "../../../../src/infra/output-blocks.js"
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js"
import type { ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"

describe("thinking disclosure", () => {
  it("keeps a thought the person opened open when the thought completes", async () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" })
    const runtime = new RuntimeEventProjector(projector)
    const turn: AssistantTurnResult = {
      entryId: "entry", outcome: { kind: "ok", stopReason: "unknown" }, assistantContent: [], toolCalls: [],
      assistantMetadata: undefined, lastAssistantMetadata: undefined, usageAnchor: undefined, terminalEvent: undefined, transportContext: undefined,
    }
    const context = {
      options: { onEvent: (event: Parameters<typeof runtime.dispatch>[0]) => runtime.dispatch(event) },
      contextWindow: 200_000,
      costTracker: createTurnUsageTracker({ emit: () => {}, budgetStreamId: "thinking-disclosure" }),
      providerSessionKey: "thinking-disclosure",
      parentToolUseId: undefined,
      thinking: createThinkingAccumulator(),
      tools: new RequestToolMap(),
    }
    // The runtime's own projection of one provider stream feeds the row, as
    // the client's patched transcript does.
    const [block, setBlock] = createSignal<ThinkingBlockType | undefined>()
    const publish = () => setBlock(projector.getBlocks().find((candidate): candidate is ThinkingBlockType => candidate.kind === "thinking"))
    const stream = (event: Extract<ProviderStreamEvent, { kind: "thinking_delta" | "thinking_complete" }>) => {
      const published = handleStreamEvent(event, turn)
      if (published.kind === "thinking_delta" || published.kind === "thinking_complete") emitAgentStreamEvent(published, context)
      publish()
    }
    stream({ kind: "thinking_delta", text: "one\ntwo\nthree\n", blockKey: "run:0" })
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode="dark"><TickPoolProvider>
      <Show when={block()}>{(shown) => <ThinkingBlock block={shown()} />}</Show>
    </TickPoolProvider></ThemeProvider></BlockDisclosureProvider>, { width: 60, height: 12 })
    const header = () => result.captureCharFrame().split("\n")[0] ?? ""
    try {
      stream({ kind: "thinking_delta", text: "four\nfive", blockKey: "run:0" })
      await result.renderOnce()
      expect(header()).toContain("▸")
      await result.mockMouse.click(header().indexOf("▸"), 0)
      await result.renderOnce()
      expect(header()).toContain("▾")

      stream({ kind: "thinking_complete", thinking: "one\ntwo\nthree\nfour\nfive", signature: "c2lnbmVk", blockKey: "run:0" })
      emitTurnAssistant(context.options.onEvent, turn.assistantContent, context.costTracker, undefined, "entry")
      publish()
      await result.renderOnce()
      expect(block()?.status).toBe("completed")
      expect(header()).toContain("▾")
    } finally { result.renderer.destroy() }
  })
})

describe("thinking body hitbox", () => {
  it("toggles and highlights from the rail and padding beside its shown body, while the space beside its header does nothing", async () => {
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <ThinkingBlock block={{ kind: "thinking", id: "think", content: "one\ntwo\nthree\nfour\nfive", status: "completed", timestamp: 1, completedAt: 1 }} />
    }
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode="dark"><TickPoolProvider>
      <Harness />
    </TickPoolProvider></ThemeProvider></BlockDisclosureProvider>, { width: 60, height: 10 })
    const rows = () => result.captureCharFrame().split("\n")
    const header = () => rows()[0] ?? ""
    try {
      await result.renderOnce()
      expect(header()).toContain("▸")
      await result.mockMouse.click(50, 0)
      await result.renderOnce()
      expect(header()).toContain("▸")

      // The rail cell and the padding cell beside the preview's first line.
      const preview = rows().findIndex((row) => row.includes("three"))
      const rail = rows()[preview]?.indexOf("┃") ?? -1
      await result.mockMouse.moveTo(rail, preview)
      await result.renderOnce()
      const text = result.captureSpans().lines[preview]?.spans.find((span) => span.text.includes("three"))
      if (!colors) throw new Error("Missing theme")
      expect(text?.bg.equals(colors.backgroundElement)).toBe(true)
      await result.mockMouse.click(rail, preview)
      await result.renderOnce()
      expect(header()).toContain("▾")

      await result.mockMouse.click(rail + 1, rows().findIndex((row) => row.includes("one")))
      await result.renderOnce()
      expect(header()).toContain("▸")
    } finally { result.renderer.destroy() }
  })

  it("redraws its rail in the new theme's colour after a mode switch", async () => {
    const [mode, setMode] = createSignal<"dark" | "light">("dark")
    let colors: ReturnType<typeof useTheme>["theme"] | undefined
    function Harness() {
      colors = useTheme().theme
      return <ThinkingBlock block={{ kind: "thinking", id: "think", content: "one\ntwo\nthree\nfour\nfive", status: "completed", timestamp: 1, completedAt: 1 }} />
    }
    const result = await testRender(() => <BlockDisclosureProvider value={createBlockDisclosureChannel()}><ThemeProvider mode={mode()}><TickPoolProvider>
      <Harness />
    </TickPoolProvider></ThemeProvider></BlockDisclosureProvider>, { width: 60, height: 10 })
    const railColor = () => {
      const lines = result.captureSpans().lines
      const row = lines.findIndex((line) => line.spans.some((span) => span.text.includes("three")))
      return lines[row]?.spans.find((span) => span.text.includes("┃"))?.fg
    }
    try {
      await result.renderOnce()
      if (!colors) throw new Error("Missing theme")
      const dark = colors.borderSubtle
      expect(railColor()?.equals(dark)).toBe(true)
      setMode("light")
      await result.renderOnce()
      expect(colors.borderSubtle.equals(dark)).toBe(false)
      expect(railColor()?.equals(colors.borderSubtle)).toBe(true)
    } finally { result.renderer.destroy() }
  })
})
