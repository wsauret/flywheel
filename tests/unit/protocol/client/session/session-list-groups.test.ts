import { describe, expect, test } from "bun:test"
import { selectNeedsYou } from "../../../../../src/protocol/client/session/needs-you.js"
import { groupSessionList, type ListedTurns } from "../../../../../src/protocol/client/session/session-list-groups.js"
import type { StoppedChat, UnreadChatsView } from "../../../../../src/protocol/session/unread-protocol-types.js"

const at = (minute: number) => new Date(Date.UTC(2026, 10, 27, 12, minute)).toISOString()
const stop = (sessionId: string, stoppedAt: number): StoppedChat => ({ sessionId, ending: { kind: "completed" }, firstLine: "Done.", stoppedAt, stopKey: `answer-${sessionId}` })

interface Row { readonly id: string; readonly lastUpdated: string; readonly createdAt?: string; readonly working?: boolean }

function grouped(rows: readonly Row[], unread: UnreadChatsView | undefined, waiting: readonly string[] = [], turns: ListedTurns = unread?.turns) {
  const needsYou = selectNeedsYou({ waiting: { sessions: waiting.map((sessionId, index) => ({ sessionId, openedAt: index })) }, unread, listed: rows })
  return groupSessionList({ rows, needsYou, working: (row) => row.working === true, turns })
    .map((entry) => [entry.row.id, entry.group, entry.lastActiveAt])
}

describe("groupSessionList", () => {
  test("files Needs you, then Working, then Recent, each in its order, with the time each row shows", () => {
    const rows: Row[] = [
      { id: "recent-old", lastUpdated: at(59) },
      { id: "asks", lastUpdated: at(1), working: true },
      { id: "working-new", lastUpdated: at(2), working: true },
      { id: "stopped", lastUpdated: at(3) },
      { id: "recent-new", lastUpdated: at(4) },
      { id: "working-old", lastUpdated: at(5), working: true },
    ]
    const turns = { "recent-old": 10, asks: 50, "working-new": 40, stopped: 20, "recent-new": 30, "working-old": 35 }
    expect(grouped(rows, { stopped: [stop("stopped", 25)], unread: [], turns }, ["asks"])).toEqual([
      ["asks", "Needs you", 50],
      ["stopped", "Needs you", 25],
      ["working-new", "Working", 40],
      ["working-old", "Working", 35],
      ["recent-new", "Recent", 30],
      ["recent-old", "Recent", 10],
    ])
  })

  test("orders by the latest turn, not by the last change that opening or closing a chat writes", () => {
    const rows: Row[] = [{ id: "opened", lastUpdated: at(50) }, { id: "worked", lastUpdated: at(10) }]
    expect(grouped(rows, { stopped: [], unread: [], turns: { opened: 100, worked: 200 } }).map(([id]) => id)).toEqual(["worked", "opened"])
  })

  test("a chat with no latest turn takes its creation time, else its last change", () => {
    const rows: Row[] = [
      { id: "created", lastUpdated: at(50), createdAt: at(5) },
      { id: "changed", lastUpdated: at(20) },
      { id: "turned", lastUpdated: at(1) },
    ]
    const turnedAt = Date.parse(at(30))
    expect(grouped(rows, { stopped: [], unread: [], turns: { turned: turnedAt } })).toEqual([
      ["turned", "Recent", turnedAt],
      ["changed", "Recent", Date.parse(at(20))],
      ["created", "Recent", Date.parse(at(5))],
    ])
  })

  test("with no times, every chat is filed by its own times", () => {
    const rows: Row[] = [{ id: "asks", lastUpdated: at(1) }, { id: "busy", lastUpdated: at(2), working: true }, { id: "rest", lastUpdated: at(3) }]
    expect(grouped(rows, undefined, ["asks"], undefined)).toEqual([["asks", "Needs you", Date.parse(at(1))], ["busy", "Working", Date.parse(at(2))], ["rest", "Recent", Date.parse(at(3))]])
  })

  test("a chat moves from Working to Needs you when its turn stops unread, and to Recent when it is read", () => {
    const working: Row[] = [{ id: "chat", lastUpdated: at(1), working: true }, { id: "other", lastUpdated: at(2) }]
    expect(grouped(working, { stopped: [], unread: ["chat"], turns: { chat: 10, other: 5 } })).toEqual([["chat", "Working", 10], ["other", "Recent", 5]])
    const resting = working.map((row) => ({ ...row, working: false }))
    expect(grouped(resting, { stopped: [stop("chat", 20)], unread: [], turns: { chat: 20, other: 5 } })).toEqual([["chat", "Needs you", 20], ["other", "Recent", 5]])
    expect(grouped(resting, { stopped: [], unread: [], turns: { chat: 20, other: 5 } })).toEqual([["chat", "Recent", 20], ["other", "Recent", 5]])
  })
})
