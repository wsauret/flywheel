import { describe, expect, it } from "bun:test";
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { TextRenderable, type BaseRenderable, type ScrollBoxRenderable } from "@opentui/core"
import type { AnyBlock } from "../../../src/infra/output-blocks.js"
import { renderWindow, transcriptOf } from "./_output-window-transcript.js"

function textsUnder(node: BaseRenderable): TextRenderable[] {
  const own = node instanceof TextRenderable ? [node] : []
  return [...own, ...node.getChildren().flatMap(textsUnder)]
}

async function renderOutputWindow(outputBlocks: readonly AnyBlock[], height = 18): Promise<{ readonly frame: string; readonly scrollbox: ScrollBoxRenderable }> {
  const [{ OutputWindow }, { ThemeProvider }] = await Promise.all([
    import("../../../src/tui/output-window/output-window.js"),
    import("../../../src/tui/context/theme.js"),
  ])

  let scrollbox!: ScrollBoxRenderable
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(OutputWindow, {
          layoutSlot: {},
          transcript: transcriptOf(outputBlocks),
          running: false,
          sessionIntro: {
            moduleRows: () => [],
            runtimeIdentity: () => ({ version: "0.0.0-test", buildId: null }), showBuild: () => false,
            projectRoot: () => "/scratch/project",
            accountHome: "/scratch/home",
            userDataRoot: "/scratch/home/.flywheel",
            branchName: () => undefined,
            sessionKind: () => "workflow-agent" as const,
            modelLabel: () => undefined,
            profileName: () => "default",
            fontTipDismissed: () => false,
            tabsHintDismissed: () => false, onDismissTabsHint: () => {},
            availableWidth: () => 60,
          },
          captureScrollbox: (el: ScrollBoxRenderable) => { scrollbox = el },
        })
      },
    }),
    { width: 60, height },
  )

  try {
    await result.renderOnce()
    // Second pass: the queued-message overlay measures its height on the first
    // layout and mounts the matching in-scrollbox spacer reactively.
    await result.renderOnce()
    return { frame: result.captureCharFrame(), scrollbox }
  } finally {
    result.renderer.destroy()
  }
}

function xRunLengthsAfter(rows: string[], label: string): number[] {
  const start = rows.findIndex((line) => line.includes(label))
  expect(start).toBeGreaterThanOrEqual(0)

  const lengths: number[] = []
  for (const line of rows.slice(start + 1)) {
    const match = line.match(/x+/)
    if (match) {
      lengths.push(match[0].length)
      continue
    }
    if (lengths.length > 0) break
  }
  return lengths
}

function borderColumnForMessage(rows: string[], label: string): number {
  const row = rows.find((line) => line.includes(label))
  expect(row).toBeDefined()
  const column = row!.indexOf("┃")
  expect(column).toBeGreaterThanOrEqual(0)
  return column
}

describe("OutputWindow layout", () => {
  it("wraps queued user messages at the same width as delivered user messages", async () => {
    const longWord = "x".repeat(110)
    const outputBlocks: readonly AnyBlock[] = [
      {
        kind: "userMessage",
        id: "normal",
        content: `normal ${longWord}`,
        timestamp: 1,
        pending: false,
        injected: false,
      },
      {
        kind: "userMessage",
        id: "queued",
        content: `queued ${longWord}`,
        timestamp: 2,
        pending: true,
        injected: false,
      },
    ]

    // The session intro card renders above the timeline inside the scrollbox;
    // the taller viewport keeps both messages fully visible despite it.
    const rows = (await renderOutputWindow(outputBlocks, 36)).frame.split("\n")

    expect(xRunLengthsAfter(rows, "queued")).toEqual(xRunLengthsAfter(rows, "normal"))
  })

  it("aligns queued user messages with delivered user messages", async () => {
    const outputBlocks: readonly AnyBlock[] = [
      {
        kind: "userMessage",
        id: "normal",
        content: "normal message",
        timestamp: 1,
        pending: false,
        injected: false,
      },
      {
        kind: "userMessage",
        id: "queued",
        content: "queued message",
        timestamp: 2,
        pending: true,
        injected: false,
      },
    ]

    const rows = (await renderOutputWindow(outputBlocks, 30)).frame.split("\n")

    expect(borderColumnForMessage(rows, "queued message")).toBe(
      borderColumnForMessage(rows, "normal message"),
    )
  })

  it("extends the scroll range by the queued message height without shrinking the viewport", async () => {
    const history: AnyBlock = {
      kind: "text",
      id: "assistant-history",
      content: Array.from({ length: 40 }, (_, i) => `timeline line ${i + 1}`).join("\n"),
      timestamp: 1,
    }
    const queued: AnyBlock = {
      kind: "userMessage",
      id: "queued",
      content: "queued first line\nqueued second line",
      timestamp: 2,
      pending: true,
      injected: false,
    }

    const withoutQueued = await renderOutputWindow([history], 12)
    const withQueued = await renderOutputWindow([history, queued], 12)
    const rows = withQueued.frame.split("\n")

    // The queued overlay sits over the scrollbox bottom, not below it: the
    // viewport keeps its full height (so the scrollbar spans down to the
    // prompt bar) and a trailing spacer extends the scroll range by the
    // overlay's measured height.
    expect(withQueued.scrollbox.viewport.height).toBe(withoutQueued.scrollbox.viewport.height)
    expect(withQueued.scrollbox.scrollHeight).toBeGreaterThan(withoutQueued.scrollbox.scrollHeight)
    expect(rows.findIndex((line) => line.includes("timeline line"))).toBeLessThan(
      rows.findIndex((line) => line.includes("queued first line")),
    )
  })

  it("lays out a user message taller than the viewport at full height and scrolls only the transcript under the wheel", async () => {
    // The shape of a long first message: wrapped paragraphs, blank lines, and
    // one very long line. Only some word layouts trip OpenTUI 0.6.8's row
    // clamp, and this one does.
    const content = Array.from({ length: 30 }, (_, i) => {
      if (i % 3 === 2) return ""
      const words = `L${i}${` word${i}`.repeat(110)}`
      return words.slice(0, i === 4 ? 532 : 120)
    }).join("\n")
    const outputBlocks: readonly AnyBlock[] = [
      { kind: "userMessage", id: "long", content, timestamp: 1, pending: false, injected: false },
      { kind: "text", id: "reply", content: "short reply", timestamp: 2 },
    ]
    const { scrollbox, result } = await renderWindow(transcriptOf(outputBlocks), 20, 100)
    try {
      const message = textsUnder(scrollbox).find((text) => text.plainText.startsWith("L0 "))!
      expect(message.virtualLineCount).toBeGreaterThan(scrollbox.viewport.height)
      expect(message.height).toBe(message.virtualLineCount)

      scrollbox.scrollTo(0)
      await result.renderOnce()
      const [x, y] = [message.x + 2, Math.max(message.y, scrollbox.viewport.y) + 1]
      expect(result.renderer.hitTest(x, y)).toBe(message.num)
      await result.mockMouse.scroll(x, y, "down")
      await result.renderOnce()
      expect(scrollbox.scrollTop).toBeGreaterThan(0)
      expect(message.scrollY).toBe(0)
    } finally {
      result.renderer.destroy()
    }
  })
})
