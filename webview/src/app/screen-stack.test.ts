import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"

import type { SessionLink } from "../client/session-navigation.js"
import { createScreenStack, type ScreenStackNavigation, type SwipeRoot } from "./screen-stack.js"
import { createWorkflowNavigation } from "../modules/workflows/navigation.js"
import { plainAgentTree } from "../../../tests/helpers/workflow-view.js"
import type { FrontendAttempt } from "../../../src/protocol/workflow-view-protocol-types.js"

/** Browser history in memory. A deferred one queues each traversal until
 *  `settle`, as a browser delivers its popstate after the tap's own work. A
 *  traversal past the first entry leaves the app. */
function memoryNavigation(options: { readonly deferred?: boolean; readonly entries?: readonly unknown[] } = {}) {
  const entries: unknown[] = options.entries === undefined ? [null] : [...options.entries]
  let index = entries.length - 1
  let left = false
  const queue: number[] = []
  const listeners = new Set<(event: { readonly state: unknown }) => void>()
  const traverse = (delta: number) => {
    const target = index + delta
    if (target < 0) { left = true; return }
    if (target >= entries.length || target === index) return
    index = target
    const event = { state: entries[index] }
    for (const listener of listeners) listener(event)
  }
  const request = (delta: number) => { if (options.deferred === true) queue.push(delta); else traverse(delta) }
  const navigation: ScreenStackNavigation = {
    get state() { return entries[index] },
    replaceState(state) { entries[index] = state },
    pushState(state) { entries.splice(++index, entries.length, state) },
    back: () => request(-1),
    forward: () => request(1),
    go: request,
    addPopStateListener(listener) { listeners.add(listener) },
    removePopStateListener(listener) { listeners.delete(listener) },
  }
  return { navigation, entries: () => [...entries], left: () => left, settle: () => { while (queue.length > 0) traverse(queue.shift()!) } }
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

test("a session link opens its child over its parent, so Back returns to the parent at once, from a chat and from a workflow agent's view", () => {
  const attempts: readonly FrontendAttempt[] = [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", sessionId: "member", history: [] }]
  const parents = new Map([["child", "chat"], ["agent-child", "member"]])
  const mount = () => {
    const memory = memoryNavigation()
    return createRoot((dispose) => {
      const [selected, setSelected] = createSignal<string>()
      const [tapped, setTapped] = createSignal<SessionLink>()
      const select = (sessionId: string, link?: SessionLink) => { setTapped(link); setSelected(sessionId) }
      // The app builds the agent navigation before the module host's stack.
      const agents = createWorkflowNavigation({
        reading: () => ({ detail: undefined, view: { attemptsStatus: "loaded", state: "running", attempts, tree: plainAgentTree(attempts) }, live: [] }),
        selected, select,
      }, memory.navigation)
      const stack = createScreenStack(() => undefined, {
        selectedSessionId: selected,
        selectSession: select,
        // The open chat's parent is known from the tap (app.tsx parentSessionId).
        parentSessionId: (id) => id === selected() ? tapped()?.parentSessionId ?? parents.get(id) : parents.get(id),
      }, memory.navigation)
      return { dispose, stack, agents, selected, memory }
    })
  }
  const chat = mount()
  try {
    chat.stack.openChat("chat")
    // A transcript link and a Background row of the shown chat both name it as the parent.
    chat.stack.openChat("child", { label: "Child", parentSessionId: "chat" })
    chat.stack.back()
    assert.equal(chat.stack.screen(), "chat")
    assert.equal(chat.selected(), "chat", "the first Back shows the parent")
    assert.equal(chat.memory.entries().length, 2, "the list and one chat")
    chat.stack.back()
    assert.equal(chat.stack.screen(), "sessions")
  } finally {
    chat.dispose()
  }
  const agent = mount()
  try {
    agent.stack.openChat("chat")
    agent.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: true }, "chat")
    // The agent's transcript names the agent's session as the parent.
    agent.stack.openChat("agent-child", { label: "Agent child", parentSessionId: "member" })
    agent.stack.back()
    assert.equal(agent.selected(), "member", "Back from the agent's child returns to the agent")
    assert.equal(agent.agents.place()?.kind, "agent")
    agent.stack.back()
    assert.equal(agent.selected(), "chat")
    agent.stack.back()
    assert.equal(agent.stack.screen(), "sessions")
  } finally {
    agent.dispose()
  }
})

