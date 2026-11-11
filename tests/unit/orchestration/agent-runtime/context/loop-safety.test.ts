import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { createHandoffTool } from "../../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { budgetCaptureSurface, makeCaptureClient } from "./_loop-fixtures.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { RequestToolMap, testBaseTools } from "../../../../helpers/request-tool-surface.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { estimateConversationTokens, tokenCountingPolicy } from "../../../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { createAgentRunTally } from "../../../../../src/orchestration/agent-runtime/agent-loop-state.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { messageInput, type AgentLoopInput } from "../../../../../src/infra/agent-loop-events.js";

const loopIdentity = { userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", providerSessionKey: "loop-safety", promptCacheKey: "loop-safety", artifactScopeId: "loop-safety", retrievalSessionId: "loop-safety" };

describe("agent loop safety limits", () => {
  test("a tool-free one-shot settles unsolicited calls without an exhausted-budget summary", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      { events: [
        { kind: "text_delta", text: "Keep this answer.", blockKey: "answer" },
        { kind: "tool_use", toolCall: { id: "unsolicited", name: "bash", input: { command: "must not execute" } } },
        { kind: "done", stopReason: "tool_use" },
      ] },
      { events: [{ kind: "done", stopReason: "end_turn" }] },
    ]);
    const written: ConversationMessage[] = [];
    const result = await runAgentLoop({
      ...loopIdentity, tools: new RequestToolMap(), client,
      systemPrompt: stableSystemPrompt("test"), instruction: "answer once", executionCwd: "/scratch",
      persistence: { history: { append: (message) => { written.push(message); } } },
      seed: { kind: "fresh" }, onEvent() {}, maxLLMCalls: 1,
    });
    expect(result.kind).toBe("completed");
    expect(capturedMessages).toHaveLength(1);
    const refusal = written.find((message) => message.kind === "toolResult");
    expect(refusal?.kind === "toolResult" && refusal.isError).toBe(true);
    expect(JSON.stringify(refusal)).toContain("Unknown tool");
    expect(JSON.stringify(written)).toContain("Keep this answer.");
  });

  test("terminates after exceeding maxLLMCalls", async () => {
    const requests: StreamOptions[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo 1" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_2", name: "bash", input: { command: "echo 2" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_3", name: "bash", input: { command: "echo 3" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta", text: "Summary of progress.", blockKey: "text" },
          { kind: "done", stopReason: "end_turn" },
        ],
      },
    ], { onRequest: (options) => { requests.push(options); } });

    const result = await runAgentLoop({
      ...loopIdentity,
      sessionId: "agent-session",
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "loop forever",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      maxLLMCalls: 3,
    });

    expect(result.kind).toBe("budget_exhausted");
    expect(capturedMessages.length).toBe(4);
    const finalCallMsgs = capturedMessages[3]!;
    const lastMsg = finalCallMsgs[finalCallMsgs.length - 1]!;
    expect(lastMsg.kind).toBe("user");
    expect(typeof lastMsg.content).toBe("string");
    expect(lastMsg.content).toContain("Budget exhausted");
    expect(requests.map((request) => request.providerSessionKey)).toEqual(Array.from({ length: 4 }, () => "loop-safety"));
  });

  test("a run that recovery starts again at the cap goes straight to the exhaustion step, which is the one call it starts", async () => {
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "Summary of progress.", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ]);
    const tally = createAgentRunTally();
    const result = await runAgentLoop({
      ...loopIdentity, tools: testBaseTools(), client,
      systemPrompt: stableSystemPrompt("test"), instruction: "continue", executionCwd: "/scratch",
      persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
      maxLLMCalls: 3, priorLLMCalls: 3, tally,
    });
    expect(result.kind).toBe("budget_exhausted");
    expect(capturedMessages).toHaveLength(1);
    expect(JSON.stringify(capturedMessages[0]!.at(-1))).toContain("Budget exhausted (3 LLM calls used)");
    expect(tally.requests).toBe(1);
  });

  test("the budget trailer of a recovered run counts the calls of the runs before it", async () => {
    const tools = new RequestToolMap(testBaseTools());
    tools.set("handoff", createHandoffTool({ schema: { input: { type: "object", properties: { summary: { type: "string", description: "Summary" } }, required: ["summary"] } } }));
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_4", name: "bash", input: { command: "echo 4" } } }, { kind: "done", stopReason: "tool_use" }] },
      { events: [{ kind: "tool_use", toolCall: { id: "tc_handoff", name: "handoff", input: { summary: "recovered" } } }, { kind: "done", stopReason: "tool_use" }] },
    ]);
    const result = await runAgentLoop({
      ...loopIdentity, sessionId: "agent-session", tools, client,
      systemPrompt: stableSystemPrompt("test"), instruction: "continue", executionCwd: "/scratch",
      persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
      handoff: { onContent: () => {} },
      // Calls 1 to 3 ran before a provider fault; call 4 reaches the nudge stage of a 5-call budget.
      maxLLMCalls: 5, priorLLMCalls: 3,
    });
    expect(result.kind).toBe("completed");
    expect(JSON.stringify(capturedMessages[1])).toContain("[budget: 1 of 5 turns remain");
  });

  test("a final-summary request that the provider rejects ends the run with that error after one request", async () => {
    let requestCount = 0;
    const rejected = Object.assign(new Error("400 invalid_request_error: the request was rejected"), { status: 400 });
    const written: ConversationMessage[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "tool_use", toolCall: { id: "tc_1", name: "bash", input: { command: "echo 1" } } }, { kind: "done", stopReason: "tool_use" }] },
    ], { onRequest: () => { if (requestCount++ >= 1) throw normalizeProviderAttemptFailure(rejected); } });
    const run = runAgentLoop({
      ...loopIdentity, sessionId: "agent-session", tools: testBaseTools(), client,
      systemPrompt: stableSystemPrompt("test"), instruction: "work", executionCwd: "/scratch",
      persistence: { history: { append: (message) => { written.push(message); } } }, seed: { kind: "fresh" }, onEvent: () => {},
      maxLLMCalls: 1,
    });
    // The walk's classified rejection, which needs a person: no later run can send it again.
    await expect(run).rejects.toMatchObject({ _tag: "ApiError", message: "400 invalid_request_error: the request was rejected", recovery: { kind: "none" } });
    expect(capturedMessages).toHaveLength(2);
    expect(JSON.stringify(written)).not.toContain("gave no final summary");
  });

  test("a batch notice queued after a rejected request does not send the request again", async () => {
    const rejected = Object.assign(new Error("400 invalid_request_error: the request was rejected"), { status: 400 });
    let requestCount = 0;
    const queue: AgentLoopInput[] = [];
    const { client, capturedMessages } = makeCaptureClient([
      { events: [{ kind: "text_delta", text: "unused", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
      { events: [{ kind: "text_delta", text: "unused", blockKey: "text" }, { kind: "done", stopReason: "end_turn" }] },
    ], { onRequest: () => { if (requestCount++ === 0) throw normalizeProviderAttemptFailure(rejected); } });
    const run = runAgentLoop({
      ...loopIdentity, tools: testBaseTools(), client,
      systemPrompt: stableSystemPrompt("test"), instruction: "work", executionCwd: "/scratch",
      persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
      inputSource: {
        drainPending: () => queue.shift() ?? null,
        enqueueRuntimeNotice: (text) => { queue.push(messageInput({ text }, { origin: "silent-system", runtimeNotice: true })); },
      },
      lifecycle: { onToolBatchSettled: () => { queue.push(messageInput({ text: "budget low" }, { origin: "silent-system", runtimeNotice: true })); } },
    });
    await expect(run).rejects.toMatchObject({ _tag: "ApiError", recovery: { kind: "none" } });
    expect(capturedMessages).toHaveLength(1);
  });

  describe("the repetition guard", () => {
    const sameBash = (n: number) => ({ events: [{ kind: "tool_use" as const, toolCall: { id: `tc_${n}`, name: "bash", input: { command: "bun run test" } } }, { kind: "done" as const, stopReason: "tool_use" as const }] });
    const finalAnswer = { events: [{ kind: "text_delta" as const, text: "Done.", blockKey: "text" }, { kind: "done" as const, stopReason: "end_turn" as const }] };

    /** Runs four requests: three identical bash batches, then an answer. `personAfterBatch` queues a person message after that batch. */
    async function requestsWithNotice(personAfterBatch?: number): Promise<boolean[]> {
      const queue: AgentLoopInput[] = [];
      let batches = 0;
      const { client, capturedMessages } = makeCaptureClient([sameBash(1), sameBash(2), sameBash(3), finalAnswer]);
      await runAgentLoop({
        ...loopIdentity, tools: testBaseTools(), client,
        systemPrompt: stableSystemPrompt("test"), instruction: "work", executionCwd: "/scratch",
        persistence: { history: { append: () => {} } }, seed: { kind: "fresh" }, onEvent: () => {},
        inputSource: {
          drainPending: () => queue.shift() ?? null,
          enqueueRuntimeNotice: (text) => { queue.push(messageInput({ text }, { origin: "silent-system", runtimeNotice: true })); },
        },
        lifecycle: {
          onToolBatchSettled: () => {
            batches += 1;
            if (batches === personAfterBatch) queue.push(messageInput({ text: "run the tests again" }));
          },
        },
      });
      return capturedMessages.map((messages) => JSON.stringify(messages.at(-1)).includes("repetition_notice"));
    }

    test("the third identical batch sends a runtime notice with that batch's results, within one turn", async () => {
      expect(await requestsWithNotice()).toEqual([false, false, false, true]);
    });

    test("a person message between batches starts the history again", async () => {
      expect(await requestsWithNotice(2)).toEqual([false, false, false, false]);
    });
  });

  test("a capped handoff run gets a budget trailer at 80% and a handoff-only gate at 95%", async () => {
    const bashTurn = (n: number) => ({
      events: [
        { kind: "tool_use", toolCall: { id: `tc_${n}`, name: "bash", input: { command: `echo ${n}` } } },
        { kind: "done", stopReason: "tool_use" },
      ] satisfies ProviderStreamEvent[],
    });
    const tools = new RequestToolMap(testBaseTools());
    tools.set("handoff", createHandoffTool({ schema: { input: { type: "object", properties: { summary: { type: "string", description: "Summary" } }, required: ["summary"] } } }));
    const capture = await budgetCaptureSurface(() => tools, [[
      bashTurn(1), bashTurn(2), bashTurn(3), bashTurn(4), bashTurn(5),
      { events: [{ kind: "done", stopReason: "end_turn" }] },
    ], [
      {
        events: [
          { kind: "tool_use", toolCall: { id: "tc_handoff", name: "handoff", input: { summary: "capped" } } },
          { kind: "done", stopReason: "tool_use" },
        ],
      },
    ]], (requestCount) => {
      // The first exhaustion step answers with nothing; the next one captures a new surface.
      if (requestCount !== 6) return;
      tools.set("handoff", createHandoffTool({ schema: { input: { type: "object", properties: { summary: { type: "string", description: "Fresh summary" } }, required: ["summary"] } } }));
      capture.advance();
    });

    let handoffContent: { [key: string]: unknown } | undefined;
    const result = await runAgentLoop({
      ...loopIdentity,
      client: capture.client,
      sessionId: "agent-session",
      systemPrompt: (attempt, profile) => stableSystemPrompt(`${attempt.model} profile ${profile.id}`),
      instruction: "work",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      handoff: { onContent: (content) => { handoffContent = content; } },
      onEvent: () => {},
      tools: capture.surface,
      requestAudit: capture.requestAudit,
      // Nudge stage from turn ceil(5 * 0.8) = 4; closure from ceil(5 * 0.95) = 5.
      maxLLMCalls: 5,
    });

    expect(result.kind).toBe("budget_exhausted");
    expect(handoffContent).toEqual({ summary: "capped" });
    expect(capture.requests).toHaveLength(7);
    expect(capture.admissions).toEqual([
      ...Array.from({ length: 6 }, () => ({ generation: 0, uses: 1 })),
      { generation: 1, uses: 1 },
    ]);
    const summaryRequests = capture.requests.slice(5).map(({ options }) => options);
    expect(summaryRequests.map(({ providerSessionKey }) => providerSessionKey)).toEqual(["loop-safety", "loop-safety"]);
    expect(summaryRequests.map(({ providerOptions }) => providerOptions?.openai?.text_verbosity)).toEqual(["low", "high"]);
    // The exhaustion step keeps the agent's whole tool list; only its dispatch narrows to handoff.
    const toolNames = capture.requests[0]!.options.tools.map(({ name }) => name);
    expect(toolNames).toContain("handoff");
    expect(summaryRequests.map((request) => request.tools.map(({ name }) => name))).toEqual([toolNames, toolNames]);
    // A swapped output contract validates the input but never changes the schema the model sees, so the cached prefix holds.
    const handoffSchema = (request: StreamOptions | undefined) => request?.tools.find(({ name }) => name === "handoff")?.input_schema;
    expect(handoffSchema(summaryRequests[1])).toEqual(handoffSchema(summaryRequests[0]));
    expect(JSON.stringify(summaryRequests[1]?.tools)).not.toContain("Fresh summary");
    expect(capture.audits.slice(5).map(({ interactionProfileId }) => interactionProfileId)).toEqual(["default", "default"]);
    expect(capture.audits.slice(5).map(({ systemPrompt }) => systemPrompt)).toEqual(["claude-opus-3 profile default", "gpt-6-luna profile default"]);
    expect(capture.gates.at(-1)).toEqual({ generation: 1, tool: "handoff" });
    expect(capture.audits[6]!.estimatedContextTokens - capture.audits[6]!.attemptStaticTokens).toBe(
      estimateConversationTokens(summaryRequests[1]!.messages, tokenCountingPolicy("gpt-6-luna", "openai")),
    );
    const capturedMessages = capture.requests.map(({ options }) => options.messages);

    // Turn 4's request carries turn 3's results: below the nudge stage, no trailer.
    expect(JSON.stringify(capturedMessages[3])).not.toContain("[budget:");
    // Turn 5's request carries turn 4's results with the budget trailer.
    expect(JSON.stringify(capturedMessages[4])).toContain("[budget: 1 of 5 turns remain");
    // Turn 5 itself is gated: its bash call was denied with a message naming handoff.
    const exhaustRequest = JSON.stringify(capturedMessages[5]);
    expect(exhaustRequest).toContain("Tool 'bash' denied");
    expect(exhaustRequest).toContain("Call handoff now");
  });

  test("the final call keeps the agent's tools, so its request matches the agent's other requests", async () => {
    let firstCallTools: StreamOptions["tools"] | undefined;
    let finalCallTools: StreamOptions["tools"] | undefined;
    let callIndex = 0;
    const responses: Array<{ events: ProviderStreamEvent[] }> = [
      {
        events: [
          { kind: "tool_use" as const, toolCall: { id: "tc_1", name: "bash", input: { command: "echo" } } },
          { kind: "done" as const, stopReason: "tool_use" },
        ],
      },
      {
        events: [
          { kind: "text_delta" as const, text: "Done.", blockKey: "text" },
          { kind: "done" as const, stopReason: "end_turn" },
        ],
      },
    ];

    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(opts: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        if (callIndex === 0) firstCallTools = opts.tools;
        if (callIndex === 1) finalCallTools = opts.tools;
        const response = responses[callIndex++];
        if (!response) throw new Error("No more mock responses");
        for (const event of response.events) yield event;
      },
      priceFor() { return { status: "unavailable", reason: "missing-rate-card" }; },
    };

    await runAgentLoop({
      ...loopIdentity,
      tools: testBaseTools(),
      client: asModelClient(client),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      maxLLMCalls: 1,
    });

    expect(firstCallTools?.length).toBeGreaterThan(0);
    expect(finalCallTools).toEqual(firstCallTools);
  });

});

