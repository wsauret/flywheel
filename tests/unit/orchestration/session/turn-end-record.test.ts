import { describe, expect, test } from "bun:test"
import {
  carriedTurnEndRecord,
  chatTurnEndOf,
  cutRunningToolCall,
  endsAtTurnEnd,
  interruptedTurnEnd,
  interruptedTurnMessage,
  isResumableTurnEnd,
  isVisibleTurnEnd,
  turnEndEntryId,
  turnEndOfEntry,
  questionExchangeOf,
  waitsAtRuntimeInterrupt,
  waitsForPerson,
  type TurnEndEntry,
} from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages.js"
import { toolResultMessages } from "../../../../src/orchestration/agent-runtime/agent-state.js"
import { TOOL_OUTCOME_VALUES } from "../../../../src/infra/tool-outcome.js"

/** The display-only content Escape markers carried before interrupt became resumable. */
const LEGACY_USER_INTERRUPT_CONTENT = "Interrupted by user."

let seq = 0
function message(kind: "user" | "assistant" | "system", options: { id?: string; origin?: "human" | "system"; displayOnly?: boolean; content?: string } = {}): TurnEndEntry {
  seq += 1
  return {
    kind: "message",
    id: options.id ?? `e${seq}`,
    ...(options.displayOnly ? { displayOnly: true } : {}),
    message: { kind, ...(options.origin ? { origin: options.origin } : {}), content: options.content ?? `${kind} ${seq}` },
  }
}

