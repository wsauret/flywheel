import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { FrontendMutation } from "../../../../../src/protocol/runtime/app-service-types.js"
import { RuntimeLaneLost } from "../../../../../src/protocol/client/runtime/connection-failures.js"
import { fakeLanes } from "../../../../../tests/helpers/fake-lanes.js"
import type { HostAttention } from "../../../host.js"
import { createPresenceReport, documentAttention, followPresence } from "./presence.js"

function connection() {
  const lanes = fakeLanes()
  const sent: FrontendMutation[] = []
  let fail: unknown
  return {
    lanes,
    sent,
    failNext(cause: unknown) { fail = cause },
    client: {
      onLane: lanes.onLane,
      dispatch: async (mutation: FrontendMutation) => {
        sent.push(mutation)
        const cause = fail
        fail = undefined
        if (cause !== undefined) throw cause
        return { ok: true }
      },
    },
  }
}

const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

describe("presence report", () => {
  test("sends a change once, none when the person leaves, and the current chat again on each new lane", async () => {
    const fake = connection()
    const diagnostics: string[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake answers every mutation with the shape the report reads, which is none
    const report = createPresenceReport({ connection: fake.client as never, onDiagnostic: (message) => diagnostics.push(message) })
    report.report("chat-a")
    report.report("chat-a")
    report.report(undefined)
    report.report("chat-b")
    assert.deepEqual(fake.sent, [{ type: "chat.presence", sessionId: "chat-a" }, { type: "chat.presence" }, { type: "chat.presence", sessionId: "chat-b" }])
    fake.lanes.open()
    assert.deepEqual(fake.sent.at(-1), { type: "chat.presence", sessionId: "chat-b" })
    report.report(undefined)
    fake.lanes.open()
    assert.equal(fake.sent.length, 5, "a lane opened while the person is at no chat sends nothing")
    // A report lost with its lane is sent again by the next lane, and says nothing.
    fake.failNext(new RuntimeLaneLost(new Error("lane")))
    report.report("chat-c")
    fake.failNext(new Error("refused"))
    report.report("chat-d")
    await settle()
    assert.deepEqual(diagnostics, ["the chat the person is at could not be reported"])
    report.dispose()
  })
})

describe("document attention", () => {
  function page(visibilityState: DocumentVisibilityState, focused: boolean) {
    const listeners = new Map<string, Set<() => void>>()
    const target = {
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, (listeners.get(type) ?? new Set()).add(listener)) },
      removeEventListener: (type: string, listener: () => void) => { listeners.get(type)?.delete(listener) },
    }
    const state = { visibilityState, focused }
    return {
      state,
      fire: (type: string) => { for (const listener of listeners.get(type) ?? []) listener() },
      listening: () => [...listeners.values()].reduce((count, set) => count + set.size, 0),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake carries only the members that documentAttention reads
      page: { window: target, document: { ...target, get visibilityState() { return state.visibilityState }, hasFocus: () => state.focused } } as never,
    }
  }

  test("a page counts only while it shows and has focus", () => {
    const browser = page("visible", false)
    assert.equal(documentAttention(browser.page).present(), false)
    browser.state.focused = true
    assert.equal(documentAttention(browser.page).present(), true)
    browser.state.visibilityState = "hidden"
    assert.equal(documentAttention(browser.page).present(), false)
  })

  test("follows visibility, focus, and blur until unsubscribed", () => {
    const desktop = page("visible", true)
    let changes = 0
    const stop = documentAttention(desktop.page).onChange(() => { changes += 1 })
    for (const type of ["visibilitychange", "focus", "blur"]) desktop.fire(type)
    assert.equal(changes, 3)
    stop()
    assert.equal(desktop.listening(), 0)
  })
})

describe("followed presence", () => {
  test("reports the selected chat only while nothing covers it and the host says the person is at the client", () => {
    const fake = connection()
    let present = false
    const listeners = new Set<() => void>()
    const attention: HostAttention = { present: () => present, onChange: (listener) => { listeners.add(listener); return () => listeners.delete(listener) } }
    const attend = (next: boolean) => { present = next; for (const listener of listeners) listener() }
    const [shown, setShown] = createSignal<string | undefined>("chat-a")
    const [covered, setCovered] = createSignal(false)
    const dispose = createRoot((disposeRoot) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- the fake answers every mutation with the shape the report reads, which is none
      followPresence({ host: { capabilities: { attention } }, connection: fake.client as never, selected: shown, covered, onDiagnostic: () => {} })
      return disposeRoot
    })
    try {
      // A hidden or unfocused client reports no one, also as the shown chat changes.
      setShown("chat-b")
      assert.deepEqual(fake.sent, [])
      attend(true)
      assert.deepEqual(fake.sent, [{ type: "chat.presence", sessionId: "chat-b" }])
      attend(false)
      assert.deepEqual(fake.sent.at(-1), { type: "chat.presence" })
      attend(true)
      assert.deepEqual(fake.sent.at(-1), { type: "chat.presence", sessionId: "chat-b" })
      // A full workflow card or the phone's list in front hides the chat.
      setCovered(true)
      assert.deepEqual(fake.sent.at(-1), { type: "chat.presence" })
      setCovered(false)
      assert.deepEqual(fake.sent.at(-1), { type: "chat.presence", sessionId: "chat-b" })
      setShown(undefined)
      assert.deepEqual(fake.sent.at(-1), { type: "chat.presence" })
    } finally { dispose() }
    assert.equal(listeners.size, 0)
  })
})
