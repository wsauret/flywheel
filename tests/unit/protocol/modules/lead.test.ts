import { expect, test } from "bun:test"
import { moduleDomainReader } from "../../../../src/protocol/client/module-domain.js"
import { EMPTY_LEAD_VIEW, leadLongestWaiting, leadNeedsPerson, leadProtocol, leadRowOrder, type LeadRow, type LeadRowState, type LeadView } from "../../../../src/protocol/modules/lead.js"

const row = (sessionId: string, state: LeadRowState, since: number, waitingSince?: number): LeadRow => ({
  sessionId, state, update: null, since, request: null, updates: [], ...(waitingSince === undefined ? {} : { waitingSince }),
})
const view = (rows: readonly LeadRow[]): LeadView => ({ ...EMPTY_LEAD_VIEW, rows })
const status = (current: LeadView | undefined) => leadProtocol.composer.status(moduleDomainReader((domain) => domain.domain === "lead" ? current : undefined))

const rows = [
  row("result-old", "result", 10),
  row("working", "working", 50),
  row("cut-recent", "cut", 90, 80),
  row("question-oldest", "question", 95, 20),
  row("result-new", "result", 60),
  row("failed-middle", "failed", 70, 40),
]

test("the chats that need the person come first, the longest wait first", () => {
  expect(leadRowOrder(rows).map((current) => current.sessionId)).toEqual(["question-oldest", "failed-middle", "cut-recent", "working", "result-new", "result-old"])
})

test("question, failed, and cut need the person, and the composer border counts them in the warning tone", () => {
  expect(leadNeedsPerson(view(rows))).toBe(3)
  expect(status(view(rows.filter((current) => current.sessionId !== "cut-recent")))).toEqual([{ id: "lead", text: "2 need you", tone: "warning" }])
  expect(status(view([row("question", "question", 1, 1), row("working", "working", 2)]))).toEqual([{ id: "lead", text: "1 needs you", tone: "warning" }])
  expect(status(view([row("working", "working", 2), row("result", "result", 3)]))).toEqual([])
  expect(status(undefined)).toEqual([])
})

test("the longest waiting row is the chat that needs the person with the smallest waitingSince, and no row when none waits", () => {
  expect(leadLongestWaiting(view(rows))?.sessionId).toBe("question-oldest")
  expect(leadLongestWaiting(view([row("failed", "failed", 5, 30), row("cut", "cut", 9, 10)]))?.sessionId).toBe("cut")
  expect(leadLongestWaiting(view([row("working", "working", 2), row("result", "result", 3)]))).toBeUndefined()
})
