import { expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import { tmpdir } from "node:os";
import type { ModelInfo, ModelsClient } from "../../../../../src/infra/llm/models.js";
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { createAnthropicAdapter, operationsFromAnthropicClient } from "../../../../../src/orchestration/agent-runtime/llm/anthropic.js";
import type { ConversationMessage, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { fixedRequestToolSurface, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { asModelClient } from "../_model-client.js";
import { wireResponse } from "./_wire-fixtures.js";

const info: ModelInfo = {
  provider: "anthropic", family: "anthropic", id: "claude-fable-5-1", name: "Fable",
  reasoning: true, toolCall: true, attachment: false, temperature: false, openWeights: false,
  cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
  modalities: { input: ["text"], output: ["text"] }, contextLimit: 200_000, outputLimit: 16_384,
};
const models: ModelsClient = {
  async refresh() {},
  getProviderCatalog() { return []; },
  getTokenizerIdentity() { return undefined; },
};
const progress = "Found the cause. Checking the fix.";
function thinking(index: number, text: string, signature: string) {
  return [
    { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } },
    { type: "content_block_delta", index, delta: { type: "signature_delta", signature } },
    { type: "content_block_stop", index },
  ];
}

test("progress streams as presentation, tools run once, and the next request replays signed blocks", async () => {
  const requests: unknown[] = [];
  const operations = operationsFromAnthropicClient(new Anthropic({
    apiKey: "test-key", maxRetries: 0,
    fetch: async (input, init) => {
      requests.push(await new Request(input, init).json());
      const first = requests.length === 1;
      return wireResponse([
        { type: "message_start", message: { id: `msg_${requests.length}`, usage: { input_tokens: 10, output_tokens: 0 } } },
        ...(first ? [
          ...thinking(0, "", "reasoning-signature"),
          ...thinking(1, progress, "progress-signature"),
          { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "call_probe", name: "probe", input: {} } },
          { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{}" } },
          { type: "content_block_stop", index: 2 },
        ] : [
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Verified." } },
          { type: "content_block_stop", index: 0 },
        ]),
        { type: "message_delta", delta: { stop_reason: first ? "tool_use" : "end_turn" }, usage: { output_tokens: 20 } },
        { type: "message_stop" },
      ]);
    },
  }));
  const adapter = await createAnthropicAdapter(Redacted.make("test-key"), info.id, models, { resolvedModelMetadata: info, operations });
  let calls = 0;
  const probe: RuntimeTool = {
    name: "probe", action: "ui_meta", description: "Verify the fix", inputSchema: { type: "object" }, isConcurrencySafe: true,
    async execute() { calls++; return { content: "ok", outcome: "ok" }; },
  };
  const history: ConversationMessage[] = [];
  const events: ProviderStreamEvent[] = [];
  await runAgentLoop({
    client: asModelClient(adapter), tools: await fixedRequestToolSurface(new RequestToolMap([["probe", probe]])),
    systemPrompt: () => stableSystemPrompt("test"), instruction: "Verify the fix", reasoningEffort: async () => "medium",
    executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(), providerSessionKey: "progress-test", promptCacheKey: "progress-test",
    artifactScopeId: "progress-test", retrievalSessionId: "progress-test",
    persistence: { history: { append: (message) => { history.push(message); } } },
    seed: { kind: "fresh" }, onEvent: (event) => { if (event.kind === "thinking_delta" || event.kind === "thinking_complete") events.push(event); },
    inputSource: { drainPending: () => null, prepareWaitForInput: () => ({ commit: async () => null, cancel: async () => {} }) },
  });
  expect(calls).toBe(1);
  expect(requests).toHaveLength(2);
  expect(events).toContainEqual(expect.objectContaining({ kind: "thinking_delta", text: progress, presentation: "progress" }));
  expect(events).toContainEqual(expect.objectContaining({ kind: "thinking_complete", thinking: "", signature: "reasoning-signature" }));
  expect(history.filter((message) => message.kind === "assistant")[0]).toMatchObject({ content: [
    { type: "thinking", thinking: "", signature: "reasoning-signature" },
    { type: "thinking", thinking: progress, signature: "progress-signature", presentation: "progress" },
    { type: "tool_use", id: "call_probe", name: "probe" },
  ] });
  expect(requests[1]).toMatchObject({ messages: expect.arrayContaining([
    { role: "assistant", content: expect.arrayContaining([
      { type: "thinking", thinking: "", signature: "reasoning-signature" },
      { type: "thinking", thinking: progress, signature: "progress-signature" },
    ]) },
  ]) });
  expect(JSON.stringify(requests[1])).not.toContain('"presentation"');
  expect(history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "Verified." }] });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
