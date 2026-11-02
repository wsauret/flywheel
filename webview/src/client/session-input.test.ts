import assert from "node:assert/strict"
import { test } from "node:test"

import type { ChildSessionRow, FrontendMutation, MutationResult } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createSessionInput } from "./session-input.js"
import type { HoldOutcome } from "../../../src/protocol/client/held-session-details.js"
import { CONNECTED_PROVIDER, fakeConnection, settle, type Provider } from "./session-connection-fixture.js"
import { createClientActions } from "./actions.js"
import { createRuntimeSession } from "./session.js"
import { detailView } from "../../../tests/helpers/runtime-views.js"
import { runtimeDispatch, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

/** A control that cannot act says why, instead of a tap that does nothing. */
test("Interrupt and Resume say why when no session is open or its row has not loaded", async () => {
  const opened: string[] = []
  const input = createSessionInput({
    connection: fakeConnection([]),
    selected: () => opened.at(-1),
    row: () => undefined,
    refreshStatus: async () => {},
    hold: async () => ({ kind: "held" }),
    newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })

  await assert.rejects(input.interrupt(), /No session is open to interrupt/)
  await assert.rejects(input.resume(), /No session is open to resume/)
  opened.push("child-1")
  await assert.rejects(input.interrupt(), /details have not loaded yet, so Flywheel cannot interrupt it/)
  await assert.rejects(input.resume(), /details have not loaded yet, so Flywheel cannot resume it/)
})

/** A connection that records what it dispatches and answers each detail
 *  read with the child's row. */
function deliveryConnection(providers: readonly Provider[] = []) {
  const dispatched: FrontendMutation[] = []
  const detailReads: string[] = []
  const plainReads: string[] = []
  const base = fakeConnection(providers)
  const query = runtimeQuery({
    sessionDetail: async (request) => {
      plainReads.push(request.sessionId)
      return { view: detailView({ ...CHILD, id: request.sessionId }) }
    },
    sessionDetailSnapshot: async (request) => {
      detailReads.push(...request.sessionIds)
      return { snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: detailView({ ...CHILD, id: sessionId }) })) }
    },
  }, base.query)
  const connection: RuntimeConnection = { ...base, query, dispatch: accepting(dispatched) }
  return { connection, dispatched, detailReads, plainReads }
}

/** A dispatch that records each message, interrupt, and resume in
 *  `dispatched` and accepts it. */
function accepting(dispatched: FrontendMutation[]): RuntimeConnection["dispatch"] {
  const accept = async (command: FrontendMutation) => {
    dispatched.push(command)
    return { ok: true as const }
  }
  return runtimeDispatch({ "session.send": accept, "chat.interrupt": accept, "chat.resume": accept })
}

/** A dispatch that refuses every message with `refusal` and accepts the
 *  release of a held detail that disposal sends. */
function refusingSends(refusal: MutationResult<Extract<FrontendMutation, { type: "session.send" }>>): RuntimeConnection["dispatch"] {
  return runtimeDispatch({ "session.send": async () => refusal, "session_detail.release": async () => ({ ok: true }) })
}

/** The text a `session.send` command carries, or nothing for any other command. */
const sentText = (command: FrontendMutation | undefined): string | undefined =>
  command?.type !== "session.send" ? undefined : typeof command.input === "string" ? command.input : command.input.text

const sessionIdOf = (command: FrontendMutation | undefined): string | undefined =>
  command !== undefined && "sessionId" in command ? command.sessionId : undefined

const CHILD: ChildSessionRow = {
  id: "child", kind: "subagent", title: "Child", lifecycleState: "active", notices: [], lastUpdated: "2026-01-01T00:00:00.000Z",
  executionCwd: "/project", inputMode: { kind: "message" }, admittedActions: ["session.send"], totalsLoading: true,
}
const MEMBER: ChildSessionRow = {
  id: "member-json", kind: "workflow-agent", title: "json", lifecycleState: "active", notices: [], lastUpdated: "2026-01-01T00:00:00.000Z",
  executionCwd: "/project", inputMode: { kind: "message" }, workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt-json" },
  admittedActions: ["session.send", "chat.interrupt", "chat.resume"], totalsLoading: true,
}

