import { describe, expect, test } from "bun:test";

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/agent-loop.js";
import { ApiOverloaded } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { ContentFilteredError, ContentRefusedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ProviderStreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { asModelClient, ownHistoryTarget } from "../_model-client.js";
import { assemblyPinned, RequestToolMap } from "../../../../helpers/request-tool-surface.js";
import { compactInput } from "../../../../../src/infra/agent-loop-events.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";


describe("agent loop stream_error recovery", () => {
  test("does not run a queued compaction after a failed checkpoint turn", async () => {
    let streamCalls = 0;
    let drainCalls = 0;
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
        streamCalls++;
        throw new ApiOverloaded({ message: "checkpoint failed" });
      },
      priceFor() {
        return { status: "unavailable", reason: "missing-rate-card" };
      },
    };

    await expect(runAgentLoop({
      client: asModelClient(client),
      tools: await assemblyPinned(new RequestToolMap()),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "failed-checkpoint", promptCacheKey: "failed-checkpoint",
      artifactScopeId: "failed-checkpoint",
      retrievalSessionId: "failed-checkpoint",
      onEvent: () => {},
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      inputSource: {
        drainPending: () => {
          drainCalls++;
          return drainCalls === 1 ? compactInput() : null;
        },
      },
    })).rejects.toMatchObject({ _tag: "ApiOverloaded" });

    expect(streamCalls).toBe(1);
  });

  test("a content filter error takes the content-filter nudge and sends the next request", async () => {
    const requests: ConversationMessage[][] = [];
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      async *streamWithTools(request: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        requests.push([...request.messages]);
        if (requests.length === 1) {
          yield { kind: "text_delta", text: "partial", blockKey: "text" };
          throw normalizeProviderAttemptFailure(new ContentFilteredError("Output blocked by content filtering policy"));
        }
        yield { kind: "text_delta", text: "done", blockKey: "text" };
        yield { kind: "done", stopReason: "end_turn" };
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    };

    await expect(runAgentLoop({
      client: asModelClient(client),
      tools: await assemblyPinned(new RequestToolMap()),
      systemPrompt: stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: "/scratch",
      userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
      providerSessionKey: "content-filter", promptCacheKey: "content-filter",
      artifactScopeId: "content-filter",
      retrievalSessionId: "content-filter",
      onEvent: () => {},
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
    })).resolves.toBeDefined();

    expect(requests).toHaveLength(2);
    const next = requests[1]!;
    expect(next.some((message) => message.kind === "assistant" && JSON.stringify(message.content).includes("partial"))).toBe(true);
    expect(next.at(-1)).toMatchObject({ kind: "user" });
    expect(JSON.stringify(next.at(-1))).toContain("stopped by the provider's content filter");
  });

  // The tool_use event already started the call, so the partial keeps its
  // tool_use block and the call settles: one canonical result, no continuation
  // user message.

  describe("content refusal repair", () => {
    const PROVIDER_MESSAGE = "400 invalid_request_error: Could not process image";
    const REASON = "Could not process image";
    const image = { type: "image" as const, mediaType: "image/png", data: "aGVsbG8=" };
    const readCall = (id: string) => ({ type: "tool_use" as const, id, name: "read", registrationId: "read", input: { path: `${id}.png` } });
    type Refusal = { part?: { toolUseId: string; partIndex: number; kind: "text" | "image" } };

    /** Runs a resumed loop whose fake provider refuses, as an adapter does, while `refuse` returns a refusal, and
     *  otherwise answers "done". */
    async function runRefusingLoop(priorMessages: ConversationMessage[], refuse: (messages: readonly ConversationMessage[]) => Refusal | undefined) {
      const requests: ConversationMessage[][] = [];
      const appended: ConversationMessage[] = [];
      const shown: string[] = [];
      const client: LLMClient = { historyTarget: ownHistoryTarget,
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
        contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
        toolPresentation: FUNCTION_TOOL_PRESENTATION,
        async *streamWithTools(request: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
          requests.push([...request.messages]);
          const refusal = refuse(request.messages);
          if (refusal) throw normalizeProviderAttemptFailure(new ContentRefusedError("Anthropic", new Error(PROVIDER_MESSAGE), { reason: REASON, part: refusal.part }));
          yield { kind: "text_delta", text: "done", blockKey: "text" };
          yield { kind: "done", stopReason: "end_turn" };
        },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      };
      const run = runAgentLoop({
        client: asModelClient(client), tools: await assemblyPinned(new RequestToolMap([["read", {
          name: "read", description: "Read", action: "file_read", isConcurrencySafe: true,
          inputSchema: { type: "object", properties: {} }, execute: async () => ({ content: "unused", outcome: "ok" }),
        }]])),
        systemPrompt: stableSystemPrompt("test"), instruction: null,
        executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch",
        providerSessionKey: "content-refusal", promptCacheKey: "content-refusal", artifactScopeId: "content-refusal", retrievalSessionId: "content-refusal",
        onEvent: () => {},
        onSystemMessage: (message) => { shown.push(message); },
        persistence: { history: { append: (message) => { appended.push(message); } } },
        seed: { kind: "resume", priorMessages },
      });
      return { run, requests, appended, shown };
    }

    const firstImage = (messages: readonly ConversationMessage[]): Refusal | undefined => {
      for (const message of messages) {
        if (message.kind !== "toolResult") continue;
        const partIndex = message.content.findIndex((part) => part.type === "image");
        if (partIndex >= 0) return { part: { toolUseId: message.toolUseId, partIndex, kind: "image" } };
      }
      return undefined;
    };
    const decisions = (messages: readonly ConversationMessage[]) => messages.filter((message): message is Extract<ConversationMessage, { kind: "system" }> => message.kind === "system" && message.contentRepair !== undefined);
    const toolUseIds = (messages: readonly ConversationMessage[]) => messages.flatMap((message) =>
      message.kind === "assistant" && typeof message.content !== "string" ? message.content.flatMap((block) => block.type === "tool_use" ? [block.id] : []) : []);

    test("withholds each refused image in turn, and the model and the live transcript receive each decision's note", async () => {
      const ids = Array.from({ length: 7 }, (_, index) => `call-${index}`);
      const { run, requests, appended, shown } = await runRefusingLoop([
        { kind: "user", content: "look at the screenshots" },
        { kind: "assistant", content: ids.map(readCall) },
        ...ids.map((id): ConversationMessage => ({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "(1920x1080)" }, image] })),
        { kind: "user", content: "Describe what the screenshots showed." },
      ], firstImage);

      await expect(run).resolves.toBeDefined();

      expect(requests).toHaveLength(8);
      const withholds = decisions(appended);
      expect(withholds.map((decision) => decision.kind === "system" && decision.contentRepair)).toEqual(ids.map((id) => ({ kind: "withhold", toolUseId: id, partIndex: 1, partKind: "image" })));
      expect(shown).toEqual(withholds.map((decision) => decision.content));
      const last = requests[7]!;
      expect(last.some((message) => message.kind === "toolResult" && message.content.some((part) => part.type === "image"))).toBe(false);
      for (const [index, id] of ids.entries()) {
        const result = last.find((message) => message.kind === "toolResult" && message.toolUseId === id);
        expect(result?.kind === "toolResult" && result.content[1]).toEqual({ type: "text", text: withholds[index]!.content });
      }
    });

    test("removes the newest assistant message's calls when the named part is already withheld", async () => {
      const { run, requests, appended } = await runRefusingLoop([
        { kind: "user", content: "look" },
        { kind: "assistant", content: [readCall("call-a"), readCall("call-b")] },
        { kind: "toolResult", toolUseId: "call-a", content: [{ type: "text", text: "(1x1)" }, image] },
        { kind: "toolResult", toolUseId: "call-b", content: [image] },
        { kind: "system", content: "[withheld]", contentRepair: { kind: "withhold", toolUseId: "call-a", partIndex: 1, partKind: "image" } },
      ], (messages) => toolUseIds(messages).length > 0 ? { part: { toolUseId: "call-a", partIndex: 1, kind: "image" } } : undefined);

      await expect(run).resolves.toBeDefined();

      expect(requests).toHaveLength(2);
      const [removal] = decisions(appended);
      expect(removal?.kind === "system" && removal.contentRepair).toEqual({ kind: "remove", toolUseIds: ["call-a", "call-b"] });
      expect(requests[1]!.some((message) => message.kind === "user" && message.origin === "system" && message.content === removal!.content)).toBe(true);
    });

    test("a second pathless refusal after the removal ends the run with the provider's message", async () => {
      const { run, requests, appended } = await runRefusingLoop([
        { kind: "user", content: "look" },
        { kind: "assistant", content: [readCall("call-a")] },
        { kind: "toolResult", toolUseId: "call-a", content: [image] },
      ], () => ({}));

      await expect(run).rejects.toMatchObject({ _tag: "ContentRefused", message: PROVIDER_MESSAGE });

      expect(requests).toHaveLength(2);
      expect(toolUseIds(requests[1]!)).toEqual([]);
      expect(requests[1]!.some((message) => message.kind === "toolResult")).toBe(false);
      const [removal, ...rest] = decisions(appended);
      expect(rest).toEqual([]);
      expect(requests[1]!.some((message) => message.kind === "user" && message.origin === "system" && message.content === removal!.content)).toBe(true);
    });

    const removable: ConversationMessage[] = [
      { kind: "user", content: "look" },
      { kind: "assistant", content: [readCall("call-a")] },
      { kind: "toolResult", toolUseId: "call-a", content: [image] },
      { kind: "assistant", content: [readCall("call-b")] },
      { kind: "toolResult", toolUseId: "call-b", content: [{ type: "text", text: "listing" }] },
    ];
    const locatedAfterPathless = (messages: readonly ConversationMessage[]): Refusal => toolUseIds(messages).includes("call-b") ? {} : { part: { toolUseId: "call-a", partIndex: 0, kind: "image" } };

    test("a located refusal after the removal's one retry ends the run", async () => {
      const { run, requests, appended } = await runRefusingLoop([...removable], locatedAfterPathless);

      await expect(run).rejects.toMatchObject({ _tag: "ContentRefused", message: PROVIDER_MESSAGE });

      expect(requests).toHaveLength(2);
      expect(decisions(appended).map((decision) => decision.kind === "system" && decision.contentRepair?.kind)).toEqual(["remove"]);
    });

    test("a located refusal ends a run resumed after a removal", async () => {
      const { run, requests, appended } = await runRefusingLoop([
        ...removable,
        { kind: "system", content: "[removed]", contentRepair: { kind: "remove", toolUseIds: ["call-b"] } },
      ], locatedAfterPathless);

      await expect(run).rejects.toMatchObject({ _tag: "ContentRefused", message: PROVIDER_MESSAGE });

      expect(requests).toHaveLength(1);
      expect(decisions(appended)).toEqual([]);
    });

    test("a pathless refusal with no tool calls to remove ends the run at once", async () => {
      const { run, requests, appended } = await runRefusingLoop([
        { kind: "user", content: "look" },
        { kind: "assistant", content: "nothing to call" },
        { kind: "user", content: "again" },
      ], () => ({}));

      await expect(run).rejects.toMatchObject({ _tag: "ContentRefused", message: PROVIDER_MESSAGE });

      expect(requests).toHaveLength(1);
      expect(decisions(appended)).toEqual([]);
    });

    test("a resumed history that still holds a refused image beside an earlier decision withholds it and continues", async () => {
      const { run, requests, appended } = await runRefusingLoop([
        { kind: "user", content: "look" },
        { kind: "assistant", content: [readCall("call-a"), readCall("call-b")] },
        { kind: "toolResult", toolUseId: "call-a", content: [image] },
        { kind: "toolResult", toolUseId: "call-b", content: [image] },
        { kind: "system", content: "[earlier withhold]", contentRepair: { kind: "withhold", toolUseId: "call-a", partIndex: 0, partKind: "image" } },
      ], firstImage);

      await expect(run).resolves.toBeDefined();

      expect(requests).toHaveLength(2);
      const [withhold] = decisions(appended);
      expect(withhold?.kind === "system" && withhold.contentRepair).toEqual({ kind: "withhold", toolUseId: "call-b", partIndex: 0, partKind: "image" });
      const results = requests[1]!.filter((message) => message.kind === "toolResult").map((message) => message.kind === "toolResult" && message.content);
      expect(results).toEqual([[{ type: "text", text: "[earlier withhold]" }], [{ type: "text", text: withhold!.content }]]);
    });
  });
});
