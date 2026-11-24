import { describe, expect, it } from "bun:test"
import { testProviderSessionLifetime } from "../../../../helpers/provider-authority.js";
import type { ProviderRequestAttribution, ProviderStreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import { assembleRuntimeForTurn } from "../../../../../src/orchestration/agent-runtime/runner/runtime-assembly.js"
import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/loop/agent-loop.js"
import { resolveRuntimeConversation } from "../../../../../src/orchestration/agent-runtime/request/runtime-conversation.js"
import type { AgentOptions, RunnableAgentOptions } from "../../../../../src/orchestration/agent-runtime/types.js"
import type { AgentOptionsOverride } from "../_runner-options.js"
import type { ProviderRequestAuditFact } from "../../../../../src/orchestration/session/runtime-facts/provider-request-audit-facts.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { testDirectories } from "../../../../helpers/directories.js"
import { asModelClient } from "../_model-client.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../../helpers/request-tool-surface.js"
import type { GitAiAttributionService, GitAiRequestRegistration } from "../../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js"

/** A client that answers its first `toolTurns` requests with a tool call, so one
 *  run sends `toolTurns + 1` requests through the same audit writer. */
function modelClient(toolTurns = 0) {
  let requests = 0
  return asModelClient({
    accessProvider: "anthropic_api" as const,
    modelFamily: "anthropic" as const,
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      const request = requests++
      if (request < toolTurns) {
        yield { kind: "tool_use", toolCall: { id: `tc_${request}`, name: "read", input: { path: "/nonexistent-audit-probe" } } }
        yield { kind: "done", stopReason: "tool_use" }
        return
      }
      yield { kind: "done", stopReason: "end_turn" }
    },
  })
}

async function assembledRuntime(extraOptions: AgentOptionsOverride, facts: ProviderRequestAuditFact[], client = modelClient()) {
  const options: RunnableAgentOptions = {
    model: "test",
    ...testDirectories(process.cwd()),
    purpose: { kind: "interactive-chat" },
    agentsMd: "",
    onEvent: () => {},
    moduleSelection: testCapabilityModules,
    awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    runtimeSurfaces: {},
    conversation: { kind: "stateless" },
    lifecycle: { kind: "one-shot" },
    auditObserver: (fact: ProviderRequestAuditFact) => { facts.push(fact) },
    ...extraOptions,
  }
  const signal = new AbortController().signal
  return assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options,
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation(options.conversation, {
      providerSessionKey: "agent-runner-id",
      artifactScopeId: "agent-artifacts",
      retrievalSessionId: "agent-retrieval",
    }),
    signal,
    disposalSignal: signal,
    instruction: null,
    currentTurn: undefined,
    personas: new Map(),
    captureModelRuntime: async () => ({ generation: {}, createLLMClient: async () => client }),
    createRunner: () => { throw new Error("unused in this test") },
  })
}

async function recordedFacts(extraOptions: AgentOptionsOverride): Promise<ProviderRequestAuditFact[]> {
  const facts: ProviderRequestAuditFact[] = []
  const attribution: ProviderRequestAttribution = {
    accessProvider: "anthropic_api",
    accessProviderCandidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
  }
  const assembled = await assembledRuntime(extraOptions, facts)
  await assembled.tools.resolve()
  await assembled.requestAudit?.recordRequest({
    requestId: "00000000-0000-4000-8000-000000000001",
    turn: 1,
    attribution,
    systemPrompt: "system",
    messages: [],
    tools: [],
    omittedTools: [],
    messageCount: 0,
    estimatedContextTokens: 0,
    attemptStaticTokens: 1,
    interactionProfileId: "default",
    reasoningEffort: undefined,
    cacheRetention: undefined,
    cacheKey: undefined,
    providerOptions: undefined,
    staleMasking: undefined,
    treeLeafEntryId: await assembled.requestAudit?.captureTreeLeaf?.(),
  })
  return facts
}

function promptAssembled(facts: ProviderRequestAuditFact[]) {
  const fact = facts.find((candidate) => candidate.type === "prompt.assembled")
  if (!fact || fact.type !== "prompt.assembled") throw new Error("expected a prompt.assembled fact")
  return fact
}

