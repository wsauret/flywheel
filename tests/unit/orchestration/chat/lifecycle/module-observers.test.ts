import { expect, test } from "bun:test"
import { createModuleChatObservers } from "../../../../../src/orchestration/chat/lifecycle/module-observers.js"
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../../../../src/orchestration/modules.js"
import type { ModuleChatObserverContext } from "../../../../../src/orchestration/module-seams.js"
import { createEmit, EventBus } from "../../../../../src/infra/event-bus.js"
import { createTestChatSessionDeps } from "../_chat-session-agent-runtime-fixtures.js"

function context(): ModuleChatObserverContext {
  const deps = createTestChatSessionDeps({ sessionId: "observer-fixture", createAgent: () => { throw new Error("observer starts no runner") } })
  return { sessionId: deps.sessionId, eventStore: deps.infra.eventStore, projectionReader: deps.infra.eventStore, writer: deps.infra.sessionEventWriter, enqueueSilentSystem: () => {}, showSystemMessage: () => {} }
}

test("all declared chat observers receive hooks and independent failures are contained", async () => {
  const calls: string[] = []
  const base = composeFirstPartyModules([])
  const selection: FirstPartyModuleComposition = { ...base, observers: [
    { seam: "chat", observer: () => { throw new Error("factory failed") } },
    { seam: "chat", observer: () => ({ onTurnComplete: async () => { calls.push("first"); throw new Error("hook failed") }, dispose: () => { calls.push("first-disposed") } }) },
    { seam: "chat", observer: () => ({ onTurnComplete: async () => { calls.push("second") }, dispose: () => { calls.push("second-disposed") } }) },
  ] }
  const observers = createModuleChatObservers(() => selection, context(), new EventBus())
  await observers.onTurnComplete("turn_end")
  await observers.dispose()
  expect(calls).toEqual(["first", "second", "first-disposed", "second-disposed"])
})

test("the selection is read at construction and turn boundaries, never per tool input", async () => {
  const base = composeFirstPartyModules([])
  let reads = 0
  let selected = true
  const toolInputs: string[] = []
  const declaration = { seam: "chat" as const, observer: () => ({ onToolInput: (toolUse: { readonly id: string }) => { toolInputs.push(toolUse.id) } }) }
  const selection: FirstPartyModuleComposition = { ...base, get observers() {
    reads += 1
    return selected ? [declaration] : []
  } }
  const bus = new EventBus()
  const emit = createEmit(bus)
  const toolInput = (id: string): void => { emit("tool.input.completed", { sessionId: "observer-fixture", data: { tool_use: { id, name: "read", input: {} } } }) }
  const subscriptions: string[] = []
  const observers = createModuleChatObservers(() => selection, context(), {
    subscribeToType(type, listener, options) {
      subscriptions.push(`open:${type}`)
      const unsubscribe = bus.subscribeToType(type, listener, options)
      return () => { subscriptions.push(`close:${type}`); unsubscribe() }
    },
  })
  toolInput("first")
  toolInput("second")
  await bus.drain()
  expect(toolInputs).toEqual(["first", "second"])
  expect(reads).toBe(1)
  // A selection with no reader closes the subscription at the turn boundary.
  selected = false
  await observers.onTurnComplete("turn_end")
  expect(reads).toBe(2)
  expect(subscriptions).toEqual(["open:tool.input.completed", "close:tool.input.completed"])
  toolInput("third")
  await bus.drain()
  expect(toolInputs).toEqual(["first", "second"])
  await observers.dispose()
  await bus.dispose()
})

test("selection generations construct on demand and disposal joins admitted hooks before resources", async () => {
  const base = composeFirstPartyModules([])
  const gate = Promise.withResolvers<void>()
  const calls: string[] = []
  let generation = 0
  const declaration = { seam: "chat" as const, observer: () => {
    generation += 1
    return { onTurnComplete: async () => { calls.push("start"); await gate.promise; calls.push("settled") }, dispose: () => { calls.push("disposed") } }
  } }
  let selection: FirstPartyModuleComposition = base
  const observers = createModuleChatObservers(() => selection, context(), new EventBus())
  await observers.onTurnComplete("turn_end")
  expect(generation).toBe(0)
  selection = { ...base, observers: [declaration] }
  const turn = observers.onTurnComplete("turn_end")
  expect(generation).toBe(1)
  selection = base
  await observers.onCompactionContinuation()
  expect(calls).toEqual(["start"])
  const disposed = observers.dispose()
  gate.resolve()
  await Promise.all([turn, disposed])
  expect(calls).toEqual(["start", "settled", "disposed"])
  await observers.onTurnComplete("turn_end")
  expect(generation).toBe(1)
})
