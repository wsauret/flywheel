import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import type { SessionCatalogRow } from "../../../../../src/protocol/runtime/app-service-types.js"
import {
  buildDiffStatChunks,
  flattenSessionRows,
  formatCompactTimeAgo,
  parseSessionIdQuery,
  pickerRowLastActive,
  pickerRowLines,
  stopDetail,
  timeAgoColumnWidth,
} from "../../../../../src/tui/modals/session-picker/picker-helpers.js"
import { selectNeedsYou } from "../../../../../src/protocol/client/session/needs-you.js"
import { groupSessionList } from "../../../../../src/protocol/client/session/session-list-groups.js"
import type { PickerRow, PickerSessionRow } from "../../../../../src/tui/modals/session-picker/picker-types.js"

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
    case "found":
      return `found:${row.session.id}`
  }
}

describe("picker helpers", () => {
  it("lists chats without expanding owned workflow or subagent ids", () => {
    const parent = session("parent", "2026-07-05T12:00:00.000Z", { childSessionIds: ["subagent", "workflow"] })
    const rows = flattenSessionRows(groupSessionList({ rows: [parent], needsYou: selectNeedsYou({ waiting: undefined, unread: undefined, listed: [parent] }), working: () => false, turns: undefined }))

    expect(sessionRows(rows).map((row) => row.session.id)).toEqual(["parent"])
  })

  it("heads each group that has a chat, Needs you, then Working, then Recent, with a spacer between groups and no day heading", () => {
    const now = new Date(2026, 6, 5, 12)
    const listed = [
      session("today", new Date(2026, 6, 5, 11).toISOString()),
      session("waiting-old", new Date(2026, 5, 1, 10).toISOString()),
      { ...session("waiting-new", new Date(2026, 6, 5, 10).toISOString()), lifecycleState: "active" as const },
      session("yesterday", new Date(2026, 6, 4, 10).toISOString()),
      session("stopped-old", new Date(2026, 6, 5, 9).toISOString()),
      session("failed-new", new Date(2026, 6, 5, 8).toISOString()),
      session("working", new Date(2026, 5, 1, 9).toISOString()),
    ]
    const failed = { sessionId: "failed-new", ending: { kind: "failed", failure: "api_overloaded" }, stoppedAt: now.getTime() - 60_000, stopKey: "stop:9" } as const
    const stopped = { sessionId: "stopped-old", ending: { kind: "completed" }, firstLine: "All tests pass.", stoppedAt: now.getTime() - 3 * 60 * 60_000, stopKey: "entry-1" } as const
    const unread = { stopped: [failed, stopped], unread: ["today"], turns: { yesterday: now.getTime() - 5 * 60_000 } }
    const needsYou = selectNeedsYou({
      waiting: { sessions: [{ sessionId: "waiting-old", openedAt: 1 }, { sessionId: "waiting-new", openedAt: 2 }, { sessionId: "deleted", openedAt: 3 }] },
      unread,
      listed,
    })
    const rows = flattenSessionRows(groupSessionList({ rows: listed, needsYou, working: (row) => row.id === "working", turns: unread.turns }))

    expect(rows.map(rowLabel)).toEqual([
      "header:Needs you",
      "session:waiting-new",
      "session:waiting-old",
      "session:failed-new",
      "session:stopped-old",
      "header:",
      "header:Working",
      "session:working",
      "header:",
      "header:Recent",
      "session:yesterday",
      "session:today",
    ])
    // A stopped row shows what it stopped with on a second line, and its age
    // counts from the stop; another row's age counts from its latest turn.
    const row = (id: string) => rows.find((candidate): candidate is PickerSessionRow => candidate.kind === "session" && candidate.session.id === id)
    expect(row("stopped-old")).toMatchObject({ group: "Needs you", stopped })
    expect([pickerRowLines(row("stopped-old")!), pickerRowLines(row("waiting-new")!)]).toEqual([2, 1])
    expect(formatCompactTimeAgo(now.getTime(), pickerRowLastActive(row("stopped-old")!))).toBe("3h")
    expect(formatCompactTimeAgo(now.getTime(), pickerRowLastActive(row("yesterday")!))).toBe("5m")
    expect([stopDetail(stopped), stopDetail(failed)]).toEqual(["All tests pass.", "The model provider is overloaded"])
    expect(row("today")?.group).toBe("Recent")
  })

  it("shows no heading for an empty group", () => {
    const listed = [session("only", "2026-07-05T12:00:00.000Z")]
    const rows = flattenSessionRows(groupSessionList({ rows: listed, needsYou: selectNeedsYou({ waiting: undefined, unread: undefined, listed }), working: () => false, turns: undefined }))
    expect(rows.map(rowLabel)).toEqual(["header:Recent", "session:only"])
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
