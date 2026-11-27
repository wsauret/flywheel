import { describe, expect, test } from "bun:test"
import { selectNeedsYou } from "../../../../../src/protocol/client/session/needs-you.js"
import type { StoppedChat } from "../../../../../src/protocol/session/unread-protocol-types.js"

const stopped = (sessionId: string, stoppedAt: number): StoppedChat => ({ sessionId, ending: { kind: "completed" }, firstLine: "Done.", stoppedAt, stopKey: `answer-${sessionId}` })
const listed = (...ids: string[]) => ids.map((id) => ({ id }))

describe("selectNeedsYou", () => {
  test("lists questions newest first, then stopped chats newest first, and counts a chat with both once, as its question", () => {
    const needs = selectNeedsYou({
      waiting: { sessions: [{ sessionId: "asked-old", openedAt: 1 }, { sessionId: "both", openedAt: 5 }, { sessionId: "asked-new", openedAt: 9 }] },
      unread: { stopped: [stopped("stopped-new", 8), stopped("both", 7), stopped("stopped-old", 2)], unread: ["working", "both"], turns: {} },
      listed: listed("asked-old", "both", "asked-new", "stopped-new", "stopped-old", "working", "quiet"),
    })

    expect(needs.rows.map((row) => [row.kind, row.sessionId])).toEqual([
      ["question", "asked-new"], ["question", "both"], ["question", "asked-old"],
      ["stopped", "stopped-new"], ["stopped", "stopped-old"],
    ])
    expect(needs.count).toBe(5)
    expect([...needs.unread]).toEqual(["working"])
    expect(needs.rows[3]).toEqual({ kind: "stopped", sessionId: "stopped-new", since: 8, stopped: stopped("stopped-new", 8) })
  })

  test("shows no session that the client does not list", () => {
    const needs = selectNeedsYou({
      waiting: { sessions: [{ sessionId: "subagent", openedAt: 1 }] },
      unread: { stopped: [stopped("deleted", 2)], unread: ["gone"], turns: {} },
      listed: listed("chat"),
    })
    expect(needs).toEqual({ rows: [], unread: new Set(), count: 0 })
  })

  test("a view that an older runtime never answered counts as empty and keeps the questions", () => {
    const needs = selectNeedsYou({ waiting: { sessions: [{ sessionId: "asked", openedAt: 1 }] }, unread: undefined, listed: listed("asked") })
    expect(needs).toEqual({ rows: [{ kind: "question", sessionId: "asked", since: 1 }], unread: new Set(), count: 1 })
    expect(selectNeedsYou({ waiting: undefined, unread: undefined, listed: listed("asked") }).count).toBe(0)
  })
})
