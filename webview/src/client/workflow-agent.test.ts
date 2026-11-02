import assert from "node:assert/strict"
import { test } from "node:test"
import { createRoot, createSignal } from "solid-js"
import { createWorkflowNavigation, type HistoryPort } from "../modules/workflows/navigation.js"
import type { WorkflowReading } from "../modules/workflows/inspection.js"
import type { LoadedWorkflowView } from "../../../src/protocol/workflow-view-protocol-types.js"

function memoryHistory() {
  const entries: unknown[] = [{ flywheelScreen: "chat", flywheelSession: "chat" }]
  let index = 0
  const listeners = new Set<(event: { state: unknown }) => void>()
  const publish = () => { for (const listener of listeners) listener({ state: entries[index] }) }
  const port: HistoryPort = {
    get state() { return entries[index] },
    replaceState(state) { entries[index] = state },
    pushState(state) { entries.splice(++index, entries.length, state) },
    back() { if (index > 0) { index -= 1; publish() } },
    addPopStateListener(listener) { listeners.add(listener) },
    removePopStateListener(listener) { listeners.delete(listener) },
  }
  return { port, count: () => entries.length, forward() { if (index + 1 < entries.length) { index += 1; publish() } } }
}
function view(later = false): LoadedWorkflowView {
  return {
    attemptsStatus: "loaded", state: "running",
    attempts: [
      { id: "draft-1", definitionId: "draft", briefId: "draft", name: "Draft", status: "completed", sessionId: "member-draft", history: [{ sessionId: "generation", conversationId: "old" }] },
      ...(later ? [{ id: "review-1", definitionId: "review", briefId: "review", name: "Review", status: "running" as const, sessionId: "member-review", history: [] }] : []),
    ],
    tree: { nodes: [
      { id: "draft-phase", kind: "phase", form: "list", phaseId: "draft", label: "Draft", parentId: null, disposition: "completed", list: { id: "items", expanded: true } },
      { id: "draft-node", kind: "agent", definitionId: "draft", label: "Draft", parentId: "draft-phase", disposition: "completed", attempts: 1, currentAttemptId: "draft-1", item: { nodeId: "item", key: "a", label: "A", ordinal: 1, text: "a" } },
      { id: "review-phase", kind: "phase", form: "list", phaseId: "review", label: "Review", parentId: null, disposition: later ? "running" : "pending", list: { id: "items", expanded: true } },
      { id: "review-node", kind: "agent", definitionId: "review", label: "Review", parentId: "review-phase", disposition: later ? "running" : "pending", attempts: later ? 1 : 0, ...(later ? { currentAttemptId: "review-1" } : {}), item: { nodeId: "item", key: "a", label: "A", ordinal: 1, text: "a" } },
    ] },
  }
}
function mount() {
  const history = memoryHistory()
  return createRoot(dispose => {
    const [selected, select] = createSignal<string | undefined>("chat")
    const [reading, setReading] = createSignal<WorkflowReading>({ detail: undefined, view: view(), live: [] })
    const navigation = createWorkflowNavigation({ reading, selected, select }, history.port)
    return { dispose, history, navigation, selected, select, setReading }
  })
}

test("an inline agent open selects its actual member, Back returns to the launching chat and Forward restores the agent", () => {
  const mounted = mount()
  try {
    mounted.navigation.openAgent("run", "chat", { kind: "agent", agentNodeId: "draft-node", follow: false }, "chat")
    assert.equal(mounted.selected(), "member-draft")
    assert.notEqual(mounted.selected(), "run")
    assert.equal(mounted.history.count(), 2)
    mounted.history.port.back()
    assert.equal(mounted.selected(), "chat")
    assert.equal(mounted.navigation.place(), undefined)
    mounted.history.forward()
    assert.equal(mounted.selected(), "member-draft")
  } finally { mounted.dispose() }
})

test("a card selects only its chat and an agent opened there returns to that passive card", () => {
  const mounted = mount()
  try {
    mounted.navigation.openCard("run", "chat")
    assert.equal(mounted.selected(), "chat")
    mounted.navigation.openAgent("run", "chat", { kind: "agent", agentNodeId: "draft-node", follow: false }, "card")
    assert.equal(mounted.selected(), "member-draft")
    mounted.history.port.back()
    assert.equal(mounted.navigation.place()?.kind, "card")
    assert.equal(mounted.selected(), "chat")
    mounted.history.port.back()
    assert.equal(mounted.navigation.place(), undefined)
    assert.equal(mounted.selected(), "chat")
  } finally { mounted.dispose() }
})

test("follow advances the actual session once a successor starts, stays forward after a stale read, and imported history pins its own real session", () => {
  const mounted = mount()
  try {
    mounted.navigation.openAgent("run", "chat", { kind: "agent", agentNodeId: "draft-node", follow: true }, "chat")
    assert.equal(mounted.selected(), "member-draft")
    mounted.setReading({ detail: undefined, view: view(true), live: [] })
    assert.equal(mounted.selected(), "member-review")
    mounted.setReading({ detail: undefined, view: view(), live: [] })
    assert.equal(mounted.selected(), "member-review")
    mounted.setReading({ detail: undefined, view: view(true), live: [] })
    mounted.navigation.openAgent("run", "chat", { kind: "agent", agentNodeId: "draft-node", follow: false }, "chat")
    mounted.navigation.history("generation")
    assert.equal(mounted.selected(), "generation")
    assert.equal(mounted.history.count(), 2, "history and agent movement replace the current place")
  } finally { mounted.dispose() }
})

test("a nested child is selected without losing the agent's remembered origin and returns through browser history", () => {
  const mounted = mount()
  try {
    mounted.navigation.openAgent("run", "chat", { kind: "agent", agentNodeId: "draft-node", follow: false }, "card")
    mounted.history.port.pushState({ flywheelScreen: "chat", flywheelSession: "nested" })
    mounted.select("nested")
    assert.equal(mounted.selected(), "nested")
    mounted.history.port.back()
    assert.equal(mounted.selected(), "member-draft")
    assert.equal(mounted.navigation.place()?.kind, "agent")
    mounted.history.forward()
    assert.equal(mounted.selected(), "nested")
  } finally { mounted.dispose() }
})

test("a question in the chat under its full-size card reveals the chat in a new entry, Back returns to the card, and a question elsewhere leaves the card", () => {
  const mounted = mount()
  try {
    mounted.navigation.openCard("run", "chat")
    mounted.navigation.reveal("other")
    assert.equal(mounted.navigation.place()?.kind, "card", "a question in another session opens it the ordinary way")
    mounted.navigation.reveal("chat")
    assert.equal(mounted.navigation.place(), undefined)
    assert.equal(mounted.selected(), "chat")
    assert.equal(mounted.history.count(), 3)
    mounted.history.port.back()
    assert.equal(mounted.navigation.place()?.kind, "card")
    assert.equal(mounted.selected(), "chat")
  } finally { mounted.dispose() }
})
