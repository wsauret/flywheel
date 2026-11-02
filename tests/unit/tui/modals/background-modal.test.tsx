/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import type { BackgroundWorkRow } from "../../../../src/protocol/background-index-protocol-types.js"
import type { BackgroundIndexEntry } from "../../../../src/protocol/client/background-index.js"
import { flattenWithCategories } from "../../../../src/tui/components/modal-select-helpers.js"
import { contrastRatio } from "../../../../src/tui/context/theme/color-contrast.js"

const [{ testRender }, { createComponent }, { ThemeProvider }, { BackgroundModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/background-modal.js"),
])

const goal = "Implement versioned workflow recovery so interrupted work can resume with its original settings and retain every completed action"
const commandRow: BackgroundWorkRow = {
  id: "tool-review",
  kind: "command",
  title: goal,
  startedAtMs: 1,
  cardToolUseId: "tool-review",
  status: "running",
  model: "claude-opus-4-6",
  effort: "high",
  stop: { sessionId: "chat", toolUseId: "tool-review" },
}
const command: BackgroundIndexEntry = { row: commandRow, depth: 0, dimmed: false }
const MODAL_ACTIONS = { navigationRevision: 0, filter: "active" as const, empty: "No active background work · a shows all", onClose: () => {}, onRowClick: () => {}, onStopClick: () => {}, onFilter: () => {} }

const entry = (fields: Partial<BackgroundWorkRow>, depth = 0): BackgroundIndexEntry => {
  const row = { ...commandRow, ...fields }
  return { row, depth, dimmed: row.status !== "running" && row.status !== "waiting_on_parent" }
}

async function frame(entries = [command], outputs: { [toolUseId: string]: readonly string[] } = {}, cursor = 0, width = 60) {
  const result = flattenWithCategories(entries.map((value) => ({
    id: value.row.id,
    title: value.row.title,
    value,
    rightDetail: value.row.model ? `${value.row.model} · ${value.row.effort}` : undefined,
  })), false)
  const rendered = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      return createComponent(BackgroundModal, {
        ...MODAL_ACTIONS, result, cursor, tail: (id) => outputs[id],
      })
    },
  }), { width, height: 30 })
  try {
    await rendered.renderOnce()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await rendered.renderOnce()
    return rendered.captureCharFrame()
  } finally {
    rendered.renderer.destroy()
  }
}