describe("runtime request audit conversation identity", () => {
  it("records the durable conversation id and tree pointer when the host owns a tree", async () => {
    const facts = await recordedFacts({
      conversation: {
        kind: "durable-tree",
        reserveMessageId: async () => crypto.randomUUID(),
        sessionId: "session-1",
        conversationId: "tree-1",
        priorMessages: [],
        append: () => {},
        captureCommittedForkMessages: async () => [],
        resolveLeafId: async () => "leaf-1", committedTree: async () => ({ leafId: null, entriesById: {} }),
      },
    })
    const fact = promptAssembled(facts)
    expect("identity" in fact.payload ? fact.payload.identity : undefined).toEqual({
      providerSessionKey: "agent-runner-id",
      conversationId: "tree-1",
    })
    expect("treeLeafEntryId" in fact.payload ? fact.payload.treeLeafEntryId : undefined).toBe("leaf-1")
  })

  it("uses the durable session as artifact and retrieval scope independently of the provider key", () => {
    const conversation = resolveRuntimeConversation({
      kind: "durable-tree",
      reserveMessageId: async () => crypto.randomUUID(),
      sessionId: "session-1",
      conversationId: "tree-1",
      providerSessionKey: "provider-key-1",
      priorMessages: [],
      append: () => {},
      captureCommittedForkMessages: async () => [],
      resolveLeafId: async () => "leaf-1", committedTree: async () => ({ leafId: null, entriesById: {} }),
    }, {
      providerSessionKey: "provider-fallback",
      artifactScopeId: "artifact-fallback",
      retrievalSessionId: "retrieval-fallback",
    })

    expect(conversation.artifactScopeId).toBe("session-1")
    expect(conversation.retrievalSessionId).toBe("session-1")
    expect(conversation.providerSessionKey).toBe("provider-key-1")
  })

  it("records only the provider key and omits the tree pointer when no durable tree exists", async () => {
    const facts = await recordedFacts({})
    const fact = promptAssembled(facts)
    expect("identity" in fact.payload ? fact.payload.identity : undefined).toEqual({ providerSessionKey: "agent-runner-id" })
    expect("conversationId" in fact.payload).toBe(false)
    expect("treeLeafEntryId" in fact.payload ? fact.payload.treeLeafEntryId : undefined).toBeUndefined()
  })
})

