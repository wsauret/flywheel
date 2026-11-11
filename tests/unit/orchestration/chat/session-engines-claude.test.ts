import { describe, expect, test } from "bun:test"
import { providerModelInfo } from "../../../../src/infra/llm/provider-model-info.js"
import { createSessionEngines } from "../../../../src/orchestration/chat/session-engines.js"
import type { ResolvedRole, ResolvedRoles } from "../../../../src/orchestration/config/roles.js"
import type { AccessProviderBuild } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import type { LLMClientFactory } from "../../../../src/orchestration/agent-runtime/factory.js"
import { FUNCTION_TOOL_PRESENTATION, type ProviderSessionLifetime } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { prepareRunRequest } from "../../../../src/orchestration/agent-runtime/request-preparation.js"
import type { ProviderSession } from "../../../../src/orchestration/agent-runtime/provider-runtime-cache.js"
import { holdSharedTree, type SharedTree } from "../../../../src/orchestration/agent-runtime/shared-tree.js"
import type { AgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import { hostKey, type HostRegistry } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host-registry.js"
import type { AgentHost } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/agent-host/host.js"
import { createClaudeAgentSdkClient } from "../../../../src/orchestration/modules/provider-claude-agent-sdk/client.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { makeOptions } from "../agent-runtime/_runner-options.js"
import { fakeAvailability } from "../agent-runtime/llm/_provider-chain-harness.js"
import { SESSION_TITLE_PURPOSE } from "../../../../src/orchestration/session/session-title.js"

/*
 * A shown session's engine demand through the production wiring: the session's planning, request preparation, the
 * provider runtime cache, and the Claude Agent SDK client with its hosted agent, over a host registry that the test
 * holds. Only the host process is fake.
 */

const TREE = "session-engines-claude"
const unused = (): never => { throw new Error("unused in this test") }

/** A registry of one host whose leases the test counts, and whose end promise counts the listeners that it has. */
function countingHosts() {
  const leases: { readonly key: string; released: boolean }[] = []
  let listeners = 0
  class CountedEnd extends Promise<Error> {
    static override get [Symbol.species]() { return Promise }
    override then<Fulfilled = Error, Rejected = never>(onFulfilled?: ((value: Error) => Fulfilled | PromiseLike<Fulfilled>) | null, onRejected?: ((reason: unknown) => Rejected | PromiseLike<Rejected>) | null): Promise<Fulfilled | Rejected> {
      listeners += 1
      return super.then(onFulfilled, onRejected)
    }
  }
  const counted = new CountedEnd(() => {})
  const host: AgentHost = {
    sessionId: "host", folder: { configDir: "/scratch", cwd: "/scratch", sessionId: "host" }, get toolGate() { return unused() },
    definition: unused, admit: unused, dispatch: unused, settled: unused, stopTask: unused, takeHiddenRequests: unused, released: unused, requestFailure: unused,
    ended: counted, served: false, close: async () => {},
  }
  const registry: HostRegistry = {
    lease: (place) => {
      const leased = { key: hostKey(place), released: false }
      leases.push(leased)
      return { host, opened: true, release: async () => { leased.released = true } }
    },
    drain: async () => {},
  }
  return { registry, leases, listeners: () => listeners }
}

/** The Claude Agent SDK client of `model` for a client whose provider lifetime is `lifetime`, as the client factory
 *  builds it on a subscription login, with `registry` as the process's host registry. */
async function claudeClient(model: string, lifetime: ProviderSessionLifetime, registry: HostRegistry, anticipated: () => void) {
  const info = providerModelInfo({ provider: "anthropic", id: model, contextLimit: 1_000_000, outputLimit: 128_000, reasoning: true, reasoningEfforts: ["low", "medium", "high"] })
  const candidate = { kind: "subscription", providerId: "claude_agent_sdk", instanceId: "login", spendMode: "included" } as const
  const build: AccessProviderBuild = {
    notify: () => {},
    candidate, providerIdentity: { name: "Anthropic Sub", credential: "oauth" },
    model, wireModelId: model, family: "anthropic",
    modelsClient: { async refresh() {}, getProviderCatalog: () => [], getTokenizerIdentity: () => undefined },
    connection: {
      id: "connection", authDir: "/scratch/auth", oauthPersistence: "memory-only",
      auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
      subscriptionCredentials: new Map([[candidate.providerId, [{ instanceId: candidate.instanceId, identity: "person@example.com", lineageId: candidate.instanceId, credential: { type: "external", configDir: "/scratch/claude-config" } }]]]),
    },
    classifySlot: () => "subscription", availability: fakeAvailability({}).availability, projectRoot: process.cwd(),
    attribution: { candidate, wireModelId: model, dataUse: "standard", resolvedModelMetadata: info },
    recordModelRefusal: () => {},
    accountOfferings: () => [],
    launcher: {
      spawnOwned: () => Promise.reject(new Error("no launch in a unit test")),
      adoptOwned: () => Promise.reject(new Error("no adoption in a unit test")),
      open() { return this },
      close: async () => ({ settled: true }),
    },
    providerSessionLifetime: lifetime,
  }
  const staged = await createClaudeAgentSdkClient(build, {
    enginePath: "/scratch/bin/claude",
    createLauncher: () => () => { throw new Error("a tree-hosted client starts no engine of its own") },
    createHostLauncher: () => () => { throw new Error("the counting registry opens no host") },
    agentHosts: registry,
  })
  const connected = await staged.connect()
  return asModelClient({
    ...staged.attempt,
    anticipate: async (options) => {
      const claim = await connected.anticipate?.(options)
      anticipated()
      return claim
    },
    streamWithTools: (options) => connected.streamWithTools(options),
  })
}

/** A shown session whose chat runs on an OpenAI route, which anticipates nothing, and whose `roles` run on Claude. */
function session(initial: readonly ResolvedRole[]) {
  const hosts = countingHosts()
  let roles = initial
  const trees: (SharedTree | undefined)[] = []
  let anticipations = 0
  const createLLMClient: LLMClientFactory = async (model, _modules, _config, lifetime) => {
    if (model === "gpt-5.5") {
      return asModelClient({
        accessProvider: "openai_api", modelFamily: "openai", model, toolPresentation: FUNCTION_TOOL_PRESENTATION,
        contextLimit: 400_000, outputLimit: 64_000, supportsReasoning: true, 
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } },
      })
    }
    trees.push(lifetime?.sharedHost)
    return claudeClient(model, lifetime, hosts.registry, () => { anticipations += 1 })
  }
  const prestartOptions = (overrides: Partial<AgentOptions>, providerSession: ProviderSession): AgentOptions & { readonly providerSession: ProviderSession } => ({ ...makeOptions({ agentRegistry: new Map(), agentsMd: "", ...overrides }), providerSession })
  const engines = createSessionEngines({
    sessionId: TREE,
    resolveRoles: async (): Promise<ResolvedRoles> => new Map([["chat", { roleId: "chat", model: "gpt-5.5", effort: "medium" }], ...roles.map((role): [string, ResolvedRole] => [role.roleId, role])]),
    prepareRequest: (options, preparation) => prepareRunRequest({
      ...preparation,
      options: { captureRuntimeConfig: testRuntimeConfigCapture, awaitModelAccessSettled: async () => {}, ...options, runtimeSurfaces: options.runtimeSurfaces ?? {}, moduleSelection: testCapabilityModules },
      definitions: repoDefinitions(),
      captureModelRuntime: async () => ({ generation: createLLMClient, createLLMClient }),
      createRunner: () => { throw new Error("a pre-start builds no run") },
    }),
    chatOptions: async (provider) => ({ options: prestartOptions({ model: "gpt-5.5" }, provider), readHistory: async () => [] }),
    hostOptions: (role, provider) => prestartOptions({
      model: role.model, effort: role.effort, purpose: SESSION_TITLE_PURPOSE, treeRootSessionId: TREE, memorySnapshot: null,
    }, provider),
  })
  return {
    engines, hosts, trees,
    setRoles: (next: readonly ResolvedRole[]) => { roles = next },
    anticipations: () => anticipations,
  }
}