describe("BackgroundModal", () => {
  it("keeps the visible variable-height row through refresh, status, and tail growth; explicit navigation reveals", async () => {
    const initial = Array.from({ length: 20 }, (_, index) => entry({ id: `tool-${index}`, title: `Process ${index}` }))
    const resultOf = (entries: readonly BackgroundIndexEntry[]) => flattenWithCategories(entries.map((value) => ({ id: value.row.id, title: value.row.title, value })), false)
    const [result, setResult] = createSignal(resultOf(initial))
    const [output, setOutput] = createSignal<readonly string[]>(["initial output"])
    const [cursor, setCursor] = createSignal(0)
    const [revision, setRevision] = createSignal(0)
    const rendered = await testRender(() => <ThemeProvider mode="dark">
      <BackgroundModal {...MODAL_ACTIONS} result={result()} cursor={cursor()} navigationRevision={revision()} tail={(id) => id === "tool-0" ? output() : undefined} />
    </ThemeProvider>, { width: 70, height: 24 })
    const visible = () => rendered.captureCharFrame().split("\n").flatMap((line, y) => line.includes("Process ") ? [{ y, text: line }] : [])
    try {
      await rendered.flush()
      for (let index = 0; index < 10; index++) { await rendered.mockMouse.scroll(10, 10, "down"); await rendered.flush() }
      const anchor = visible()[0]
      expect(anchor).toBeDefined()
      expect(rendered.captureCharFrame()).not.toContain("Process 0")
      setResult(resultOf(initial.map((value) => ({ ...value, row: { ...value.row } }))))
      await rendered.flush()
      expect(visible()[0]).toEqual(anchor)
      setResult(resultOf(initial.map((value, index) => index === 0 ? { ...value, row: { ...value.row, status: "completed" } } : value)))
      setOutput(Array.from({ length: 12 }, (_, index) => `Growing output ${index}`))
      await rendered.flush()
      expect(visible()[0]).toEqual(anchor)
      setCursor(1)
      setRevision((value) => value + 1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("Process 1")
      setCursor(0)
      setRevision((value) => value + 1)
      await rendered.flush()
      expect(rendered.captureCharFrame()).toContain("Process 0")
    } finally { rendered.renderer.destroy() }
  })
  it.each(["dark", "light"] as const)("isolates row navigation from the compact stop control in %s mode", async (mode) => {
    const rowClicks: number[] = []
    const stopClicks: number[] = []
    const result = flattenWithCategories([{ id: commandRow.id, title: goal, value: command }], false)
    const rendered = await testRender(() => <ThemeProvider mode={mode}>
      <BackgroundModal
        {...MODAL_ACTIONS}
        result={result}
        cursor={0}
        tail={() => undefined}
        onRowClick={(index) => rowClicks.push(index)}
        onStopClick={(index) => stopClicks.push(index)}
      />
    </ThemeProvider>, { width: 60, height: 30 })
    try {
      await rendered.renderOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await rendered.renderOnce()
      const lines = rendered.captureCharFrame().split("\n")
      const goalRow = lines.findIndex((line) => line.includes("Implement versioned"))
      const stopColumn = goalRow < 0 ? -1 : lines[goalRow]?.lastIndexOf("x") ?? -1
      if (goalRow < 0 || stopColumn < 0) throw new Error("Missing process mouse targets")

      await rendered.mockMouse.click(4, goalRow)
      expect(rowClicks).toEqual([0])
      expect(stopClicks).toEqual([])
      // A row click closes the modal and scrolls the transcript; a text
      // selection started by the same press would then highlight it.
      expect(rendered.renderer.getSelection()).toBeNull()

      await rendered.mockMouse.click(stopColumn, goalRow)
      expect(rowClicks).toEqual([0])
      expect(stopClicks).toEqual([0])
    } finally {
      rendered.renderer.destroy()
    }
  })

  it.each(["dark", "light"] as const)("distinguishes selection and model metadata in %s mode", async (mode) => {
    const result = flattenWithCategories([
      { id: "first", title: "Selected goal", rightDetail: "claude-opus-4-6", value: command },
      { id: "second", title: "Other goal", value: command },
    ], false)
    const rendered = await testRender(() => <ThemeProvider mode={mode}>
      <BackgroundModal {...MODAL_ACTIONS} result={result} cursor={0} tail={(id) => id === "first" ? ["Visible live output"] : undefined} />
    </ThemeProvider>, { width: 80, height: 30 })
    try {
      await rendered.renderOnce()
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      const selected = spans.find((span) => span.text.includes("Selected goal"))
      const other = spans.find((span) => span.text.includes("Other goal"))
      const model = spans.find((span) => span.text.includes("claude-opus-4-6"))
      const label = spans.find((span) => span.text.includes("Recent output"))
      const output = spans.find((span) => span.text.includes("Visible live output"))
      expect(selected).toBeDefined()
      expect(other).toBeDefined()
      expect(model).toBeDefined()
      expect(label).toBeDefined()
      expect(output).toBeDefined()
      expect(selected!.bg.equals(other!.bg)).toBe(false)
      expect(selected!.fg.equals(selected!.bg)).toBe(false)
      expect(model!.fg.equals(selected!.fg)).toBe(false)
      expect(model!.fg.equals(model!.bg)).toBe(false)
      expect(label!.fg.equals(label!.bg)).toBe(false)
      expect(output!.fg.equals(output!.bg)).toBe(false)
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("wraps the complete goal and places model metadata on its own line", async () => {
    const rendered = await frame([command], {}, 0, 80)
    const lines = rendered.split("\n")
    for (const word of goal.split(" ")) expect(rendered).toContain(word)
    expect(rendered).not.toContain("internal-process-id")
    expect(rendered).not.toContain("...")
    expect(lines.findIndex((line) => line.includes("claude-opus-4-6"))).toBeGreaterThan(
      lines.findIndex((line) => line.includes("completed action")),
    )
    expect(rendered).toContain("enter open")
    expect(rendered).toContain("x stop")
    expect(rendered).toContain("space output")
    expect(rendered).not.toContain("Recent output")
    expect(rendered).toContain("x")
  })

  it("places each expanded output under its command and wraps within the terminal", async () => {
    const commands = [
      entry({ title: "First command" }),
      entry({ title: "Second command", id: "tool-second" }),
      entry({ title: "Third command", id: "tool-third" }),
    ]
    const rendered = await frame(commands, {
      "tool-review": ["Output includes enough detail to span the available width and ends with OUTPUT-END"],
      "tool-second": [],
    })
    expect(rendered).toContain("OUTPUT-END")
    expect(rendered.indexOf("First command")).toBeLessThan(rendered.indexOf("OUTPUT-END"))
    expect(rendered.indexOf("OUTPUT-END")).toBeLessThan(rendered.indexOf("Second command"))
    expect(rendered.indexOf("Second command")).toBeLessThan(rendered.indexOf("No output yet"))
    expect(rendered.indexOf("No output yet")).toBeLessThan(rendered.indexOf("Third command"))
    expect(rendered.match(/Recent output/g)).toHaveLength(2)
    expect(rendered).toContain("esc close")
  })

  it("reveals the selected command header for wrapped and expanded processes", async () => {
    const commands = Array.from({ length: 12 }, (_, index) => entry({ id: `tool-${index}`, title: index === 11 ? "Selected final process" : goal }))
    expect(await frame(commands, {}, 11)).toContain("Selected final process")

    const [cursor, setCursor] = createSignal(1)
    const result = flattenWithCategories([
      { id: "expanded", title: "Expanded first process", value: command },
      { id: "next", title: goal, value: command },
    ], false)
    const output = Array.from({ length: 12 }, (_, index) => `Output line ${index}`)
    const rendered = await testRender(() => <ThemeProvider mode="dark">
      <BackgroundModal
        {...MODAL_ACTIONS}
        result={result}
        cursor={cursor()}
        navigationRevision={cursor()}
        tail={(id) => id === "expanded" ? output : undefined}
      />
    </ThemeProvider>, { width: 60, height: 24 })
    try {
      await rendered.renderOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("Implement versioned")
      setCursor(0)
      await rendered.renderOnce()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await rendered.renderOnce()
      expect(rendered.captureCharFrame()).toContain("Expanded first process")
    } finally {
      rendered.renderer.destroy()
    }
  })

  it("shows the empty state it is given, with the Active and All toggle", async () => {
    const rendered = await frame([])
    expect(rendered).toContain("No active background work · a shows all")
    expect(rendered).toContain("Active")
    expect(rendered).toContain("All")
  })

  it("dims a finished row, shows it no Stop, and indents a nested row under its parent", async () => {
    const entries = [entry({ id: "running", title: "Running server" }), entry({ id: "finished", title: "Finished tests", status: "completed", model: undefined }), entry({ id: "nested", title: "Nested reviewer", status: "running" }, 1)]
    const details = new Map([["running", "Running now"], ["finished", "Completed · exit 0"], ["nested", "Running nested"]])
    const result = flattenWithCategories(entries.map((value) => ({ id: value.row.id, title: value.row.title, value, rightDetail: details.get(value.row.id) })), false)
    const rendered = await testRender(() => <ThemeProvider mode="dark">
      <BackgroundModal {...MODAL_ACTIONS} filter="all" result={result} cursor={2} tail={() => undefined} />
    </ThemeProvider>, { width: 60, height: 30 })
    try {
      await rendered.renderOnce()
      const lines = rendered.captureCharFrame().split("\n")
      const running = lines.find((line) => line.includes("Running server")) ?? ""
      const finished = lines.find((line) => line.includes("Finished tests")) ?? ""
      const nested = lines.find((line) => line.includes("Nested reviewer")) ?? ""
      // The row's Stop control is its last cell before the frame.
      expect(running).toMatch(/x\s*│\s*$/)
      expect(finished).not.toMatch(/x\s*│\s*$/)
      expect(nested.indexOf("Nested reviewer")).toBeGreaterThan(running.indexOf("Running server"))
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans)
      const live = spans.find((span) => span.text.includes("Running server"))
      const dim = spans.find((span) => span.text.includes("Finished tests"))
      expect(live).toBeDefined()
      expect(dim).toBeDefined()
      expect(dim!.fg.equals(live!.fg)).toBe(false)
      expect(dim!.fg.equals(dim!.bg)).toBe(false)
      // Each line of a finished row reads no brighter than the same line of a
      // running row: lower contrast against the surface is dimmer.
      const liveStatus = spans.find((span) => span.text.includes("Running now"))
      const dimStatus = spans.find((span) => span.text.includes("Completed · exit 0"))
      expect(liveStatus).toBeDefined()
      expect(dimStatus).toBeDefined()
      expect(contrastRatio(dim!.fg, dim!.bg)).toBeLessThan(contrastRatio(live!.fg, live!.bg))
      expect(contrastRatio(dimStatus!.fg, dimStatus!.bg)).toBeLessThanOrEqual(contrastRatio(liveStatus!.fg, liveStatus!.bg))
    } finally {
      rendered.renderer.destroy()
    }
  })
})
