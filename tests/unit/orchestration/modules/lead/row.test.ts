import { describe, expect, test } from "bun:test"
import { foldRowBatch, ROW_TAIL_ENTRIES, type RowFold } from "../../../../../src/orchestration/modules/lead/row.js"
import type { StoredTailEntry } from "../../../../../src/orchestration/session/chat-session-run-evidence.js"
import { chatTurnEndOf, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"

type Message = Extract<StoredTailEntry, { readonly kind: "message" }>["message"]

const entry = (id: string, message: Message): StoredTailEntry => ({ kind: "message", id, parentId: null, timestamp: "2026-11-13T00:00:00.000Z", message })
const person = (id: string, text: string) => entry(id, { kind: "user", content: text, origin: "human" })
const answer = (id: string, text: string) => entry(id, { kind: "assistant", content: [{ type: "text", text }] })
const call = (id: string, toolUseId: string, input: { readonly [key: string]: unknown } = {}) => entry(id, { kind: "assistant", content: [{ type: "text", text: "Reading the code.\nMore." }, { type: "tool_use", id: toolUseId, name: "read", input }] })
const result = (id: string, toolUseId: string) => entry(id, { kind: "toolResult", toolUseId, content: [{ type: "text", text: "ok" }] })
const notice = (id: string) => entry(id, { kind: "user", content: "A background command finished.", origin: "system" })
const record = (id: string) => entry(id, { kind: "user", content: "The turn ended.", origin: "system" })

/** Folds each batch in order from an empty fold. */
function fold(batches: readonly (readonly StoredTailEntry[])[]): RowFold {
  let state: RowFold = { tail: [], truncated: false, turnEnd: undefined, latest: null, request: null, final: null, contexts: {} }
  for (const [index, batch] of batches.entries()) state = foldRowBatch(state, batch, index + 1)
  return state
}

const CRASH = turnEndEntryId({ reason: "crash" }, "c1")
const INTERRUPT = turnEndEntryId({ reason: "paused", pausedBy: "person" }, "p1")

describe("the row fold's turn-end reading", () => {
  const fixtures: { readonly name: string; readonly batches: readonly (readonly StoredTailEntry[])[] }[] = [
    { name: "a final answer", batches: [[person("u1", "Fix it")], [answer("a1", "Fixed.")]] },
    { name: "an open turn with no record", batches: [[answer("a0", "Earlier.")], [person("u1", "Fix it")]] },
    { name: "a visible interrupt", batches: [[person("u1", "Fix it"), call("a1", "t1")], [result("r1", "t1"), record(INTERRUPT)]] },
    { name: "a crash record", batches: [[person("u1", "Fix it"), call("a1", "t1")], [result("r1", "t1")], [record(CRASH)]] },
    { name: "a notice after an answer", batches: [[person("u1", "Fix it"), answer("a1", "Fixed.")], [notice("n1")]] },
  ]
  for (const { name, batches } of fixtures) {
    test(`agrees with chatTurnEndOf over the same entries: ${name}`, () => {
      expect(fold(batches).turnEnd?.reading).toEqual(chatTurnEndOf(batches.flat()))
    })
  }

  test("names the crash record's entry, and no entry for an open turn with no record", () => {
    expect(fold(fixtures[3]!.batches).turnEnd?.recordId).toBe(CRASH)
    expect(fold(fixtures[1]!.batches).turnEnd).toMatchObject({ reading: { recorded: false }, recordId: null })
  })

  // Each notice lands in its own batch, so the fold compacts again on every batch past the retained tail.
  const notices = (prefix: string) => Array.from({ length: ROW_TAIL_ENTRIES + 6 }, (_, index) => [notice(`${prefix}${index}`)])
  const RUNTIME_CUT = turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, "r1")
  const longTurns: { readonly name: string; readonly batches: readonly (readonly StoredTailEntry[])[]; readonly recordId: string }[] = [
    { name: "a crash after more notices than the tail holds", batches: [[person("u1", "Fix it"), answer("a1", "Waiting on the build.")], ...notices("n"), [record(CRASH)]], recordId: CRASH },
    { name: "a person's cut followed by more notices than the tail holds", batches: [[person("u1", "Fix it"), call("a1", "t1")], [result("r1", "t1"), record(INTERRUPT)], ...notices("n")], recordId: INTERRUPT },
    { name: "a runtime cut followed by more notices than the tail holds", batches: [[person("u1", "Fix it"), answer("a1", "Waiting on the build.")], [record(RUNTIME_CUT)], ...notices("n")], recordId: RUNTIME_CUT },
    { name: "a crash record followed by more notices than the tail holds", batches: [[person("u1", "Fix it"), call("a1", "t1")], [result("r1", "t1"), record(CRASH)], ...notices("n")], recordId: CRASH },
  ]
  for (const { name, batches, recordId } of longTurns) {
    test(`agrees with chatTurnEndOf over the whole history, past the retained tail: ${name}`, () => {
      const state = fold(batches)
      expect(batches.flat().length).toBeGreaterThan(ROW_TAIL_ENTRIES)
      expect(state.turnEnd?.reading).toEqual(chatTurnEndOf(batches.flat()))
      expect(state.turnEnd?.recordId).toBe(recordId)
    })
  }
})

test("the fold keeps the newest output, the person's newest message, the final answer, and each call's context", () => {
  const state = fold([
    [person("u1", "Add a form"), answer("a1", "Added the form.")],
    [person("u2", "Fix the login page"), entry("a2", { kind: "assistant", content: [{ type: "text", text: "\nDesign is ready.\nDetails..." }, { type: "tool_use", id: "ask-1", name: "ask_user", input: { context: "Two forms share a handler.", question: "Which?" } }] })],
  ])
  expect(state.request).toEqual({ entryId: "u2", text: "Fix the login page", at: 2 })
  expect(state.final).toEqual({ entryId: "a1", text: "Added the form.", at: 1 })
  // The newest output is the message's last block: here its question call.
  expect(state.latest).toEqual({ kind: "call", name: "ask_user", input: { context: "Two forms share a handler.", question: "Which?" }, at: 2 })
  expect(fold([[answer("a1", "\nDesign is ready.\nDetails...")]]).latest).toEqual({ kind: "text", text: "Design is ready.", at: 1 })
  // A message with no text and no shown call keeps the newest output before it.
  expect(fold([[answer("a1", "Started.")], [entry("a2", { kind: "assistant", content: [{ type: "text", text: "  " }] })]]).latest).toEqual({ kind: "text", text: "Started.", at: 1 })
  expect(state.contexts).toEqual({ "ask-1": "Two forms share a handler." })
})
