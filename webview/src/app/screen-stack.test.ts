import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { SessionLink } from "../client/session-navigation.js"
import { createScreenStack, type ScreenStackNavigation, type SwipeRoot } from "./screen-stack.js"
import { createWorkflowNavigation } from "../modules/workflows/navigation.js"
import { plainAgentTree } from "../../../tests/helpers/workflow-view.js"
import type { FrontendAttempt } from "../../../src/protocol/workflow-view-protocol-types.js"

function memoryNavigation() {
  const entries: unknown[] = [null]
  let index = 0
  const listeners = new Set<(event: { readonly state: unknown }) => void>()
  const publish = () => {
    const event = { state: entries[index] }
    for (const listener of listeners) listener(event)
  }
  const navigation: ScreenStackNavigation = {
    get state() { return entries[index] },
    replaceState(state) { entries[index] = state },
    pushState(state) { entries.splice(++index, entries.length, state) },
    back() { if (index > 0) { index -= 1; publish() } },
    forward() { if (index + 1 < entries.length) { index += 1; publish() } },
    addPopStateListener(listener) { listeners.add(listener) },
    removePopStateListener(listener) { listeners.delete(listener) },
  }
  return { navigation, entries: () => [...entries] }
}

class TouchRoot extends EventTarget implements SwipeRoot {
  readonly clientWidth = 400
  readonly selection = { isCollapsed: true }
  readonly ownerDocument = Object.assign(new EventTarget(), { getSelection: () => this.selection })

  touch(type: string, x: number, time: number) {
    const event = new Event(type)
    Object.defineProperties(event, {
      touches: { value: type === "touchend" ? [] : [{ clientX: x, clientY: 100 }] },
      timeStamp: { value: time },
    })
    this.dispatchEvent(event)
  }
}

for (const phase of ["start", "move", "end", "selectionchange"] as const) {
  test(`native selection at ${phase} releases the screen swipe until a new unselected touch`, () => {
    const memory = memoryNavigation()
    const root = new TouchRoot()
    // This event target stands in for the root element, not a scrollable child.
    const elementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Element")
    Object.defineProperty(globalThis, "Element", { value: TouchRoot, configurable: true })
    const mounted = createRoot((dispose) => ({
      dispose,
      stack: createScreenStack(() => undefined, undefined, memory.navigation),
    }))
    const unbind = mounted.stack.bindSwipe(root)
    try {
      mounted.stack.openChat("chat")
      if (phase === "start") root.selection.isCollapsed = false
      root.touch("touchstart", 100, 0)
      if (phase === "start") root.selection.isCollapsed = true
      if (phase === "move") root.selection.isCollapsed = false
      root.touch("touchmove", 180, 100)
      if (phase === "end" || phase === "selectionchange") {
        assert.equal(mounted.stack.dragX(), 80)
        root.selection.isCollapsed = false
        if (phase === "selectionchange") root.ownerDocument.dispatchEvent(new Event("selectionchange"))
      }
      if (phase === "start" || phase === "move" || phase === "selectionchange") {
        assert.equal(mounted.stack.dragX(), undefined)
        root.selection.isCollapsed = true
        root.touch("touchmove", 300, 200)
        assert.equal(mounted.stack.dragX(), undefined)
      }
      root.touch("touchend", 300, 300)
      assert.equal(mounted.stack.screen(), "chat")
      assert.equal(mounted.stack.dragX(), undefined)

      root.selection.isCollapsed = true
      root.touch("touchstart", 100, 400)
      root.touch("touchmove", 300, 500)
      assert.equal(mounted.stack.dragX(), 200)
      root.touch("touchend", 300, 600)
      assert.equal(mounted.stack.screen(), "sessions")
      root.touch("touchstart", 300, 700)
      root.touch("touchmove", 100, 800)
      root.touch("touchend", 100, 900)
      assert.equal(mounted.stack.screen(), "chat")
    } finally {
      unbind()
      mounted.dispose()
      if (elementDescriptor) Object.defineProperty(globalThis, "Element", elementDescriptor)
      else Reflect.deleteProperty(globalThis, "Element")
    }
  })
}

test("Back follows parents rather than the order in which chats were visited", () => {
  const memory = memoryNavigation()
  const selected: string[] = []
  const parents = new Map([["child", "parent"], ["grandchild", "child"]])
  const mounted = createRoot((dispose) => ({
    dispose,
    stack: createScreenStack(
      () => undefined,
      { selectedSessionId: () => selected.at(-1), selectSession: (sessionId) => selected.push(sessionId), parentSessionId: (id) => parents.get(id) },
      memory.navigation,
    ),
  }))
  try {
    mounted.stack.openChat("unrelated")
    mounted.stack.openChat("grandchild")
    mounted.stack.back()
    assert.deepEqual(selected, ["unrelated", "grandchild", "child"])
    assert.equal(mounted.stack.screen(), "chat")
    memory.navigation.back()
    assert.equal(selected.at(-1), "parent")
    mounted.stack.back()
    assert.equal(mounted.stack.screen(), "sessions")
    mounted.stack.forward()
    assert.equal(mounted.stack.screen(), "chat")
    assert.equal(selected.at(-1), "parent")
  } finally {
    mounted.dispose()
  }
})

