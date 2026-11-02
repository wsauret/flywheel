import assert from "node:assert/strict"
import { test } from "node:test"

import { Layer } from "effect"
import { Socket } from "effect/unstable/socket"
import { headlessClient } from "./session-host-loader-fixture.js"
import { selectionConnection } from "./session-selection-fixture.js"

test("a host that asks the client to make sure it is connected leaves the lane decision to the connection and never forces a reconnect", async () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")
  const storage = { getItem: () => null, setItem() {}, removeItem() {} }
  Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage })
  const calls: string[] = []
  const connection = Object.assign(selectionConnection(), {
    resume() { calls.push("resume") },
    reconnect() { calls.push("reconnect") },
  })
  headlessClient.setConnection(connection)
  const handle = headlessClient.mountForTest({
    socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    capabilities: {},
  })
  try {
    handle.command({ type: "ensureConnected" })
    assert.deepEqual(calls, [], "commands wait until checkpoint loading finishes")
    await Promise.resolve()
    assert.deepEqual(calls, ["resume"])
  } finally {
    handle.dispose()
    if (previousDocument) Object.defineProperty(globalThis, "document", previousDocument)
    else Reflect.deleteProperty(globalThis, "document")
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage)
    else Reflect.deleteProperty(globalThis, "sessionStorage")
  }
})
