/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { ScrollBoxRenderable, TextRenderable, type Renderable } from "@opentui/core"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import type { SessionPreviewState } from "../../../../src/tui/session-picker/use-session-preview.js"
import type { HydratedOutputRange, OutputRangeRequest } from "../../../../src/protocol/transcript-protocol-types.js"
import type { AnyBlock } from "../../../../src/infra/output-blocks.js"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { session as catalogSession } from "../hooks/_session-modal-fixtures.js"
import type { SessionPickerResult } from "../../../../src/tui/hooks/use-session-modal-types.js"
import { scrollFrameHook } from "../../../helpers/scroll-frame-hook.js"

function descendants(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(descendants)]
}

async function renderPreview(preview: SessionPreviewState, session?: Parameters<typeof import("../../../../src/tui/session-picker/session-preview-pane.js").SessionPreviewPane>[0]["session"]): Promise<string> {
  const [{ SessionPreviewPane }, { ThemeProvider }] = await Promise.all([
    import("../../../../src/tui/session-picker/session-preview-pane.js"),
    import("../../../../src/tui/context/theme.js"),
  ])
  const result = await testRender(
    () =>
      createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          return createComponent(SessionPreviewPane, {
            preview: preview.status === "idle" ? preview : { ...preview, sessionId: preview.sessionId ?? "test-preview" },
            session,
            width: 60,
            height: 10,
          })
        },
      }),
    { width: 60, height: 10 },
  )

  try {
    await result.renderOnce()
    return result.captureCharFrame()
  } finally {
    result.renderer.destroy()
  }
}