test("a pop from a level inside the shown chat, such as a workflow's agent view, keeps the chat", () => {
  const memory = memoryNavigation()
  const selected: string[] = []
  const mounted = createRoot((dispose) => ({
    dispose,
    stack: createScreenStack(
      () => undefined,
      { selectedSessionId: () => selected.at(-1), selectSession: (sessionId) => selected.push(sessionId), parentSessionId: (id) => id === "run" ? "chat" : undefined },
      memory.navigation,
    ),
  }))
  try {
    mounted.stack.openChat("run")
    const chatEntry: unknown = memory.navigation.state
    memory.navigation.pushState({ ...(chatEntry instanceof Object ? chatEntry : {}), flywheelWorkflowAgent: { sessionId: "run", nodeId: "agent" } })
    memory.navigation.back()
    assert.equal(mounted.stack.screen(), "chat")
    assert.deepEqual(selected, ["run"])
    // The next Back leaves the chat as before.
    mounted.stack.back()
    assert.deepEqual(selected, ["run", "chat"])
  } finally {
    mounted.dispose()
  }
})

test("an agent that a chat's inline card opened on a phone holds one entry with its workflow, and one Back returns to the chat", () => {
  // The app builds the agent navigation before the module host's stack, so
  // the agent navigation hears the pop first and has moved the selection to
  // the chat before the stack reads it. Both orders return to the chat.
  for (const agentsFirst of [false, true]) {
    const memory = memoryNavigation()
    const [selected, setSelected] = createSignal<readonly string[]>([])
    const mounted = createRoot((dispose) => {
      const attempts: readonly FrontendAttempt[] = [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", sessionId: "member", history: [] }]
      const createStack = () => createScreenStack(
        () => undefined,
        { selectedSessionId: () => selected().at(-1), selectSession: (sessionId) => setSelected((current) => [...current, sessionId]), parentSessionId: (id) => id === "run" ? "chat" : undefined },
        memory.navigation,
      )
      let stack = agentsFirst ? undefined : createStack()
      const agents = createWorkflowNavigation({
        reading: () => ({ detail: undefined, view: { attemptsStatus: "loaded", state: "running", attempts, tree: plainAgentTree(attempts) }, live: [] }),
        selected: () => selected().at(-1),
        select: sessionId => setSelected(current => [...current, sessionId]),
      }, memory.navigation)
      stack ??= createStack()
      return { dispose, stack, agents }
    })
    try {
      mounted.stack.openChat("chat")
      const before = memory.entries().length
      // The inline card's agent line selects the workflow in the chat's entry,
      // then pushes the agent's entry over it.
      mounted.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: true }, "chat")
      assert.equal(memory.entries().length, before + 1)
      const place = mounted.agents.place()
      assert.ok(place?.kind === "agent" && place.origin === "chat")
      mounted.stack.back()
      assert.equal(mounted.stack.screen(), "chat", `agents first: ${agentsFirst}`)
      assert.equal(mounted.agents.place(), undefined)
      assert.deepEqual(selected(), ["chat", "member", "chat"])
      assert.equal(memory.entries().length, before + 1, "the chat's entry replaced the workflow's, and the agent's waits forward")
      assert.deepEqual(memory.entries()[before - 1], { flywheelScreen: "chat", flywheelSession: "chat" })
    } finally {
      mounted.dispose()
    }
  }
})

test("Sessions from a level inside the shown chat goes to the list, and the next Back does not reopen a parent", () => {
  const memory = memoryNavigation()
  const selected: string[] = []
  const mounted = createRoot((dispose) => ({
    dispose,
    stack: createScreenStack(
      () => undefined,
      { selectedSessionId: () => selected.at(-1), selectSession: (sessionId) => selected.push(sessionId), parentSessionId: (id) => id === "run" ? "chat" : undefined },
      memory.navigation,
    ),
  }))
  try {
    mounted.stack.openChat("run")
    const chatEntry: unknown = memory.navigation.state
    memory.navigation.pushState({ ...(chatEntry instanceof Object ? chatEntry : {}), flywheelWorkflowAgent: { sessionId: "run", nodeId: "agent" } })
    mounted.stack.showSessions()
    assert.equal(mounted.stack.screen(), "sessions")
    assert.deepEqual(selected, ["run"])
    mounted.stack.openChat("other")
    mounted.stack.back()
    assert.equal(mounted.stack.screen(), "sessions")
    assert.deepEqual(selected, ["run", "other"])
  } finally {
    mounted.dispose()
  }
})