describe("turn-end records", () => {
  test("the reason and who interrupted travel in the id, so every reader of the entry already has them", () => {
    expect(turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k")).toBe("itb-paused-person-k")
    expect(turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, "k")).toBe("itb-paused-runtime-k")
    expect(turnEndEntryId({ reason: "crash" }, "k")).toBe("itb-crash-k")
    expect(turnEndEntryId({ reason: "discarded" }, "k")).toBe("itb-discarded-k")
    for (const end of [{ reason: "paused" as const, pausedBy: "person" as const }, { reason: "paused" as const, pausedBy: "runtime" as const }, { reason: "crash" as const }, { reason: "discarded" as const }]) {
      expect(turnEndOfEntry(message("user", { id: turnEndEntryId(end, "k"), origin: "system" }))).toEqual(end)
    }
    expect(turnEndOfEntry(message("assistant"))).toBeUndefined()
    expect(turnEndOfEntry({ kind: "label", id: "itb-crash-k" })).toBeUndefined()
  })

  test("an exchange the runtime answered itself is a recorded, visible turn end that Resume never continues", () => {
    const settled = { reason: "settled" } as const
    expect(turnEndEntryId(settled, "operation-1")).toBe("itb-settled-operation-1")
    for (const origin of ["human", "system"] as const) {
      const acknowledgement = message("user", { id: turnEndEntryId(settled, "operation-1"), origin, content: "Launched the qa workflow: verify" })
      expect(turnEndOfEntry(acknowledgement)).toEqual(settled)
      expect(chatTurnEndOf([message("assistant"), acknowledgement])).toEqual({ end: settled, recorded: true })
      expect(chatTurnEndOf([message("assistant"), acknowledgement, message("system", { displayOnly: true })])).toEqual({ end: settled, recorded: true })
    }
    expect(isResumableTurnEnd(settled)).toBe(false)
    expect(isVisibleTurnEnd(settled)).toBe(true)
  })

  test("a planned replacement's cut is the runtime's resumable interrupt, marked planned and invisible, under the prefix older releases read", () => {
    const planned = interruptedTurnEnd("replacement")
    expect(planned).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
    const id = turnEndEntryId(planned, "k")
    expect(id).toBe("itb-paused-runtime-planned-k")
    expect(id.startsWith("itb-paused-runtime-")).toBe(true)
    expect(turnEndOfEntry(message("user", { id, origin: "system" }))).toEqual(planned)
    expect(isResumableTurnEnd(planned)).toBe(true)
    expect(isVisibleTurnEnd(planned)).toBe(false)
    expect(isVisibleTurnEnd(interruptedTurnEnd("runtime"))).toBe(true)
  })

  test("Close chat's cut is the runtime's visible, resumable interrupt, marked closed, under the prefix older releases read", () => {
    const closed = interruptedTurnEnd("close")
    expect(closed).toEqual({ reason: "paused", pausedBy: "runtime", closed: true })
    const id = turnEndEntryId(closed, "k")
    expect(id).toBe("itb-paused-runtime-closed-k")
    expect(id.startsWith("itb-paused-runtime-")).toBe(true)
    expect(turnEndOfEntry(message("user", { id, origin: "system" }))).toEqual(closed)
    expect(isResumableTurnEnd(closed)).toBe(true)
    expect(isVisibleTurnEnd(closed)).toBe(true)
  })

  test("converts records written before ids carried a reason: the discarded record by its opening sentence, every other one a crash", () => {
    // Remove with the conversion after 2027-03-22.
    expect(turnEndOfEntry(message("user", { id: "itb-0123abcd", origin: "system", content: "The process running this turn exited before the turn finished. Its reply was lost." }))).toEqual({ reason: "crash" })
    expect(turnEndOfEntry(message("user", { id: "itb-0123abcd", origin: "system", content: "The user ended the session before this turn finished, and its unfinished reply was discarded." }))).toEqual({ reason: "discarded" })
  })

  test("converts the Escape records written before interrupt became resumable into a person's resumable interrupt", () => {
    // Remove with the conversion after 2027-03-22.
    const escapeRecord = message("system", { id: "itb-user-k", displayOnly: true, content: LEGACY_USER_INTERRUPT_CONTENT })
    expect(turnEndOfEntry(escapeRecord)).toEqual({ reason: "paused", pausedBy: "person" })
    expect(chatTurnEndOf([message("user"), escapeRecord])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(isResumableTurnEnd(turnEndOfEntry(escapeRecord))).toBe(true)
  })

  test("converts an Escape marker written before it had a turn-end id, by its display-only content", () => {
    // Remove with the conversion after 2027-03-22.
    expect(turnEndOfEntry(message("system", { displayOnly: true, content: LEGACY_USER_INTERRUPT_CONTENT }))).toEqual({ reason: "paused", pausedBy: "person" })
    expect(turnEndOfEntry(message("system", { displayOnly: true, content: "A review notice." }))).toBeUndefined()
    expect(turnEndOfEntry(message("system", { content: LEGACY_USER_INTERRUPT_CONTENT }))).toBeUndefined()
  })

  test("the interrupt record states who interrupted the turn, that a tool call was cut only when one was, and never asks to continue", () => {
    expect(interruptedTurnMessage("person", false)).toBe("The user interrupted this turn before it finished.")
    expect(interruptedTurnMessage("runtime", false)).toBe("The runtime interrupted this turn before it finished, at a planned stop.")
    expect(interruptedTurnMessage("close", false)).toBe("The runtime interrupted this turn before it finished, because the user closed the chat.")
    for (const by of ["person", "runtime", "close"] as const) {
      expect(interruptedTurnMessage(by, true)).toBe(`${interruptedTurnMessage(by, false)} A tool call that was running was cut and may have partially executed.`)
      expect(interruptedTurnMessage(by, false)).not.toContain("tool call")
      for (const cut of [true, false]) expect(interruptedTurnMessage(by, cut).toLowerCase()).not.toContain("continue")
    }
  })

  test("a cut tool call is read from the last step's results, past produced input and notices, and never past a turn end", () => {
    const result = (interrupted: boolean): TurnEndEntry => ({ kind: "message", id: "r", message: { kind: "toolResult", content: [], ...(interrupted ? { interrupted: true } : {}) } })
    const record = message("user", { id: turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"), origin: "system" })
    expect(cutRunningToolCall([message("user"), message("assistant"), result(false), result(true)])).toBe(true)
    expect(cutRunningToolCall([message("assistant"), result(true), message("user", { origin: "system" }), message("system"), { kind: "label", id: "l" }])).toBe(true)
    expect(cutRunningToolCall([message("assistant"), result(false)])).toBe(false)
    expect(cutRunningToolCall([message("assistant"), result(true), message("user")])).toBe(false)
    expect(cutRunningToolCall([message("assistant"), result(true), record, message("user", { origin: "system" })])).toBe(false)
    expect(cutRunningToolCall([result(true), message("assistant")])).toBe(false)
    expect(cutRunningToolCall([])).toBe(false)
  })
})

describe("the turn end a branch tail reads", () => {
  const user = () => message("user")
  const paused = () => message("user", { id: turnEndEntryId({ reason: "paused", pausedBy: "person" }, "p"), origin: "system" })
  const crashed = () => message("user", { id: turnEndEntryId({ reason: "crash" }, "c"), origin: "system" })
  const discarded = () => message("user", { id: turnEndEntryId({ reason: "discarded" }, "d"), origin: "system" })
  const notice = () => message("system", { displayOnly: true, content: "A review landed." })

  test("an interrupt or crash record at the tail is resumable; a discard is not", () => {
    expect(chatTurnEndOf([user(), paused()])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(chatTurnEndOf([user(), crashed()])).toEqual({ end: { reason: "crash" }, recorded: true })
    expect(chatTurnEndOf([user(), discarded()])).toEqual({ end: { reason: "discarded" }, recorded: true })
    expect(isResumableTurnEnd({ reason: "paused", pausedBy: "person" })).toBe(true)
    expect(isResumableTurnEnd({ reason: "paused", pausedBy: "runtime" })).toBe(true)
    expect(isResumableTurnEnd({ reason: "crash" })).toBe(true)
    expect(isResumableTurnEnd({ reason: "discarded" })).toBe(false)
    expect(isResumableTurnEnd(undefined)).toBe(false)
  })

  test("an unanswered user message or tool result with no record reads as a crash nobody recorded yet", () => {
    expect(chatTurnEndOf([message("assistant"), user()])).toEqual({ end: { reason: "crash" }, recorded: false })
    expect(chatTurnEndOf([user(), message("user", { origin: "system", content: "A background task finished." })])).toEqual({ end: { reason: "crash" }, recorded: false })
    // A process that died while its tool call ran: recovery closed the call
    // with an interrupted result, and no answer or record follows it.
    const cutCall: TurnEndEntry = { kind: "message", id: "r1", message: { kind: "toolResult", interrupted: true } }
    expect(chatTurnEndOf([user(), message("assistant"), cutCall])).toEqual({ end: { reason: "crash" }, recorded: false })
  })

  test("only a successful result matched to its handoff answers the turn, not later input", () => {
    const call: TurnEndEntry = { kind: "message", id: "assistant", message: { kind: "assistant", content: [{ type: "tool_use", id: "handoff-1", name: "handoff", input: { summary: "done" } }] } }
    const unanswered = { end: { reason: "crash" }, recorded: false } as const
    for (const outcome of TOOL_OUTCOME_VALUES) {
      const result: TurnEndEntry = { kind: "message", id: "result", message: toolResultMessages([{ toolUseId: "handoff-1", content: [], outcome }])[0]! }
      const tail = [user(), call, result]
      expect(chatTurnEndOf(tail)).toEqual(outcome === "ok" ? undefined : unanswered)
      expect(chatTurnEndOf([...tail, user()])).toEqual(unanswered)
      expect(chatTurnEndOf([...tail, message("user", { origin: "system" })])).toEqual(unanswered)
      expect(chatTurnEndOf([user(), call, { ...result, message: { ...result.message!, toolUseId: "other" } }])).toEqual(unanswered)
      expect(chatTurnEndOf([user(), message("assistant"), result])).toEqual(unanswered)
    }
  })

  test.each([true, false])("a successful handoff answers its complete tool batch, handoff first: %s", (handoffFirst) => {
    const handoff = { type: "tool_use" as const, id: "handoff-1", name: "handoff", input: { summary: "done" } }
    const sibling = { type: "tool_use" as const, id: "read-1", name: "read", input: { path: "/scratch/result" } }
    const calls = handoffFirst ? [handoff, sibling] : [sibling, handoff]
    const assistant: TurnEndEntry = { kind: "message", id: "assistant", message: { kind: "assistant", content: calls } }
    const results: TurnEndEntry[] = toolResultMessages(calls.map((call) => ({
      toolUseId: call.id, content: [], outcome: "ok" as const,
    }))).map((result, index) => ({ kind: "message", id: `result-${index}`, message: result }))
    expect(chatTurnEndOf([user(), assistant, ...results])).toBeUndefined()
    expect(chatTurnEndOf([user(), assistant, ...results, user()])).toEqual({ end: { reason: "crash" }, recorded: false })
  })

  test("an answered turn, a compaction, or a moved leaf means nothing waits", () => {
    expect(chatTurnEndOf([user(), message("assistant")])).toBeUndefined()
    expect(chatTurnEndOf([user(), paused(), message("assistant")])).toBeUndefined()
    expect(chatTurnEndOf([user(), paused(), { kind: "compaction", id: "c1" }])).toBeUndefined()
    expect(chatTurnEndOf([user(), paused(), { kind: "leaf", id: "l1" }])).toBeUndefined()
    expect(chatTurnEndOf([])).toBeUndefined()
  })

  test("a turn that waits on a question reads as waiting, not crashed, until its ask has a result", () => {
    const ask: TurnEndEntry = { kind: "message", id: "a1", message: { kind: "assistant", content: [
      { type: "tool_use", id: "ask-1", name: "ask_user" },
      { type: "tool_use", id: "read-1", name: "search" },
    ] } }
    const result = (toolUseId: string): TurnEndEntry => ({ kind: "message", id: `r-${toolUseId}`, message: { kind: "toolResult", toolUseId } })
    expect(chatTurnEndOf([user(), ask])).toBeUndefined()
    expect(chatTurnEndOf([user(), ask, result("read-1"), notice()])).toBeUndefined()
    expect(questionExchangeOf([user(), ask, result("read-1")])).toBe("waiting")
    expect(questionExchangeOf([user(), ask, result("read-1"), result("ask-1")])).toBe("settled")
    expect(questionExchangeOf([user(), message("assistant"), result("read-1")])).toBeUndefined()
    expect(chatTurnEndOf([user(), ask, result("read-1"), result("ask-1")])).toEqual({ end: { reason: "crash" }, recorded: false })
  })

  test("notices and labels after the record do not hide it", () => {
    expect(chatTurnEndOf([user(), paused(), notice(), { kind: "label", id: "n1" }, { kind: "session_info", id: "s1" }])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
  })

  test("a notification or a Resume's continuation after an interrupt or an unexpected exit does not hide it: the session still waits for the person", () => {
    const produced = () => message("user", { origin: "system", content: "A background task finished." })
    expect(chatTurnEndOf([user(), paused(), produced()])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(chatTurnEndOf([user(), paused(), produced(), notice(), produced()])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(chatTurnEndOf([user(), crashed(), produced()])).toEqual({ end: { reason: "crash" }, recorded: true })
    // A message from another session is produced input too: a child's question
    // that lands just after an Escape leaves the interrupt to Resume.
    const fromSession: TurnEndEntry = { kind: "message", id: "from-child", message: { kind: "user", producer: { kind: "session" }, content: "Which color?" } }
    expect(chatTurnEndOf([user(), paused(), fromSession])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    // After any other end, a produced message is still an unanswered turn.
    expect(chatTurnEndOf([user(), discarded(), produced()])).toEqual({ end: { reason: "crash" }, recorded: false })
    expect(chatTurnEndOf([message("assistant"), produced()])).toEqual({ end: { reason: "crash" }, recorded: false })
    expect(chatTurnEndOf([produced()])).toEqual({ end: { reason: "crash" }, recorded: false })
  })

  test("only a recorded interrupt or unexpected exit waits for the person; an idle tail that a notification follows does not", () => {
    const produced = () => message("user", { origin: "system", content: "A background task finished." })
    expect(waitsForPerson(chatTurnEndOf([user(), paused(), produced()]))).toBe(true)
    expect(waitsForPerson(chatTurnEndOf([user(), crashed(), produced()]))).toBe(true)
    expect(waitsForPerson(chatTurnEndOf([message("assistant"), produced()]))).toBe(false)
    expect(waitsForPerson(chatTurnEndOf([produced()]))).toBe(false)
    expect(waitsForPerson(chatTurnEndOf([user(), discarded(), produced()]))).toBe(false)
    expect(waitsForPerson(undefined)).toBe(false)
  })

  test("a turn that the runtime or an unexpected exit cut while it waited on background work still waits on that work, not on the person", () => {
    const runtimeCut = () => message("user", { id: turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, `r${seq}`), origin: "system" })
    const call = (name: string, input: { readonly [key: string]: unknown } = {}, registrationId?: string): TurnEndEntry => ({ kind: "message", id: `a-${name}`, message: { kind: "assistant", content: [{ type: "tool_use", id: `${name}-1`, name, input, ...(registrationId === undefined ? {} : { registrationId }) }] } })
    const result = (interrupted = false): TurnEndEntry => ({ kind: "message", id: "r-1", message: { kind: "toolResult", toolUseId: "t-1", ...(interrupted ? { interrupted: true } : {}) } })
    const waitCall = () => call("process", { action: "wait" })
    const notification = () => message("user", { origin: "system", content: "A background task finished." })
    // A wait call's batch finished, or the turn answered, and the park waited on background work.
    for (const end of [runtimeCut, crashed]) {
      expect(waitsForPerson(chatTurnEndOf([user(), waitCall(), result(), end()]))).toBe(false)
      expect(waitsForPerson(chatTurnEndOf([user(), message("assistant"), end(), notification()]))).toBe(false)
      // The cut came mid-request: the turn owed the model a request.
      expect(waitsForPerson(chatTurnEndOf([user(), end()]))).toBe(true)
      expect(waitsForPerson(chatTurnEndOf([user(), call("search"), result(), end()]))).toBe(true)
      expect(waitsForPerson(chatTurnEndOf([user(), waitCall(), result(true), end()]))).toBe(true)
      // The call's registration names its contract: a named native wait parked, and a recorded named wait of the retired gpt-6-luna process registration returned, so the turn owed a request.
      expect(waitsForPerson(chatTurnEndOf([user(), call("process", { action: "wait", process_id: "p1" }, "process.native"), result(), end()]))).toBe(false)
      expect(waitsForPerson(chatTurnEndOf([user(), call("process", { action: "wait", process_id: "p1" }, "process.luna"), result(), end()]))).toBe(true)
      expect(waitsForPerson(chatTurnEndOf([user(), call("process", { action: "wait" }, "process.luna"), result(), end()]))).toBe(false)
    }
    // A person's interrupt of the same wait, or Close chat's, waits for the
    // person, also once the killed work's notice lands (PI-INTERACTION-043).
    const closedCut = () => message("user", { id: turnEndEntryId(interruptedTurnEnd("close"), `c${seq}`), origin: "system" })
    for (const end of [paused, closedCut]) {
      expect(waitsForPerson(chatTurnEndOf([user(), waitCall(), result(), end()]))).toBe(true)
      expect(waitsForPerson(chatTurnEndOf([user(), waitCall(), result(), end(), notification()]))).toBe(true)
      expect(waitsForPerson(chatTurnEndOf([user(), message("assistant"), end()]))).toBe(true)
    }
  })

  test("a newer human message after a record is the turn that waits, not the record", () => {
    expect(chatTurnEndOf([user(), paused(), message("user")])).toEqual({ end: { reason: "crash" }, recorded: false })
  })

  test("a settled record closes only the exchange the runtime answered: a turn older than it that still waits is the tail's turn end", () => {
    const settledEnd = { end: { reason: "settled" }, recorded: true } as const
    const unanswered = { end: { reason: "crash" }, recorded: false } as const
    const settled = () => message("user", { id: turnEndEntryId({ reason: "settled" }, `operation-${seq}`), origin: "system", content: "The qa workflow could not start: required skills are missing" })
    const toolUse = (name = "search"): TurnEndEntry => ({ kind: "message", id: `a-${name}`, message: { kind: "assistant", content: [{ type: "tool_use", id: `${name}-1`, name }] } })
    const result = (name = "search", interrupted = false): TurnEndEntry => ({ kind: "message", id: `r-${name}`, message: { kind: "toolResult", toolUseId: `${name}-1`, ...(interrupted ? { interrupted: true } : {}) } })
    // A save point released it between a tool result and the model's answer
    // to that result. A process that died there still owes the answer.
    const midTurn = [user(), toolUse(), result(), settled()]
    expect(chatTurnEndOf(midTurn)).toEqual(unanswered)
    expect(endsAtTurnEnd(midTurn)).toBe(false)
    expect(chatTurnEndOf([message("assistant"), user(), settled()])).toEqual(unanswered)
    // An interrupt older than it stays resumable (PI-INTERACTION-043).
    expect(chatTurnEndOf([user(), paused(), settled()])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(chatTurnEndOf([user(), paused(), message("user", { origin: "system" }), settled()])).toEqual({ end: { reason: "paused", pausedBy: "person" }, recorded: true })
    expect(endsAtTurnEnd([user(), paused(), settled(), notice()])).toBe(true)
    // A question older than it still waits for the person.
    expect(questionExchangeOf([user(), toolUse("ask_user"), settled()])).toBe("waiting")
    expect(chatTurnEndOf([user(), toolUse("ask_user"), settled()])).toBeUndefined()
    // A cut call older than it is still the cut the interrupt record names.
    expect(cutRunningToolCall([toolUse(), result("search", true), settled()])).toBe(true)
    // A Resume that continued the runtime's interrupt before it still counts.
    const runtimeInterrupt = message("user", { id: turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, "r"), origin: "system" })
    const resumed = message("user", { origin: "system", content: CONTINUATION_MESSAGES.resumed })
    expect(waitsAtRuntimeInterrupt([user(), runtimeInterrupt, resumed, settled()])).toBe(false)
    expect(waitsAtRuntimeInterrupt([user(), runtimeInterrupt, settled()])).toBe(true)
    // When nothing older waits, the newest settled record is the turn end.
    expect(chatTurnEndOf([user(), message("assistant"), settled(), settled()])).toEqual(settledEnd)
    expect(chatTurnEndOf([settled()])).toEqual(settledEnd)
    expect(chatTurnEndOf([user(), paused(), message("assistant"), settled()])).toEqual(settledEnd)
    expect(chatTurnEndOf([user(), paused(), { kind: "compaction", id: "c1" }, settled()])).toEqual(settledEnd)
    // Input produced after it is unanswered, as after any answer.
    expect(chatTurnEndOf([message("assistant"), settled(), message("user", { origin: "system" })])).toEqual(unanswered)
  })

  test("a reset while the turn waits for the person carries a copy of its record, which the tail readers find past the reset and the context it starts", () => {
    const crash = { reason: "crash" } as const
    const record = message("user", { id: turnEndEntryId(crash, "k"), origin: "system", content: "The process running this turn exited before the turn finished." })
    const settled = message("user", { id: turnEndEntryId({ reason: "settled" }, "operation-1"), origin: "system" })
    // The compaction's checkpoint exchange follows the record.
    const checkpoint = [message("user", { origin: "system", content: "Save one concise checkpoint" }), message("assistant")]
    const carried = carriedTurnEndRecord([message("user", { origin: "human" }), record, settled, ...checkpoint])
    expect(carried?.message).toEqual({ kind: "user", content: "The process running this turn exited before the turn finished.", origin: "system" })
    expect(carried?.id).not.toBe(record.id)
    const copy: TurnEndEntry = { kind: "message", id: carried!.id, message: carried!.message }
    expect(turnEndOfEntry(copy)).toEqual(crash)
    expect(chatTurnEndOf([record, ...checkpoint, { kind: "compaction", id: "c1" }, copy, message("user", { origin: "system", content: "A fresh context window has started" })])).toEqual({ end: crash, recorded: true })
    // A planned cut keeps its reason; a legacy Escape marker carries as a person's interrupt.
    const planned = interruptedTurnEnd("replacement")
    expect(turnEndOfEntry({ kind: "message", id: carriedTurnEndRecord([message("user", { id: turnEndEntryId(planned, "p"), origin: "system" })])!.id, message: { kind: "user" } })).toEqual(planned)
    expect(turnEndOfEntry({ kind: "message", id: carriedTurnEndRecord([message("system", { displayOnly: true, content: LEGACY_USER_INTERRUPT_CONTENT })])!.id, message: { kind: "user" } })).toEqual({ reason: "paused", pausedBy: "person" })
    // Nothing waits behind a record that is not resumable, a person's
    // message, or an older reset.
    expect(carriedTurnEndRecord([message("user", { id: turnEndEntryId({ reason: "discarded" }, "d"), origin: "system" }), ...checkpoint])).toBeUndefined()
    expect(carriedTurnEndRecord([record, message("user", { origin: "human" }), message("assistant"), ...checkpoint])).toBeUndefined()
    expect(carriedTurnEndRecord([record, { kind: "compaction", id: "c0" }, ...checkpoint])).toBeUndefined()
    expect(carriedTurnEndRecord(checkpoint)).toBeUndefined()
  })
})
