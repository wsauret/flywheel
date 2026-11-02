import { expect, test } from "bun:test"
import { createModuleChatObservers } from "../../../../src/orchestration/chat/module-observers.js"
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../../../src/orchestration/modules.js"
import type { ModuleChatObserverContext } from "../../../../src/orchestration/module-seams.js"
import type { AgentStreamEvent } from "../../../../src/orchestration/agent-runtime/types.js"
import { createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures.js"

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
  const observers = createModuleChatObservers(() => selection, context())
  await observers.onTurnComplete("turn_end")
  await observers.dispose()
  expect(calls).toEqual(["first", "second", "first-disposed", "second-disposed"])
})

test("the selection is read at construction and turn boundaries, never per stream event", async () => {
  const base = composeFirstPartyModules([])
  let reads = 0
  const events: string[] = []
  const selection: FirstPartyModuleComposition = { ...base, get observers() {
    reads += 1
    return [{ seam: "chat" as const, observer: () => ({ onEvent: (event: AgentStreamEvent) => { events.push(event.type) } }) }]
  } }
  const observers = createModuleChatObservers(() => selection, context())
  observers.onEvent({ type: "text" })
  observers.onEvent({ type: "result" })
  expect(events).toEqual(["text", "result"])
  expect(reads).toBe(1)
  await observers.onTurnComplete("turn_end")
  expect(reads).toBe(2)
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
  const observers = createModuleChatObservers(() => selection, context())
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