test("a page that loads on an address opens on its session over the list, and Back from a workflow returns to its chat", () => {
  for (const [addressed, parent] of [["chat", undefined], ["run", "chat"]] as const) {
    const memory = memoryNavigation()
    // The session owner opens the address itself; the stack only shows it.
    const selected: string[] = [addressed]
    const mounted = createRoot((dispose) => ({
      dispose,
      stack: createScreenStack(
        () => undefined,
        { addressed, selectedSessionId: () => selected.at(-1), selectSession: (sessionId) => selected.push(sessionId), parentSessionId: (id) => id === "run" ? "chat" : undefined },
        memory.navigation,
      ),
    }))
    try {
      assert.equal(mounted.stack.screen(), "chat", addressed)
      assert.deepEqual(memory.entries(), [{ flywheelScreen: "sessions" }, { flywheelScreen: "chat", flywheelSession: addressed }])
      assert.deepEqual(selected, [addressed], "the stack selects nothing the owner already opens")
      mounted.stack.back()
      if (parent === undefined) {
        assert.equal(mounted.stack.screen(), "sessions")
      } else {
        assert.equal(mounted.stack.screen(), "chat")
        assert.equal(selected.at(-1), parent)
      }
    } finally {
      mounted.dispose()
    }
  }
})

test("a reload on a chat entry keeps it and opens no address again", () => {
  const memory = memoryNavigation()
  memory.navigation.replaceState({ flywheelScreen: "chat", flywheelSession: "kept" })
  const mounted = createRoot((dispose) => ({
    dispose,
    stack: createScreenStack(() => undefined, { addressed: "run", selectedSessionId: () => "kept", selectSession: () => {}, parentSessionId: () => undefined }, memory.navigation),
  }))
  try {
    assert.deepEqual(memory.entries(), [{ flywheelScreen: "chat", flywheelSession: "kept" }])
  } finally {
    mounted.dispose()
  }
})

test("a directly entered child returns to its parent then the session list", () => {
  const memory = memoryNavigation()
  const selected: string[] = []
  const mounted = createRoot((dispose) => ({
    dispose,
    stack: createScreenStack(
      () => undefined,
      { selectedSessionId: () => selected.at(-1), selectSession: (sessionId) => selected.push(sessionId), parentSessionId: (id) => id === "child" ? "parent" : undefined },
      memory.navigation,
    ),
  }))
  try {
    mounted.stack.openChat("child")
    mounted.stack.back()
    assert.deepEqual(selected, ["child", "parent"])

    mounted.stack.back()
    assert.equal(mounted.stack.screen(), "sessions")
    assert.deepEqual(selected, ["child", "parent"])
    selected.push("elsewhere")
    mounted.stack.forward()
    assert.equal(selected.at(-1), "parent")
  } finally {
    mounted.dispose()
  }
})

test("reactive selection changes replace the chat and Sessions leaves a child directly", () => {
  const memory = memoryNavigation()
  const mounted = createRoot((dispose) => {
    const [selectedSessionId, selectSession] = createSignal<string>()
    const stack = createScreenStack(() => undefined, {
      selectedSessionId, selectSession,
      parentSessionId: (id) => id === "child" ? "parent" : undefined,
    }, memory.navigation)
    return { dispose, stack, selectedSessionId, selectSession }
  })
  try {
    mounted.stack.openChat("first")
    mounted.selectSession("second")
    assert.equal(memory.entries().length, 2)
    mounted.stack.back()
    assert.equal(mounted.stack.screen(), "sessions")
    mounted.stack.forward()
    assert.equal(mounted.selectedSessionId(), "second")
    mounted.stack.openChat("child")
    mounted.stack.showSessions()
    assert.equal(mounted.stack.screen(), "sessions")
    mounted.stack.forward()
    assert.equal(mounted.selectedSessionId(), "child")
    mounted.stack.back()
    assert.equal(mounted.selectedSessionId(), "parent")
  } finally {
    mounted.dispose()
  }
})

test("a second tap on a chat whose open failed asks for it again", () => {
  const memory = memoryNavigation()
  const requested: (readonly [string, SessionLink | undefined])[] = []
  const mounted = createRoot((dispose) => {
    const [selectedSessionId, setSelected] = createSignal<string>()
    const stack = createScreenStack(() => undefined, {
      selectedSessionId,
      // The selection moves in the tap; the session owner decides whether a
      // repeat is a retry, so the stack always passes the tap on.
      selectSession: (sessionId, link) => { requested.push([sessionId, link]); setSelected(sessionId) },
      parentSessionId: () => undefined,
    }, memory.navigation)
    return { dispose, stack }
  })
  try {
    const link = { label: "Review agent", parentSessionId: "chat" }
    mounted.stack.openChat("child", link)
    mounted.stack.openChat("child", link)
    assert.deepEqual(requested, [["child", link], ["child", link]])
    assert.equal(memory.entries().length, 2)
  } finally {
    mounted.dispose()
  }
})
