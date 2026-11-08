import { afterEach, describe, expect, test } from "bun:test"
import { Redacted, Scope } from "effect"
import { join } from "node:path"
import type { DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { Log } from "../../../../src/infra/log.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import type { AgentConversation, AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory.js"
import { FUNCTION_TOOL_PRESENTATION, type Claim, type ConversationMessage, type ModelClient, type ProviderDemand, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { planCapabilitiesOfRun, prepareRunRequest, type AnticipatedRequest } from "../../../../src/orchestration/agent-runtime/request-preparation.js"
import { composeFirstPartyModules, SHIPPED_MODULES, type FirstPartyModule } from "../../../../src/orchestration/modules.js"
import { openProviderSession, type HeldProviderSession } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js"
import { holdSharedTree, type SharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js"
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js"
import { createAnthropicAdapter, type AnthropicOperations } from "../../../../src/orchestration/agent-runtime/llm/anthropic.js"
import { createAdmittedClient, stagedProviderClient } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import type { ProviderAvailability } from "../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js"
import { testProviderEligibility, testProviderRegistry, testProviderSessionLifetime } from "../../../helpers/provider-authority.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { authProviders } from "../../../helpers/auth-context.js"
import { createSessionFactWriter } from "../chat/_chat-session-agent-runtime-fixtures.js"
import { asModelClient } from "./_model-client.js"
import { makeOptions } from "./_runner-options.js"
import { fakeAvailability, SAFE_RECHECK_MS } from "./llm/_provider-chain-harness.js"

const HISTORY: ConversationMessage[] = [{ kind: "user", origin: "human", content: "Read a." }, { kind: "assistant", content: [{ type: "text", text: "Done." }] }]
const NEXT: ConversationMessage = { kind: "user", content: "Read b.", origin: "human" }
const CLAIM: Claim = { release: async () => {} }

/** A reader of one engine demand, as a session's owner gives its provider runtimes, which no provider asks to plan
 *  again in these tests. */
function stableDemand(): () => ProviderDemand {
  const demand: ProviderDemand = { scope: Scope.makeUnsafe("sequential"), stale: () => {} }
  return () => demand
}

/** The durable conversation of one chat: its history and a writer that counts what it is given. */
function conversation(priorMessages: readonly ConversationMessage[], appended: ConversationMessage[]): AgentConversation {
  return {
    kind: "durable-tree", sessionId: "session", conversationId: "conversation", providerSessionKey: "key", priorMessages,
    append: (message) => { appended.push(message) }, reserveMessageId: async () => crypto.randomUUID(),
    captureCommittedForkMessages: async () => [], resolveLeafId: async () => null, committedTree: async () => ({ leafId: null, entriesById: {} }),
  }
}

describe("a pre-start's request preparation", () => {
  const tempDir = temporaryDirectories()
  const held: HeldProviderSession[] = []
  afterEach(async () => { await Promise.all(held.splice(0).map((session) => session.close())) })
  const providerSession = () => {
    const session = openProviderSession(stableDemand())
    held.push(session)
    return session.session
  }

  /** Prepares the next request of `options` as the agent factory does, counting the runs it builds. `outcome` is what
   *  the pre-start returned; `prepared` is its request, and rejects when it prepared none. */
  function prepare(options: AgentOptions, createLLMClient: LLMClientFactory, preparation: { nextMessage?: string; signal?: AbortSignal; readHistory?: () => Promise<readonly ConversationMessage[]> } = {}) {
    let runners = 0
    const outcome = prepareRunRequest({
      options: {
        captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {}, ...options,
        runtimeSurfaces: options.runtimeSurfaces ?? {}, moduleSelection: options.moduleSelection ?? testCapabilityModules,
        providerSession: options.providerSession ?? providerSession(),
      },
      definitions: repoDefinitions(),
      captureModelRuntime: async () => ({ generation: createLLMClient, createLLMClient }),
      createRunner: () => { runners += 1; throw new Error("a pre-start builds no run") },
      ...(preparation.nextMessage === undefined ? {} : { nextMessage: preparation.nextMessage }),
      ...(preparation.readHistory === undefined ? {} : { readHistory: preparation.readHistory }),
      signal: preparation.signal ?? new AbortController().signal,
    })
    return {
      outcome,
      get prepared() {
        return outcome.then((result): AnticipatedRequest => {
          if (result === undefined) throw new Error("the pre-start prepared no request")
          return result
        })
      },
      runners: () => runners,
    }
  }

  /** The production client of one Anthropic API candidate: the failover walk behind the runtime error boundary
   *  (`createAdmittedClient`), over a provider client whose transport the test holds. */
  async function claudeClient(root: string, operations: Pick<AnthropicOperations, "anticipate" | "createStream">, availability: ProviderAvailability = fakeAvailability({}).availability): Promise<ModelClient> {
    const model = "claude-sonnet-4.6"
    const connection = captureProviderConnection({
      profileId: "default", authDir: join(root, "auth"), oauthPersistence: "memory-only", subscriptionCredentials: new Map(),
      auth: { providers: authProviders({ apiKeys: { anthropic_api: "hermetic-api-key" } }), droppedCredentials: [], credentialLineages: { anthropic_api: "00000000-0000-4000-8000-000000000001" } },
    })
    const registry = testProviderRegistry()
    const factories = new Map(registry.factories)
    factories.set("anthropic_api", async (build) => {
      const client = await createAnthropicAdapter(Redacted.make("hermetic-api-key"), build.model, fakeModelsClient, {
        accessProvider: "anthropic_api", candidate: build.candidate, availability: build.availability,
        resolvedModelMetadata: build.attribution.resolvedModelMetadata ?? fakeModelsClient.modelInfos.get(build.model) ?? null,
        operations: { isBadRequestError: () => false, ...operations },
      })
      return stagedProviderClient(build, { ...client, anticipatesRequests: true }, async () => client)
    })
    const providers = { ...registry, factories }
    const eligibility = testProviderEligibility()
    const plan = providers.selection.plan(model, connection, eligibility)
    if (plan.kind !== "admitted") throw new Error(`the test plan is ${plan.kind}`)
    return createAdmittedClient(plan, fakeModelsClient, connection, {
      notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
      projectRoot: root, providers, eligibility, allowTrainingRoutes: false,
      availability: { forCandidates: () => availability, dispose: async () => {} },
      retrySleep: async () => {},
      requestAdmission: async () => ({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined, subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }) }),
    })
  }

  test("on a Claude route, the request that a pre-start hands to the client is the request that the send then sends, byte for byte", async () => {
    const root = tempDir("prestart-claude-")
    const anticipated: unknown[] = []
    const sent: unknown[] = []
    const client = await claudeClient(root, {
      anticipate: async (params) => { anticipated.push(params); return CLAIM },
      createStream: async (params) => { sent.push(params); throw new Error("the test ends the send at its request") },
    })
    const base = { ...testDirectories(root), model: "claude-sonnet-4.6", agentRegistry: new Map(), agentsMd: "" }

    const { prepared } = prepare(makeOptions({ ...base, conversation: conversation(HISTORY, []) }), async () => client, { nextMessage: "Read b." })
    const request = await prepared
    expect(await request.candidate.client.anticipate?.(request.request)).toBe(CLAIM)
    const runner = newTestRunner(makeOptions({ ...base, conversation: conversation([...HISTORY, NEXT], []) }), async () => client)
    runner.send("Read b.")
    await runner.done

    expect(anticipated).toHaveLength(1)
    expect(sent.length).toBeGreaterThan(0)
    expect(JSON.stringify(anticipated[0])).toBe(JSON.stringify(sent[0]))
  })

  test("on an OpenAI route that anticipates requests, the prepared request is the request that the send gives its client, byte for byte", async () => {
    const streamed: StreamOptions[] = []
    const client: LLMClientFactory = async () => asModelClient({
      accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.5", toolPresentation: FUNCTION_TOOL_PRESENTATION, anticipatesRequests: true,
      contextLimit: 400_000, outputLimit: 64_000, supportsReasoning: true, promptNotes: { progress: "", modelNotes: "" },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) { streamed.push(options); yield { kind: "done", stopReason: "end_turn" } },
    })
    const base = { model: "gpt-5.5", agentRegistry: new Map(), agentsMd: "" }

    const request = await prepare(makeOptions({ ...base, conversation: conversation(HISTORY, []) }), client, { nextMessage: "Read b." }).prepared
    const runner = newTestRunner(makeOptions({ ...base, conversation: conversation([...HISTORY, NEXT], []) }), client)
    runner.send("Read b.")
    await runner.done

    expect(request.candidate.attempt.modelFamily).toBe("openai")
    // The stream's signal, telemetry, and repetition guard belong to the attempt that sends it, not to its bytes.
    const bytes = ({ signal: _signal, telemetry: _telemetry, repetitionGuard: _guard, ...options }: StreamOptions) => JSON.stringify(options)
    expect(streamed).toHaveLength(1)
    expect(bytes(request.request)).toBe(bytes(streamed[0]!))
  })

  test("a pre-start sends nothing, claims no recheck lease, records no routing choice, writes no durable fact, and builds no run or module runtime generation", async () => {
    const records: DebugLogRecordInput[] = []
    await Log.init({ level: "DEBUG", forward: (record) => { records.push(record) } })
    try {
      const root = tempDir("prestart-effects-")
      const fake = fakeAvailability({})
      fake.availability.markUnreachable("anthropic_api")
      fake.advance(SAFE_RECHECK_MS + 1)
      let leases = 0
      const availability: ProviderAvailability = {
        ...fake.availability,
        claimServiceProbe: (provider) => { leases += 1; return fake.availability.claimServiceProbe(provider) },
        claimQuotaProbe: (candidate) => { leases += 1; return fake.availability.claimQuotaProbe(candidate) },
      }
      const sent: unknown[] = []
      const client = await claudeClient(root, {
        anticipate: async () => CLAIM,
        createStream: async (params) => { sent.push(params); throw new Error("a pre-start sends no request") },
      }, availability)
      const writer = createSessionFactWriter()
      const facts: unknown[] = []
      const record = writer.record
      const appended: ConversationMessage[] = []
      let generations = 0
      const options = makeOptions({
        ...testDirectories(root), model: "claude-sonnet-4.6", agentRegistry: new Map(), agentsMd: "",
        conversation: conversation(HISTORY, appended),
        sessionEventWriter: { ...writer, record: (fact) => { facts.push(fact); return record(fact) } },
        usageProfile: { profileId: "default", authorityIncarnation: "test", acquireAuthority: async () => { throw new Error("a pre-start settles no usage") } },
        lifecycle: { kind: "one-shot", onRuntimeAssembled: () => { generations += 1 } },
      })

      for (let preparation = 0; preparation < 2; preparation++) {
        const { prepared, runners } = prepare(options, async () => client)
        await prepared
        expect(runners()).toBe(0)
      }

      expect(sent).toEqual([])
      expect(leases).toBe(0)
      expect(records.filter((entry) => JSON.stringify(entry).includes("provider request routed"))).toEqual([])
      expect(facts).toEqual([])
      expect(appended).toEqual([])
      expect(generations).toBe(0)
    } finally {
      await Log.closeGlobal()
    }
  })

  test.each([
    ["a new conversation", [], { kind: "stateless" } as const],
    ["a conversation that ends with the chat's reply", HISTORY, undefined],
  ] satisfies [string, ConversationMessage[], AgentConversation | undefined][])("a pre-start of %s with no queued message ends its draft with a placeholder and marks the next message unknown", async (_name, history, stateless) => {
    const anticipated: StreamOptions[] = []
    const client: LLMClientFactory = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION, anticipatesRequests: true,
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools(options: StreamOptions) { anticipated.push(options); yield { kind: "done", stopReason: "end_turn" } },
    })

    const request = await prepare(makeOptions({ agentRegistry: new Map(), agentsMd: "", conversation: stateless ?? conversation(history, []) }), client).prepared

    expect(request.nextMessage).toBe("unknown")
    expect(request.request.messages.slice(0, history.length)).toEqual(history)
    expect(request.request.messages.at(-1)).toMatchObject({ kind: "user", content: "(next message)" })
    expect(request.request.signal).toBeUndefined()
    expect(anticipated).toEqual([])
  })

  test("a host's pre-start holds its chat tree for the provider session, so the host and every later run of the session find one tree until the session closes", async () => {
    const trees: (SharedTree | undefined)[] = []
    const client: LLMClientFactory = async (_model, _modules, _config, lifetime) => {
      trees.push(lifetime?.sharedHost)
      return asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
        contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
      })
    }
    const session = openProviderSession(stableDemand())
    const options = makeOptions({
      agentRegistry: new Map(), agentsMd: "", purpose: { kind: "session-title" }, treeRootSessionId: "prestart-tree",
      conversation: { kind: "stateless" }, providerSession: session.session,
    })

    await prepare(options, client).outcome
    await prepare(options, client).outcome
    const later = holdSharedTree("prestart-tree", () => ({ modules: testCapabilityModules(), shellWriteGuard: true, allowPersistentProcesses: false }))
    later.release()
    await session.close()
    const afterClose = holdSharedTree("prestart-tree", () => ({ modules: testCapabilityModules(), shellWriteGuard: true, allowPersistentProcesses: false }))
    afterClose.release()

    expect(trees).toHaveLength(1)
    expect(trees[0]).toBeDefined()
    expect(later.tree === trees[0]).toBe(true)
    expect(afterClose.tree === trees[0]).toBe(false)
  })

  test("a pre-start whose route anticipates no request resolves undefined once the session's client resolved, and reads no history and no environment", async () => {
    const session = openProviderSession(stableDemand())
    held.push(session)
    let clients = 0
    let histories = 0
    let environments = 0
    const client: LLMClientFactory = async () => {
      clients += 1
      return asModelClient({
        accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
        contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
      })
    }
    const options = makeOptions({
      agentRegistry: new Map(), agentsMd: "", conversation: conversation([], []), providerSession: session.session,
      resolveEnvSnapshot: async () => { environments += 1; return { envBlock: "<env>" } },
    })

    const { outcome } = prepare(options, client, { readHistory: async () => { histories += 1; return HISTORY } })

    expect(await outcome).toBeUndefined()
    expect(clients).toBe(1)
    expect(histories).toBe(0)
    expect(environments).toBe(0)
  })

  test("a capability plan answers the agent check of the next request's tool plan, which its exposure gate narrows, and sends, writes, and builds nothing", async () => {
    // The tool exposure gate of an active experiment, which omits Bash and the subagent tool from the next request.
    const gated = {
      id: "test-exposure-gate", dependencies: [], availability: { kind: "available" }, contributions: [], observers: [], transformers: [],
      gates: [{ seam: "toolExposure", gate: () => new Map([["bash", "sealed paths"], ["subagent", "delegation"]]) }],
    } as const satisfies FirstPartyModule
    const withoutExperiments = SHIPPED_MODULES.filter((module) => module.id !== "experiments")
    let streams = 0
    const appended: ConversationMessage[] = []
    const client: LLMClientFactory = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION,
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() { streams += 1; yield { kind: "done", stopReason: "end_turn" } },
    })
    const plan = (modules: readonly FirstPartyModule[]) => {
      const options = makeOptions({ agentRegistry: new Map(), agentsMd: "", conversation: conversation(HISTORY, appended) })
      return planCapabilitiesOfRun({
        options: {
          captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {}, ...options,
          runtimeSurfaces: {}, moduleSelection: () => composeFirstPartyModules(modules),
        },
        definitions: repoDefinitions(),
        captureModelRuntime: async () => ({ generation: client, createLLMClient: client }),
        createRunner: () => { throw new Error("a capability plan builds no run") },
      })
    }

    expect((await plan(withoutExperiments))("bash")).toBe(true)
    expect((await plan([...withoutExperiments, gated]))("bash")).toBe(false)
    expect(streams).toBe(0)
    expect(appended).toEqual([])
  })

  test("a pre-start that prepares reads its owner's history once and its environment once, and its draft holds that history", async () => {
    let histories = 0
    let environments = 0
    const client: LLMClientFactory = async () => asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", toolPresentation: FUNCTION_TOOL_PRESENTATION, anticipatesRequests: true,
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
    })
    const options = makeOptions({
      agentRegistry: new Map(), agentsMd: "", conversation: conversation([], []),
      resolveEnvSnapshot: async () => { environments += 1; return { envBlock: "<env>" } },
    })

    const request = await prepare(options, client, { readHistory: async () => { histories += 1; return HISTORY } }).prepared

    expect(histories).toBe(1)
    expect(environments).toBe(1)
    expect(request.request.messages.slice(0, HISTORY.length)).toEqual(HISTORY)
  })

  test("a pre-start that its owner stopped rejects before it resolves the session's client", async () => {
    const controller = new AbortController()
    controller.abort(new DOMException("stopped", "AbortError"))
    let clients = 0
    const { prepared } = prepare(makeOptions({ agentRegistry: new Map(), agentsMd: "" }), async () => { clients += 1; throw new Error("a stopped pre-start builds no client") }, { signal: controller.signal })

    await expect(prepared).rejects.toHaveProperty("name", "AbortError")
    expect(clients).toBe(0)
  })
})
