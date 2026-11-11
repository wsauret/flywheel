import { expect, test, setSystemTime } from "bun:test"
import { liveChildRun } from "../../../../../src/orchestration/session/live-session-control.js"
import type { AgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js"
import { makeContext, TEST_RATIONALE } from "../../agent-runtime/subagent/_fixtures.js"
import { subagentChildHarnesses, createRoot, waitForSettled, continuationService, heldRunner } from "./_subagent-child-fixtures.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { newTestRunner } from "../../../../helpers/agent-runner.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js"
import type { BackgroundWorkResult } from "../../../../../src/orchestration/agent-runtime/background-work.js"

const createHarness = subagentChildHarnesses()

test.each(["runtime", "person"] as const)("a %s cut supplies the saved wait policy through child Resume", async (by) => {
  const harness = createHarness(heldRunner().createAgent)
  const root = await createRoot(harness.manager)
  const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
  const result = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() }).execute({ persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE }, context)
  const child: string = JSON.parse(result.content).session_id
  await liveChildRun(harness.reader, child)?.child.interrupt(by)
  const metadata = await harness.manager.read(child)
  if (metadata?.kind !== "subagent") throw new Error("Missing child")
  const at = Date.now() - 30_000
  const tree = await tryOpenConversationTree({ conversationId: metadata.conversationId, sessionId: child, store: harness.reader, writer: asAsyncEventWriter(harness.store) })
  if (!tree) throw new Error("Missing conversation")
  setSystemTime(at)
  try {
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-command", name: "process", input: { action: "wait", soft_timeout: 60 } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-command", content: [{ type: "text", text: "Wait acknowledged." }] })
    const end = interruptedTurnEnd(by)
    await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "wait-cut"))
  } finally { setSystemTime(); tree.getStorage().dispose() }
  const stop = new AbortController()
  const parked = Promise.withResolvers<void>()
  const requested = Promise.withResolvers<void>()
  const task = Promise.withResolvers<BackgroundWorkResult>()
  let requests = 0
  let restored: AgentOptions["lifecycle"]["restoredWait"]
  const host = continuationService(harness, (options) => {
    restored = options.lifecycle.restoredWait
    options.runtimeSurfaces?.background?.tasks.track({ done: task.promise, meta: { id: "pending", type: "background_command", description: "pending" }, kill: { run: () => { task.resolve({ status: "completed", content: "" }) } } })
    return newTestRunner({
      ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
      lifecycle: { ...options.lifecycle, signal: AbortSignal.any([stop.signal, ...(options.lifecycle.signal ? [options.lifecycle.signal] : [])]), onTurnParked: async (park) => { await options.lifecycle.onTurnParked?.(park); parked.resolve() } },
    }, async (model) => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, 
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() { requests += 1; requested.resolve(); stop.abort(); yield { kind: "done", stopReason: "end_turn" } },
    }))
  })
  try {
    expect((await host.service.resume(child)).outcome).toBe("ok")
    if (by === "runtime") {
      await parked.promise
      expect(restored).toEqual({ expiry: { seconds: 60, deadlineMs: at + 60_000 }, replyWaitIds: [] })
      expect(requests).toBe(0)
      task.resolve({ status: "completed", content: "command completed" })
    } else expect(restored).toBeUndefined()
    await requested.promise
    expect(requests).toBe(1)
    await waitForSettled(harness, root.sessionId)
  } finally { stop.abort(); task.resolve({ status: "completed", content: "" }); await host.close(); await harness.close() }
})

// A planned replacement cut the child between the requests of a turn whose
// earlier wait call still holds; the continuation has no Resume input, so
// the run itself takes the wait with its original deadline, answers the cut
// batch, and parks waiting.
test("a planned cut in the middle of a child's turn continues its open wait through the continuation", async () => {
  const harness = createHarness(heldRunner().createAgent)
  const root = await createRoot(harness.manager)
  const context = makeContext({ projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, conversationId: root.conversationId, availableTools: new Set(["read"]) })
  const result = await harness.tool(root.sessionId, { agentRegistry: repoDefinitions().personas() }).execute({ persona: "general", prompt: "Inspect the saved assignment.", rationale: TEST_RATIONALE }, context)
  const child: string = JSON.parse(result.content).session_id
  await liveChildRun(harness.reader, child)?.child.interrupt("runtime")
  const metadata = await harness.manager.read(child)
  if (metadata?.kind !== "subagent") throw new Error("Missing child")
  const at = Date.now() - 30_000
  const tree = await tryOpenConversationTree({ conversationId: metadata.conversationId, sessionId: child, store: harness.reader, writer: asAsyncEventWriter(harness.store) })
  if (!tree) throw new Error("Missing conversation")
  setSystemTime(at)
  try {
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "wait-command", name: "process", input: { action: "wait", soft_timeout: 3600 } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "wait-command", content: [{ type: "text", text: "Wait acknowledged." }] })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "read-1", name: "read", input: { path: "notes.md" } }] })
    await tree.appendMessage({ kind: "toolResult", toolUseId: "read-1", content: [{ type: "text", text: "notes" }] })
    const end = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", origin: "system", content: interruptedTurnMessage(end.pausedBy, false) }, turnEndEntryId(end, "planned-cut"))
  } finally { setSystemTime(); tree.getStorage().dispose() }
  const stop = new AbortController()
  const parked = Promise.withResolvers<string>()
  let requests = 0
  const task = Promise.withResolvers<BackgroundWorkResult>()
  let continued: AgentOptions["lifecycle"]["continuedWait"]
  const host = continuationService(harness, (options) => {
    continued = options.lifecycle.continuedWait
    options.runtimeSurfaces?.background?.tasks.track({ done: task.promise, meta: { id: "pending", type: "background_command", description: "pending" }, kill: { run: () => { task.resolve({ status: "completed", content: "" }) } } })
    return newTestRunner({
      ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
      lifecycle: { ...options.lifecycle, signal: AbortSignal.any([stop.signal, ...(options.lifecycle.signal ? [options.lifecycle.signal] : [])]), onTurnParked: async (park) => { parked.resolve(park.park); stop.abort() } },
    }, async (model) => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, 
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() { requests += 1; yield { kind: "text_delta", text: "Read the notes.", blockKey: "text-0" }; yield { kind: "done", stopReason: "end_turn" } },
    }))
  })
  try {
    expect((await host.service.resume(child)).outcome).toBe("ok")
    expect(await parked.promise).toBe("waiting_on_work")
    expect(continued).toEqual({ expiry: { seconds: 3600, deadlineMs: at + 3_600_000 }, replyWaitIds: [] })
    // Without the wait, the text answer would draw the pending-work nudge first.
    expect(requests).toBe(1)
  } finally { stop.abort(); task.resolve({ status: "completed", content: "" }); await host.close(); await harness.close() }
})