describe("budget boundaries (T2.3)", () => {
  function buildToolTurns(n: number): Array<{ events: ProviderStreamEvent[] }> {
    const out: Array<{ events: ProviderStreamEvent[] }> = [];
    for (let i = 0; i < n; i++) {
      out.push({
        events: [
          { kind: "tool_use", toolCall: { id: `tc_${i}`, name: "noop_tool", input: {} } },
          { kind: "done", stopReason: "tool_use" },
        ],
      });
    }
    return out;
  }

  test("an uncapped loop runs past 200 calls with no injected wrap-up message", async () => {
    const responses = buildToolTurns(201);
    responses.push({
      events: [
        { kind: "text_delta", text: "wrapping up", blockKey: "text" },
        { kind: "done", stopReason: "end_turn" },
      ],
    });
    const { client, capturedMessages } = makeCaptureClient(responses);

    const result = await runAgentLoop({
      ...loopIdentity,
      tools: testBaseTools(),
      client,
      systemPrompt: stableSystemPrompt("test"),
      instruction: "long task",
      executionCwd: "/scratch",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
    });

    expect(result.kind).toBe("completed");
    // No runtime-injected budget message anywhere in the final request: the
    // soft budget warning was removed after it pressured workers into
    // premature handoffs while its telemetry event had no consumer.
    const finalCall = capturedMessages[capturedMessages.length - 1]!;
    expect(JSON.stringify(finalCall)).not.toContain("LLM calls");
  });

});

