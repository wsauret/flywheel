import { expect, test } from "bun:test"
import { tmpdir } from "node:os"

import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { createRequestToolSurface } from "../../../../src/orchestration/agent-runtime/request-tool-surface.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue.js"
import { RequestToolMap, testCapabilityModules, testDefinitionAvailability, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"

function requestPlan(tool: RuntimeTool) {
  const tools = new RequestToolMap([[tool.name, tool]])
  return {
    eligibleTools: tools,
    tools,
    omitted: [],
    usable: new Set([tool.name]), turnedOff: [],
    registrationIds: new Map([[tool.name, tool.name]]),
    registrationIdentities: new Map([[tool.name, tool.name]]),
    definitionAvailability: testDefinitionAvailability(),
  }
}

async function requestSurface(tool: RuntimeTool) {
  const surface = await createRequestToolSurface(() => requestPlan(tool), testCapabilityModules, testRuntimeConfigCapture)
  return {
    async resolve() {
      const resolved = await surface.resolve()
      return { ...resolved, executionAdmission: (toolName: string) => resolved.tools.has(toolName) ? { ok: true as const } : resolved.executionAdmission(toolName) }
    },
    current() {
      const current = surface.current()
      return { ...current, executionAdmission: (toolName: string) => current.tools.has(toolName) ? { ok: true as const } : current.executionAdmission(toolName) }
    },
  }
}

test("delivers every queued steering message in receive order before the next request", async () => {
  const toolStarted = Promise.withResolvers<void>()
  const releaseTool = Promise.withResolvers<void>()
  const waiter: RuntimeTool = {
    name: "waiter",
    action: "ui_meta",
    description: "Wait for steering",
    inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: true,
    async execute() {
      toolStarted.resolve()
      await releaseTool.promise
      return { content: "finished", outcome: "ok" }
    },
  }
  const messages: ConversationMessage[][] = []
  const responses: ProviderStreamEvent[][] = [
    [
      { kind: "tool_use", toolCall: { id: "tool-1", name: waiter.name, input: {} } },
      { kind: "done", stopReason: "tool_use" },
    ],
    [{ kind: "done", stopReason: "end_turn" }],
  ]
  const client: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
      messages.push(structuredClone(options.messages))
      const response = responses.shift()
      if (!response) throw new Error("No more mock responses")
      for (const event of response) yield event
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  }
  const queue = new WorkflowInjectionQueue()
  const run = runAgentLoop({
    client: asModelClient(client),
    tools: await requestSurface(waiter),
    systemPrompt: () => stableSystemPrompt("test"),
    instruction: "work",
    executionCwd: tmpdir(),
    userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
    providerSessionKey: "queued-steering", promptCacheKey: "queued-steering",
    artifactScopeId: "queued-steering",
    retrievalSessionId: "queued-steering",
    persistence: { history: { append: () => {} } },
    seed: { kind: "fresh" },
    onEvent: () => {},
    inputSource: queue,
    completeOnIdle: {},
  })

  await toolStarted.promise
  queue.enqueueMessage({
    text: "parent guidance",
    producer: { kind: "session", sessionId: "parent", conversationId: "parent-conversation", toolUseId: "steer-call", hop: 0 },
  })
  queue.enqueueMessage({ text: "human guidance", producer: { kind: "human" } })
  releaseTool.resolve()
  await run

  expect(messages).toHaveLength(2)
  expect(messages[1]?.filter((message) => message.kind === "user").slice(-2)).toEqual([
    {
      kind: "user",
      content: "parent guidance",
      producer: { kind: "session", sessionId: "parent", conversationId: "parent-conversation", toolUseId: "steer-call", hop: 0 },
    },
    { kind: "user", content: "human guidance", origin: "human", producer: { kind: "human" } },
  ])
})