test("a selection that leaves an agent view takes the chat's entry without the agent's place, so a reload stays on the chat", () => {
  const memory = memoryNavigation()
  const attempts: readonly FrontendAttempt[] = [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", sessionId: "member", history: [] }]
  const reading = () => ({ detail: undefined, view: { attemptsStatus: "loaded" as const, state: "running" as const, attempts, tree: plainAgentTree(attempts) }, live: [] })
  const mount = (initial: string | undefined) => createRoot((dispose) => {
    const [selected, setSelected] = createSignal<string | undefined>(initial)
    const select = (sessionId: string) => setSelected(sessionId)
    const agents = createWorkflowNavigation({ reading, selected, select }, memory.navigation)
    const stack = createScreenStack(() => undefined, { selectedSessionId: selected, selectSession: select, parentSessionId: () => undefined }, memory.navigation)
    return { dispose, stack, agents, selected, setSelected }
  })
  const first = mount(undefined)
  first.stack.openChat("chat")
  first.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: true }, "chat")
  // The command menu's New chat, or a kept side question, moves the selection without the stack.
  first.setSelected("new")
  first.dispose()
  const reloaded = mount("new")
  try {
    assert.equal(reloaded.selected(), "new", "the reload is not pulled back to the agent")
    assert.equal(reloaded.agents.place(), undefined)
  } finally {
    reloaded.dispose()
  }
})

test("Back from a chat that the person reached from a workflow's level goes to the list at once, whatever the level", () => {
  const attempts: readonly FrontendAttempt[] = [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", sessionId: "member", history: [] }]
  const reading = () => ({ detail: undefined, view: { attemptsStatus: "loaded" as const, state: "running" as const, attempts, tree: plainAgentTree(attempts) }, live: [] })
  // The agent view from the chat's inline card, and from the full-size card,
  // which holds two entries over the chat's. Each is left by a selection
  // that the stack does not make (New chat, a kept side question) and by an
  // open that names no parent (a notification, a question, the host).
  for (const origin of ["chat", "card"] as const) {
    for (const leave of ["selection", "open"] as const) {
      const memory = memoryNavigation()
      const mounted = createRoot((dispose) => {
        const [selected, setSelected] = createSignal<string>()
        const select = (sessionId: string) => setSelected(sessionId)
        // The app builds the agent navigation before the module host's stack.
        const agents = createWorkflowNavigation({ reading, selected, select }, memory.navigation)
        const stack = createScreenStack(() => undefined, { selectedSessionId: selected, selectSession: select, parentSessionId: () => undefined }, memory.navigation)
        return { dispose, stack, agents, selected, setSelected }
      })
      const label = `${origin}, ${leave}`
      try {
        mounted.stack.openChat("chat")
        if (origin === "card") mounted.agents.openCard("run", "chat")
        mounted.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: false, historySessionId: "member" }, origin)
        if (leave === "selection") mounted.setSelected("new")
        else mounted.stack.openChat("new")
        assert.equal(mounted.selected(), "new", label)
        assert.equal(mounted.stack.screen(), "chat", label)
        mounted.stack.back()
        assert.equal(mounted.stack.screen(), "sessions", `${label}: the first Back reaches the list`)
        assert.equal(mounted.selected(), "new", `${label}: the workflow does not pull the selection back`)
        assert.deepEqual(memory.entries(), [{ flywheelScreen: "sessions" }, { flywheelScreen: "chat", flywheelSession: "new" }], `${label}: the workflow's entries are gone`)
      } finally {
        mounted.dispose()
      }
    }
  }
})

