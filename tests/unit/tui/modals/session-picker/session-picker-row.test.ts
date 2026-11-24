import { describe, expect, it } from "bun:test"
import { createTextAttributes, TextRenderable, type TextChunk } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme, type ThemeJson } from "../../../../../src/tui/context/theme/resolve.js"
import type { SessionCatalogRow } from "../../../../../src/protocol/app-service-types.js"
import { SessionPickerRow } from "../../../../../src/tui/modals/session-picker/session-picker-row.js"
import type { PickerCorruptRow, PickerFoundRow, PickerSessionRow } from "../../../../../src/tui/modals/session-picker/picker-types.js"

const themeJson: ThemeJson = flywheelTheme
const theme = resolveTheme(themeJson, "dark")
const now = new Date("2026-07-05T12:00:00.000Z").getTime()
type ReadySessionCatalogRow = Extract<SessionCatalogRow, { readonly totalsLoading: false }>

function session(overrides: Partial<ReadySessionCatalogRow> = {}): ReadySessionCatalogRow {
  return {
    id: "session-1",
    kind: "chat",
    title: "Session",
    executionCwd: "/scratch/project",
    lifecycleState: "inactive",
    notices: [],
    inputMode: { kind: "chat" },
    lastUpdated: new Date(now - 5 * 60_000).toISOString(),
    totalsLoading: false,
    totalCost: 0,
    totalBilledCost: 0,
    priceUnavailable: false,
    totalTokens: 0,
    contextPercent: 0,
    contextPromptTokens: 0,
    durationMs: 0,
    ...overrides,
  }
}

function pickerRow(rowSession: SessionCatalogRow, overrides: Partial<PickerSessionRow> = {}): PickerSessionRow {
  return {
    kind: "session",
    id: rowSession.id,
    session: rowSession,
    category: "Today",
    ...overrides,
  }
}

type RowInput = Omit<Parameters<typeof SessionPickerRow>[0], "rowIndex" | "onRowClick">

/** The styled chunks that a mounted SessionPickerRow shows. */
async function rowChunks(input: RowInput): Promise<TextChunk[]> {
  const result = await testRender(() => createComponent(SessionPickerRow, { ...input, rowIndex: 0, onRowClick: () => {} }), { width: 120, height: 1 })
  try {
    await result.renderOnce()
    const text = result.renderer.root.getChildren()[0]?.getChildren()[0]
    if (!(text instanceof TextRenderable)) throw new Error("expected the row text")
    return [...text.content.chunks]
  } finally {
    result.renderer.destroy()
  }
}

async function plain(row: PickerSessionRow, overrides: Partial<RowInput> = {}): Promise<string> {
  return (await rowChunks({
    row,
    theme,
    rowWidth: 80,
    selected: false,
    isWorking: false,
    blinkOn: true,
    now,
    timeAgoWidth: 3,
    ...overrides,
  })).map((chunk) => chunk.text).join("")
}

