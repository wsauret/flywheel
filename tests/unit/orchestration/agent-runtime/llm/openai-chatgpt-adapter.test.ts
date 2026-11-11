import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { preparedRequest } from "./_provider-chain-harness.js";
import { Redacted } from "effect";
import { Log } from "../../../../../src/infra/log.js";
import { candidateProviderId, type AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import type { OpenAIAuth } from "../../../../../src/infra/auth/openai-auth-types.js";
import { createFailoverClient, createRoutingDecisions } from "../../../../../src/orchestration/agent-runtime/llm/failover-client.js";
import { testProviderSelection } from "../../../../helpers/provider-authority.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { isFailoverFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import {
  COST_INFO,
  collectStreamEvents,
  installChatGptAdapterModuleMocks,
  setMockResponseUsage,
  state,
  REASONING_INFO,
} from "./_openai-chatgpt-adapter-fixtures.js";

installChatGptAdapterModuleMocks();

// ---------------------------------------------------------------------------
// createOpenAIAdapter: auth routing
// ---------------------------------------------------------------------------

describe("createOpenAIAdapter — ChatGPT mode", () => {
  let createOpenAIAdapter: typeof import("../../../../../src/orchestration/agent-runtime/llm/openai.js").createOpenAIAdapter;

  beforeEach(async () => {
    state.streamEvents = [];
    state.webSocketStreamEvents = undefined;
    state.lastResponsesCreateParams = undefined;
    state.invocationOrder = [];
    state.ensureFreshCalls = [];
    state.ensureFreshImpl = undefined;
    const mod = await import("../../../../../src/orchestration/agent-runtime/llm/openai.js");
    createOpenAIAdapter = mod.createOpenAIAdapter;
  });

  it("records value-free request fields for a provider rejection inside an HTTP 200 stream", async () => {
    state.streamEvents = [{ type: "error", error: { code: "unsupported_parameter", message: "input.content is unsupported" } }];
    const warning = spyOn(Log.create({ service: "llm-openai-chatgpt" }), "warn").mockImplementation(() => {});
    try {
      const client = await createOpenAIAdapter({
        kind: "chatgpt",
        accessToken: Redacted.make("test-access"),
        refreshToken: Redacted.make("test-refresh"),
        expiresAtMs: Date.now() + 3_600_000,
      }, "gpt-5.4", REASONING_INFO);
      const failure = await collectStreamEvents(client, {
        messages: [{ kind: "user", content: "private-prompt-marker" }],
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(ProviderAttemptFailure);
      if (!(failure instanceof ProviderAttemptFailure)) throw new Error("expected provider attempt failure");
      expect(failure.failure._tag).toBe("InvalidRequestFailure");
      const diagnostic = warning.mock.calls.find(([message]) => message === "ChatGPT backend request rejected");
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.[1]).toMatchObject({ transport: "http", requestFields: { input: { count: 1 } } });
      expect(JSON.stringify(diagnostic)).not.toContain("private-prompt-marker");
    } finally {
      warning.mockRestore();
    }
  });

  it("produces a client with provider 'openai' in chatgpt mode", async () => {
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", REASONING_INFO);
    expect(client.accessProvider).toBe("chatgpt");
    expect(client.modelFamily).toBe("openai");
    expect(client.model).toBe("gpt-5.4");
  });

  it("returns an external attempt failure when request-time refresh is rejected without notice or model dispatch", async () => {
    const originalFetch = globalThis.fetch;
    let modelDispatches = 0;
    globalThis.fetch = Object.assign(async () =>
      new Response(JSON.stringify({ error: { code: "refresh_token_expired", message: "expired" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }), { preconnect: () => {} });
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("expired-access"),
      refreshToken: Redacted.make("expired-refresh"),
      expiresAtMs: 1,
      accountId: "account-a",
    };

    try {
      const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO, {
        oauthPersistence: "memory-only",
      });
      const failure = await collectStreamEvents(client, {
        onDispatch: () => { modelDispatches += 1; },
      }).catch((error) => error);

      expect(failure).toBeInstanceOf(ProviderAttemptFailure);
      expect(modelDispatches).toBe(0);
      expect(state.invocationOrder).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("priceFor charges reasoning_tokens once because output_tokens already include them", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    const events = await collectStreamEvents(client);
    const usageEvent = events.find((event) => event.kind === "usage");
    const cost = client.priceFor({
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 50,
    });

    expect(usageEvent).toMatchObject({
      inputTokens: 1000,
      outputTokens: 200,
      reasoningTokens: 50,
    });
    expect(cost.status).toBe("priced");
    if (cost.status === "priced") expect(cost.amountUsd).toBeCloseTo((1000 * 2.5 + 200 * 15) / 1_000_000, 10);
  });

  it("streams OpenAI reasoning summary deltas as live thinking deltas", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_test" } },
      // A proxy can stream an item at another output_index than its position in the completed response.
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 1, delta: "Inspecting " },
      { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 1, delta: "events" },
      { type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 1 },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
          output: [{ type: "reasoning", id: "rs_1", encrypted_content: "ENC", summary: [{ type: "summary_text", text: "Inspecting events" }] }],
        },
      },
    ];
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", { ...COST_INFO, reasoning: true });

    const events = await collectStreamEvents(client);

    expect(events.flatMap((event) => event.kind === "thinking_delta" ? [event.text] : [])).toEqual(["Inspecting ", "events", "\n\n"]);
    const draft = events.find((event) => event.kind === "thinking_complete");
    expect(draft).toMatchObject({
      kind: "thinking_complete",
      thinking: "Inspecting events\n\n",
    });
    // The persisted item names the row its summary streamed into, so that row settles to it.
    expect(events.find((event) => event.kind === "reasoning")).toMatchObject({ kind: "reasoning", id: "rs_1", blockKey: draft?.kind === "thinking_complete" ? draft.blockKey : "missing" });
  });

  it("marks reasoning active when an OpenAI reasoning item starts", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_test", summary: [] } },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
          output: [],
        },
      },
    ];
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", { ...COST_INFO, reasoning: true });

    const events = await collectStreamEvents(client);

    const responseStartedIndex = events.findIndex((event) => event.kind === "provider_response_started");
    expect(events[responseStartedIndex + 1]).toEqual({
      kind: "thinking_delta",
      text: "",
      blockKey: expect.any(String),
    });
    expect(events.filter((event) => event.kind === "thinking_delta")).toHaveLength(1);
  });

  it("skips provider keepalive heartbeats without treating them as response progress", async () => {
    state.streamEvents = [
      { type: "keepalive" },
      { type: "response.created", response: { id: "resp_test" } },
      { type: "keepalive" },
      { type: "response.output_text.delta", delta: "hi" },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } },
          output: [],
        },
      },
    ];
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    const events = await collectStreamEvents(client);

    // Heartbeats are skipped; real events still drive the stream normally.
    expect(events.filter((event) => event.kind === "provider_response_started")).toHaveLength(1);
    expect(events.flatMap((event) => event.kind === "text_delta" ? [event.text] : [])).toEqual(["hi"]);
    expect(events.find((event) => event.kind === "usage")).toMatchObject({ inputTokens: 10, outputTokens: 5 });
  });


  it("records a WebSocket quota failure so a later automatic chain request skips ChatGPT", async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    state.webSocketStreamEvents = [
      {
        type: "response.failed",
        response: {
          id: "resp_ws",
          status: "failed",
          error: { code: "usage_limit_reached", message: "You have hit your ChatGPT usage limit.", resets_at: resetsAtSeconds },
        },
      },
    ];
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    // This test's own account binding: nothing it observes reaches another test.
    const availability = createProviderAvailability().forCandidates("default", [{ kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" }]);
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO, { availability, candidate: { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" } });

    await expect(collectStreamEvents(client)).rejects.toThrow("You have hit your ChatGPT usage limit.");
    expect(availability.chatGptStanding({ kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" })).toMatchObject({ kind: "suppressed", exhaustion: { resetsAtMs: resetsAtSeconds * 1000 } });

    const chain = await createFailoverClient({
      model: "gpt-5.4",
      family: "openai",
      routing: createRoutingDecisions(),
      candidateAttributions: [{ candidate: { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" }, wireModelId: "gpt-5.4", dataUse: "standard" }, { candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, wireModelId: "gpt-5.4", dataUse: "standard" }],
      build: async ({ candidate }) => {
        const adapter = await createOpenAIAdapter(
          candidateProviderId(candidate) === "chatgpt" ? auth : { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") },
          "gpt-5.4",
          COST_INFO,
          { availability, candidate },
        );
        return { attempt: adapter, connect: async () => adapter };
      },
      availability,
      shortName: testProviderSelection().shortName,
    });

    // A ModelClient names no provider of its own; the planned attempt does.
    expect((await chain.plannedAttempt()).accessProvider).toBe("openai_api");
  });

  it("returns the typed terminal ChatGPT quota failure without obsolete deferral", async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    state.webSocketStreamEvents = [
      { type: "error", code: "usage_limit_reached", message: "You have hit your ChatGPT usage limit.", resets_at: resetsAtSeconds },
    ];
    setMockResponseUsage();
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const availability = createProviderAvailability().forCandidates("default", [{ kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" }]);
    const built: AccessProviderId[] = [];
    const chain = await createFailoverClient({
      model: "gpt-5.4",
      family: "openai",
      routing: createRoutingDecisions(),
      candidateAttributions: [{ candidate: { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" }, wireModelId: "gpt-5.4", dataUse: "standard" }, { candidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" }, wireModelId: "gpt-5.4", dataUse: "standard" }],
      build: async ({ candidate }) => {
        const provider = candidateProviderId(candidate);
        built.push(provider);
        const client = await createOpenAIAdapter(
          provider === "chatgpt" ? auth : { kind: "apiKey", apiKey: Redacted.make("[redacted secret]") },
          "gpt-5.4",
          COST_INFO,
          { availability, candidate },
        );
        return { attempt: client, connect: async () => client };
      },
      availability,
      shortName: testProviderSelection().shortName,
    });

    const events = await (await chain.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ client: adapter }) => {
        try {
          return { kind: "success", value: await collectStreamEvents(adapter) };
        } catch (error) {
          if (!(error instanceof ProviderAttemptFailure) || !isFailoverFailure(error.failure)) throw error;
          return { kind: "provider_failure", failure: error.failure };
        }
      },
    });
    expect(events).toContainEqual(expect.objectContaining({ kind: "done" }));
    expect(built).toEqual(["chatgpt", "openai_api"]);
    expect(availability.chatGptStanding({ kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" })).toMatchObject({ kind: "suppressed", exhaustion: { resetsAtMs: resetsAtSeconds * 1000 } });
  });

  it("streams OpenAI raw reasoning text deltas as live thinking deltas", async () => {
    state.streamEvents = [
      { type: "response.created", response: { id: "resp_test" } },
      { type: "response.reasoning_text.delta", output_index: 0, delta: "Raw " },
      { type: "response.reasoning_text.delta", output_index: 0, delta: "thought" },
      {
        type: "response.completed",
        response: {
          id: "resp_test",
          status: "completed",
          usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: { reasoning_tokens: 3 } },
          output: [],
        },
      },
    ];
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", { ...COST_INFO, reasoning: true });

    const events = await collectStreamEvents(client);

    expect(events.flatMap((event) => event.kind === "thinking_delta" ? [event.text] : [])).toEqual(["Raw ", "thought"]);
    expect(events.find((event) => event.kind === "thinking_complete")).toMatchObject({
      kind: "thinking_complete",
      thinking: "Raw thought",
    });
  });

  it("records one dispatch when setup-only WebSocket selection uses SSE", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);
    state.invocationOrder.length = 0;
    let dispatches = 0;

    await collectStreamEvents(client, { onDispatch: () => { dispatches += 1; } });

    expect(state.invocationOrder).toEqual(["sse"]);
    expect(dispatches).toBe(1);
  });

  it("uses pricing in chatgpt mode once model info is cached", async () => {
    setMockResponseUsage({ inputTokens: 1200, outputTokens: 300, reasoningTokens: 80 });
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client);

    const price = client.priceFor({
      input: 1200,
      output: 300,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 80,
    });
    expect(price.status).toBe("priced");
    if (price.status === "priced") expect(price.amountUsd).toBeCloseTo((1200 * 2.5 + 300 * 15) / 1_000_000, 10);
  });

  it("sends top-level instructions for ChatGPT backend streaming requests", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, { systemPrompt: stableSystemPrompt("Follow Flywheel QA instructions.") });

    expect(state.lastResponsesCreateParams).toMatchObject({
      instructions: "Follow Flywheel QA instructions.",
      store: false,
    });
    const input = state.lastResponsesCreateParams?.input;
    expect(Array.isArray(input) && input.some((item) => "role" in item && (item.role === "system" || item.role === "developer"))).toBe(false);
  });

  it("preflights ChatGPT auth once with the turn's signal and no notice before streaming", async () => {
    setMockResponseUsage();
    const signal = new AbortController().signal;
    state.ensureFreshImpl = async () => ({
      accessToken: Redacted.make("chatgpt-access-token"),
      refreshToken: Redacted.make("chatgpt-refresh-token"),
      expiresAtMs: Date.now() + 3_600_000,
    });
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() - 1,
    };
    const tokenAccessor = {
      fresh: async (options: Parameters<NonNullable<typeof state.ensureFreshImpl>>[1]) => {
        state.ensureFreshCalls.push({ signal: options?.signal });
        const tokens = await state.ensureFreshImpl?.(auth, options);
        if (!tokens) throw new Error("expected refreshed ChatGPT tokens");
        return tokens;
      },
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO, { tokenAccessor });

    const events = await collectStreamEvents(client, { signal });

    expect(state.ensureFreshCalls).toEqual([{ signal }]);
    expect(events.find((event) => event.kind === "usage")).toBeDefined();
  });

  it("uses the higher GPT-5.4 rate when prompt usage crosses 200k tokens", async () => {
    setMockResponseUsage({
      inputTokens: 220_000,
      outputTokens: 200,
      cachedTokens: 60_000,
      reasoningTokens: 50,
    });
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    const events = await collectStreamEvents(client);
    const usageEvent = events.find((event) => event.kind === "usage");
    const cost = client.priceFor({
      input: 160_000,
      output: 200,
      cacheRead: 60_000,
      cacheWrite: 0,
      reasoning: 50,
    });

    expect(usageEvent).toMatchObject({
      inputTokens: 160_000,
      outputTokens: 200,
      cacheReadTokens: 60_000,
      reasoningTokens: 50,
    });
    expect(cost.status).toBe("priced");
    if (cost.status === "priced") expect(cost.amountUsd).toBeCloseTo((160_000 * 5 + 200 * 22.5 + 60_000 * 0.5) / 1_000_000, 10);
  });

  it("sends top-level instructions for OpenAI API streaming requests", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, { systemPrompt: stableSystemPrompt("Follow Flywheel QA instructions.") });

    expect(state.lastResponsesCreateParams).toMatchObject({
      instructions: "Follow Flywheel QA instructions.",
      store: false,
    });
    const input = state.lastResponsesCreateParams?.input;
    expect(Array.isArray(input) && input.some((item) => "role" in item && (item.role === "system" || item.role === "developer"))).toBe(false);
  });

  it("passes 24h prompt cache retention when requested", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, { cacheRetention: "24h" });

    expect(state.lastResponsesCreateParams).toMatchObject({ prompt_cache_retention: "24h" });
  });

  it("applies agent runtime OpenAI Responses provider options", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", { ...COST_INFO, reasoning: true });

    await collectStreamEvents(client, {
      reasoningEffort: "high",
      tools: [{ name: "read", description: "Read a file", input_schema: { type: "object" } }],
      providerOptions: {
        openai: {
          parallel_tool_calls: true,
          text_verbosity: "medium",
          reasoning_summary: "concise",
          service_tier: "priority",
          extra_body: { metadata: { source: "test" }, store: true },
        },
      },
    });

    expect(state.lastResponsesCreateParams).toMatchObject({
      parallel_tool_calls: true,
      text: { verbosity: "medium" },
      reasoning: { effort: "high", summary: "concise" },
      service_tier: "priority",
      metadata: { source: "test" },
      store: false,
    });
  });

  it("maps the uniform speed option to OpenAI's fast service tier", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, {
      providerOptions: { openai: { speed: "fast" } },
    });

    expect(state.lastResponsesCreateParams).toMatchObject({ service_tier: "fast" });
  });

  it("lets an explicit service_tier win over the speed option", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, {
      providerOptions: { openai: { speed: "fast", service_tier: "flex" } },
    });

    expect(state.lastResponsesCreateParams).toMatchObject({ service_tier: "flex" });
  });

  it("prices an observed fast service tier at the priority multiplier", async () => {
    setMockResponseUsage({ serviceTier: "fast" });
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, {
      providerOptions: { openai: { speed: "fast" } },
    });
    const cost = client.priceFor({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

    expect(cost.status).toBe("priced");
    if (cost.status === "priced") {
      expect(cost.amountUsd).toBeCloseTo(2 * (1000 * 2.5 + 200 * 15) / 1_000_000, 10);
      expect(cost.rateCard.standard.input).toBe(5);
      expect(Object.isFrozen(cost.rateCard.standard)).toBe(true);
    }
  });

  it("prices the requested fast tier when ChatGPT reports the default tier", async () => {
    setMockResponseUsage({ serviceTier: "default" });
    const auth: OpenAIAuth = {
      kind: "chatgpt",
      accessToken: Redacted.make("test-access"),
      refreshToken: Redacted.make("test-refresh"),
      expiresAtMs: Date.now() + 3_600_000,
    };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);

    await collectStreamEvents(client, {
      providerOptions: { openai: { speed: "fast" } },
    });
    const cost = client.priceFor({ input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

    expect(cost.status).toBe("priced");
    if (cost.status === "priced") expect(cost.amountUsd).toBeCloseTo(2 * (1000 * 2.5 + 200 * 15) / 1_000_000, 10);
  });

  it("defaults GPT-5 Responses verbosity low and omits reasoning summary when disabled", async () => {
    setMockResponseUsage();
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", { ...COST_INFO, reasoning: true });

    await collectStreamEvents(client, {
      reasoningEffort: "medium",
      providerOptions: { openai: { reasoning_summary: "off" } },
    });

    expect(state.lastResponsesCreateParams).toMatchObject({
      reasoning: { effort: "medium" },
    });
    expect(state.lastResponsesCreateParams).not.toHaveProperty("text");
    expect(state.lastResponsesCreateParams?.reasoning).not.toHaveProperty("summary");
  });

  it("contextLimit is available immediately after async construction", async () => {
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", COST_INFO);
    expect(client.contextLimit).toBe(1_050_000);
  });

  it("produces a client with provider 'openai' in apiKey mode (regression)", async () => {
    const auth: OpenAIAuth = { kind: "apiKey", apiKey: Redacted.make("test-openai-key") };
    const client = await createOpenAIAdapter(auth, "gpt-5.4", REASONING_INFO);
    expect(client.accessProvider).toBe("openai_api");
    expect(client.modelFamily).toBe("openai");
    expect(client.model).toBe("gpt-5.4");
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