describe("SessionPreviewPane", () => {
  it("keeps the mounted Sessions list and preview through the layout breakpoint and catalog replacement", async () => {
    const [{ SessionModal }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
      import("../../../../src/tui/modals/session-modal.js"),
      import("../../../../src/tui/context/theme.js"),
      import("../../../../src/tui/context/tick-pool-context.js"),
    ])
    const lanes = fakeLanes()
    const selected = catalogSession({ id: "a" })
    const [catalog, setCatalog] = createSignal<SessionPickerResult>({
      rows: [{ kind: "session", id: "a", category: "Recent", session: selected }], totalMatches: 1, capped: false, effectiveHighlightQuery: "", timeAgoWidth: 0,
    })
    const calls: { request: OutputRangeRequest; resolve: (range: HydratedOutputRange) => void; reject: (error: Error) => void }[] = []
    const held: AnyBlock[] = [
      { kind: "text", id: "intro", timestamp: 0, content: "earlier content" },
      { kind: "text", id: "reading", timestamp: 1, content: Array.from({ length: 100 }, (_, i) => `reading line ${i} ${"detail ".repeat(15)}`).join("\n") },
      { kind: "tool", id: "visible-tool", name: "bash", action: "shell_exec", presentation: { name: "Bash", detail: "resident-tool" }, status: "completed", timestamp: 2, content: "disclosed tool output" },
      { kind: "text", id: "separator", timestamp: 3, content: "before received message" },
      { kind: "userMessage", id: "received", content: "received message body", timestamp: 4, pending: false, injected: false,
        from: { sessionId: "sender", name: "Sender", relation: "sibling" } },
    ]
    const range = (blocks: readonly AnyBlock[], request: OutputRangeRequest) => hydrateDerivedOutputRange({ ...indexOutputBlocks(blocks), consistencyToken: "v1" }, request)
    const presentation = { value: "", cursor: 0, selection: null, preferredVisualColumn: null }
    const rendered = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(TickPoolProvider, {
          get children() {
            return createComponent(SessionModal, {
              get result() { return catalog() }, cursor: 0, navigationRevision: 0, actions: [],
              appService: { query: ({ request }) => new Promise<HydratedOutputRange>((resolve, reject) => calls.push({ request, resolve, reject })), onLane: lanes.onLane },
              onClose: () => {}, onRowClick: () => {}, filterQuery: "", inputPresentation: presentation,
              inputPlaceholder: "Search", renaming: false, renamePresentation: () => presentation, statusView: () => undefined, now: 0,
            })
          },
        })
      },
    }), { width: 119, height: 40 })
    try {
      await rendered.renderOnce()
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      const initial = calls[0]
      if (!initial) throw new Error("missing initial acquisition")
      initial.resolve(await range(held, initial.request))
      await Promise.resolve()
      await rendered.renderOnce()
      const scrollers = descendants(rendered.renderer.root).filter(node => node instanceof ScrollBoxRenderable)
      expect(scrollers).toHaveLength(2)
      const preview = scrollers[1]
      if (!preview) throw new Error("missing preview scroller")
      const update = scrollFrameHook(preview)
      const paint = async () => {
        await rendered.renderOnce()
        update(16)
        await rendered.renderOnce()
      }
      await paint()
      const textNodes = descendants(preview).filter(node => node instanceof TextRenderable)
      const tool = textNodes.find(node => node.plainText.includes("resident-tool"))
      if (!tool) throw new Error("missing visible tool")
      const frameRows = rendered.captureCharFrame().split("\n")
      const toolLine = frameRows.findIndex(line => line.includes("resident-tool"))
      const toolText = frameRows[toolLine]
      if (toolText === undefined) throw new Error(`tool is not visible: offset=${preview.scrollTop}, content=${preview.content.height}, viewport=${preview.viewport.height}\n${rendered.captureCharFrame()}`)
      await rendered.mockMouse.click(toolText.indexOf("resident-tool") + 1, toolLine)
      await paint()
      expect(tool.plainText).toContain("▾")
      preview.scrollTo(21)
      await paint()
      const readingOffset = preview.scrollTop
      expect(readingOffset).toBeGreaterThan(0)
      for (const width of [120, 119]) {
        rendered.resize(width, 40)
        await paint()
        const current = descendants(rendered.renderer.root)
        expect(scrollers.every(node => current.includes(node))).toBe(true)
        expect(current.includes(tool)).toBe(true)
        if (width === 119) expect(preview.scrollTop).toBe(readingOffset)
        else expect(preview.scrollTop).toBeGreaterThan(readingOffset)
        expect(rendered.captureCharFrame()).toContain("reading line 9")
      }
      setCatalog({ ...catalog(), rows: [{ kind: "session", id: "a", category: "Recent", session: { ...selected, title: "updated" } }] })
      await paint()
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      expect(calls).toHaveLength(1)
      lanes.open()
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      calls[1]?.reject(new Error("recovery failed"))
      await Promise.resolve()
      await Promise.resolve()
      await paint()
      expect(descendants(rendered.renderer.root).includes(preview)).toBe(true)
      expect(rendered.captureCharFrame()).toContain("Preview Unavailable")
      expect(rendered.captureCharFrame()).toContain("reading line 9")
      expect(preview.scrollTop).toBe(readingOffset)
      lanes.open()
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      const recovery = calls[2]
      if (!recovery) throw new Error("missing recovery acquisition")
      expect(recovery.request.anchor.kind).toBe("residentSpan")
      const newer: AnyBlock[] = Array.from({ length: 100 }, (_, i) => ({ kind: "text", id: `new-${i}`, timestamp: i + 3, content: `new output ${i}` }))
      const older: AnyBlock[] = Array.from({ length: 50 }, (_, i) => ({ kind: "text", id: `older-${i}`, timestamp: i, content: `older output ${i}` }))
      recovery.resolve(await range([...older, ...held, ...newer], recovery.request))
      await Promise.resolve()
      await paint()
      expect(descendants(rendered.renderer.root).includes(tool)).toBe(true)
      expect(tool.plainText).toContain("▾")
      expect(preview.scrollTop).toBeLessThan(readingOffset)
      expect(rendered.captureCharFrame()).toContain("reading line 9")
      const rebasedOffset = preview.scrollTop - readingOffset
      preview.scrollTo(201 + rebasedOffset)
      await paint()
      expect(rendered.captureCharFrame()).toContain("resident-tool ▾")
      const received = descendants(preview).find(node => node instanceof TextRenderable && node.plainText.includes("Message from"))
      if (!received) throw new Error("missing received message row")
      preview.scrollTo(preview.scrollTop + received.y - preview.viewport.y)
      await paint()
      const receivedOffset = received.y - preview.viewport.y
      lanes.open()
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      const receivedRecovery = calls[3]
      if (!receivedRecovery) throw new Error("missing received message recovery")
      const receivedAnchor = receivedRecovery.request.anchor
      if (receivedAnchor.kind !== "residentSpan") throw new Error("expected received message protection")
      expect(receivedAnchor.blockIds).toContain("userMessage:received")
      const tail = await range([...older, ...held, ...newer], { ...receivedRecovery.request, anchor: { kind: "tail" } })
      if (tail.kind !== "ok") throw new Error("expected tail history")
      expect(tail.blocks.some(block => block.kind === "userMessage" && block.id === "received")).toBe(false)
      receivedRecovery.resolve(await range([...older, ...held, ...newer], receivedRecovery.request))
      await Promise.resolve()
      await paint()
      expect(descendants(preview).includes(received)).toBe(true)
      expect(received.y - preview.viewport.y).toBe(receivedOffset)
      expect(rendered.captureCharFrame()).toContain("Message from")
      setCatalog({ ...catalog(), rows: [{ kind: "session", id: "b", category: "Recent", session: catalogSession({ id: "b" }) }] })
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).not.toContain("reading line")
      expect(rendered.captureCharFrame()).not.toContain("disclosed tool output")
      for (let i = 0; i < 6; i++) await Bun.sleep(30)
      const other = calls[4]
      if (!other) throw new Error("missing new subject acquisition")
      other.resolve(await range(held.filter(block => block.kind === "tool"), other.request))
      await Promise.resolve()
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("resident-tool ▸")
      expect(descendants(rendered.renderer.root).includes(tool)).toBe(false)
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("groups consecutive shell calls in the preview", async () => {
    const frame = await renderPreview({ status: "ready", streamingToolText: {}, blocks: [1, 2].map(n => ({
      kind: "tool", id: `bash-${n}`, name: "bash", action: "shell_exec", status: "completed", timestamp: n,
      presentation: { name: "Bash", detail: `echo preview-${n}` },
    })) })
    expect(frame).toContain("Ran")
    expect(frame).toContain("preview-1")
    expect(frame).toContain("preview-2")
  })

  it("does not show loading when no session is selected", async () => {
    const frame = await renderPreview({ status: "idle", blocks: [], streamingToolText: {} })

    expect(frame).toContain("No session selected")
    expect(frame).not.toContain("Loading Preview")
  })

  it("shows an unavailable advisory when the initial read has no content", async () => {
    const frame = await renderPreview({
      status: "unavailable", sessionId: "missing", blocks: [], streamingToolText: {},
      unavailable: { title: "Unavailable", message: "This preview cannot be read", diagnostic: "missing snapshot" },
    })
    expect(frame).toContain("Preview Unavailable")
    expect(frame).toContain("This preview cannot be read")
  })

  it("labels incomplete price totals", async () => {
    const frame = await renderPreview(
      { status: "ready", blocks: [], streamingToolText: {} },
      { id: "s1", kind: "chat", title: "Chat", lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: false, totalCost: 1.25, totalBilledCost: 0.5, priceUnavailable: true, totalTokens: 100, contextPercent: 10, contextPromptTokens: 50, durationMs: 1_000 },
    )
    expect(frame).toContain("$0.50 · ~$0.75 · price unavailable")
  })

  it("leaves unknown historical statistics blank", async () => {
    const frame = await renderPreview(
      { status: "ready", blocks: [], streamingToolText: {} },
      { id: "s1", kind: "chat", title: "Chat", lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/repo", totalsLoading: true },
    )

    expect(frame).not.toContain("totals loading")
    expect(frame).not.toContain("Loading totals")
    expect(frame).not.toContain("0%")
    expect(frame).not.toContain("$")
  })
})
