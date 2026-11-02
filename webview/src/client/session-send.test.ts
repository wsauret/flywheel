import assert from "node:assert/strict"
import { test } from "node:test"

import { createRuntimeSession } from "./session.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import { CONNECTED_PROVIDER, settle } from "./session-connection-fixture.js"
import { selectionConnection, waitForSelection } from "./session-selection-fixture.js"
import { RuntimeLaneLost } from "../../../src/protocol/client/connection-failures.js"
import { WAITING_RECALL } from "../../../src/protocol/client/chat-submissions.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

test("a refused message to a workflow agent rejects and keeps the words to be recalled", async () => {
  const connection = selectionConnection([], "Invocation budget exhausted (1/1)")
  const session = createRuntimeSession({ connection, initialSessionId: "cold-workflow" })
  await waitForSelection(session, "cold-workflow")
  await assert.rejects(session.send("continue"), /Invocation budget exhausted \(1\/1\)/)
  assert.deepEqual(session.localSubmissions[0]?.delivery, { kind: "failed", error: "Invocation budget exhausted (1/1)" })
  assert.deepEqual(session.recallLocal(), { kind: "input", input: { text: "continue" } })
  assert.deepEqual(session.localSubmissions, [])
  session.dispose()
})

test("a sent message shows at once and the runtime's own message replaces it", async () => {
  const base = selectionConnection()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const window = { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 0 }
  const query = runtimeQuery({
    outputWindow: async () => ({ snapshotPosition: 0, totalBlocks: 1, visibleMessageCount: 1, range: {
      kind: "ok", consistencyToken: "fixture", anchor: { kind: "tail" }, streamingToolText: {}, streamingOutputChars: 0,
      blocks: [{ kind: "text", id: "earlier", content: "Earlier answer", timestamp: 0 }], window,
    } }),
  }, base.query)
  const connection: RuntimeConnection = {
    ...base, query,
    subscribe(listener) { listeners.add(listener); const stop = base.subscribe(listener); return () => { listeners.delete(listener); stop() } },
  }
  const session = createRuntimeSession({ connection })
  try {
    await settle()
    await session.select("cold-chat")
    await settle()
    let changes = 0
    const stop = session.onChange(() => { changes += 1 })
    const sending = session.send("hello")
    const [entry] = session.localSubmissions
    assert.equal(entry?.input.text, "hello")
    assert.ok(changes > 0, "the entry tells the view in the same call")
    stop()
    await sending
    assert.equal(session.localSubmissions.length, 1, "a resolved dispatch does not prove the transcript holds the message")
    for (const listener of listeners) listener({ type: "patch", patch: {
      cursor: { scope: "session", domain: "output", sessionId: "cold-chat" }, position: 1, prevPosition: 0,
      payload: { kind: "output.delta", delta: { visibleMessageCount: 2, blocks: [{
        kind: "upsert", index: 1, blockId: "userMessage:server",
        block: { kind: "userMessage", id: "server", content: "hello", timestamp: 0, pending: false, injected: false, submissionIds: [entry!.id] },
      }] } },
    } })
    await settle()
    assert.deepEqual(session.localSubmissions, [])
    assert.deepEqual(session.transcript?.view.blocks.map(block => block.kind), ["text", "userMessage"])
  } finally { session.dispose() }
})

