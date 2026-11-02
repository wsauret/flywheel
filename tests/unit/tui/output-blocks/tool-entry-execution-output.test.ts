import { describe, expect, it, mock } from "bun:test"
import type { ToolEntry as ToolEntryType } from "../../../../src/infra/output-blocks.js"
import { renderToolEntry } from "./_tool-entry-render.js"
import { getToolDisplay, resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry.js"
import flywheelThemeJson from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const theme = resolveTheme(flywheelThemeJson, "dark")

function pendingBashEntry(id = "bash-1"): ToolEntryType {
  return {
    kind: "tool",
    id,
    name: "bash",
    presentation: { name: "Bash", detail: "bun run test" },
    status: "pending",
    timestamp: Date.now(),
  }
}

describe("tool entry execution output", () => {
  it("toggles pending execution output from the header", async () => {
    const block = pendingBashEntry()
    const result = await renderToolEntry(block, {
      streamingToolText: { [block.id]: { content: "line one\nline two" } },
    })

    try {
      await result.renderOnce()

      await result.mockMouse.click(4, 0)
      // Park the mouse outside the entry so the assertions see the resting
      // render (hovering materializes the accent rail in the body gutter).
      await result.mockMouse.moveTo(79, 31)
      await result.renderOnce()
      const expanded = result.captureCharFrame()
      expect(expanded).toContain("▾")
      expect(expanded).toMatch(/\n {4}line one/)
      expect(expanded).toMatch(/\n {4}line two/)
      expect(expanded).not.toContain("1  line one")

      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      const collapsed = result.captureCharFrame()
      expect(collapsed).toContain("▸")
      expect(collapsed).not.toContain("line one")
      expect(collapsed).not.toContain("line two")
    } finally {
      result.renderer.destroy()
    }
  })

  it("bounds live standalone execution output to the last 100 lines", async () => {
    const lines = Array.from({ length: 1001 }, (_, i) => `standalone-exec-${String(i + 1).padStart(4, "0")}`)
    const block = pendingBashEntry("bash-standalone-tail")
    const result = await renderToolEntry(block, {
      height: 1010,
      streamingToolText: { [block.id]: { content: lines.join("\n") } },
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      const expanded = result.captureCharFrame()

      expect(expanded).not.toContain("standalone-exec-0901")
      expect(expanded).toContain("standalone-exec-0902")
      expect(expanded).toContain("standalone-exec-1001")
      expect(expanded).not.toContain("more lines")
      expect(expanded).not.toContain("click to expand")
    } finally {
      result.renderer.destroy()
    }
  })

  it("settles expanded execution output into final content in place", async () => {
    const { batch, createSignal } = await import("solid-js")
    const { createStore, reconcile } = await import("solid-js/store")
    const pending = pendingBashEntry("bash-settle")
    const [block, setBlock] = createSignal<ToolEntryType>(pending)
    const [streaming, setStreaming] = createStore({ [pending.id]: { content: "line one\nline two" } })
    const result = await renderToolEntry(() => block(), {
      streamingToolText: streaming,
    })

    try {
      await result.renderOnce()
      await result.mockMouse.click(4, 0)
      await result.mockMouse.moveTo(79, 31)
      await result.renderOnce()
      expect(result.captureCharFrame()).toMatch(/\n {4}line one/)

      // Completion swaps the live execution tail for the block's final
      // content. The body stays disclosed and the same renderable is
      // overwritten in place: the very next frame shows the settled,
      // line-numbered content with no empty intermediate body.
      batch(() => {
        setBlock({ ...pending, status: "completed", content: "line one\nline two\nline three" })
        setStreaming(reconcile({}))
      })
      await result.renderOnce()
      const settled = result.captureCharFrame()
      expect(settled).toContain("1  line one")
      expect(settled).toContain("3  line three")
    } finally {
      result.renderer.destroy()
    }
  })

  it("does not add an execution-output chevron without a live record", async () => {
    const result = await renderToolEntry(pendingBashEntry("bash-empty"))

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()

      expect(frame).not.toContain("▸")
      expect(frame).not.toContain("▾")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps streaming-status records on the input streaming path", async () => {
    const block: ToolEntryType = {
      kind: "tool",
      id: "bash-streaming",
      name: "bash",
      presentation: { name: "Bash", detail: "bun run test" },
      status: "streaming",
      timestamp: Date.now(),
    }
    const result = await renderToolEntry(block, {
      streamingToolText: { [block.id]: { content: "input line" } },
    })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()

      expect(frame).toContain("1  input line")
      expect(frame).not.toContain("▸")
      expect(frame).not.toContain("▾")
    } finally {
      result.renderer.destroy()
    }
  })

  it.each([undefined, false, true])("keeps the latest tail across restoration and settlement with background=%s", async (background) => {
    const block: ToolEntryType = {
      ...pendingBashEntry("bash-background-output"),
      status: "completed",
      ...(background === undefined ? {} : { background }),
      content: "Running in background...\nLog: /scratch/bash.log",
    }
    const { batch, createSignal } = await import("solid-js")
    const { createStore, reconcile } = await import("solid-js/store")
    const [active, setActive] = createSignal<ReadonlySet<string>>(new Set([block.id]))
    const [current, setCurrent] = createSignal(block)
    const [streaming, setStreaming] = createStore({ [block.id]: { content: "tick 1\ntick 2" } })
    const result = await renderToolEntry(current, {
      streamingToolText: streaming,
      activeManagedProcessToolCallIds: active,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("tick 1")
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      const activeFrame = result.captureCharFrame()
      expect(activeFrame).toContain("tick 1")
      expect(activeFrame).toContain("tick 2")
      expect(activeFrame).not.toContain("Running in background")
      expect(activeFrame).not.toContain("/scratch/bash.log")

      batch(() => {
        setCurrent({
          ...pendingBashEntry(block.id),
          status: "completed",
          content: "restored old output",
        })
        setStreaming(block.id, "content", "tick 2\ntick 3")
      })
      await result.renderOnce()
      const restoredFrame = result.captureCharFrame()
      expect(restoredFrame).toContain("tick 3")
      expect(restoredFrame).not.toContain("tick 1")
      expect(restoredFrame).not.toContain("restored old output")

      setActive(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("tick 3")
      expect(result.captureCharFrame()).not.toContain("Running in background")

      batch(() => {
        setCurrent({ ...block, content: "tick 1\ntick 2\nfinished" })
        setStreaming(reconcile({}))
      })
      await result.renderOnce()
      const settledFrame = result.captureCharFrame()
      expect(settledFrame).toContain("tick 1")
      expect(settledFrame).toContain("tick 2")
      expect(settledFrame).toContain("finished")
      expect(settledFrame).toContain("3  finished")
      expect(settledFrame).not.toContain("Running in background")
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows and targets stop on an active standalone background Bash entry without toggling it", async () => {
    const block: ToolEntryType = { ...pendingBashEntry("bash-background"), status: "completed", background: true }
    const stop = mock((_toolUseId: string) => {})
    const result = await renderToolEntry(block, {
      streamingToolText: { [block.id]: { content: "server ready" } },
      activeManagedProcessToolCallIds: () => new Set([block.id]),
      onStop: stop,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("stop")
      expect(result.captureCharFrame()).not.toContain("server ready")

      await result.mockMouse.click(25, 0)
      await result.renderOnce()
      expect(stop).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledWith(block.id)
      expect(result.captureCharFrame()).not.toContain("server ready")

      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("server ready")
    } finally {
      result.renderer.destroy()
    }
  })

  it("detaches a held standalone Bash entry before disclosure and gives detach precedence over stop", async () => {
    const block = pendingBashEntry("bash-held")
    const { createSignal } = await import("solid-js")
    const [held, setHeld] = createSignal<ReadonlySet<string>>(new Set([block.id]))
    const [managed, setManaged] = createSignal<ReadonlySet<string>>(new Set([block.id]))
    const detach = mock((_toolUseId: string) => {})
    const stop = mock((_toolUseId: string) => {})
    const result = await renderToolEntry(block, {
      width: 18,
      streamingToolText: { [block.id]: { content: "server ready" } },
      activeHeldToolCallIds: held,
      activeManagedProcessToolCallIds: managed,
      onDetach: detach,
      onStop: stop,
    })
    try {
      await result.renderOnce()
      let lines = result.captureCharFrame().split("\n")
      const detachRow = lines.findIndex(line => line.includes("detach"))
      expect(detachRow).toBeGreaterThan(0)
      expect(lines.join("\n")).not.toContain("stop")
      const detachColumn = lines[detachRow]!.indexOf("detach")
      await result.mockMouse.click(detachColumn + 1, detachRow)
      expect(detach).toHaveBeenCalledTimes(1)
      expect(detach).toHaveBeenCalledWith(block.id)
      expect(stop).not.toHaveBeenCalled()
      expect(result.captureCharFrame()).not.toContain("server ready")

      setHeld(new Set<string>())
      await result.renderOnce()
      lines = result.captureCharFrame().split("\n")
      expect(lines.join("\n")).toContain("stop")
      expect(lines.join("\n")).not.toContain("detach")
      setManaged(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("stop")
      expect(result.captureCharFrame()).not.toContain("detach")
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a held background command as waiting for CPU and keeps its spinner and stop", async () => {
    const block: ToolEntryType = { ...pendingBashEntry("bash-cpu"), status: "completed", background: true }
    const [processorHeld, setProcessorHeld] = (await import("solid-js")).createSignal<ReadonlySet<string>>(new Set([block.id]))
    const result = await renderToolEntry(block, {
      activeManagedProcessToolCallIds: () => new Set([block.id]),
      processorHeldToolCallIds: processorHeld,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash bun run test Waiting for CPU {2} stop /)
      const note = result.captureSpans().lines.flatMap(line => line.spans).find(span => span.text.includes("Waiting for CPU"))
      expect(note?.fg.equals(theme.info)).toBe(true)
      expect(note?.fg.equals(theme.textMuted)).toBe(false)

      setProcessorHeld(new Set<string>())
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Waiting for CPU")
      expect(result.captureCharFrame()).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Bash bun run test {2} stop /)
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a spinner and targeted stop control for an active benchmark", async () => {
    const block: ToolEntryType = {
      kind: "tool",
      id: "benchmark-1",
      name: "benchmark",
      presentation: { name: "Resume Benchmark", detail: "implementer-run" },
      status: "completed",
      timestamp: Date.now(),
    }
    const stop = mock((_toolUseId: string) => {})
    const [active, setActive] = (await import("solid-js")).createSignal<ReadonlySet<string>>(new Set([block.id]))
    const result = await renderToolEntry(block, { activeManagedProcessToolCallIds: active, onStop: stop })
    try {
      await result.renderOnce()
      const activeFrame = result.captureCharFrame()
      expect(activeFrame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Resume Benchmark implementer-run  \u00a0stop\u00a0/)

      const stopColumn = activeFrame.split("\n")[0]?.indexOf("stop") ?? -1
      expect(stopColumn).toBeGreaterThanOrEqual(0)
      await result.mockMouse.click(stopColumn + 1, 0)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledWith(block.id)

      setActive(new Set<string>())
      await result.renderOnce()
      const settledFrame = result.captureCharFrame()
      expect(settledFrame).toContain("• Resume Benchmark implementer-run")
      expect(settledFrame).not.toContain("stop")
      expect(settledFrame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps stop visible and targeted when an active benchmark header exceeds the terminal width", async () => {
    const block: ToolEntryType = {
      kind: "tool",
      id: "benchmark-long",
      name: "benchmark",
      presentation: { name: "Resume Benchmark", detail: "implementer-2026-08-08T04-50-28-280Z" },
      status: "completed",
      timestamp: Date.now(),
    }
    const stop = mock((_toolUseId: string) => {})
    const result = await renderToolEntry(block, {
      width: 40,
      activeManagedProcessToolCallIds: () => new Set([block.id]),
      onStop: stop,
    })
    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const stopRow = lines.findIndex(line => line.includes("stop"))
      expect(stopRow).toBeGreaterThan(0)
      expect(lines.map(line => line.trim()).join("")).toContain("implementer-2026-08-08T04-50-28-280Z")
      const stopColumn = lines[stopRow]!.indexOf("stop")
      expect(stopColumn).toBeGreaterThanOrEqual(0)
      expect(stopColumn + "stop".length).toBeLessThanOrEqual(40)

      await result.mockMouse.click(stopColumn + 1, stopRow)
      expect(stop).toHaveBeenCalledTimes(1)
      expect(stop).toHaveBeenCalledWith(block.id)
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows stop when the active header has exactly the stop control's available width", async () => {
    const block: ToolEntryType = {
      kind: "tool",
      id: "benchmark-minimum",
      name: "benchmark",
      presentation: { name: "Resume Benchmark", detail: "long-result-id" },
      status: "completed",
      timestamp: Date.now(),
    }
    const result = await renderToolEntry(block, {
      width: 10,
      activeManagedProcessToolCallIds: () => new Set([block.id]),
      onStop: () => {},
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("stop")
    } finally {
      result.renderer.destroy()
    }
  })

  it.each(["web", "bash", "workflow"])("wraps a single %s card's complete long detail", async (name) => {
    const result = await renderToolEntry({
      kind: "tool", id: "long-detail", name, status: "completed", timestamp: 0,
      presentation: { name: "Tool", detail: "first segment ".repeat(6) + "visible-tail" },
    }, { width: 60 })
    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      expect(lines.findIndex(line => line.includes("visible-tail"))).toBeGreaterThan(0)
      const header = lines.find(line => line.includes("Tool first segment"))!
      const detailColumn = header.indexOf("first segment")
      const continuationLines = lines.filter(line => !line.includes("Tool") && /first|segment|visible-tail/.test(line))
      expect(continuationLines.length).toBeGreaterThan(0)
      for (const line of continuationLines) expect(line.search(/\S/)).toBe(detailColumn)
    } finally {
      result.renderer.destroy()
    }
  })

  it("hydrates an expanded body when a repave strips its content to a wire-omitted count", async () => {
    const { createSignal } = await import("solid-js")
    const [block, setBlock] = createSignal<ToolEntryType>(pendingBashEntry("bash-repave"))
    const hydrate = mock((_blockId: string) => {})
    const result = await renderToolEntry(block, {
      streamingToolText: { "bash-repave": { content: "live line" } },
      onHydrateBody: hydrate,
    })
    try {
      await result.renderOnce()
      await result.mockMouse.click(4, 0)
      await result.mockMouse.moveTo(79, 31)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("live line")
      expect(hydrate).not.toHaveBeenCalled()

      // The durable view replaces the live block with a wire-truncated form:
      // the open body must fetch its content without another click.
      setBlock({ ...block(), status: "completed", contentOmittedLines: 3 })
      await result.renderOnce()
      expect(hydrate).toHaveBeenCalledTimes(1)
      expect(hydrate).toHaveBeenCalledWith("tool:bash-repave")
    } finally {
      result.renderer.destroy()
    }
  })

  it("starts a sent message collapsed and opens only its text, including omitted invocation hydration", async () => {
    const { batch, createSignal } = await import("solid-js")
    const { createStore, reconcile } = await import("solid-js/store")
    const [block, setBlock] = createSignal<ToolEntryType>({
      kind: "tool", id: "message", name: "message_session", status: "streaming", timestamp: 1,
      presentation: { name: "Message to", detail: "Chat · Release" },
    })
    const [streaming, setStreaming] = createStore({ [block().id]: { content: "Use the old parser" } })
    const hydrate = mock((_id: string) => {})
    const result = await renderToolEntry(block, { onHydrateBody: hydrate, streamingToolText: streaming })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Message to Chat · Release")
      expect(result.captureCharFrame()).not.toContain("Use the old parser")
      expect(result.captureCharFrame()).not.toContain("Delivered")
      batch(() => {
        setBlock({ ...block(), status: "completed",
          invocationBody: { content: "Use the old parser", filetype: "text", presentation: "disclosure" }, content: "Delivered" })
        setStreaming(reconcile({}))
      })
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Use the old parser")
      expect(result.captureCharFrame()).not.toContain("Delivered")
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Use the old parser")
      expect(result.captureCharFrame()).not.toContain("Delivered")
      setBlock({ ...block(), content: undefined, contentOmittedLines: 1 })
      await result.renderOnce()
      expect(hydrate).not.toHaveBeenCalled()
      setBlock({ kind: "tool", id: "message", name: "message_session", status: "completed", timestamp: 1,
        presentation: { name: "Message to", detail: "Chat · Release" }, invocationBodyOmittedBytes: 80 })
      await result.renderOnce()
      expect(hydrate).toHaveBeenCalledWith("tool:message")
      setBlock({ ...block(), invocationBodyOmittedBytes: undefined,
        invocationBody: { content: "Hydrated message", filetype: "text", presentation: "disclosure" } })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Hydrated message")
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Hydrated message")
      setBlock({ kind: "tool", id: "message", name: "message_session", status: "completed", timestamp: 1,
        presentation: { name: "Message to", detail: "Chat · Release" }, content: "Not waiting on Release: it cannot answer now." })
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Not waiting")
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Not waiting on Release")
    } finally { result.renderer.destroy() }
  })

  it.each(["error", "blocked"] as const)("keeps a message's %s outcome behind its arrow even when the call only waited", async (status) => {
    const block: ToolEntryType = {
      kind: "tool", id: "message-outcome", name: "message_session", timestamp: 1, presentation: { name: "Message to", detail: "Chat · Release" },
      ...(status === "error" ? { status, errorMessage: "Recipient finished" } : { status, statusMessage: "Message held" }),
    }
    const outcome = status === "error" ? "Recipient finished" : "Message held"
    const result = await renderToolEntry(block)
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain(outcome)
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(outcome)
    } finally { result.renderer.destroy() }
  })

  it("defines bounded replay-stable Papercut presentation and disclosure content", () => {
    const observation = `  Exact observation with\nintentional spacing ${"x".repeat(120)}  `
    const display = getToolDisplay("papercut_log")
    const presentation = resolveToolPresentation("papercut_log", { observation }, "/workspace")

    expect(presentation.name).toBe("Papercut")
    expect(presentation.detail.length).toBeLessThanOrEqual(96)
    expect(presentation.detail).not.toContain("\n")
    expect(display.invocationBody?.({ observation })).toEqual({ content: observation, filetype: "text", presentation: "disclosure" })
  })
})
