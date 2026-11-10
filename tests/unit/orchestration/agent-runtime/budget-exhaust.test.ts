/**
 * Budget-exhaust turns under provider failover.
 *
 * Each exhaust request uses one admitted provider walk.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { openStandaloneTurn, RunLifecycle } from "../../../../src/orchestration/agent-runtime/run-lifecycle.js";
import { RequestToolMap } from "../../../helpers/request-tool-surface.js";
import { runBudgetExhaustionTurn } from "../../../../src/orchestration/agent-runtime/budget-exhaust.js";
import { resolveModelInteractionProfile } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import {
  FUNCTION_TOOL_PRESENTATION,
  type ConversationMessage,
  type ModelClient,
  type ProviderStreamEvent,
  type ServingAttempt,
  type StreamOptions,
} from "../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js";
import { makeContext } from "./tools/_fixtures.js";
import type { ToolResultEntry } from "../../../../src/orchestration/agent-runtime/agent-state.js";
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js";
import { AllCandidatesExhaustedError, QuotaExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { withRequestAdmission, ownHistoryTarget } from "./_model-client.js";
import { tokenCountingPolicy, type TokenCountingPolicy } from "../../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { prepareLocalTokenizer } from "../../../../src/infra/local-tokenizer.js";
import { handoffDefinition } from "../../../../src/orchestration/agent-runtime/tools/handoff.js";
import { renderSystemPrompt, stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { loginWaitingRequest } from "./_login-wait-fixture.js";
import { createHandoffTracker } from "../../../../src/orchestration/agent-runtime/agent-loop-handoff.js";

const turns: ReturnType<typeof openStandaloneTurn>[] = [];
afterEach(async () => { for (const turn of turns.splice(0)) await turn.end(); });
function openTurn() {
  const turn = openStandaloneTurn();
  turns.push(turn);
  return turn;
}

function summaryClient(prepared: StreamOptions[]): ModelClient {
  const attempt = { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const) } as const;
  return withRequestAdmission({
    model: "test-model",
    modelFamily: "anthropic",
    plannedAttempt: async () => attempt,
    async *streamWithTools(options) {
      prepared.push(options);
      yield { kind: "text_delta", text: "the whole summary", blockKey: "text" };
      yield { kind: "done", stopReason: "end_turn" };
    },
  });
}

function strictSettlementClient(onPrepare: () => void): ModelClient {
  const attempt = { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const) } as const;
  return withRequestAdmission({
    model: attempt.model, modelFamily: attempt.modelFamily, plannedAttempt: async () => attempt,
    async *streamWithTools() {
      onPrepare();
      throw normalizeProviderAttemptFailure(new QuotaExhaustedError("provider quota"));
    },
  });
}

describe("budget exhaust turn under failover", () => {
  it.each([false, true])("preserves a declined login during the %s forced-handoff variant", async (handoffConfigured) => {
    const fixture = loginWaitingRequest();
    const pushed: ConversationMessage[] = [];
    let captures = 0;
    const interactionProfile = resolveModelInteractionProfile("test-model", "openai");
    const tools = new RequestToolMap(handoffConfigured ? [["handoff", handoffDefinition]] : []);
    const pending = runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker(),
      captureRequest: async () => {
        captures++;
        return {
          client: fixture.client, request: await fixture.client.admitRequest(), interactionProfile,
          providerOptions: undefined, tools, appendEntries: async () => {}, materializeCandidatePolicy: () => {},
          prepareOutgoing: () => ({
            messages: [], prepared: { systemPrompt: stableSystemPrompt("test"), tools: [], auditTools: [], attemptStaticTokens: 0, contextApplication: { identity: "test", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [] },
            staleMasking: undefined, toolHistoryProjection: undefined, messageCount: 0, estimatedContextTokens: 0,
          }),
        };
      },
      artifactScopeId: "declined-budget", background: undefined, turn: openTurn(), signal: undefined,
      requestAudit: undefined, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "declined-budget", promptCacheKey: "declined-budget",
      onEvent: () => {}, maxLLMCalls: 0, handoffConfigured,
      toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
      pushMessage: (message) => { pushed.push(message); }, pushUser: () => {}, pushToolResults: () => {},
    });
    const declined = fixture.entered.then(() => {
      const question = fixture.observations.loginQuestions()[0]!;
      fixture.observations.answerLogin(question.id, "declined");
    });
    await expect(pending).rejects.toMatchObject({ _tag: "ApiError", message: "login refused" });
    await declined;
    expect(captures).toBe(1);
    expect(fixture.calls()).toBe(1);
    expect(pushed).toEqual([]);
  });

  it("does not publish a fallback after its owned turn is interrupted", async () => {
    const lifecycle = new RunLifecycle<{ handoffWritten: boolean }>();
    const prepared: StreamOptions[] = [];
    const pushed: ConversationMessage[] = [];
    const client = summaryClient(prepared);
    const interactionProfile = resolveModelInteractionProfile("test-model", "anthropic");
    expect(lifecycle.start(async () => {
      const turn = lifecycle.beginTurn();
      try {
        return await runBudgetExhaustionTurn({
          handoffTracker: createHandoffTracker(),
          captureRequest: async () => {
            lifecycle.interrupt();
            return {
              client, request: await client.admitRequest(), interactionProfile,
              providerOptions: undefined, tools: new RequestToolMap(), appendEntries: async () => {}, materializeCandidatePolicy: () => {},
              prepareOutgoing: () => ({
                messages: [], prepared: { systemPrompt: stableSystemPrompt("test"), tools: [], auditTools: [], attemptStaticTokens: 0, contextApplication: { identity: "test", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [] },
                staleMasking: undefined, toolHistoryProjection: undefined, messageCount: 0, estimatedContextTokens: 0,
              }),
            };
          },
          artifactScopeId: "interrupt-budget", background: undefined, turn, signal: turn.signal,
          requestAudit: undefined, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "interrupt-budget", promptCacheKey: "interrupt-budget",
          onEvent: () => {}, maxLLMCalls: 0, handoffConfigured: false,
          toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
          pushMessage: (message) => { pushed.push(message); }, pushUser: () => {}, pushToolResults: () => {},
        });
      } finally { await turn.end(); }
    })).toBe(true);
    await expect(lifecycle.done).rejects.toBeDefined();
    expect(pushed).toEqual([]);
    expect(prepared).toEqual([]);
  });

  it("records the summary from one admitted provider request", async () => {
    const prepared: StreamOptions[] = [];
    const pushed: ConversationMessage[] = [];
    const messages: ConversationMessage[] = [
      { kind: "assistant", content: [{ type: "tool_use", id: "old-tool", name: "bash", input: { command: "oldmaskedtoolbody" } }] },
      { kind: "toolResult", toolUseId: "old-tool", content: [{ type: "text", text: "oldmaskedtoolbody" }] },
    ];
    const audited: Array<{ systemPrompt: string; interactionProfileId: string; tools: string[]; omittedTools: ReadonlyArray<{ name: string; reason: string }>; attemptStaticTokens: number; messageCount: number; estimatedContextTokens: number; staleMasking: unknown; toolHistoryProjection: unknown }> = [];
    const requestAudit: ProviderRequestAuditWriter = {
      async recordRequest(input) {
        audited.push({ systemPrompt: input.systemPrompt, interactionProfileId: input.interactionProfileId, tools: input.tools.map(({ name }) => name), omittedTools: input.omittedTools, attemptStaticTokens: input.attemptStaticTokens, messageCount: input.messageCount, estimatedContextTokens: input.estimatedContextTokens, staleMasking: input.staleMasking, toolHistoryProjection: input.toolHistoryProjection });
        return { requestId: "capped-request", turn: input.turn };
      },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    };
    const interactionProfile = resolveModelInteractionProfile("gpt-6-luna", "openai");

    const client = summaryClient(prepared);
    const result = await runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker(),
      captureRequest: async () => ({
        client, request: await client.admitRequest(),
        providerOptions: undefined, tools: new RequestToolMap(),
        cacheRetentionPolicies: { anthropic_api: "5m" },
        interactionProfile,
        appendEntries: async () => {}, materializeCandidatePolicy: () => {},
        prepareOutgoing: () => {
          const tools = [{ name: "bash", description: "canonical bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }];
          const preparedAttempt = { systemPrompt: stableSystemPrompt("sys"), tools, auditTools: tools.map(tool => ({ ...tool, registrationId: tool.name, executableId: tool.name })), attemptStaticTokens: Math.ceil(("sys".length + JSON.stringify(tools).length) / 4), contextApplication: { identity: "context", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [] };
          const outgoingMessages: ConversationMessage[] = [
            { kind: "assistant", content: [{ type: "tool_use", id: "old-tool", name: "bash", input: { command: "[Old tool input cleared]" } }] },
            { kind: "toolResult", toolUseId: "old-tool", content: [{ type: "text", text: "[Old tool result cleared]" }] },
            messages[2]!,
          ];
          return {
            messages: outgoingMessages,
            prepared: preparedAttempt,
            staleMasking: { cutoffIndex: 2, masksApplied: 2, bytesSaved: 34, maskedToolUseIds: ["old-tool"], maskedToolUseInputIds: ["old-tool"] },
            toolHistoryProjection: { loweredToolUseIds: ["old-tool"] },
            messageCount: outgoingMessages.length,
            estimatedContextTokens: 41 + preparedAttempt.attemptStaticTokens,
          };
        },
      }),
      requestAudit,
      turnOrdinal: 6,
      cacheRetention: "1h",
      providerSessionKey: "conversation-1", promptCacheKey: "conversation-1",
      artifactScopeId: "artifacts-1",
      background: undefined,
      turn: openTurn(),
      signal: undefined,
      onEvent: () => {},
      maxLLMCalls: 5,
      handoffConfigured: false,
      toolContext: makeContext(),
      afterToolCall: undefined,
      onTurnAssistantMessage: undefined,
      pushMessage: (message) => { pushed.push(message); },
      pushUser: (content) => { messages.push({ kind: "user", content }); },
      pushToolResults: () => {},
    });

    expect(result.handoffWritten).toBe(false);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.reasoningEffort).toBe("low");
    expect(prepared[0]?.cacheRetention).toBe("5m");
    expect(prepared[0]?.providerSessionKey).toBe("conversation-1");
    // The summary step keeps the agent's tools and tool choice; its dispatch refuses every call.
    expect(prepared[0]?.tools.map(({ name }) => name)).toEqual(["bash"]);
    expect(prepared[0]?.toolChoice).toBeUndefined();
    expect(prepared[0]?.messages).not.toEqual(messages);
    expect(JSON.stringify(prepared[0]?.messages)).not.toContain("oldmaskedtoolbody");
    expect(prepared[0]?.messages.at(-1)).toEqual({ kind: "user", content: "Budget exhausted (5 LLM calls used). No tool runs now: provide a final summary of progress and remaining work in text." });
    expect(audited).toEqual([{ systemPrompt: "sys", interactionProfileId: "default", tools: ["bash"], omittedTools: [], attemptStaticTokens: 38, messageCount: 3, estimatedContextTokens: 79, staleMasking: { cutoffIndex: 2, masksApplied: 2, bytesSaved: 34, maskedToolUseIds: ["old-tool"], maskedToolUseInputIds: ["old-tool"] }, toolHistoryProjection: { loweredToolUseIds: ["old-tool"] } }]);
    const assistant = pushed.find((message) => message.kind === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "the whole summary" }]);
  });

  it("rethrows strict audit settlement failure without a second prepare", async () => {
    let prepares = 0;
    const messages: ConversationMessage[] = [];
    const interactionProfile = resolveModelInteractionProfile("gpt-6-luna", "openai");
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest: async (input) => ({ requestId: "strict", turn: input.turn }),
      recordResponse: async () => { throw new Error("strict append failed"); },
      recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    };

    const client = strictSettlementClient(() => { prepares += 1; });
    await expect(runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker(),
      captureRequest: async () => ({
        client, request: await client.admitRequest(), interactionProfile,
        providerOptions: undefined, tools: new RequestToolMap(),
        appendEntries: async () => {}, materializeCandidatePolicy: () => {},
        prepareOutgoing: () => ({ messages: [...messages], prepared: { systemPrompt: stableSystemPrompt("sys"), tools: [], auditTools: [], attemptStaticTokens: 1, contextApplication: { identity: "strict", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [] }, staleMasking: undefined, toolHistoryProjection: undefined, messageCount: messages.length, estimatedContextTokens: 1 }),
      }),
      artifactScopeId: "artifacts-1", background: undefined, turn: openTurn(),
      requestAudit, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "conversation-1", promptCacheKey: "conversation-1", signal: undefined,
      onEvent: () => {}, maxLLMCalls: 1, handoffConfigured: false,
      toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
      pushMessage: () => {}, pushUser: (content) => { messages.push({ kind: "user", content }); }, pushToolResults: () => {},
    })).rejects.toMatchObject({ _tag: "ProviderAuditSettlementError", message: "strict append failed" });
    expect(prepares).toBe(1);
  });

  it.each([undefined, "handoff", "Handoff"])("fences and records the capped handoff (streamed name: %s)", async (streamedName) => {
    const prepared: StreamOptions[] = [];
    const messages: ConversationMessage[] = [];
    const pushed: ConversationMessage[] = [];
    const observedStarts: boolean[] = [];
    let fenced = false;
    const handoffTool = {
      ...handoffDefinition,
      execute: async () => { expect(fenced).toBe(true); return { content: "written", outcome: "ok" as const }; },
    };
    const tools = new RequestToolMap([
      ["handoff", handoffTool],
      ["other", {
        name: "other", action: "ui_meta", description: "other tool", inputSchema: { type: "object", properties: {} },
        promptGuidelines: [], isConcurrencySafe: true,
        execute: async () => ({ content: "unused", outcome: "ok" }),
      } satisfies RuntimeTool],
    ]);
    const interactionProfile = resolveModelInteractionProfile("gpt-6-luna", "openai");

    const attempt = { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const) } as const;
    const client = withRequestAdmission({
      model: attempt.model,
      modelFamily: attempt.modelFamily,
      plannedAttempt: async () => attempt,
      async *streamWithTools(options) {
        prepared.push(options);
        if (streamedName) yield { kind: "tool_input_start", toolUseId: "forced-handoff", name: streamedName } as const;
        yield { kind: "tool_use", toolCall: { id: "forced-handoff", name: streamedName ?? "handoff", input: {} } } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
      },
    });

    const result = await runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker({ onStarted: () => { fenced = true; } }),
      captureRequest: async () => ({
        client, request: await client.admitRequest(), interactionProfile, appendEntries: async () => {}, materializeCandidatePolicy: () => {},
        providerOptions: undefined, tools,
        cacheRetentionPolicies: { anthropic_api: "5m" },
        prepareOutgoing: (servingAttempt) => {
          const selected = [...tools.values()];
          return {
            messages: [...messages],
            prepared: {
              systemPrompt: stableSystemPrompt("sys"), tools: selected.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema })),
              auditTools: selected.map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema, registrationId: name, executableId: name })),
              attemptStaticTokens: selected.length, contextApplication: { identity: "handoff", applications: [] },
              interactionProfileId: interactionProfile.id, omittedTools: [], tokenCountingPolicyIdentity: tokenCountingPolicy(servingAttempt.model, servingAttempt.modelFamily).identity,
            },
            staleMasking: undefined, toolHistoryProjection: undefined, messageCount: messages.length, estimatedContextTokens: selected.length,
          };
        },
      }),
      artifactScopeId: "artifacts-1", background: undefined, turn: openTurn(),
      requestAudit: undefined, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "conversation-1", promptCacheKey: "conversation-1", signal: undefined,
      onEvent: (event) => { if (event.kind === "tool_input_start") observedStarts.push(fenced); },
      maxLLMCalls: 1, handoffConfigured: true,
      toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
      pushMessage: (message) => { pushed.push(message); }, pushUser: (content) => { messages.push({ kind: "user", content }); }, pushToolResults: () => {},
    });

    expect(result.handoffWritten).toBe(true);
    expect(observedStarts).toEqual(streamedName ? [true] : []);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.tools.map(({ name }) => name)).toEqual(["handoff", "other"]);
    expect(prepared[0]?.toolChoice).toBeUndefined();
    expect(prepared[0]?.cacheRetention).toBe("5m");
    expect(pushed).toContainEqual(expect.objectContaining({
      kind: "assistant",
      content: [expect.objectContaining({ id: "forced-handoff", registrationId: "handoff" })],
    }));
  });

  it("keeps the whole tool list and automatic choice at the turn limit, states the notice, and executes only handoff", async () => {
    const prepared: StreamOptions[] = [];
    const messages: ConversationMessage[] = [];
    const results: ToolResultEntry[] = [];
    let otherRuns = 0;
    const tools = new RequestToolMap([
      ["handoff", { ...handoffDefinition, execute: async () => ({ content: "written", outcome: "ok" as const }) }],
      ["other", {
        name: "other", action: "ui_meta", description: "other tool", inputSchema: { type: "object", properties: {} },
        promptGuidelines: [], isConcurrencySafe: true,
        execute: async () => { otherRuns += 1; return { content: "ran", outcome: "ok" }; },
      } satisfies RuntimeTool],
    ]);
    const interactionProfile = resolveModelInteractionProfile("gpt-6-luna", "openai");
    const attempt = { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model", toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const) } as const;
    const client = withRequestAdmission({
      model: attempt.model, modelFamily: attempt.modelFamily, plannedAttempt: async () => attempt,
      async *streamWithTools(options) {
        prepared.push(options);
        yield { kind: "tool_use", toolCall: { id: "late-other", name: "other", input: {} } } as const;
        yield { kind: "tool_use", toolCall: { id: "late-handoff", name: "handoff", input: {} } } as const;
        yield { kind: "done", stopReason: "tool_use" } as const;
      },
    });

    const result = await runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker(),
      captureRequest: async () => ({
        client, request: await client.admitRequest(), interactionProfile, appendEntries: async () => {}, materializeCandidatePolicy: () => {},
        providerOptions: undefined, tools,
        prepareOutgoing: () => {
          const definitions = [...tools.values()].map(({ name, description, inputSchema }) => ({ name, description, input_schema: inputSchema }));
          return {
            messages: [...messages],
            prepared: {
              systemPrompt: stableSystemPrompt("sys"), tools: definitions, auditTools: definitions.map((definition) => ({ ...definition, registrationId: definition.name, executableId: definition.name })),
              attemptStaticTokens: 1, contextApplication: { identity: "limit", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [],
            },
            staleMasking: undefined, toolHistoryProjection: undefined, messageCount: messages.length, estimatedContextTokens: 1,
          };
        },
      }),
      artifactScopeId: "artifacts-1", background: undefined, turn: openTurn(),
      requestAudit: undefined, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "conversation-1", promptCacheKey: "conversation-1", signal: undefined,
      onEvent: () => {}, maxLLMCalls: 7, handoffConfigured: true,
      toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
      pushMessage: () => {}, pushUser: (content) => { messages.push({ kind: "user", content }); },
      pushToolResults: (entries) => { results.push(...entries); },
    });

    expect(result.handoffWritten).toBe(true);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.tools.map(({ name }) => name)).toEqual(["handoff", "other"]);
    expect(prepared[0]?.toolChoice).toBeUndefined();
    expect(prepared[0]?.messages.at(-1)).toEqual({ kind: "user", content: "Budget exhausted (7 LLM calls used). Only handoff runs now: call handoff with a final summary of progress and remaining work." });
    expect(otherRuns).toBe(0);
    const text = (id: string) => results.find((entry) => entry.toolUseId === id)?.content.map((block) => block.type === "text" ? block.text : "").join("");
    expect(text("late-other")).toBe("The other tool is unavailable to this agent now: the turn budget is spent. Do not call other again; call handoff.");
    expect(text("late-handoff")).toBe("written");
  });

  it("materializes each failover candidate policy before computing its request costs", async () => {
    await prepareLocalTokenizer();
    const preparedRequests: StreamOptions[] = [];
    const attempts: ServingAttempt[] = ["claude-opus-3", "claude-opus-5"].map((model) => ({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model, toolPresentation: FUNCTION_TOOL_PRESENTATION,
      tokenizerIdentity: model === "claude-opus-3" ? "ClaudeV3" : "ClaudeV5",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" }, priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    }));
    const streams: Array<(options: StreamOptions) => AsyncGenerator<ProviderStreamEvent>> = [
      async function* (options) { preparedRequests.push(options); throw normalizeProviderAttemptFailure(new QuotaExhaustedError("provider quota")); },
      async function* (options) { preparedRequests.push(options); yield { kind: "text_delta", text: "summary", blockKey: "text" }; yield { kind: "done", stopReason: "end_turn" }; },
    ];
    const plannedAttempt = async () => attempts[0]!;
    const client: ModelClient = {
      model: attempts[0]!.model, modelFamily: "anthropic", plannedAttempt,
      admitRequest: async () => ({
        candidateAttributions: [], plannedAttempt,
        prepare: async () => { throw new Error("this fake serves sends only") },
        run: async ({ execute, prepare }) => {
          for (const [index, attempt] of attempts.entries()) {
            const preparedRequest = await prepare(attempt);
            const result = await execute({ attempt, client: { historyTarget: ownHistoryTarget, ...attempt, streamWithTools(options) {
              expect(preparedRequest.messages).toBe(options.messages);
              expect(options.systemPrompt).toEqual(preparedRequest.systemPrompt);
              expect(options.tools).toBe(preparedRequest.tools);
              // SAFETY: the attempts and streams fixtures are parallel arrays.
              return streams[index]!(options);
            } }, prepared: preparedRequest, sample: 1, repetitionGuard: "detect" });
            if (result.kind === "success") return result.value;
          }
          throw new AllCandidatesExhaustedError({ message: "all candidates exhausted", recovery: { kind: "none" } });
        },
      }),
    };
    const interactionProfile = resolveModelInteractionProfile("claude-opus-5", "anthropic");
    const messages: ConversationMessage[] = [];
    let policy: TokenCountingPolicy | undefined;
    const materializedPolicies: string[] = [];

    await runBudgetExhaustionTurn({
      handoffTracker: createHandoffTracker(),
      captureRequest: async () => ({
        client, request: await client.admitRequest(), interactionProfile,
        providerOptions: undefined, tools: new RequestToolMap(),
        appendEntries: async () => {}, materializeCandidatePolicy: (attempt) => {
          policy = tokenCountingPolicy(attempt.model, attempt.modelFamily, attempt.tokenizerIdentity);
          materializedPolicies.push(policy.identity);
        },
        prepareOutgoing: () => {
          if (!policy) throw new Error("candidate policy was not materialized");
          const systemPrompt = stableSystemPrompt("candidate request cost ".repeat(50));
          const attemptStaticTokens = policy.countText(renderSystemPrompt(systemPrompt));
          return {
            messages: [...messages],
            prepared: { systemPrompt, tools: [], auditTools: [], attemptStaticTokens, tokenCountingPolicyIdentity: policy.identity, contextApplication: { identity: "candidate", applications: [] }, interactionProfileId: interactionProfile.id, omittedTools: [] },
            staleMasking: undefined, toolHistoryProjection: undefined, messageCount: messages.length, estimatedContextTokens: attemptStaticTokens,
          };
        },
      }),
      artifactScopeId: "artifacts-1", background: undefined, turn: openTurn(),
      requestAudit: undefined, turnOrdinal: 1, cacheRetention: undefined, providerSessionKey: "conversation-1", promptCacheKey: "conversation-1", signal: undefined,
      onEvent: () => {}, maxLLMCalls: 1, handoffConfigured: false,
      toolContext: makeContext(), afterToolCall: undefined, onTurnAssistantMessage: undefined,
      pushMessage: () => {}, pushUser: (content) => { messages.push({ kind: "user", content }); }, pushToolResults: () => {},
    });

    expect(materializedPolicies).toEqual(["local:ClaudeV3", "local:ClaudeV5"]);
    expect(preparedRequests.map(({ estimatedContextTokens }) => estimatedContextTokens)).toEqual(
      preparedRequests.map(({ systemPrompt }, index) => tokenCountingPolicy(attempts[index]!.model, "anthropic", attempts[index]!.tokenizerIdentity).countText(renderSystemPrompt(systemPrompt))),
    );
  });
});
