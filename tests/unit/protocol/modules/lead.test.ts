import { expect, test } from "bun:test"
import { moduleDomainReader } from "../../../../src/protocol/client/module-domain.js"
import { leadNeedsPerson, leadProtocol, leadRowOrder, type LeadChatsView, type LeadRow, type LeadRowState } from "../../../../src/protocol/modules/lead.js"

const row = (sessionId: string, state: LeadRowState, since: number, waitingSince?: number): LeadRow => ({
  sessionId, state, status: state, since, ...(waitingSince === undefined ? {} : { waitingSince }),
})
const view = (rows: readonly LeadRow[]): LeadChatsView => ({ rows })
// The count reads the rows domain that the executor serves, never the designation that the control part serves.
const status = (current: LeadChatsView | undefined) => leadProtocol.composer.status(moduleDomainReader((domain) => domain.domain === "leadChats" ? current : undefined))

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
