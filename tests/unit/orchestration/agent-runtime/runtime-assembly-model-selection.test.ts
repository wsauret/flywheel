import { expect, test } from "bun:test"
import { testProviderSessionLifetime } from "../../../helpers/provider-authority.js";
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context.js"
import { accessProviderAccountKey } from "../../../../src/infra/llm/access-provider.js"
import { accessProviderRegistry } from "../../../../src/orchestration/agent-runtime/llm/access-provider-registry.js"
import { providerModelEligibilityDecision, type ProviderModelEnabledCandidate } from "../../../../src/orchestration/config/provider-model-eligibility.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { fakeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { attemptHistoryTarget } from "./_model-client.js"
import { createAdmittedClient, type AccessProviderBuild } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import { FUNCTION_TOOL_PRESENTATION, type AdapterAdmission, type LLMClient, type ServingAttempt } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import type { RoleHold } from "../../../../src/orchestration/agent-runtime/types.js"
import { capabilityAccessHolding } from "./tools/_fixtures.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { dispatchedToolContext } from "../../../helpers/dispatched-tool-context.js"

const tempDir = temporaryDirectories()

/** A user data root whose benchmark cache was refreshed now, so the `models`
 *  tool reads the cache and fetches nothing. */
function freshBenchmarkCacheRoot(): string {
  const userDataRoot = tempDir("runtime-assembly-models-")
  mkdirSync(join(userDataRoot, "models"), { recursive: true })
  writeFileSync(join(userDataRoot, "models", "benchmark-tiers.json"), JSON.stringify({ attemptedAt: Date.now(), snapshot: null }))
  return userDataRoot
}