// No module transforms model context, so a provider request records no
// context application: no manifest fact and no per-request application id.
describe("runtime request audit context application", () => {
  const conversation = (): AgentOptions["conversation"] => ({
    kind: "durable-tree",
    reserveMessageId: async () => crypto.randomUUID(),
    sessionId: "session-1",
    conversationId: "tree-1",
    priorMessages: [{ kind: "user", content: "hello" }],
    append: () => {},
    captureCommittedForkMessages: async () => [],
    resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }),
  })

  it("A request records prompt.assembled without contextApplicationId and no context.application.recorded fact", async () => {
    const facts: ProviderRequestAuditFact[] = []
    await runAgentLoop(await assembledRuntime({ conversation: conversation() }, facts))
    const prompt = promptAssembled(facts)
    expect("contextApplicationId" in prompt.payload).toBe(false)
    expect(facts.map((fact) => fact.type)).toEqual(expect.arrayContaining(["prompt.assembled", "model.requested"]))
    expect(facts.filter((fact) => fact.type === "context.application.recorded" || fact.type === "context.transformer.applied")).toEqual([])
  })

  it("Three requests record no context application", async () => {
    const facts: ProviderRequestAuditFact[] = []
    await runAgentLoop(await assembledRuntime({ conversation: conversation() }, facts, modelClient(2)))
    const prompts = facts.filter((fact) => fact.type === "prompt.assembled")
    expect(prompts).toHaveLength(3)
    for (const prompt of prompts) expect("contextApplicationId" in prompt.payload).toBe(false)
    expect(facts.filter((fact) => fact.type === "context.application.recorded" || fact.type === "context.transformer.applied")).toEqual([])
  })
})

  it("registers enabled requests with immutable serving attribution and retires them on response", async () => {
    const registrations: GitAiRequestRegistration[] = []
    const initialConfig = { ...testRuntimeConfigCapture(), gitAiAttribution: true };
    let observedConfig: typeof initialConfig | undefined;
    const observerEntered = Promise.withResolvers<void>();
    const observerReleased = Promise.withResolvers<void>();
    let providerPrepared = false;
    const service: GitAiAttributionService = {
      canonicalRepositoryRoot: process.cwd(),
      status: () => ({ kind: "available" }),
      subscribe: () => () => {},
      checkAvailability: async () => ({ kind: "available" }),
      registerRequest: (registration) => { registrations.push(registration); return registration },
      direct: () => {},
      dispose: async () => {},
    }
    const facts: ProviderRequestAuditFact[] = []
    const options = {
      model: "planned-model",
      activeProfileId: "work",
      ...testDirectories(process.cwd()),
      purpose: { kind: "interactive-chat" as const },
      agentsMd: "",
      onEvent: () => {},
      moduleSelection: testCapabilityModules,
      awaitModelAccessSettled: async () => {}, captureRuntimeConfig: () => initialConfig,
      onRuntimeConfigCapture: async (config: typeof initialConfig) => {
        observerEntered.resolve();
        await observerReleased.promise;
        observedConfig = config;
      },
      runtimeSurfaces: { gitAiAttribution: service },
      conversation: { kind: "stateless" as const },
      lifecycle: { kind: "one-shot" as const },
      auditObserver: (fact: ProviderRequestAuditFact) => { facts.push(fact) },
    }
    const signal = new AbortController().signal
    const assembly = assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options,
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation({ kind: "durable-tree", reserveMessageId: async () => crypto.randomUUID(), sessionId: "session-1", conversationId: "conversation-1", priorMessages: [], append: () => {}, captureCommittedForkMessages: async () => [], resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }) }, { providerSessionKey: "provider-key", artifactScopeId: "artifact", retrievalSessionId: "retrieval" }),
      signal,
      disposalSignal: signal,
      instruction: null,
      currentTurn: undefined,
      personas: new Map(),
      captureModelRuntime: async () => ({ generation: {}, createLLMClient: async (_model, _modules, config) => {
        providerPrepared = true;
        expect(observedConfig).toBe(config);
        expect(config).toBe(initialConfig);
        return modelClient();
      } }),
      createRunner: () => { throw new Error("unused") },
    })
    await observerEntered.promise;
    expect(providerPrepared).toBe(false);
    expect(observedConfig).toBeUndefined();
    observerReleased.resolve();
    const assembled = await assembly;
    await assembled.tools.resolve()
    const handle = await assembled.requestAudit?.recordRequest({
      requestId: "00000000-0000-4000-8000-000000000002",
      turn: 1,
      attribution: { accessProvider: "anthropic_api", modelFamily: "anthropic", model: "served-model", contextLimit: 100_000 },
      systemPrompt: "system",
      messages: [{ kind: "user", content: "hello" }],
      tools: [], omittedTools: [], messageCount: 1, estimatedContextTokens: 1, attemptStaticTokens: 1,
      interactionProfileId: "default", reasoningEffort: undefined, cacheRetention: undefined, cacheKey: undefined,
      providerOptions: undefined, staleMasking: undefined,
    })
    expect(handle).toBeDefined()
    expect(registrations).toEqual([expect.objectContaining({ requestId: handle?.requestId, model: "served-model", conversationId: "conversation-1" })])
    expect(assembled.requestAttribution?.resolve(handle!.requestId)).toMatchObject({ profileId: "work", enabled: true, model: "served-model", conversationId: "conversation-1" })
    await assembled.requestAudit?.recordResponse(handle!, { outcome: "ok" })
    expect(assembled.requestAttribution?.resolve(handle!.requestId)).toBeUndefined()
    expect(facts.some((fact) => fact.type === "model.requested")).toBe(true)
  })