test("a return to the list from a workflow's level ends where the person's latest tap or selection points", () => {
  const agent = (sessionId?: string): readonly FrontendAttempt[] => [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", ...(sessionId === undefined ? {} : { sessionId }), history: [] }]
  const target = { kind: "agent", agentNodeId: "agent", follow: false, historySessionId: "member" } as const
  const list = { flywheelScreen: "sessions" }
  // History as a browser keeps it: a traversal arrives after the tap's own
  // work, so everything in one tap happens while the return is under way.
  const mount = (entries?: readonly unknown[], initial?: string, member?: string) => {
    const memory = memoryNavigation({ deferred: true, entries })
    return createRoot((dispose) => {
      const [selected, setSelected] = createSignal<string | undefined>(initial)
      const [attempts, setAttempts] = createSignal(agent(member))
      const reading = () => ({ detail: undefined, view: { attemptsStatus: "loaded" as const, state: "running" as const, attempts: attempts(), tree: plainAgentTree(attempts()) }, live: [] })
      const select = (sessionId: string) => setSelected(sessionId)
      // The app builds the agent navigation before the module host's stack.
      const agents = createWorkflowNavigation({ reading, selected, select }, memory.navigation)
      const stack = createScreenStack(() => undefined, { selectedSessionId: selected, selectSession: select, parentSessionId: () => undefined }, memory.navigation)
      return { dispose, memory, stack, agents, selected, setSelected, learn: (sessionId: string) => setAttempts(agent(sessionId)) }
    })
  }
  const atAgent = () => {
    const mounted = mount(undefined, undefined, "member")
    mounted.stack.openChat("chat")
    mounted.agents.openAgent("run", "chat", target, "chat")
    mounted.memory.settle()
    return mounted
  }
  // An agent whose session is not known yet. When a reading names it, the
  // view writes its own entry for it and selects it, which is the view's
  // answer, not the person's intent.
  const atUnknownAgent = () => {
    const mounted = mount()
    mounted.stack.openChat("chat")
    mounted.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: false }, "chat")
    mounted.memory.settle()
    return mounted
  }
  const cases: readonly { readonly name: string; readonly page: () => ReturnType<typeof mount>; readonly tap: (page: ReturnType<typeof mount>) => void; readonly selected: string | undefined }[] = [
    // The slash panel's New chat shows the new chat before the runtime has
    // created it, and the creation can fail.
    { name: "New chat whose creation fails", page: atAgent, tap: (page) => page.setSelected(undefined), selected: undefined },
    { name: "an open, then New chat", page: atAgent, tap: (page) => { page.stack.openChat("other"); page.setSelected(undefined); page.setSelected("new") }, selected: "new" },
    { name: "an open, then an open of the shown member", page: atAgent, tap: (page) => { page.stack.openChat("other"); page.stack.openChat("member") }, selected: "member" },
    { name: "an open, then a reading that names the agent's session", page: atUnknownAgent, tap: (page) => { page.stack.openChat("other"); page.learn("member") }, selected: "other" },
    // The agent view as the released writers left it, with no depth, in a
    // tab that a reload carried across the update.
    {
      name: "New chat from an agent entry written before entries stated their depth",
      page: () => mount([list, { flywheelScreen: "chat", flywheelSession: "chat", flywheelPlace: undefined }, { flywheelScreen: "chat", flywheelSession: "member", flywheelPlace: { kind: "agent", workflowId: "run", chatSessionId: "chat", origin: "chat", target } }], "member", "member"),
      tap: (page) => { page.setSelected(undefined); page.setSelected("new") },
      selected: "new",
    },
  ]
  for (const { name, page: open, tap, selected } of cases) {
    const page = open()
    try {
      tap(page)
      page.memory.settle()
      assert.equal(page.stack.screen(), "chat", name)
      assert.equal(page.selected(), selected, `${name}: the latest intent decides where the return ends`)
      assert.deepEqual(page.memory.entries(), [list, { flywheelScreen: "chat", ...(selected === undefined ? {} : { flywheelSession: selected }) }], `${name}: the chat stands alone on the list`)
      page.stack.back()
      page.memory.settle()
      assert.equal(page.stack.screen(), "sessions", `${name}: the first Back reaches the list`)
      assert.equal(page.selected(), selected, `${name}: the workflow does not pull the selection back`)
    } finally {
      page.dispose()
    }
  }
  // A Back in the same tap as the move that started the return ends it on
  // the list, and history never goes on past it.
  const page = atAgent()
  try {
    page.setSelected(undefined)
    page.stack.back()
    page.memory.settle()
    assert.equal(page.stack.screen(), "sessions", "a Back during the return ends it on the list")
    assert.equal(page.memory.left(), false, "a Back during the return does not leave the app")
  } finally {
    page.dispose()
  }
  const sessions = atUnknownAgent()
  try {
    sessions.stack.showSessions()
    sessions.learn("member")
    sessions.memory.settle()
    assert.equal(sessions.stack.screen(), "sessions", "a reading during a return to the list does not end it on the agent")
  } finally {
    sessions.dispose()
  }
})
