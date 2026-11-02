import { expect, it, mock } from "bun:test"
import type { ToolEntry } from "../../../../src/infra/output-blocks.js"
import { terminalTranscript } from "../../../../src/tui/output-blocks/visible-output-blocks.js"

it.each(["standalone", "grouped"] as const)("keeps %s background Stop live through a transcript history reload", async (kind) => {
  const [{ testRender }, { createComponent }, { createSignal }, { BlockRenderer }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
    import("solid-js"),
    import("../../../../src/tui/output-blocks/block-renderer.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const id = "background-build"
  const tool: ToolEntry = {
    kind: "tool",
    id,
    name: "bash",
    presentation: { name: "Bash", detail: "dbt build --target sandbox" },
    status: "completed",
    background: true,
    timestamp: Date.now(),
  }
  const block = terminalTranscript(kind === "standalone" ? [tool] : [
    { ...tool, action: "shell_exec" },
    { kind: "text", id: "after-run", content: "Done", timestamp: tool.timestamp + 1200 },
  ], false).timelineBlocks[0]!
  const [historical, setHistorical] = createSignal(false)
  const [active, setActive] = createSignal<ReadonlySet<string>>(new Set([id]))
  const stop = mock((_toolUseId: string) => {})
  const result = await testRender(
    () => createComponent(TickPoolProvider, {
      get children() {
        return createComponent(ThemeProvider, {
          mode: "dark",
          get children() {
            return createComponent(BlockRenderer, {
              block,
              get historical() { return historical() },
              processControls: {
                activeHeldToolCallIds: () => new Set(),
                activeManagedProcessToolCallIds: active,
                processorHeldToolCallIds: () => new Set(),
                onDetach: () => {},
                onStop: stop,
              },
            })
          },
        })
      },
    }),
    { width: 80, height: 8 },
  )
  try {
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("stop")
    expect(result.captureCharFrame()).toMatch(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/m)
    expect(result.captureCharFrame()).not.toContain("Ran · 1.2s")
    const before = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("stop"))!
    setHistorical(true)
    await result.renderOnce()
    const lines = result.captureCharFrame().split("\n")
    const row = lines.findIndex((line) => line.includes("stop"))
    expect(row).toBeGreaterThanOrEqual(0)
    const after = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("stop"))!
    expect(after.bg.equals(before.bg)).toBe(true)
    expect(after.fg.equals(before.fg)).toBe(true)
    expect(after.bg.equals(after.fg)).toBe(false)
    const column = lines[row]!.indexOf("stop")
    await result.mockMouse.click(column + 1, row)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(id)
    // The label's no-break padding is blank, yet it presses as the button.
    await result.mockMouse.click(column - 1, row)
    await result.mockMouse.click(column + "stop".length, row)
    expect(stop).toHaveBeenCalledTimes(3)
    setActive(new Set<string>())
    await result.renderOnce()
    expect(result.captureCharFrame()).not.toContain("stop")
    expect(result.captureCharFrame()).toMatch(/^•/m)
    if (kind === "grouped") expect(result.captureCharFrame()).toContain("Ran · 1.2s")
  } finally {
    result.renderer.destroy()
  }
})

it("targets stop after an active grouped row wraps", async () => {
  const [{ testRender }, { createComponent }] = await Promise.all([
    import("@opentui/solid"),
    import("solid-js/web"),
  ])
  const [{ ToolRow }, { ThemeProvider }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/output-blocks/tool-row.js"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const tool = {
    kind: "tool" as const,
    id: "benchmark-row",
    name: "bash",
    presentation: { name: "Bash", detail: "abcdefghijklmnopqrst" },
    status: "completed" as const,
    timestamp: Date.now(),
  }
  const stop = mock((_toolUseId: string) => {})
  const result = await testRender(
    () => createComponent(TickPoolProvider, {
      get children() {
        return createComponent(ThemeProvider, {
          mode: "dark",
          get children() {
            return createComponent(ToolRow, {
              tool,
              availWidth: 24,
              hideVerb: true,
              rowControls: {
                activeHeldToolCallIds: () => new Set(),
                activeManagedProcessToolCallIds: () => new Set([tool.id]),
                processorHeldToolCallIds: () => new Set(),
                onDetach: () => {},
                onStop: stop,
              },
            })
          },
        })
      },
    }),
    { width: 24, height: 8 },
  )

  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    expect(frame).toContain("stop")
    const lines = frame.split("\n")
    const stopRow = lines.findIndex((line) => line.includes("stop"))
    const stopColumn = lines[stopRow]?.indexOf("stop") ?? -1
    expect(stopRow).toBeGreaterThan(0)
    expect(stopColumn).toBeGreaterThanOrEqual(0)

    await result.mockMouse.click(stopColumn + 1, stopRow)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith(tool.id)
  } finally {
    result.renderer.destroy()
  }
})