describe("SessionPickerRow", () => {
  it.each([false, true])("preserves diff colors when selected=%s", async (selected) => {
    const chunks = await rowChunks({
      row: pickerRow(session({ diffStats: { added: 38, modified: 0, removed: 0 } })),
      theme,
      rowWidth: 100,
      selected,
      isWorking: false,
      blinkOn: false,
      now,
      timeAgoWidth: 3,
    })
    for (const [text, color] of [["+38", theme.success], ["~0", theme.warning], ["-0", theme.error]] as const) {
      expect(chunks.find((chunk) => chunk.text === text)?.fg).toEqual(color)
    }
    expect(chunks[0]?.text).toBe(selected ? "> " : "  ")
    expect(chunks[0]?.fg).toEqual(selected ? theme.primary : theme.textMuted)
    expect((chunks[0]?.attributes ?? 0) & createTextAttributes({ dim: true })).toBe(0)
    const time = chunks.at(-1)!
    expect(time.fg).toEqual(theme.textMuted)
    expect((time.attributes ?? 0) & createTextAttributes({ dim: true })).toBe(0)
  })

  it.each([
    { lifecycleState: "inactive", isWorking: false, blinkOn: true, glyph: "○ ", color: theme.textMuted },
    { lifecycleState: "inactive", isWorking: false, blinkOn: false, glyph: "○ ", color: theme.textMuted },
    { lifecycleState: "active", isWorking: false, blinkOn: true, glyph: "● ", color: theme.success },
    { lifecycleState: "active", isWorking: false, blinkOn: false, glyph: "● ", color: theme.success },
    { lifecycleState: "active", isWorking: true, blinkOn: true, glyph: "● ", color: theme.success },
    { lifecycleState: "active", isWorking: true, blinkOn: false, glyph: "● ", color: theme.textMuted },
    { lifecycleState: "inactive", isWorking: true, blinkOn: true, glyph: "● ", color: theme.success },
  ] as const)("styles the $glyph indicator for $lifecycleState, working=$isWorking, blink=$blinkOn", async ({ lifecycleState, isWorking, blinkOn, glyph, color }) => {
    const chunks = await rowChunks({
      row: pickerRow(session({ lifecycleState })),
      theme,
      rowWidth: 80,
      selected: false,
      isWorking,
      blinkOn,
      now,
      timeAgoWidth: 3,
    })

    expect(chunks.find((chunk) => chunk.text === glyph)?.fg).toEqual(color)
    expect((chunks.find((chunk) => chunk.text === glyph)?.attributes ?? 0) & createTextAttributes({ bold: true }))
      .toBe(isWorking ? createTextAttributes({ bold: true }) : 0)
  })

  it("distinguishes inactive, active idle, and working sessions without shifting titles", async () => {
    const active = pickerRow(session({ lifecycleState: "active" }))
    const working = await plain(active, { isWorking: true })
    const idle = await plain(active)
    const inactive = await plain(pickerRow(session()))

    expect(working.startsWith("  ● Session")).toBe(true)
    expect(idle.startsWith("  ● Session")).toBe(true)
    expect(inactive.startsWith("  ○ Session")).toBe(true)
    expect(idle.indexOf("Session")).toBe(working.indexOf("Session"))
    expect(inactive.indexOf("Session")).toBe(working.indexOf("Session"))
  })

  it("marks the foreground session with the current prefix after row padding", async () => {
    const row = pickerRow(session({ id: "current" }))

    expect((await plain(row, { foregroundId: "current" })).startsWith("  (current) ")).toBe(true)
  })


  it("ellipsizes long titles to keep the row at the requested width with right-aligned time", async () => {
    const width = 42
    const row = pickerRow(session({ title: "A very long session title that cannot possibly fit" }))
    const text = await plain(row, { rowWidth: width })

    expect(text.length).toBe(width)
    expect(text).toContain("…")
    expect(text.slice(-3)).toBe(" 5m")
  })

  it("leaves unknown diff chips blank until totals arrive", async () => {
    const loadingSession: SessionCatalogRow = {
      id: "session-1",
      kind: "chat",
      title: "Session",
      lifecycleState: "inactive",
      notices: [],
      inputMode: { kind: "chat" },
      lastUpdated: new Date(now - 5 * 60_000).toISOString(),
      executionCwd: "/repo",
      totalsLoading: true,
    }
    const withoutDiff = await rowChunks({
      row: pickerRow(loadingSession),
      theme,
      rowWidth: 80,
      selected: false,
      isWorking: false,
      blinkOn: true,
      now,
      timeAgoWidth: 3,
    })
    expect(withoutDiff.map((chunk) => chunk.text).join("")).not.toContain("loading")
    expect(withoutDiff.map((chunk) => chunk.text).join("")).not.toContain("+0 ~0 -0")
    expect(withoutDiff.map((chunk) => chunk.text).join("")).toContain("Session")
    expect(withoutDiff.map((chunk) => chunk.text).join("")).toContain("5m")

    const selected = await rowChunks({
      row: pickerRow(session({ diffStats: { added: 1, modified: 2, removed: 3 } })),
      theme,
      rowWidth: 80,
      selected: true,
      isWorking: false,
      blinkOn: true,
      now,
      timeAgoWidth: 3,
    })
    const chipColors = selected
      .filter((chunk) => chunk.text === "+1" || chunk.text === "~2" || chunk.text === "-3")
      .map((chunk) => chunk.fg)

    expect(chipColors).toEqual([theme.success, theme.warning, theme.error])
  })

  it("renders a chat found by its messages with its title line, its last activity, the marked matching words, and where it stands", async () => {
    const found: PickerFoundRow = {
      kind: "found",
      id: "found:session-1",
      session: session({ title: "Graph matcher" }),
      found: { sessionId: "session-1", lastActivityAt: now - 2 * 3_600_000, entryId: "e1", snippet: "fix the [kafka]\nconsumer lag", excerpt: { source: "checkpoint", text: "PR 5132 waits on review" } },
    }
    const result = await testRender(() => createComponent(SessionPickerRow, { row: found, theme, rowWidth: 60, selected: false, isWorking: false, blinkOn: true, now, timeAgoWidth: 3, rowIndex: 0, onRowClick: () => {} }), { width: 60, height: 3 })
    try {
      await result.renderOnce()
      const lines = result.renderer.root.getChildren()[0]?.getChildren().map((text) => {
        if (!(text instanceof TextRenderable)) throw new Error("expected a row line")
        return [...text.content.chunks]
      }) ?? []
      const plainLines = lines.map((chunks) => chunks.map((chunk) => chunk.text).join("").trimEnd())
      expect(plainLines[0]?.startsWith("  ○ Graph matcher")).toBe(true)
      expect(plainLines[0]?.endsWith(" 2h")).toBe(true)
      expect(plainLines.slice(1)).toEqual(["    fix the kafka consumer lag", "    PR 5132 waits on review"])
      const match = lines[1]?.find((chunk) => chunk.text === "kafka")
      expect(match?.fg).toEqual(theme.accent)
      expect((match?.attributes ?? 0) & createTextAttributes({ bold: true })).toBe(createTextAttributes({ bold: true }))
      expect(lines[1]?.find((chunk) => chunk.text === "fix the ")?.fg).toEqual(theme.textMuted)
      expect(lines[2]?.find((chunk) => chunk.text === "PR 5132 waits on review")?.fg).toEqual(theme.textMuted)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders corrupt rows with the session id, an error marker, and confirm-delete text", async () => {
    const corrupt: PickerCorruptRow = { kind: "corrupt", id: "corrupt:broken", sessionId: "broken", reason: "bad fact" }
    const base = { theme, rowWidth: 60, selected: false, isWorking: false, blinkOn: true, now, timeAgoWidth: 3 }

    const chunks = await rowChunks({ ...base, row: corrupt })
    const text = chunks.map((chunk) => chunk.text).join("")
    expect(text).toContain("! ")
    expect(text).toContain("broken")
    expect(text).toContain("unreadable")
    const unreadable = chunks.find(chunk => chunk.text === "unreadable")!
    expect(unreadable.fg).toEqual(theme.error)
    expect((unreadable.attributes ?? 0) & createTextAttributes({ dim: true })).toBe(0)

    for (const row of [corrupt, pickerRow(session({ id: "broken" }))]) {
      const confirming = await rowChunks({ ...base, row, confirmDeleteSessionId: "broken" })
      expect(confirming.map(chunk => chunk.text).join("")).toContain("Press ctrl+d again to confirm")
      expect(confirming.every(chunk => chunk.fg?.equals(theme.background))).toBe(true)
    }
  })
})
