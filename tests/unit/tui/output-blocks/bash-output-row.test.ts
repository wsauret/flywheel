import { describe, expect, it, mock } from "bun:test"
import type { CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import type { ToolEntry, ToolStreamingText } from "../../../../src/infra/output-blocks.js"
import { resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { STRIKETHROUGH } from "../../../../src/tui/utils/text-attributes.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"

const theme = resolveTheme(flywheelThemeJson, "dark")
const CWD = "/workspace"

/** Presentation always comes from the resolver, so a row fixture cannot claim a
 *  presentation the projectors would not produce. */
const bashPresentation = (command: string) => resolveToolPresentation("bash", { command }, CWD)

interface StreamingToolTextById {
  readonly [toolUseId: string]: ToolStreamingText
}

interface RenderBashRowOptions {
  streamingToolText?: Readonly<StreamingToolTextById>
  height?: number
  width?: number
  activeManagedProcessToolCallIds?: () => ReadonlySet<string>
  activeHeldToolCallIds?: () => ReadonlySet<string>
  processorHeldToolCallIds?: () => ReadonlySet<string>
  onStop?: (toolUseId: string) => void
  onDetach?: (toolUseId: string) => void
  onHydrateBody?: (blockId: string) => void
  hideVerb?: boolean
  hideOutput?: boolean
}

async function renderBashRow(
  tool: ToolEntry | (() => ToolEntry) = {
    kind: "tool",
    id: "bash-row",
    name: "bash",
    presentation: bashPresentation("bun run test"),
    status: "completed",
    content: "line one\nline two",
    timestamp: Date.now(),
  },
  opts?: RenderBashRowOptions,
) {
  const [{ ToolRow }, { ThemeProvider }, { ScrollPreserveProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }] = await Promise.all([
    import("../../../../src/tui/output-blocks/tool-row.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/scroll-preserve.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
  ])

  return testRender(
    // A fresh disclosure channel per render: disclosure is keyed by durable
    // block identity, so tests reusing block ids must not share state.
    () => createComponent(BlockDisclosureProvider, {
      value: createBlockDisclosureChannel(),
      get children() {
        return createComponent(ScrollPreserveProvider, {
          value: (fn: () => void) => fn(),
          get children() {
            return createComponent(ThemeProvider, {
              mode: "dark",
              get children() {
                return createComponent(ToolRow, {
                  get tool() { return typeof tool === "function" ? tool() : tool },
                  streamingToolText: opts?.streamingToolText,
                  rowControls: {
                    activeHeldToolCallIds: opts?.activeHeldToolCallIds ?? (() => new Set()),
                    activeManagedProcessToolCallIds: opts?.activeManagedProcessToolCallIds ?? (() => new Set()),
                    processorHeldToolCallIds: opts?.processorHeldToolCallIds ?? (() => new Set()),
                    onDetach: opts?.onDetach ?? (() => {}),
                    onStop: opts?.onStop ?? (() => {}),
                  },
                  onHydrateBody: opts?.onHydrateBody,
                  hideStatusIcon: true,
                  hideVerb: opts?.hideVerb ?? true,
                  hideOutput: opts?.hideOutput,
                  padLeft: 0,
                  connector: "└ ",
                  availWidth: opts?.width ?? 80,
                })
              },
            })
          },
        })
      },
    }),
    { width: opts?.width ?? 80, height: opts?.height ?? 8 },
  )
}

async function renderBashBlock(tool: ToolEntry = {
  kind: "tool",
  id: "bash-block",
  name: "bash",
  presentation: bashPresentation("bun run test"),
  status: "completed",
  content: "line one\nline two",
  timestamp: Date.now(),
}) {
  const [{ BlockRenderer }, { ThemeProvider }, { ScrollPreserveProvider }, { BlockDisclosureProvider, createBlockDisclosureChannel }] = await Promise.all([
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/scroll-preserve.js"),
    import("../../../../src/tui/context/block-disclosure.js"),
  ])

  return testRender(
    () => createComponent(BlockDisclosureProvider, {
      value: createBlockDisclosureChannel(),
      get children() {
        return createComponent(ScrollPreserveProvider, {
          value: (fn: () => void) => fn(),
          get children() {
            return createComponent(ThemeProvider, {
              mode: "dark",
              get children() {
                return createComponent(BlockRenderer, { block: terminalTranscript([tool], false).timelineBlocks[0]! })
              },
            })
          },
        })
      },
    }),
    { width: 80, height: 8 },
  )
}

function spanContaining(frame: CapturedFrame, text: string) {
  for (const line of frame.lines) {
    const span = line.spans.find((s) => s.text.includes(text))
    if (span) return span
  }
  return undefined
}

function pendingBashRow(id = "bash-row"): ToolEntry {
  return {
    kind: "tool",
    id,
    name: "bash",
    presentation: bashPresentation("bun run test"),
    status: "pending",
    timestamp: Date.now(),
  }
}

describe("bash output rows", () => {
  it("shows a compact reference-backed mutation detail without disclosing its output", async () => {
    const row: ToolEntry = {
      kind: "tool", id: "compact-memory", name: "memory", presentation: { name: "Memory", detail: "" },
      status: "completed", timestamp: 1, content: "hidden output",
      mutationEvidence: {
        version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
        applied: 5000, retainedFiles: 5000, omissions: 0, notApplied: 0,
        added: 0, modified: 5000, removed: 0, addedLines: 1, removedLines: 1, conflictMarkers: 0,
        samples: [{ kind: "applied", path: "notes.md" }],
      },
    }
    const result = await renderBashRow(row, { hideOutput: true, hideVerb: false, width: 100 })
    try {
      await result.renderOnce()
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Memory notes.md, and 4999 more files (open Session Changes)")
      expect(frame).not.toContain("hidden output")
      expect(spanContaining(result.captureSpans(), "notes.md")?.fg?.equals(theme.text)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a grouped memory row from its canonical presentation, not the display name", async () => {
    const result = await renderBashRow({
      kind: "tool",
      id: "memory-row",
      name: "memory",
      presentation: resolveToolPresentation("memory", { action: "replace", title: "Refine Bun runtime fact" }, CWD),
      status: "completed",
      timestamp: Date.now(),
    }, { hideVerb: false });
    try {
      await result.renderOnce();
      const frame = result.captureCharFrame();
      expect(frame).toContain("Replace Memory Refine Bun runtime fact");
      expect(frame).not.toContain("Update memory");
      expect(frame).not.toContain("Replaced existing memory");
    } finally {
      result.renderer.destroy();
    }
  });

  it("word-wraps a wide invocation body with the hanging indent instead of clipping", async () => {
    const result = await renderBashRow({
      kind: "tool",
      id: "bash-wide-invocation",
      name: "bash",
      presentation: bashPresentation("run"),
      status: "completed",
      invocationBody: { content: "alpha bravo charlie delta echo foxtrot golf hotel", filetype: "bash" },
      timestamp: Date.now(),
    }, { width: 30 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()

      // Every word survives the narrow width: the line wraps, it does not clip.
      for (const word of ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]) {
        expect(frame).toContain(word)
      }
      // Continuation rows hang under the body start: the prefix "└ run " is
      // 6 wide, so soft-wrapped lines indent 6 columns and never sit at the
      // rail column.
      expect(frame).toMatch(/\n {6}delta echo/)
      expect(frame).toMatch(/\n {6}hotel/)
    } finally {
      result.renderer.destroy()
    }
  })

  it("collapses command output by default and expands it dimmed on click", async () => {
    const result = await renderBashRow()
    try {
      await result.renderOnce()
      const collapsed = result.captureCharFrame()

      expect(collapsed).toContain("└ bun run test ▸")
      expect(collapsed).not.toContain("line one")
      expect(collapsed).not.toContain("line two")

      await result.mockMouse.click(1, 0)
      // Hover state after a click is mock-timing dependent; park the mouse off
      // the row so the assertions see the resting render.
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()

      const expanded = result.captureCharFrame()
      expect(expanded).toContain("└ bun run test ▾")
      expect(expanded).toMatch(/\n {2}line one/)
      expect(expanded).toMatch(/\n {2}line two/)

      // Hovering the block materializes the accent rail into the blank indent
      // column in front of the output lines.
      await result.mockMouse.moveTo(1, 1)
      await result.renderOnce()
      const hovered = result.captureCharFrame()
      expect(hovered).toMatch(/\n┃ line one/)
      expect(hovered).toMatch(/\n┃ line two/)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()

      const spans = result.captureSpans()
      expect(spanContaining(spans, "line one")?.fg.equals(theme.textMuted)).toBe(true)
      expect(spanContaining(spans, "line two")?.fg.equals(theme.textMuted)).toBe(true)

      // The blank space after the command is header space and does nothing;
      // the space after a short output line is body space and collapses it.
      await result.mockMouse.click(40, 0)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("line one")
      await result.mockMouse.click(40, 1)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("└ bun run test ▸")
      expect(result.captureCharFrame()).not.toContain("line one")
    } finally {
      result.renderer.destroy()
    }
  })

  it("toggles pending live execution output on the compact row", async () => {
    const tool = pendingBashRow()
    const result = await renderBashRow(tool, {
      streamingToolText: { [tool.id]: { content: "live line one\nlive line two" } },
    })
    try {
      await result.renderOnce()
      const collapsed = result.captureCharFrame()

      expect(collapsed).toContain("└ bun run test ▸")
      expect(collapsed).not.toContain("live line one")
      expect(collapsed).not.toContain("live line two")

      await result.mockMouse.click(1, 0)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()
      const expanded = result.captureCharFrame()
      expect(expanded).toContain("└ bun run test ▾")
      expect(expanded).toMatch(/\n {2}live line one/)
      expect(expanded).toMatch(/\n {2}live line two/)
      expect(expanded).not.toContain("1  live line one")

      await result.mockMouse.click(1, 0)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()
      const collapsedAgain = result.captureCharFrame()
      expect(collapsedAgain).toContain("└ bun run test ▸")
      expect(collapsedAgain).not.toContain("live line one")
      expect(collapsedAgain).not.toContain("live line two")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the last 100 lines of pending live execution output on the compact row", async () => {
    const lines = Array.from({ length: 105 }, (_, i) => `exec-${String(i + 1).padStart(3, "0")}`)
    const tool = pendingBashRow("bash-tail")
    const result = await renderBashRow(tool, {
      height: 128,
      streamingToolText: { [tool.id]: { content: lines.join("\n") } },
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(1, 0)
      await result.renderOnce()
      const expanded = result.captureCharFrame()

      expect(expanded).not.toContain("more lines (click to expand)")
      expect(expanded).not.toContain("exec-005")
      expect(expanded).toContain("exec-006")
      expect(expanded).toContain("exec-105")
    } finally {
      result.renderer.destroy()
    }
  })

  it("silently renders only the final 1000 grouped execution-output lines", async () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `grouped-exec-${String(i + 1).padStart(4, "0")}`)
    const result = await renderBashRow({
      kind: "tool",
      id: "bash-grouped-tail",
      name: "bash",
      presentation: bashPresentation("seq 1 1001"),
      status: "completed",
      content: lines.join("\n"),
      timestamp: Date.now(),
    }, { height: 1010 })
    try {
      await result.renderOnce()
      await result.mockMouse.click(1, 0)
      await result.renderOnce()
      const expanded = result.captureCharFrame()

      expect(expanded).not.toContain("grouped-exec-0001")
      expect(expanded).toContain("grouped-exec-0002")
      expect(expanded).toContain("grouped-exec-1001")
      expect(expanded).not.toContain("more lines")
      expect(expanded).not.toContain("click to expand")
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not add an execution-output chevron without live output", async () => {
    const result = await renderBashRow(pendingBashRow("bash-empty"))
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()

      expect(frame).not.toContain("▸")
      expect(frame).not.toContain("▾")
    } finally {
      result.renderer.destroy()
    }
  })

  it("prefers live command output over previous row content", async () => {
    const tool: ToolEntry = {
      kind: "tool",
      id: "bash-final",
      name: "bash",
      presentation: bashPresentation("bun run test"),
      status: "pending",
      content: "final line",
      timestamp: Date.now(),
    }
    const result = await renderBashRow(tool, {
      streamingToolText: { [tool.id]: { content: "live line" } },
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(1, 0)
      await result.renderOnce()
      const expanded = result.captureCharFrame()

      expect(expanded).toContain("live line")
      expect(expanded).not.toContain("final line")
      expect(spanContaining(result.captureSpans(), "live line")?.fg.equals(theme.textMuted)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it.each([undefined, false, true])("keeps grouped live output until settlement with background=%s", async (background) => {
    const tool: ToolEntry = {
      kind: "tool",
      id: "bash-background-output",
      name: "bash",
      presentation: bashPresentation("bun run dev"),
      status: "completed",
      ...(background === undefined ? {} : { background }),
      content: "Running in background...\nLog: /scratch/bash.log",
      timestamp: Date.now(),
    }
    const { batch, createSignal } = await import("solid-js")
    const { createStore, reconcile } = await import("solid-js/store")
    const [active, setActive] = createSignal<ReadonlySet<string>>(new Set([tool.id]))
    const [current, setCurrent] = createSignal(tool)
    const [streaming, setStreaming] = createStore({ [tool.id]: { content: "tick 1\ntick 2" } })
    const result = await renderBashRow(current, {
      streamingToolText: streaming,
      activeManagedProcessToolCallIds: active,
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(2, 0)
      await result.renderOnce()
      const activeFrame = result.captureCharFrame()
      expect(activeFrame).toContain("tick 1")
      expect(activeFrame).toContain("tick 2")
      expect(activeFrame).not.toContain("Running in background")
      expect(activeFrame).not.toContain("/scratch/bash.log")

      setActive(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("tick 2")
      expect(result.captureCharFrame()).not.toContain("Running in background")
      batch(() => {
        setCurrent({ ...tool, content: "finished command output" })
        setStreaming(reconcile({}))
      })
      await result.renderOnce()
      const settledFrame = result.captureCharFrame()
      expect(settledFrame).toContain("finished command output")
      expect(settledFrame).not.toContain("Running in background")
      expect(settledFrame).not.toContain("tick 1")
      expect(settledFrame).not.toContain("tick 2")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps completed background Bash live output and stops it without toggling the grouped row", async () => {
    const tool: ToolEntry = {
      kind: "tool",
      id: "bash-background",
      name: "bash",
      presentation: bashPresentation("bun run dev"),
      status: "completed",
      background: true,
      timestamp: Date.now(),
    }
    const stop = mock((_toolUseId: string) => {})
    const result = await renderBashRow(tool, {
      streamingToolText: { [tool.id]: { content: "server ready" } },
      activeManagedProcessToolCallIds: () => new Set([tool.id]),
      onStop: stop,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("bun run dev")
      expect(result.captureCharFrame()).toContain("stop")
      expect(result.captureCharFrame()).not.toContain("server ready")
      const { TextRenderable } = await import("@opentui/core")
      const descendants: unknown[] = [result.renderer.root]
      let textRenderableCount = 0
      for (const node of descendants) {
        if (node instanceof TextRenderable) textRenderableCount += 1
        if (node && typeof node === "object" && "getChildren" in node && typeof node.getChildren === "function") descendants.push(...node.getChildren())
      }
      expect(textRenderableCount).toBe(1)

      await result.mockMouse.click(17, 0)
      await result.renderOnce()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledWith(tool.id)
      expect(result.captureCharFrame()).not.toContain("server ready")

      await result.mockMouse.click(2, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("server ready")
      expect(stop).toHaveBeenCalledTimes(1)
    } finally {
      result.renderer.destroy()
    }
  })

  it("detaches a held grouped Bash row without disclosing output", async () => {
    const tool = pendingBashRow("bash-grouped-held")
    const detach = mock((_toolUseId: string) => {})
    const result = await renderBashRow(tool, {
      width: 24,
      streamingToolText: { [tool.id]: { content: "server ready" } },
      activeHeldToolCallIds: () => new Set([tool.id]),
      onDetach: detach,
    })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("detach")
      expect(frame).not.toContain("stop")
      expect(frame).not.toContain("server ready")
      const lines = frame.split("\n")
      const controlRow = lines.findIndex((line) => line.includes("detach"))
      const controlColumn = lines[controlRow]?.indexOf("detach") ?? -1
      expect(controlRow).toBeGreaterThanOrEqual(0)
      expect(controlColumn).toBeGreaterThanOrEqual(0)
      await result.mockMouse.click(controlColumn + 1, controlRow)
      expect(detach).toHaveBeenCalledTimes(1)
      expect(detach).toHaveBeenCalledWith(tool.id)
      expect(result.captureCharFrame()).not.toContain("server ready")
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a held grouped command as waiting for CPU in the info color until it is released", async () => {
    const tool = pendingBashRow("bash-grouped-cpu")
    const [processorHeld, setProcessorHeld] = (await import("solid-js")).createSignal<ReadonlySet<string>>(new Set([tool.id]))
    const result = await renderBashRow(tool, {
      activeHeldToolCallIds: () => new Set([tool.id]),
      processorHeldToolCallIds: processorHeld,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toMatch(/bun run test Waiting for CPU {2} detach /)
      const note = spanContaining(result.captureSpans(), "Waiting for CPU")
      expect(note?.fg.equals(theme.info)).toBe(true)
      expect(note?.fg.equals(theme.textMuted)).toBe(false)
      expect(spanContaining(result.captureSpans(), "bun")?.fg.equals(theme.textMuted)).toBe(false)

      setProcessorHeld(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Waiting for CPU")
      expect(result.captureCharFrame()).toContain("detach")
    } finally {
      result.renderer.destroy()
    }
  })

  it("removes the grouped stop affordance reactively on settlement", async () => {
    const tool: ToolEntry = { kind: "tool", id: "bash-background", name: "bash", presentation: bashPresentation("bun run dev"), status: "completed", background: true, timestamp: Date.now() }
    const [active, setActive] = (await import("solid-js")).createSignal<ReadonlySet<string>>(new Set([tool.id]))
    const result = await renderBashRow(tool, { activeManagedProcessToolCallIds: active, onStop: () => {} })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("stop")
      setActive(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("stop")
    } finally {
      result.renderer.destroy()
    }
  })

  it("allows the blank line above a clickable row to start selection", async () => {
    const result = await renderBashBlock()
    try {
      await result.renderOnce()

      await result.mockMouse.drag(4, 1, 20, 1)
      expect(result.renderer.getSelection()?.getSelectedText() ?? "").toBe("")

      await result.mockMouse.drag(0, 0, 20, 1)
      const selected = result.renderer.getSelection()?.getSelectedText() ?? ""
      expect(selected).toContain("bun run test")
    } finally {
      result.renderer.destroy()
    }
  })

  it("strikes through interrupted commands without rendering them as errors", async () => {
    const result = await renderBashRow({
      kind: "tool",
      id: "bash-interrupted",
      name: "bash",
      presentation: bashPresentation("bun run test"),
      status: "interrupted",
      timestamp: Date.now(),
    })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("└ bun run test Interrupted")
      expect(frame).not.toContain("└ •")
      expect(frame).not.toContain("aborted")

      const spans = result.captureSpans()
      const commandStruck = ["bun", "run test"].some((text) => (((spanContaining(spans, text)?.attributes ?? 0) & STRIKETHROUGH) === STRIKETHROUGH))
      expect(commandStruck).toBe(true)
      const interrupted = spanContaining(spans, "Interrupted")
      expect(interrupted?.fg.equals(theme.error)).toBe(true)
      expect(((interrupted?.attributes ?? 0) & STRIKETHROUGH)).toBe(0)
    } finally {
      result.renderer.destroy()
    }
  })

  it("hydrates an expanded row when a repave strips its output to a wire-omitted count", async () => {
    const { createSignal } = await import("solid-js")
    const [tool, setTool] = createSignal<ToolEntry>(pendingBashRow("bash-repave"))
    const hydrate = mock((_blockId: string) => {})
    const result = await renderBashRow(tool, {
      streamingToolText: { "bash-repave": { content: "live line" } },
      onHydrateBody: hydrate,
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(1, 0)
      await result.mockMouse.moveTo(79, 7)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("live line")
      expect(hydrate).not.toHaveBeenCalled()

      // The durable view replaces the live block with a wire-truncated form:
      // the expanded row must fetch its body without another click.
      setTool({ ...tool(), status: "completed", contentOmittedLines: 3 })
      await result.renderOnce()
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledWith("tool:bash-repave")
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not hydrate a collapsed wire-omitted row until it is expanded", async () => {
    const hydrate = mock((_blockId: string) => {})
    const result = await renderBashRow({
      ...pendingBashRow("bash-omitted"),
      status: "completed",
      contentOmittedLines: 3,
    }, { onHydrateBody: hydrate })
    try {
      await result.renderOnce()
      expect(hydrate).not.toHaveBeenCalled()

      await result.mockMouse.click(1, 0)
      await result.renderOnce()
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledWith("tool:bash-omitted")
    } finally {
      result.renderer.destroy()
    }
  })
})
