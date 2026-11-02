import assert from "node:assert/strict"
import { test } from "node:test"

import { createRuntimeSession } from "./session.js"
import { settle } from "./session-connection-fixture.js"
import { saveReadingState } from "../../../src/protocol/client/reading-state.js"
import { Socket } from "effect/unstable/socket"
import { Layer } from "effect"
import { headlessClient } from "./session-host-loader-fixture.js"
import { selectionConnection, waitForSelection } from "./session-selection-fixture.js"

test("replacement restores the new-chat surface instead of opening the catalog's default chat", async () => {
  const connection = selectionConnection()
  const session = createRuntimeSession({ connection, initialNewChat: true })
  try {
    await settle()
    connection.publishCatalog()
    await settle()
    assert.equal(session.sessionId, undefined)
    await session.select("cold-chat")
    assert.equal(session.sessionId, "cold-chat")
  } finally { session.dispose() }
})

test("restored workflow-agent selection resolves its root through detail without catalog membership", async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const restored = selectionConnection([], undefined, async id => {
    if (id === "cold-workflow") { entered.resolve(); await gate.promise }
  })
  const session = createRuntimeSession({ connection: restored, initialSessionId: "cold-workflow" })
  await entered.promise
  restored.publishCatalog()
  await settle()
  // The pane is on the address while its detail reads, and shows it opening.
  assert.equal(session.sessionId, "cold-workflow")
  assert.notEqual(session.opening, undefined)
  gate.resolve()
  await settle()
  assert.equal(session.sessionId, "cold-workflow")
  // The saved session opened directly: no other session was opened on the way.
  assert.deepEqual(restored.detailReads, ["cold-workflow", "cold-chat"])
  assert.deepEqual(restored.dispatched, [{ type: "session.activate", sessionId: "cold-chat" }])
  await session.select("cold-chat")
  // The member the pane left stays resident, so its detail stays held and
  // the chat's runner is already held.
  assert.deepEqual(restored.dispatched, [{ type: "session.activate", sessionId: "cold-chat" }])
  session.dispose()

  const gone = selectionConnection()
  const plain = createRuntimeSession({ connection: gone, initialSessionId: "deleted-chat" })
  await waitForSelection(plain, "cold-chat")
  assert.equal(plain.sessionId, "cold-chat")
  plain.dispose()
})

test("host initial selection overrides the reload place and resolves unlisted or missing ids through detail", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  }
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage })
  try {
    for (const requested of ["cold-workflow", "deleted-chat", undefined]) {
      saveReadingState(storage, { sessionId: "cold-subagent", following: true, open: [] })
      const read = Promise.withResolvers<string>()
      const connection = selectionConnection([], undefined, async id => { read.resolve(id) })
      headlessClient.setConnection(connection)
      const host = {
        socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        capabilities: {}, ...(requested === undefined ? {} : { initialSessionId: requested }),
      }
      const handle = headlessClient.mountForTest(host)
      try {
        assert.equal(await read.promise, requested ?? "cold-subagent")
        const expected = requested === undefined ? "cold-subagent" : requested === "deleted-chat" ? "cold-chat" : requested
        await waitForSelection(headlessClient.session, expected)
        assert.equal(headlessClient.session.sessionId, expected)
        assert.deepEqual(headlessClient.session.sessions.map(row => row.id), ["cold-chat"])
        if (requested) assert.equal(connection.detailReads[0], requested)
      } finally {
        handle.dispose()
      }
    }
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else Reflect.deleteProperty(globalThis, "document")
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "sessionStorage")
  }
})

test("explicit selection wins over pending restored detail", async () => {
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  const connection = selectionConnection([], undefined, async id => {
    if (id === "cold-workflow") { entered.resolve(); await gate.promise }
  })
  const session = createRuntimeSession({ connection, initialSessionId: "cold-workflow" })
  await entered.promise
  await session.select("cold-chat")
  gate.resolve()
  await settle()
  assert.equal(session.sessionId, "cold-chat")
  // The restored session stays resident after the pane left it, so the read
  // that answered after the move is kept for a return.
  assert.deepEqual(connection.dispatched, [{ type: "session.activate", sessionId: "cold-chat" }])
  session.dispose()
})
