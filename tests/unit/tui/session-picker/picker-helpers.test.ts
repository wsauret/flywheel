import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import {
  buildDiffStatChunks,
  flattenSessionRows,
  formatCompactTimeAgo,
  parseSessionIdQuery,
  timeAgoColumnWidth,
} from "../../../../src/tui/session-picker/picker-helpers.js"
import type { PickerRow, PickerSessionRow } from "../../../../src/tui/session-picker/picker-types.js"

function session(id: string, lastUpdated: string, options: {
  parentSessionId?: string
  childSessionIds?: readonly string[]
} = {}): SessionCatalogRow {
  return {
    id,
    title: id,
    lifecycleState: "inactive",
    notices: [],
    kind: "chat",
    inputMode: { kind: "chat" },
    lastUpdated,
    executionCwd: "/workspace",
    totalsLoading: false,
    totalCost: 0,
    totalBilledCost: 0,
    priceUnavailable: false,
    totalTokens: 0,
    contextPercent: 0,
    contextPromptTokens: 0,
    durationMs: 0,
    ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    ...(options.childSessionIds ? { childSessionIds: options.childSessionIds } : {}),
  }
}

function sessionRows(rows: readonly PickerRow[]): PickerSessionRow[] {
  const matches: PickerSessionRow[] = []
  for (const row of rows) {
    if (row.kind === "session") matches.push(row)
  }
  return matches
}

function rowLabel(row: PickerRow): string {
  switch (row.kind) {
    case "header":
      return `header:${row.label}`
    case "session":
      return `session:${row.session.id}`
    case "corrupt":
      return `corrupt:${row.sessionId}`
  }
}

describe("picker helpers", () => {
  it("lists chats without expanding owned workflow or subagent ids", () => {
    const now = new Date(2026, 6, 5, 13)
    const parent = session("parent", "2026-07-05T12:00:00.000Z", { childSessionIds: ["subagent", "workflow"] })
    const rows = flattenSessionRows([
      parent,
    ], now)

    expect(sessionRows(rows).map((row) => row.session.id)).toEqual(["parent"])
  })

  it("sorts roots by recency and groups them under current date headers", () => {
    const now = new Date(2026, 6, 5, 12)
    const old = new Date(2026, 5, 1, 10)
    const rows = flattenSessionRows([
      session("yesterday", new Date(2026, 6, 4, 10).toISOString()),
      session("today-early", new Date(2026, 6, 5, 9).toISOString()),
      session("old", old.toISOString()),
      session("today-late", new Date(2026, 6, 5, 11).toISOString()),
    ], now)

    expect(rows.map(rowLabel)).toEqual([
      "header:Today",
      "session:today-late",
      "session:today-early",
      "header:",
      "header:Yesterday",
      "session:yesterday",
      "header:",
      `header:${old.toDateString()}`,
      "session:old",
    ])
  })

  it("sorts and groups roots by createdAt when present, not by lastUpdated", () => {
    const now = new Date(2026, 6, 5, 12)
    const startedYesterday = {
      ...session("started-yesterday", new Date(2026, 6, 5, 11).toISOString()),
      createdAt: new Date(2026, 6, 4, 10).toISOString(),
    }
    const startedToday = {
      ...session("started-today", new Date(2026, 6, 5, 9).toISOString()),
      createdAt: new Date(2026, 6, 5, 8).toISOString(),
    }
    const rows = flattenSessionRows([startedYesterday, startedToday], now)

    expect(rows.map(rowLabel)).toEqual([
      "header:Today",
      "session:started-today",
      "header:",
      "header:Yesterday",
      "session:started-yesterday",
    ])
  })

  it("formats compact time ago labels with coarse thresholds", () => {
    const now = 1_000_000_000
    expect(formatCompactTimeAgo(now, now - 30_000)).toBe("1m")
    expect(formatCompactTimeAgo(now, now - 5 * 60_000)).toBe("5m")
    expect(formatCompactTimeAgo(now, now - 2 * 60 * 60_000)).toBe("2h")
    expect(formatCompactTimeAgo(now, now - 3 * 24 * 60 * 60_000)).toBe("3d")
    expect(formatCompactTimeAgo(now, now - 14 * 24 * 60 * 60_000)).toBe("2w")
    expect(formatCompactTimeAgo(now, now - 150 * 24 * 60 * 60_000)).toBe("5mo")
  })

  it("parses only exact known session ids from queries", () => {
    const knownIds = new Set(["session-123"])
    expect(parseSessionIdQuery("  session-123  ", knownIds)).toBe("session-123")
    expect(parseSessionIdQuery("session", knownIds)).toBeNull()
    expect(parseSessionIdQuery("session-999", knownIds)).toBeNull()
  })

  it("returns the widest compact time label length", () => {
    expect(timeAgoColumnWidth(["1m", "12h", "5mo"])).toBe(3)
  })

  it("colors diff counts and mutes only all-zero totals", () => {
    const colors = {
      success: RGBA.fromHex("#00ff00"),
      warning: RGBA.fromHex("#ffff00"),
      error: RGBA.fromHex("#ff0000"),
      muted: RGBA.fromHex("#888888"),
    }

    const zeroed = buildDiffStatChunks(undefined, colors)
    expect(zeroed.map((chunk) => chunk.text)).toEqual(["+0", " ", "~0", " ", "-0"])
    expect(zeroed.every((chunk) => chunk.fg === colors.muted)).toBe(true)
    expect(buildDiffStatChunks({ added: 0, modified: 0, removed: 0 }, colors)).toEqual(zeroed)

    const unselected = buildDiffStatChunks({ added: 1, modified: 2, removed: 3 }, colors)
    expect(unselected.map((chunk) => chunk.text)).toEqual(["+1", " ", "~2", " ", "-3"])
    expect(unselected.map((chunk) => chunk.fg)).toEqual([
      colors.success,
      colors.muted,
      colors.warning,
      colors.muted,
      colors.error,
    ])
  })
})
