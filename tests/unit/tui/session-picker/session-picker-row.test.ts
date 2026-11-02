import { describe, expect, it } from "bun:test"
import { createTextAttributes } from "@opentui/core"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme, type ThemeJson } from "../../../../src/tui/context/theme/resolve.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { buildSessionRowChunks } from "../../../../src/tui/session-picker/session-picker-row.js"
import type { PickerCorruptRow, PickerSessionRow } from "../../../../src/tui/session-picker/picker-types.js"

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

function plain(row: PickerSessionRow, overrides: Partial<Parameters<typeof buildSessionRowChunks>[0]> = {}): string {
  return buildSessionRowChunks({
    row,
    theme,
    rowWidth: 80,
    selected: false,
    isWorking: false,
    blinkOn: true,
    now,
    timeAgoWidth: 3,
    ...overrides,
  }).map((chunk) => chunk.text).join("")
}

describe("SessionPickerRow", () => {
  it.each([false, true])("preserves diff colors when selected=%s", (selected) => {
    const chunks = buildSessionRowChunks({
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
  ] as const)("styles the $glyph indicator for $lifecycleState, working=$isWorking, blink=$blinkOn", ({ lifecycleState, isWorking, blinkOn, glyph, color }) => {
    const chunks = buildSessionRowChunks({
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

  it("distinguishes inactive, active idle, and working sessions without shifting titles", () => {
    const active = pickerRow(session({ lifecycleState: "active" }))
    const working = plain(active, { isWorking: true })
    const idle = plain(active)
    const inactive = plain(pickerRow(session()))

    expect(working.startsWith("  ● Session")).toBe(true)
    expect(idle.startsWith("  ● Session")).toBe(true)
    expect(inactive.startsWith("  ○ Session")).toBe(true)
    expect(idle.indexOf("Session")).toBe(working.indexOf("Session"))
    expect(inactive.indexOf("Session")).toBe(working.indexOf("Session"))
  })

  it("marks the foreground session with the current prefix after row padding", () => {
    const row = pickerRow(session({ id: "current" }))

    expect(plain(row, { foregroundId: "current" }).startsWith("  (current) ")).toBe(true)
  })


  it("ellipsizes long titles to keep the row at the requested width with right-aligned time", () => {
    const width = 42
    const row = pickerRow(session({ title: "A very long session title that cannot possibly fit" }))
    const text = plain(row, { rowWidth: width })

    expect(text.length).toBe(width)
    expect(text).toContain("…")
    expect(text.slice(-3)).toBe(" 5m")
  })

  it("leaves unknown diff chips blank until totals arrive", () => {
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
    const withoutDiff = buildSessionRowChunks({
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

    const selected = buildSessionRowChunks({
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

  it("renders corrupt rows with the session id, an error marker, and confirm-delete text", () => {
    const corrupt: PickerCorruptRow = { kind: "corrupt", id: "corrupt:broken", sessionId: "broken", reason: "bad fact" }
    const base = { theme, rowWidth: 60, selected: false, isWorking: false, blinkOn: true, now, timeAgoWidth: 3 }

    const chunks = buildSessionRowChunks({ ...base, row: corrupt })
    const text = chunks.map((chunk) => chunk.text).join("")
    expect(text).toContain("! ")
    expect(text).toContain("broken")
    expect(text).toContain("unreadable")
    const unreadable = chunks.find(chunk => chunk.text === "unreadable")!
    expect(unreadable.fg).toEqual(theme.error)
    expect((unreadable.attributes ?? 0) & createTextAttributes({ dim: true })).toBe(0)

    for (const row of [corrupt, pickerRow(session({ id: "broken" }))]) {
      const confirming = buildSessionRowChunks({ ...base, row, confirmDeleteSessionId: "broken" })
      expect(confirming.map(chunk => chunk.text).join("")).toContain("Press d again to confirm")
      expect(confirming.every(chunk => chunk.fg?.equals(theme.background))).toBe(true)
    }
  })
})