test("captures each model that a person saves next, and keeps tool calls on their request selection", async () => {
  const providers = accessProviderRegistry(testCapabilityModules())
  const outgoing: Array<{ model: string; wire: string; effort?: string }> = []
  /** Each request's attempt on a provider adapter that records the wire of the attribution that the request's own
   *  admission staged: the real client plans the request from the capture that the runtime passed it. */
  const recordingAdapter = async (build: AccessProviderBuild) => ({
    stage: async ({ attribution }: AdapterAdmission) => {
      const attempt: ServingAttempt = {
        accessProvider: build.candidate.providerId, modelFamily: build.family, model: build.model, candidateAttribution: attribution,
        toolPresentation: FUNCTION_TOOL_PRESENTATION, contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: true,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
      }
      const client: LLMClient = {
        ...attempt, historyTarget: () => attemptHistoryTarget(attempt),
        async *streamWithTools(options) {
          outgoing.push({ model: build.model, wire: attribution.wireModelId, effort: options.reasoningEffort })
          if (outgoing.length === 1) {
            eligibility = access("claude-haiku-4.5", "anthropic")
            saved = { model: "claude-haiku-4.5", effort: "high" }
            yield { kind: "tool_use", toolCall: { id: "tc", name: "missing-tool", input: {} } }
            yield { kind: "done", stopReason: "tool_use" }
          } else {
            yield { kind: "text_delta", text: "done", blockKey: "text" }
            yield { kind: "done", stopReason: "end_turn" }
          }
        },
      }
      return { attempt, connect: async () => client }
    },
  })
  const recordingProviders = { ...providers, factories: new Map([["openai_api", recordingAdapter], ["anthropic_api", recordingAdapter]]) }
  const auth = testAuthContext({ apiKeys: { openai_api: "test-key", anthropic_api: "test-key" } })
  const connection = captureProviderConnection({ profileId: "default", authDir: "/scratch/auth", auth })
  const access = (model: string, family: "openai" | "anthropic", wire = `${model}-wire`) => {
    const candidate = { kind: "singleton", providerId: `${family}_api`, spendMode: "direct_api" } as const
    const models = new Set([model])
    const offerings = new Map([[model, [{
      wireModelId: wire, dataUse: "standard" as const, metadata: null,
      transport: family === "openai" ? "openai-responses" as const : "anthropic-messages" as const,
      resolvedMetadata: modelInfo(family, model, "fixture", 2, 10, "2026-10-01"),
    }]]])
    const enabledCandidates = new Map<string, ProviderModelEnabledCandidate>([[accessProviderAccountKey(candidate), {
      candidate, configured: true, currentConnection: true, enabledOfferings: offerings,
      catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
    }]])
    if (family === "anthropic") {
      const removed = { kind: "subscription", providerId: "chatgpt", instanceId: "removed-account", spendMode: "included" } as const
      enabledCandidates.set(accessProviderAccountKey(removed), {
        candidate: removed, configured: true, currentConnection: true,
        enabledOfferings: new Map([["gpt-6-luna", [{ wireModelId: "gpt-6-luna", dataUse: "standard", metadata: null, transport: "openai-responses" }]]]),
        catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
      })
    }
    return providerModelEligibilityDecision({
      profileId: "default", revision: family === "openai" ? 1 : 2,
      catalogs: new Map([[candidate.providerId, { effective: models, enabled: models }]]), enabledCandidates,
    }).worker
  }
  let eligibility = access("gpt-6-luna", "openai")
  let saved = { model: "gpt-6-luna", effort: "high" }
  const toolModels: string[] = []
  const plans: string[] = []
  const signal = new AbortController().signal
  const assembled = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options: {
      ...testDirectories(process.cwd()), userDataRoot: freshBenchmarkCacheRoot(), model: "gpt-6-luna", effort: "high",
      resolveRoles: (capture) => {
        if (!capture) throw new Error("The role resolver must share the request capture")
        return resolveSessionRoles({ defaults: {}, overrides: { ship: saved } }, capture, "/scratch")
      },
      requestSelection: (roles) => roles.get("ship") ?? { roleId: "ship" },
      purpose: { kind: "interactive-chat" }, agentsMd: "", onEvent(event) {
        if (event.type === "tool.result.recorded") toolModels.push(assembled.tools.current().providerRuntime?.role?.model ?? "")
      },
      moduleSelection: testCapabilityModules, awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
      runtimeSurfaces: {}, conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
    },
    definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation({
      kind: "durable-tree", sessionId: "selection-session", conversationId: "selection-conversation",
      priorMessages: [{ kind: "user", content: "work" }],
      append: () => {},
      reserveMessageId: async () => crypto.randomUUID(),
      captureCommittedForkMessages: async () => [],
      resolveLeafId: async () => null,
      committedTree: async () => ({ leafId: null, entriesById: {} }),
    }, {
      providerSessionKey: "selection-test", artifactScopeId: "selection-test", retrievalSessionId: "selection-test",
    }),
    signal, disposalSignal: signal, instruction: "work", currentTurn: undefined,
    personas: new Map(), createRunner: () => { throw new Error("unused") },
    captureModelRuntime: async () => ({
      generation: connection,
      createLLMClient: async () => { throw new Error("uncaptured client path") },
      captureProviderConnection: async () => ({
        connection, providers, eligibility, runtimeConfig: testRuntimeConfigCapture(),
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), admit(admitted) {
          return {
            createAgent: () => { throw new Error("unused") },
            createLLMClient: async (model, _modules, runtimeConfig, providerSessionLifetime) => {
              const plan = admitted.get(model)
              if (plan?.kind !== "admitted") throw new Error("missing selected plan")
              expect(plan.connectionId).toBe(connection.id)
              plans.push(model)
              // The client keeps the eligibility of its build; each request admits on the capture that it passes.
              return createAdmittedClient(plan, fakeModelsClient, connection, {
                providers: recordingProviders, providerSessionLifetime: providerSessionLifetime ?? testProviderSessionLifetime(), projectRoot: process.cwd(),
                allowTrainingRoutes: runtimeConfig?.allowTrainingRoutes ?? false, eligibility, notify: () => {},
                requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
              })
            },
          }
        },
      }),
    }),
  })
  const initialSurface = assembled.tools.current()
  eligibility = access("gpt-6-luna", "openai", "gpt-6-luna-updated-wire")
  await runAgentLoop(assembled)
  expect(outgoing).toEqual([
    { model: "gpt-6-luna", wire: "gpt-6-luna-updated-wire", effort: "high" },
    { model: "claude-haiku-4.5", wire: "claude-haiku-4.5-wire", effort: "high" },
  ])
  // A new wire of the same selection keeps the client; a new selected model builds one.
  expect(plans).toEqual(["gpt-6-luna", "claude-haiku-4.5"])
  expect(initialSurface.providerRuntime?.role?.model).toBe("gpt-6-luna")
  expect(initialSurface.providerRuntime?.interactionProfile.fileEditContract).not.toBe(assembled.tools.current().providerRuntime?.interactionProfile.fileEditContract)
  expect(toolModels).toEqual(["gpt-6-luna"])
  const models = initialSurface.tools.get("models")
  if (!models) throw new Error("The assembled runtime must expose live model inspection")
  const catalog = await models.execute({}, dispatchedToolContext({ executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "selection-test", retrievalSessionId: "selection-test" }))
  if (typeof catalog.content !== "string") throw new Error("models must return JSON text")
  expect(JSON.parse(catalog.content).models.rows.map((row: unknown[]) => row[0])).toEqual(["claude-haiku-4.5"])
})

