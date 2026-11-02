import { strict as assert } from "node:assert"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { RoleAssignmentView } from "../../../src/protocol/role-protocol-types.js"
import { createSessionReading } from "./session-reading.js"

async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

test("a mounted session reading reacts only to its subscribed session", async () => {
  const harness = createRoot((dispose) => {
    // The id derives from a state that republishes as a fresh object, as the
    // client's view state does on every change.
    const [state, setState] = createSignal<{ readonly sessionId: string | undefined }>({ sessionId: "child-1" })
    const listeners = new Map<string, (view: RoleAssignmentView | undefined) => void>()
    let subscriptions = 0
    const current = createSessionReading<RoleAssignmentView>(() => state().sessionId, {
      get: () => undefined,
      subscribe(id, listener) {
        subscriptions += 1
        listeners.set(id, listener)
        return () => { listeners.delete(id) }
      },
    })
    return { current, setSessionId: (sessionId: string) => setState({ sessionId }), listeners, subscriptions: () => subscriptions, dispose }
  })

  await settle()
  assert.equal(harness.current(), undefined)
  harness.listeners.get("child-1")?.({ assignments: { chat: { model: "gpt-6-astra", effort: "medium" } } })
  assert.equal(harness.current()?.assignments.chat?.effort, "medium")

  // A publish that keeps the session keeps its subscription and its reading.
  harness.setSessionId("child-1")
  await settle()
  assert.equal(harness.subscriptions(), 1)
  assert.equal(harness.current()?.assignments.chat?.effort, "medium")

  harness.setSessionId("child-2")
  await settle()
  assert.equal(harness.listeners.has("child-1"), false)
  harness.listeners.get("child-2")?.({ assignments: { chat: { model: "claude-opus-4-6", effort: "high" } } })
  assert.equal(harness.current()?.assignments.chat?.model, "claude-opus-4-6")
  harness.dispose()
  assert.equal(harness.listeners.size, 0)
})
