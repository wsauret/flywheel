import { expect, test } from "bun:test"
import { EventBus } from "../../../../../src/infra/event-bus.js"
import type { AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createChatRunnerLifecycle } from "../../../../../src/orchestration/chat/runner-lifecycle.js"
import { ChatSessionState } from "../../../../../src/orchestration/chat/types.js"
import { sideQuestionHost } from "../../../../../src/orchestration/modules/side-question/host.js"
import { SIDE_QUESTION_PENDING_RESULT } from "../../../../../src/orchestration/modules/side-question/context.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { askUserStub, createTestChatSessionDeps, outputSessionStub } from "../../chat/_chat-session-agent-runtime-fixtures.js"
import { createChatSession } from "../../../../../src/orchestration/chat/session.js"
import { newTestRunner } from "../../../../helpers/agent-runner.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { roleCapture } from "../../../../helpers/role-capture.js"

test("an attached side host outlives turns, streams through the shared fold, and stops only its own runner", async () => {
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
  const runners: Array<{ options: AgentOptions; finish: (result: AgentRunResult) => void }> = []
  const deps = createTestChatSessionDeps({
    sessionId: "parent",
    seedContext: "parent task",
    resolveRoles: async () => new Map([["chat", { roleId: "chat", model: "test", effort: "high", providerOptions: { google: { temperature: 0.3 } } }]]),
    createAgent: (options) => {
      const done = Promise.withResolvers<AgentRunResult>()
      runners.push({ options, finish: done.resolve })
      options.lifecycle.signal?.addEventListener("abort", () => done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }), { once: true })
      started[runners.length - 1]?.resolve()
      return { send() {}, end() {}, abort: () => done.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "aborted" } }), done: done.promise }
    },
  })
  const bus = new EventBus()
  const state = new ChatSessionState("parent-continuation", () => {})
  const lifecycle = createChatRunnerLifecycle({
    deps, state, eventBus: bus, session: outputSessionStub("parent"), askUser: askUserStub(),
    setConnectionState() {},
    applyNestedStoredFact() {}, awaitDurableFacts: async () => {},
  })
  const host = lifecycle.chatModuleHosts.get(sideQuestionHost)!
  expect(host).toBeDefined()
  lifecycle.enqueueInput("main task")
  await started[0]!.promise
  const parent = runners[0]!.options
  const parentMessages = await deps.treeWriter.captureRawLiveMessages()
  const sideId = await host.ask("side question")
  await started[1]!.promise
  const side = runners[1]!.options
  expect(side.model).toBe(parent.model)
  expect(side.effort).toBe(parent.effort)
  expect(side.providerOptions).toEqual(parent.providerOptions)
  expect(side.auth).toBe(parent.auth)
  expect(side.treeRootSessionId).toBe("parent")
  expect(side.maxLLMCalls).toBe(1)
  expect(side.lifecycle.kind).toBe("one-shot")
  expect(side.purpose.kind).toBe("chat-side-call")
  expect(side.conversation.kind).toBe("replay")
  if (side.conversation.kind !== "replay") throw new Error("Expected side replay")
  expect(side.conversation.providerSessionKey).toBe(sideId)
  expect(side.conversation.providerSessionKey).not.toBe(state.providerConversationId)
  expect(side.conversation.requestAccounting).toEqual({ owner: { kind: "session", sessionId: "parent" }, streamId: sideId, writer: deps.infra.sessionEventWriter, reader: deps.infra.projectionReader })
  const parentOutput: string[] = []
  const unsubscribe = bus.subscribeToType("model.content.delta", () => { parentOutput.push("delta") }, { deliveryClass: "ui", delivery: "direct" })
  side.onEvent({ type: "model.content.delta", data: { block_key: "answer", delta: { type: "text_delta", text: "partial" } } })
  expect(host.snapshot().current?.answer).toBe("partial")
  side.onEvent({ type: "model.text.reconciled", data: { block_key: "answer", content: "final answer" } })
  side.onEvent({ type: "model.assistant_message.recorded", data: { message: { content: [{ type: "text", text: "final answer" }] } } })
  expect(host.snapshot().current?.answer).toBe("final answer")
  expect(parentOutput).toEqual([])
  expect(await deps.treeWriter.captureRawLiveMessages()).toEqual(parentMessages)
  expect(await host.stop(sideId)).toBe(true)
  expect(parent.lifecycle.signal?.aborted).not.toBe(true)
  expect(lifecycle.turnRunning).toBe(true)
  expect(host.snapshot().current?.state).toBe("stopped")
  expect(lifecycle.chatModuleHosts.get(sideQuestionHost)).toBe(host)
  unsubscribe()
  lifecycle.abortGeneration()
  await lifecycle.settle()
  await lifecycle.terminateBackgroundWorks()
  await bus.dispose()
})

