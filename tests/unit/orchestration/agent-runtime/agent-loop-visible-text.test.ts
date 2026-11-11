import { tmpdir } from "node:os"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { DELIVERY_CONFIRMATION } from "../../../../src/infra/delivery-confirmation.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../helpers/request-tool-surface.js"
import type { RuntimeTool, ToolResult } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"

describe("turnHasVisibleText across turns", () => {
  it("tracks each committed assistant turn's visible text, in both directions", async () => {
    const seen: Array<boolean | undefined> = []
    const probe: RuntimeTool = {
      name: "probe",
      action: "ui_meta",
      description: "Record the committed turn's visible-text flag",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      // Same defer contract as ask_user: read the flag only after commit.
      deferUntilAssistantCommitted: true,
      execute: async (_input, context): Promise<ToolResult> => {
        seen.push(context.turnHasVisibleText?.())
        return { content: "ok", outcome: "ok" }
      },
    }
    const responses: Array<{ events: ProviderStreamEvent[] }> = [
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "visible explanation", blockKey: "text" }, { kind: "tool_use", toolCall: { id: "tc_2", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "tool_use", toolCall: { id: "tc_3", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "thinking_complete", thinking: "The checks passed.", signature: "Eg0KC0IJbmFycmF0aW9u" }, { kind: "tool_use", toolCall: { id: "tc_4", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "thinking_complete", thinking: "private reasoning", signature: "EgwKCkIIdGhpbmtpbmc=" }, { kind: "tool_use", toolCall: { id: "tc_5", name: "probe", input: {} } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "text_delta", text: "done", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]
    let callIndex = 0
    const client = asModelClient({ historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
        const response = responses[callIndex++]
        if (!response) throw new Error("No more mock responses")
        for (const event of response.events) yield event
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    } satisfies LLMClient)

    await runAgentLoop({
      client,
      tools: await fixedRequestToolSurface(new RequestToolMap([["probe", probe]])),
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: join(tmpdir(), ".test-account"), projectRoot: tmpdir(),
      providerSessionKey: "visible-text", promptCacheKey: "visible-text", artifactScopeId: "visible-text", retrievalSessionId: "visible-text",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }) },
    })

    expect(seen).toEqual([false, true, false, true, false])
  })

  it("keeps tool results unchanged when the human-facing reply guard is enabled", async () => {
    const probe: RuntimeTool = {
      name: "probe",
      action: "ui_meta",
      description: "No-op tool",
      inputSchema: { type: "object" },
      isConcurrencySafe: true,
      execute: async (): Promise<ToolResult> => ({ content: "ok", outcome: "ok" }),
    }
    const responses: Array<{ events: ProviderStreamEvent[] }> = [
      // Silent tool turn: two results, no receipt anywhere.
      { events: [
        { kind: "tool_use", toolCall: { id: "tc_1", name: "probe", input: {} } },
        { kind: "tool_use", toolCall: { id: "tc_2", name: "probe", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      // A visible reply does not add metadata to tool results.
      { events: [
        { kind: "text_delta", text: "visible explanation", blockKey: "text" },
        { kind: "tool_use", toolCall: { id: "tc_3", name: "probe", input: {} } },
        { kind: "tool_use", toolCall: { id: "tc_4", name: "probe", input: {} } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [{ kind: "text_delta", text: "done", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]
    let callIndex = 0
    const client = asModelClient({ historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
        const response = responses[callIndex++]
        if (!response) throw new Error("No more mock responses")
        for (const event of response.events) yield event
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    } satisfies LLMClient)

    const history: ConversationMessage[] = []
    await runAgentLoop({
      client,
      tools: await fixedRequestToolSurface(new RequestToolMap([["probe", probe]])),
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: join(tmpdir(), ".test-account"), projectRoot: tmpdir(),
      providerSessionKey: "visible-text", promptCacheKey: "visible-text", artifactScopeId: "visible-text", retrievalSessionId: "visible-text",
      humanFacing: true,
      persistence: { history: { append: (message) => { history.push(message) } } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }) },
    })

    const receiptTexts = new Map<string, boolean>()
    for (const message of history) {
      if (message.kind !== "toolResult") continue
      const hasReceipt = message.content.some((part) => part.type === "text" && part.text === DELIVERY_CONFIRMATION)
      receiptTexts.set(message.toolUseId, hasReceipt)
    }
    expect(receiptTexts).toEqual(new Map([
      ["tc_1", false],
      ["tc_2", false],
      ["tc_3", false],
      ["tc_4", false],
    ]))
  })
})