/** Waits until `condition` holds, in short steps. */
async function until(condition: () => boolean): Promise<void> {
  for (let step = 0; !condition(); step++) {
    if (step > 400) throw new Error("the condition never held")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The tree that a run of the session holds now. */
function currentTree(): SharedTree {
  const held = holdSharedTree(TREE, () => ({ modules: testCapabilityModules(), shellWriteGuard: true, allowPersistentProcesses: false, disabledTypes: [] }))
  held.release()
  return held.tree
}

describe("a shown session's Claude engine demand through the production wiring", () => {
  test("three role selections on one host place hold one lease with one end listener, keep it across a client replacement, and release it at hide, and the pre-starts hold the session's tree until then", async () => {
    const s = session([
      { roleId: "reviewer", model: "claude-sonnet-5-5", effort: "low" },
      { roleId: "planner", model: "claude-sonnet-5-5", effort: "medium" },
      { roleId: "auditor", model: "claude-sonnet-5-5", effort: "high" },
    ])
    s.engines.setShown(true)
    await until(() => s.anticipations() === 3)
    expect(s.trees).toHaveLength(3)
    expect(new Set(s.trees).size).toBe(1)
    expect(s.hosts.leases).toEqual([{ key: expect.any(String), released: false }])
    expect(s.hosts.listeners()).toBe(1)
    // No run of the session runs, and the session's tree lives on for its next run.
    expect(currentTree()).toBe(s.trees[0]!)

    // One selection changes, so its provider runtime and client go and a new one comes; the host stays.
    s.setRoles([
      { roleId: "reviewer", model: "claude-haiku-5-5", effort: "low" },
      { roleId: "planner", model: "claude-sonnet-5-5", effort: "medium" },
      { roleId: "auditor", model: "claude-sonnet-5-5", effort: "high" },
    ])
    s.engines.rolesChanged()
    await until(() => s.anticipations() === 6)
    expect(s.trees).toHaveLength(4)
    expect(s.hosts.leases).toEqual([{ key: expect.any(String), released: false }])
    expect(s.hosts.listeners()).toBe(1)

    s.engines.setShown(false)
    await until(() => s.hosts.leases[0]?.released === true)
    expect(s.hosts.leases).toEqual([{ key: expect.any(String), released: true }])
    expect(currentTree()).not.toBe(s.trees[0]!)
    await s.engines.close()
  })
})