test("keeps an agent on its own model: an unreachable saved model or the pair an unsaved role resolved at the start fails its request as a wait for that model, and an unattended run's fails at once (PI-MODEL-087, ARCH-RUNTIME-082)", async () => {
  const auth = testAuthContext({ apiKeys: { openai_api: "test-key", anthropic_api: "test-key" } })
  const connection = captureProviderConnection({ profileId: "default", authDir: "/scratch/auth", auth })
  const providers = accessProviderRegistry(testCapabilityModules())
  const access = (model: string, family: "openai" | "anthropic") => {
    const candidate = { kind: "singleton", providerId: `${family}_api`, spendMode: "direct_api" } as const
    const models = new Set([model])
    return providerModelEligibilityDecision({
      profileId: "default", revision: 1, catalogs: new Map([[candidate.providerId, { effective: models, enabled: models }]]),
      enabledCandidates: new Map<string, ProviderModelEnabledCandidate>([[accessProviderAccountKey(candidate), {
        candidate, configured: true, currentConnection: true, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
        enabledOfferings: new Map([[model, [{ wireModelId: model, dataUse: "standard" as const, metadata: null, transport: family === "openai" ? "openai-responses" as const : "anthropic-messages" as const, resolvedMetadata: modelInfo(family, model, "fixture", 2, 10, "2026-10-01") }]]]),
      }]]),
    }).worker
  }
  const assemble = async (input: { readonly eligibility: ReturnType<typeof access>; readonly saved?: { readonly model: string; readonly effort: string }; readonly roleHold?: RoleHold; readonly unattended?: true; readonly durable?: LocalSqliteEventStore }) => {
    const signal = new AbortController().signal
    const durableConversation = {
      kind: "durable-tree", sessionId: "own-model-session", conversationId: "own-model-conversation",
      priorMessages: [{ kind: "user", content: "work" }],
      append: () => {},
      reserveMessageId: async () => crypto.randomUUID(),
      captureCommittedForkMessages: async () => [],
      resolveLeafId: async () => null,
      committedTree: async () => ({ leafId: null, entriesById: {} }),
    } as const
    const durable = input.durable === undefined ? {} : {
      sessionEventReader: asAsyncEventReadSurface(input.durable),
      sessionEventWriter: createSessionFactWriter({ sessionId: "own-model-session", writer: asAsyncEventWriter(input.durable) }),
    }
    const assembled = await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options: {
        ...testDirectories(process.cwd()), userDataRoot: freshBenchmarkCacheRoot(),
        resolveRoles: (capture) => {
          if (!capture) throw new Error("The role resolver must share the request capture")
          return resolveSessionRoles({ defaults: {}, overrides: input.saved === undefined ? {} : { explorer: input.saved } }, capture, "/scratch")
        },
        requestSelection: (roles) => roles.get("explorer") ?? { roleId: "explorer" },
        ...(input.roleHold === undefined ? {} : { roleHold: input.roleHold }),
        purpose: { kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" }, agentsMd: "", onEvent: () => {},
        ...(input.unattended ? { capabilityAccess: { ...capabilityAccessHolding([]), unattended: true } } : {}),
        moduleSelection: testCapabilityModules, awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
        runtimeSurfaces: {}, conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" }, ...durable,
      },
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation(input.durable === undefined ? { kind: "stateless" } : durableConversation, { providerSessionKey: "own-model-test", artifactScopeId: "own-model-test", retrievalSessionId: "own-model-test" }),
      signal, disposalSignal: signal, instruction: "work", currentTurn: undefined,
      personas: new Map(), createRunner: () => { throw new Error("unused") },
      captureModelRuntime: async () => ({
        generation: connection,
        createLLMClient: async () => { throw new Error("uncaptured client path") },
        captureProviderConnection: async () => ({
          connection, providers, eligibility: input.eligibility, runtimeConfig: testRuntimeConfigCapture(),
          requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
          admit: (admitted) => ({
            createAgent: () => { throw new Error("unused") },
            createLLMClient: async (model, _modules, runtimeConfig, providerSessionLifetime) => {
              const plan = admitted.get(model)
              if (plan?.kind !== "admitted") throw new Error("missing selected plan")
              return createAdmittedClient(plan, fakeModelsClient, connection, {
                providers, providerSessionLifetime: providerSessionLifetime ?? testProviderSessionLifetime(), projectRoot: process.cwd(),
                allowTrainingRoutes: runtimeConfig?.allowTrainingRoutes ?? false, eligibility: input.eligibility, notify: () => {},
                requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
              })
            },
          }),
        }),
      }),
    })
    return assembled.tools.current().providerRuntime?.role
  }
  const luna = access("gpt-6-luna", "openai")
  const haiku = access("claude-haiku-4.5", "anthropic")
  const waitsFor = (model: string) => ({ unserved: { model, reason: "not_offered" }, recovery: { kind: "at", hold: { kind: "recheck" } } })
  // A saved model that no account offers stays the agent's model, and its request waits for it.
  await expect(assemble({ eligibility: luna, saved: { model: "lost-model", effort: "low" } })).rejects.toMatchObject(waitsFor("lost-model"))
  await expect(assemble({ eligibility: luna, saved: { model: "lost-model", effort: "low" }, unattended: true })).rejects.toMatchObject({ missing: "provider" })
  // An unsaved role resolves its default once, and the agent keeps that pair when it can no longer serve.
  const roleHold: RoleHold = {}
  const started = await assemble({ eligibility: luna, roleHold })
  expect(started?.model).toBe("gpt-6-luna")
  await expect(assemble({ eligibility: haiku, roleHold })).rejects.toMatchObject(waitsFor("gpt-6-luna"))
  expect((await assemble({ eligibility: haiku }))?.model).toBe("claude-haiku-4.5")
  // A saved pair replaces the held one at once.
  expect((await assemble({ eligibility: haiku, saved: { model: "claude-haiku-4.5", effort: "low" }, roleHold }))?.model).toBe("claude-haiku-4.5")
  // The agent's conversation records the pair, so the agent keeps it after a restart, which holds nothing in memory.
  const store = createSqliteEventStore(join(tempDir("own-model-store-"), "events.sqlite"))
  try {
    expect((await assemble({ eligibility: luna, roleHold: {}, durable: store }))?.model).toBe("gpt-6-luna")
    await expect(assemble({ eligibility: haiku, roleHold: {}, durable: store })).rejects.toMatchObject(waitsFor("gpt-6-luna"))
  } finally {
    store.close()
  }
})