test("the first message to a created chat goes to it at once, without a read of its detail", async () => {
  const { connection, dispatched } = deliveryConnection()
  const holds: string[] = []
  const input = createSessionInput({
    connection, selected: () => undefined, row: () => undefined, refreshStatus: async () => {},
    hold: async (id) => { holds.push(id); return { kind: "missing" } },
    newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  await input.send("hello")
  assert.deepEqual(dispatched.map((command) => ({ type: command.type, sessionId: sessionIdOf(command) })), [{ type: "session.send", sessionId: "created" }])
  assert.deepEqual(holds, [])
})

test("messages to one session go out in the order they were sent, though the first waits for the session's detail", async () => {
  const { connection, dispatched } = deliveryConnection()
  const detail = Promise.withResolvers<HoldOutcome>()
  let known = false
  const input = createSessionInput({
    connection, selected: () => "child", row: () => (known ? CHILD : undefined), refreshStatus: async () => {},
    hold: () => detail.promise, newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  const first = input.send("first")
  // The session's row arrives by another way before the first read answers.
  known = true
  const second = input.send("second")
  detail.resolve({ kind: "held" })
  await Promise.all([first, second])
  assert.deepEqual(dispatched.map(sentText), ["first", "second"])
})

test("a message to a session the pane has left reads its admission once and keeps no reading of it", async () => {
  const { connection, dispatched, detailReads, plainReads } = deliveryConnection()
  const holds: string[] = []
  const input = createSessionInput({
    connection, selected: () => "child", row: () => undefined, refreshStatus: async () => {},
    // The pane moved on while the detail read, so its hold was released.
    hold: async (id) => { holds.push(id); return { kind: "released" } },
    newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  await input.send("focus on tests")
  assert.deepEqual(holds, ["child"])
  // A plain detail read, which the runtime holds nothing for.
  assert.deepEqual(detailReads, [])
  assert.deepEqual(plainReads, ["child"])
  assert.deepEqual(dispatched.map((command) => ({ type: command.type, sessionId: sessionIdOf(command) })), [{ type: "session.send", sessionId: "child" }])
})

test("an agent view sends only to its actual member session and reports a refusal", async () => {
  const { connection, dispatched } = deliveryConnection()
  const input = createSessionInput({
    connection, selected: () => "member-json", row: () => MEMBER, refreshStatus: async () => {},
    hold: async () => ({ kind: "held" }), newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  await input.send(" Keep the old flag names. ")
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0]?.type, "session.send")
  assert.equal(sessionIdOf(dispatched[0]), "member-json")
  assert.equal(sentText(dispatched[0]), "Keep the old flag names.")
  assert.ok(dispatched.every(command => !("targets" in command)))
  const refused = createSessionInput({
    connection: { ...connection, dispatch: refusingSends({ ok: false, error: "\"json\" has finished and reads no more messages." }) }, selected: () => "member-json", row: () => MEMBER, refreshStatus: async () => {},
    hold: async () => ({ kind: "held" }), newChat: async () => "created", created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  await assert.rejects(refused.send("Again."), /has finished/)
})

test("handoff refusal returns false with one warning and no failed-delivery row", async () => {
  const warning = "This agent has started its handoff and cannot read another message. Your draft was kept."
  const delivery = deliveryConnection([CONNECTED_PROVIDER])
  const connection: RuntimeConnection = { ...delivery.connection, dispatch: refusingSends({ ok: false, kind: "handing_off", error: warning }) }
  const session = createRuntimeSession({ connection, initialSessionId: "child" })
  await settle()
  const reports: { severity: string; message: string }[] = []
  const actions = createClientActions({
    session, connection, capabilities: {},
    report: (severity, message) => { reports.push({ severity, message }) }, captureSurfaceOpener: () => () => {},
  })
  try {
    assert.equal(session.sessionId, "child")
    assert.equal(await actions.send("late guidance"), false)
    assert.deepEqual(reports, [{ severity: "warning", message: warning }])
    assert.deepEqual(session.localSubmissions, [])
    assert.equal(session.recallLocal(), undefined)
  } finally { actions.dispose(); session.dispose() }
})

test("a refused skip, answer, or other control on the open session reaches the action boundary with the runtime's words", async () => {
  const refuse = (error: string) => async () => ({ ok: false as const, error })
  const connection: RuntimeConnection = {
    ...deliveryConnection([CONNECTED_PROVIDER]).connection,
    dispatch: runtimeDispatch({
      "question.cancel": refuse("This question was already answered."),
      "question.answer": refuse("This question was already skipped."),
      "chat.compact": refuse("No active context to compact yet"),
      "session_detail.release": async () => ({ ok: true }),
    }),
  }
  const session = createRuntimeSession({ connection, initialSessionId: "child" })
  await settle()
  const reports: string[] = []
  const actions = createClientActions({
    session, connection, capabilities: {},
    report: (_severity, message) => { reports.push(message) }, captureSurfaceOpener: () => () => {},
  })
  try {
    actions.cancelQuestion("ask-1")
    actions.answer("ask-1", { "Pace?": { kind: "freeform", text: "Fast" } })
    actions.compact()
    await settle()
    assert.deepEqual(reports, [
      "Flywheel could not complete that action: This question was already answered.",
      "Flywheel could not complete that action: This question was already skipped.",
      "Flywheel could not complete that action: No active context to compact yet",
    ])
  } finally { actions.dispose(); session.dispose() }
})

test("a member's ordinary controls address only that member", async () => {
  const dispatched: FrontendMutation[] = []
  const connection: RuntimeConnection = { ...fakeConnection([]), dispatch: accepting(dispatched) }
  const input = createSessionInput({
    connection, selected: () => "member", row: () => ({ ...MEMBER, id: "member" }),
    refreshStatus: () => {}, hold: async () => ({ kind: "held" }), newChat: async () => "created",
    created: () => false, position: () => undefined, providerSetup: () => "usable", providerSetupKnown: async () => {},
  })
  await input.interrupt()
  await input.resume()
  assert.deepEqual(dispatched, [
    { type: "chat.interrupt", sessionId: "member" },
    { type: "chat.resume", sessionId: "member" },
  ])
})