test("nested child selection retains its root runner and sends every message as session.send", async () => {
  const connection = selectionConnection()
  const session = createRuntimeSession({ connection })
  await settle()
  connection.clearDispatched()

  await session.select("cold-workflow")
  // The member keeps the same root served without claiming a child runner.
  assert.deepEqual(connection.dispatched, [])
  await session.send("check the tests")
  // The words show at once as a local entry, and its identity rides with the
  // input so the runtime's message can replace it.
  assert.deepEqual(connection.dispatched, [{ type: "session.send", sessionId: "cold-workflow", input: { text: "check the tests", submissionIds: [session.localSubmissions[0]?.id] } }])
  // One interrupt for every kind: the open session's kind names the mutation.
  connection.clearDispatched()
  await session.interrupt()
  assert.deepEqual(connection.dispatched, [{ type: "chat.interrupt", sessionId: "cold-workflow" }])
  connection.clearDispatched()
  await assert.rejects(session.stop("cold-workflow"), /cannot be stopped/)
  assert.deepEqual(connection.dispatched, [])
  connection.publishStatus("cold-workflow", "idle")
  await settle()
  connection.clearDispatched()
  await assert.rejects(session.send("follow up"), /read-only/)
  assert.deepEqual(connection.dispatched, [])

  connection.clearDispatched()
  await session.select("cold-chat")
  // The chat's runner is already held, and the member the person left
  // stays resident, so its detail stays held for the return.
  assert.deepEqual(connection.dispatched, [])
  connection.clearDispatched()
  await session.send("hello")
  assert.deepEqual(connection.dispatched, [{ type: "session.send", sessionId: "cold-chat", input: { text: "hello", submissionIds: [session.localSubmissions[0]?.id] } }])
  connection.clearDispatched()
  await session.interrupt()
  assert.deepEqual(connection.dispatched, [{ type: "chat.interrupt", sessionId: "cold-chat" }])

  connection.clearDispatched()
  await session.select("cold-subagent")
  assert.deepEqual(session.sessions.map(({ id }) => id), ["cold-chat"])
  assert.deepEqual(session.children.map(({ id }) => id).sort(), ["cold-subagent", "cold-workflow"])
  assert.equal(session.executionCwd, "/workspace")
  await session.send("change course")
  assert.deepEqual(connection.dispatched, [{ type: "session.send", sessionId: "cold-subagent", input: { text: "change course", submissionIds: [session.localSubmissions[0]?.id] } }])
  connection.clearDispatched()
  await session.stop("cold-subagent")
  assert.deepEqual(connection.dispatched, [{ type: "background.terminate", sessionId: "cold-workflow", toolUseId: "subagent-tool" }])

  // Admission comes from ordered detail replacements, not status-edge reads.
  const beforeReads = connection.detailReads.length
  connection.publishStatus("cold-subagent", "executing_tools")
  await settle()
  assert.equal(connection.detailReads.length, beforeReads)
  connection.publishStatus("cold-subagent", "idle")
  await settle()
  assert.equal(connection.detailReads.length, beforeReads)
  assert.deepEqual(session.children.find(row => row.id === "cold-subagent")?.admittedActions, ["session.delete"])

  connection.clearDispatched()
  await session.remove("cold-subagent")
  assert.equal(session.sessionId, "cold-workflow")
  assert.deepEqual(session.children.map(row => row.id), ["cold-workflow"])
  // Returning to the parent member does not change the root serving claim;
  // the deleted subagent's detail is let go.
  assert.deepEqual(connection.dispatched, [{ type: "session.delete", sessionId: "cold-subagent" }, { type: "session_detail.release", sessionId: "cold-subagent" }])

  // A link to a session the runtime no longer has opens a pane that says so.
  await session.select("cold-subagent")
  assert.equal(session.sessionId, "cold-subagent")
  assert.equal(session.opening?.failure, "Flywheel could not find this session.")
  session.dispose()
})

test("a message sent with no model provider set up starts no chat and keeps the words to be recalled", async () => {
  const base = selectionConnection([], undefined, undefined, [{ ...CONNECTED_PROVIDER, source: "unconfigured" }])
  const session = createRuntimeSession({ connection: base })
  try {
    await settle()
    base.clearDispatched()
    await assert.rejects(session.send("hello"), /No model provider is ready/)
    assert.deepEqual(base.dispatched.filter((command) => command.type === "session.send" || command.type === "chat.open"), [])
    assert.equal(session.localSubmissions[0]?.delivery.kind, "failed")
    assert.deepEqual(session.recallLocal(), { kind: "input", input: { text: "hello" } })
  } finally { session.dispose() }
})

test("a message lost with its lane stays queued with no error, goes out again on the next lane with its identity, and Up says why it waits", async () => {
  const base = selectionConnection()
  const lanes = fakeLanes()
  let lost = true
  const sends: unknown[] = []
  const connection: RuntimeConnection = {
    ...base,
    ...lanes.client,
    async dispatch(command) {
      if (command.type === "session.send") {
        sends.push(command.input)
        if (lost) throw new RuntimeLaneLost(new Error("the lane the call ran on ended"))
      }
      return base.dispatch(command)
    },
  }
  const session = createRuntimeSession({ connection })
  try {
    await settle()
    await session.select("cold-chat")
    await settle()
    await session.send("hello")
    assert.deepEqual(session.localSubmissions.map((entry) => entry.delivery), [{ kind: "waiting" }])
    assert.deepEqual(session.recallLocal(), { kind: "waiting", notice: WAITING_RECALL })
    assert.equal(session.localSubmissions.length, 1)
    lost = false
    lanes.open()
    await settle()
    assert.equal(sends.length, 2)
    assert.deepEqual(sends[1], sends[0])
    assert.equal(session.localSubmissions[0]?.delivery.kind, "accepted")
  } finally { session.dispose() }
})
