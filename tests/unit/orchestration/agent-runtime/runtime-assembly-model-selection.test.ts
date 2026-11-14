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
import { AllCandidatesExhaustedError } from "../../../../src/orchestration/agent-runtime/llm/errors.js"
import { createAdmittedClient, type AccessProviderBuild } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import { FUNCTION_TOOL_PRESENTATION, type AdapterAdmission, type ConversationMessage, type LLMClient, type ServingAttempt } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { resolveSessionRoles } from "../../../../src/orchestration/config/session-role-resolver.js"
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js"
import { capabilityAccessHolding } from "./tools/_fixtures.js"

const tempDir = temporaryDirectories()

/** A user data root whose benchmark cache was refreshed now, so the `models`
 *  tool reads the cache and fetches nothing. */
function freshBenchmarkCacheRoot(): string {
  const userDataRoot = tempDir("runtime-assembly-models-")
  mkdirSync(join(userDataRoot, "models"), { recursive: true })
  writeFileSync(join(userDataRoot, "models", "benchmark-tiers.json"), JSON.stringify({ attemptedAt: Date.now(), snapshot: null }))
  return userDataRoot
}

test("skips an unavailable saved pair, captures each next model, and keeps tool calls on their request selection", async () => {
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
  const toolModels: string[] = []
  const plans: string[] = []
  const notices: ConversationMessage[] = []
  const signal = new AbortController().signal
  const assembled = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options: {
      ...testDirectories(process.cwd()), userDataRoot: freshBenchmarkCacheRoot(), model: "lost-model", effort: "low",
      resolveRoles: (capture) => {
        if (!capture) throw new Error("The role resolver must share the request capture")
        return resolveSessionRoles({ defaults: {}, overrides: { explorer: { model: "lost-model", effort: "low" } } }, capture, "/scratch")
      },
      requestSelection: (roles) => roles.get("explorer") ?? { roleId: "explorer" },
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
      append: (message) => { if (message.kind === "system") notices.push(message) },
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
        requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit(admitted) {
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
  expect(notices).toEqual(["gpt-6-luna", "claude-haiku-4.5"].map((model) => ({
    kind: "system", displayOnly: true,
    content: `The saved model, lost-model, cannot serve now. ${model} at high effort serves this agent until it can.`,
  })))
  const models = initialSurface.tools.get("models")
  if (!models) throw new Error("The assembled runtime must expose live model inspection")
  const catalog = await models.execute({}, { executionCwd: "/scratch", userDataRoot: "/scratch/.test-account", projectRoot: "/scratch", artifactScopeId: "selection-test", retrievalSessionId: "selection-test" })
  if (typeof catalog.content !== "string") throw new Error("models must return JSON text")
  expect(JSON.parse(catalog.content).models.rows.map((row: unknown[]) => row[0])).toEqual(["claude-haiku-4.5"])
})

test("only an agent that is not unattended asks its role's preferences whether they serve, once per request for its own role, and its request boundary fails as the role's when none serves (PI-MODEL-087, ARCH-RUNTIME-082)", async () => {
  const auth = testAuthContext({ apiKeys: { openai_api: "test-key" } })
  const connection = captureProviderConnection({ profileId: "default", authDir: "/scratch/auth", auth })
  const candidate = { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } as const
  const models = new Set(["gpt-6-luna"])
  const eligibility = providerModelEligibilityDecision({
    profileId: "default", revision: 1, catalogs: new Map([["openai_api", { effective: models, enabled: models }]]),
    enabledCandidates: new Map<string, ProviderModelEnabledCandidate>([[accessProviderAccountKey(candidate), {
      candidate, configured: true, currentConnection: true, catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
      enabledOfferings: new Map([["gpt-6-luna", [{ wireModelId: "gpt-6-luna", dataUse: "standard" as const, metadata: null, transport: "openai-responses" as const, resolvedMetadata: modelInfo("openai", "gpt-6-luna", "fixture", 2, 10, "2026-10-01") }]]]),
    }]]),
  }).worker
  // Every preference spent its quota, the role's earliest until `RESET`; the selected model's walk states a later time.
  const RESET = Date.now() + 60_000
  const spent = { kind: "spent" as const, spent: { reset: { atMs: RESET, hold: { kind: "usage_limit" as const, stated: true } }, providers: ["OpenAI"] } }
  const walkFailure = new AllCandidatesExhaustedError({ message: "No access provider can run the model", recovery: { kind: "at", atMs: RESET + 3_600_000, hold: { kind: "usage_limit", stated: true } } })
  const judgedFor = async (purpose: AgentPurpose, unattended = false, noneServes = false): Promise<string[]> => {
    const judged: string[] = []
    const signal = new AbortController().signal
    const providers = accessProviderRegistry(testCapabilityModules())
    await assembleRuntimeForTurn({
      providerSessionLifetime: testProviderSessionLifetime(),
      options: {
        ...testDirectories(process.cwd()), userDataRoot: freshBenchmarkCacheRoot(), model: "gpt-6-luna",
        resolveRoles: (capture) => {
          if (!capture) throw new Error("The role resolver must share the request capture")
          return resolveSessionRoles({ defaults: {}, overrides: {} }, capture, "/scratch")
        },
        requestSelection: (roles) => roles.get("explorer") ?? { roleId: "explorer" },
        purpose, agentsMd: "", onEvent: () => {}, ...(unattended ? { capabilityAccess: { ...capabilityAccessHolding([]), unattended: true } } : {}),
        moduleSelection: testCapabilityModules, awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
        runtimeSurfaces: {}, conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
      },
      definitions: repoDefinitions(),
      conversation: resolveRuntimeConversation({ kind: "stateless" }, { providerSessionKey: "standing-test", artifactScopeId: "standing-test", retrievalSessionId: "standing-test" }),
      signal, disposalSignal: signal, instruction: "work", currentTurn: undefined,
      personas: new Map(), createRunner: () => { throw new Error("unused") },
      captureModelRuntime: async () => ({
        generation: connection,
        createLLMClient: async () => { throw new Error("uncaptured client path") },
        captureProviderConnection: async () => ({
          connection, providers, eligibility, runtimeConfig: testRuntimeConfigCapture(),
          requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async (plan) => { judged.push(plan.model); return noneServes ? spent : { kind: "serves" as const } },
          admit: (admitted) => ({
            createAgent: () => { throw new Error("unused") },
            createLLMClient: async (model, _modules, runtimeConfig, providerSessionLifetime) => {
              const plan = admitted.get(model)
              if (plan?.kind !== "admitted") throw new Error("missing selected plan")
              const client = await createAdmittedClient(plan, fakeModelsClient, connection, {
                providers, providerSessionLifetime: providerSessionLifetime ?? testProviderSessionLifetime(), projectRoot: process.cwd(),
                allowTrainingRoutes: runtimeConfig?.allowTrainingRoutes ?? false, eligibility, notify: () => {},
                requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }),
              })
              if (!noneServes) return client
              return { model: client.model, modelFamily: client.modelFamily, plannedAttempt: async () => { throw walkFailure },
                admitRequest: async (capture) => ({ ...await client.admitRequest(capture), plannedAttempt: async () => { throw walkFailure } }) }
            },
          }),
        }),
      }),
    })
    return judged
  }
  expect(await judgedFor({ kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" })).toEqual(["gpt-6-luna"])
  expect(await judgedFor({ kind: "workflow-follow-up" })).toEqual(["gpt-6-luna"])
  expect(await judgedFor({ kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" }, true)).toEqual([])
  expect(await judgedFor({ kind: "interactive-chat" })).toEqual([])
  const subagent = { kind: "subagent", renderAs: "subagent", parentToolUseId: "call-1" } as const
  await expect(judgedFor(subagent, false, true)).rejects.toMatchObject({ noPreferenceServes: true, recovery: { kind: "at", atMs: RESET } })
  const unmarked = await judgedFor(subagent, true, true).catch((error: unknown) => error)
  expect(unmarked).toBe(walkFailure)
})