test("disabled selection admits no side host", async () => {
  const deps = createTestChatSessionDeps({
    sessionId: "disabled",
    createAgent: () => { throw new Error("No request must start") },
    moduleSelection: () => composeFirstPartyModules(undefined, ["side-question"]),
  })
  const lifecycle = createChatRunnerLifecycle({
    deps, state: new ChatSessionState(undefined, () => {}), eventBus: new EventBus(),
    session: outputSessionStub("disabled"), askUser: askUserStub(), setConnectionState() {},
    applyNestedStoredFact() {}, awaitDurableFacts: async () => {},
  })
  expect(lifecycle.chatModuleHosts.get(sideQuestionHost)).toBeUndefined()
  await lifecycle.terminateBackgroundWorks()
})

test.each(["answer", "unsolicited", "refusal", "no-provider"] as const)("the real runner keeps source context, refuses every tool call, and handles request admission: %s", async (scenario) => {
  const unsolicited = scenario !== "answer"
  const calls: StreamOptions[] = []
  const outcomes: string[] = []
  const models: string[] = []
  const capture = async () => ({
    ...roleCapture(scenario === "no-provider" ? [] : ["fresh-model"]),
    admit: () => ({ createLLMClient: client, createAgent: () => { throw new Error("This capture constructs clients only") } }),
  })
  const client = async (model: string) => {
    models.push(model)
    return asModelClient({
    accessProvider: "openai_api", modelFamily: "openai", model,
    contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options) {
      calls.push(options)
      if (scenario !== "refusal") yield { kind: "text_delta", text: "one answer", blockKey: "b0" }
      if (unsolicited && calls.length === 1) {
        yield { kind: "tool_use", toolCall: { id: "unsolicited", name: "bash", input: { command: "must not execute" } } }
        yield { kind: "done", stopReason: "tool_use" }
      } else yield { kind: "done", stopReason: "end_turn" }
    },
  }) }
  const deps = createTestChatSessionDeps({
    sessionId: "real-side-runner",
    createAgent: (options) => newTestRunner({
      ...options, agentsMd: "", memorySnapshot: null, resolveEnvSnapshot: undefined,
      onEvent: (event) => {
        if (event.type === "tool.result.recorded" && event.data.tool_use_id === "unsolicited") outcomes.push(event.data.outcome ?? "")
        options.onEvent(event)
      },
    }, client, undefined, capture),
    captureProviderConnection: capture,
    resolveRoles: async () => scenario === "no-provider" ? new Map() : new Map([["chat", { roleId: "chat", model: "test", effort: "high" }]]),
  })
  await deps.treeWriter.commitUserTurn("parent context")
  await deps.treeWriter.recordCanonicalMessage({
    kind: "assistant", incomplete: true, content: [{ type: "tool_use", id: "live-call", name: "bash", input: { command: "parent command" } }],
  })
  const before = await deps.treeWriter.captureRawLiveMessages()
  const chat = createChatSession({ onError: () => {}, onEnded: () => {} }, deps)
  const host = chat.chatModuleHosts.get(sideQuestionHost)!
  await host.ask("question")
  await host.settled()
  if (scenario === "no-provider") {
    expect(calls).toEqual([])
    expect(models).toEqual([])
    expect(host.snapshot().current).toMatchObject({ state: "error", error: expect.stringContaining("No model provider") })
    await chat.dispose()
    return
  }
  expect(new Set(models)).toEqual(new Set(["fresh-model"]))
  expect(calls).toHaveLength(1)
  expect(outcomes).toEqual(unsolicited ? ["error"] : [])
  // It is advertised its tree's tools, told to call none, and an unsolicited call is refused while its answer stands.
  expect(calls[0]!.tools.map((tool) => tool.name)).toContain("bash")
  expect(JSON.stringify(calls[0]!.messages)).toContain("Call no tools. Every tool call is refused; answer in text.")
  expect(calls[0]!.messages[0]).toEqual(before[0])
  const quoted = calls[0]!.messages[1]
  if (quoted?.kind !== "assistant" || typeof quoted.content === "string") throw new Error("Expected quoted source operation")
  const block = quoted.content[0]
  if (block?.type !== "text") throw new Error("Expected source operation as context text")
  expect(block.text).toContain('"id":"live-call"')
  expect(block.text).toContain('"name":"bash"')
  expect(block.text).toContain('"command":"parent command"')
  expect(JSON.stringify(calls[0]!.messages)).toContain(SIDE_QUESTION_PENDING_RESULT)
  expect(calls[0]!.messages.some((message) => message.kind === "toolResult")).toBe(false)
  if (scenario === "refusal") {
    expect(host.snapshot().exchanges).toEqual([])
    expect(host.snapshot().current?.state).toBe("error")
    expect(host.snapshot().current?.error).toContain("returned no answer")
  } else expect(host.snapshot().exchanges[0]?.answer).toBe("one answer")
  expect(await deps.treeWriter.captureRawLiveMessages()).toEqual(before)
  await chat.dispose()
})
