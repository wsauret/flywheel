import Anthropic from "@anthropic-ai/sdk"
import type { RawMessageStreamEvent } from "@anthropic-ai/sdk/resources/messages.js"
import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureProviderConnection, type AuthContext } from "../../../../src/infra/auth/auth-context.js"
import { AuthStoreMutationError } from "../../../../src/infra/auth/auth-store-mutations.js"
import type { UsageEntry } from "../../../../src/infra/llm/usage-entry.js"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { LiveAgent } from "../../../../src/orchestration/agent-runtime/runner.js"
import { ApiError } from "../../../../src/orchestration/agent-runtime/errors.js"
import { createAgentHost } from "../../../../src/orchestration/runner/host.js"
import { generateSessionTitle, type SessionTitles } from "../../../../src/orchestration/session/session-title.js"
import { createLearningReviewExecution } from "../../../../src/orchestration/modules/learning/learning-review-runner.js"
import { assembleRuntimeForTurn } from "../../../../src/orchestration/agent-runtime/runtime-assembly.js"
import { resolveRuntimeConversation } from "../../../../src/orchestration/agent-runtime/runtime-conversation.js"
import { createAnthropicAdapter, type AnthropicOperations } from "../../../../src/orchestration/agent-runtime/llm/anthropic.js"
import { createAdmittedClient, stagedProviderClient } from "../../../../src/orchestration/agent-runtime/llm/client-factory.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import type { AgentFactory, RunnableAgentOptions } from "../../../../src/orchestration/agent-runtime/types.js"
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { fixedRequestToolSurface, RequestToolMap, testRuntimeConfigCapture } from "../../../helpers/request-tool-surface.js"
import { testCapabilityModules, testProviderEligibility, testProviderRegistry, testProviderSessionLifetime } from "../../../helpers/provider-authority.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testDirectories } from "../../../helpers/directories.js"
import { fakeModelsClient, modelInfo } from "../../../helpers/model-tier-fixtures.js"
import { fakeAvailability } from "./llm/_provider-chain-harness.js"
import { authProviders } from "../../../helpers/auth-context.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { requireModelMetadata } from "../../../../src/orchestration/agent-runtime/llm/provider-description.js"

const MODEL = "claude-sonnet-4.6"
const auth: AuthContext = {
  providers: authProviders({ apiKeys: { anthropic_api: "hermetic-api-key" }, oauth: ["github_copilot"] }), droppedCredentials: [],
  credentialLineages: { anthropic_api: "00000000-0000-4000-8000-000000000001" },
}

function wrappedQuota() {
  return new Anthropic.APIError(429, { error: { type: "quota_exceeded", message: "You have exceeded your premium request quota" } }, "429 {\"error\":{\"type\":\"quota_exceeded\",\"message\":\"You have exceeded your premium request quota\"}}", new Headers())
}

function* textFrames(text: string, index = 0): Generator<RawMessageStreamEvent> {
  yield { type: "content_block_start", index, content_block: { type: "text", text: "", citations: null } }
  yield { type: "content_block_delta", index, delta: { type: "text_delta", text } }
  yield { type: "content_block_stop", index }
}

function* toolFrames(id: string, complete: boolean): Generator<RawMessageStreamEvent> {
  yield { type: "content_block_start", index: 1, content_block: { type: "tool_use", id, name: "probe", input: {}, caller: { type: "direct" } } }
  yield { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: complete ? "{}" : "{\"unfinished\":" } }
  if (complete) yield { type: "content_block_stop", index: 1 }
}

interface Scenario {
  failures: readonly Error[]
  eagerTool?: boolean
  measuredFailures?: boolean
  model?: string
  responseText?: string
  /** How many responses of the serving candidate open with this looping reasoning before it answers, and what the
   *  looping response streams before its reasoning: visible text, or a signed thinking block with an executed tool call. */
  loopingReasoning?: { responses: number; text: string; lead?: "text" | "signed tool call" }
}

/** Streams `text` in small deltas, the way a looping model does, until the
 *  attempt aborts the request. The first 1024 chars close as their own signed
 *  thinking block, so the attempt holds a complete deliberation part when the
 *  loop trips.
 *  @yields {RawMessageStreamEvent} The thinking blocks' start, deltas, signature, and stop frames. */
async function* thinkingFrames(text: string, signal: AbortSignal, index = 0): AsyncGenerator<RawMessageStreamEvent> {
  yield { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }
  for (let at = 0; at < text.length; at += 64) {
    if (signal.aborted) throw new DOMException("This operation was aborted", "AbortError")
    yield { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text.slice(at, at + 64) } }
    if (at + 64 === 1024) {
      yield { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-first" } }
      yield { type: "content_block_stop", index }
      yield { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }
    }
  }
  yield { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } }
  yield { type: "content_block_stop", index }
}

/** The part of a looping response before its looping reasoning (`Scenario.loopingReasoning.lead`), and the index of
 *  the next block. A tool call waits for its eager execution, so the call is durable work when the loop trips.
 *  @yields {RawMessageStreamEvent} The lead blocks' frames. */
async function* leadFrames(lead: "text" | "signed tool call" | undefined, executed: Promise<void>): AsyncGenerator<RawMessageStreamEvent, number> {
  if (lead === "text") {
    yield* textFrames("visible before the loop")
    return 1
  }
  if (lead !== "signed tool call") return 0
  yield { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "probe first" } }
  yield { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-plan" } }
  yield { type: "content_block_stop", index: 0 }
  yield* toolFrames("executed-tool", true)
  await executed
  return 2
}

async function fixture(scenario: Scenario) {
  const model = scenario.model ?? MODEL
  let tokenizerResolutions = 0
  const modelsClient = {
    ...fakeModelsClient,
    modelInfos: new Map([
      ...fakeModelsClient.modelInfos,
      ["claude-fable-5.1", modelInfo("anthropic", "claude-fable-5.1", "claude-fable", 3, 15, "2026-08-01")],
    ]),
    getTokenizerIdentity: (modelId: string) => {
      tokenizerResolutions++
      return modelId.startsWith("claude-") ? "ClaudeV5" as const : undefined
    },
  }
  const root = mkdtempSync(join(tmpdir(), "request-owned-fallback-"))
  const store = createSqliteEventStore(join(root, "flywheel.sqlite"))
  const writer = createSessionFactWriter({ sessionId: "session", writer: asAsyncEventWriter(store) })
  const history: ConversationMessage[] = []
  let leafId: string | null = null
  const audit: ProviderRequestAuditFact[] = []
  const usage: UsageEntry[] = []
  const events: RuntimeEvent[] = []
  const notices: unknown[] = []
  const authConditions: unknown[] = []
  const order: string[] = []
  const wires: { account: string; params: Parameters<AnthropicOperations["createStream"]>[0] }[] = []
  const availability = fakeAvailability({})
  const output = createOutputSession({ executionCwd: root, updateEntry: () => {} })
  const snapshots: string[] = []
  const executed = Promise.withResolvers<void>()
  let executions = 0
  const probe: RuntimeTool = {
    name: "probe", action: "ui_meta", description: "Observe one deterministic value", inputSchema: { type: "object" }, isConcurrencySafe: true,
    execute: async () => { executions++; order.push("tool.executed"); executed.resolve(); return { content: "actual tool result", outcome: "ok" } },
  }
  const accounts = scenario.failures.map((_, index) => `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`)
  const connection = captureProviderConnection({
    profileId: "default", auth, authDir: join(root, "auth"), oauthPersistence: "memory-only",
    subscriptionCredentials: new Map([["github_copilot", accounts.map((instanceId) => ({ instanceId, credential: { type: "oauth" as const, access: Redacted.make("sdk-fixture"), refresh: Redacted.make("sdk-refresh"), expires: Number.MAX_SAFE_INTEGER } }))]]),
  })
  const registry = testProviderRegistry()
  const factories = new Map(registry.factories)
  for (const provider of ["github_copilot", "anthropic_api"] as const) {
    factories.set(provider, async (build) => {
      const { candidate, model: candidateModel, availability: boundAvailability } = build
      const failureIndex = candidate.kind === "subscription" ? accounts.indexOf(candidate.instanceId) : -1
      const account = failureIndex >= 0 ? `account-${failureIndex}` : candidate.providerId
      const client = await createAnthropicAdapter(Redacted.make("sdk-fixture"), candidateModel, requireModelMetadata(candidateModel, build.attribution.resolvedModelMetadata ?? modelsClient.modelInfos.get(candidateModel)), {
        accessProvider: provider, candidate, availability: boundAvailability,
        operations: {
          isBadRequestError: () => false,
          createStream: async (params, { signal }) => {
            const looping = failureIndex < 0 && wires.filter((wire) => wire.account === account).length < (scenario.loopingReasoning?.responses ?? 0)
            wires.push({ account, params: structuredClone(params) })
            order.push(`wire:${account}`)
            if (failureIndex >= 0 && !scenario.measuredFailures && !scenario.eagerTool) throw scenario.failures[failureIndex]
            return {
              response: new Response(),
              data: {
                controller: new AbortController(),
                async *[Symbol.asyncIterator](): AsyncGenerator<RawMessageStreamEvent> {
                  const ordinal = failureIndex >= 0 ? failureIndex + 1 : accounts.length + 1
                  yield { type: "message_start", message: { id: `response-${account}`, type: "message", role: "assistant", model: candidateModel, content: [], container: null, diagnostics: null, stop_details: null, stop_reason: null, stop_sequence: null, usage: { input_tokens: 10 * ordinal, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: null, inference_geo: null, output_tokens_details: null, server_tool_use: null, service_tier: null, speed: null } } }
                  if (failureIndex >= 0) {
                    if (scenario.eagerTool) {
                      yield* textFrames("retained partial")
                      yield* toolFrames("executed-tool", true)
                      await executed.promise
                      yield* toolFrames("unfinished-preview", false)
                    }
                    throw scenario.failures[failureIndex]
                  }
                  let next = 0
                  if (looping && scenario.loopingReasoning) {
                    next = yield* leadFrames(scenario.loopingReasoning.lead, executed.promise)
                    yield* thinkingFrames(scenario.loopingReasoning.text, signal, next++)
                  }
                  yield* textFrames(scenario.responseText ?? "finished on authorized API", next)
                  yield { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null, container: null, stop_details: null }, usage: { output_tokens: 7, input_tokens: null, cache_creation_input_tokens: null, cache_read_input_tokens: null, output_tokens_details: null, server_tool_use: null } }
                  yield { type: "message_stop" }
                },
              },
            }
          },
        },
      })
      return stagedProviderClient(build, client, async () => client)
    })
  }
  const providers = { ...registry, factories }
  const eligibility = testProviderEligibility()
  const plan = providers.selection.plan(model, connection, eligibility)
  expect(plan.kind).toBe("admitted")
  const client = await createAdmittedClient(plan, modelsClient, connection, {
    notify: () => {}, providerSessionLifetime: testProviderSessionLifetime(),
    projectRoot: root, providers, eligibility,
    allowTrainingRoutes: false,
    availability: { forCandidates: () => availability.availability, dispose: async () => {} },
    retrySleep: async () => {},
    requestAdmission: async () => ({ spendSources: () => undefined, subscriptionSpendAuthorizationFor: () => undefined, subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }) }),
    observeAuthConditions: (conditions) => { authConditions.push(...conditions) },
  })
  const tokenizerResolutionsAtConstruction = tokenizerResolutions
  const options: RunnableAgentOptions = {
    ...testDirectories(root), model, agentsMd: "", memorySnapshot: null,
    purpose: { kind: "interactive-chat" }, runtimeSurfaces: {}, toolNames: [],
    moduleSelection: testCapabilityModules, awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
    lifecycle: { kind: "one-shot" },
    conversation: { kind: "durable-tree", reserveMessageId: async () => crypto.randomUUID(), sessionId: "session", conversationId: "conversation", priorMessages: [{ kind: "user", content: "work" }], append: (message, entryId) => { history.push(message); leafId = entryId ?? null; order.push(`canonical:${message.kind}`) }, captureCommittedForkMessages: async () => [], resolveLeafId: async () => leafId, committedTree: async () => ({ leafId: null, entriesById: {} }) },
    sessionEventStore: asAsyncEventReadSurface(store), sessionEventWriter: writer,
    auditObserver: (fact) => { audit.push(fact); order.push(`audit:${fact.type}`) },
    usageProfile: { profileId: "default", authorityIncarnation: "test-authority", acquireAuthority: async () => ({ profileId: "default", authorityIncarnation: "test-authority", append: (entry) => {
      if (entry.attribution.kind !== "candidate") throw new Error("Expected candidate usage attribution")
      usage.push(entry); order.push(`usage:${entry.attribution.providerId}`); return { kind: "appended" }
    }, release: async () => {} }) },
    onEvent: (event) => { events.push(event); output.dispatchRuntimeEvent(event); snapshots.push(JSON.stringify(output.getBlocks())) },
    onNotice: (notice) => { notices.push(notice) }, onSystemMessage: (...message) => { notices.push(message) },
  }
  const signal = new AbortController().signal
  const loop = await assembleRuntimeForTurn({
    providerSessionLifetime: testProviderSessionLifetime(),
    options, definitions: repoDefinitions(),
    conversation: resolveRuntimeConversation(options.conversation, { providerSessionKey: "conversation", artifactScopeId: "session", retrievalSessionId: "session" }),
    signal, disposalSignal: signal, instruction: null, currentTurn: undefined, personas: new Map(),
    captureModelRuntime: async () => ({ generation: client, createLLMClient: async () => client }),
    createRunner: () => { throw new Error("Unexpected nested dispatch") },
  })
  const dispose = () => { output.dispose(); writer.dispose(); store.close(); rmSync(root, { recursive: true, force: true }) }
  let runners = 0
  const createRunner: AgentFactory = (requested) => {
    if (requested.model !== model) throw new ApiError({ message: `No fixture credentials for ${requested.model}`, recovery: { kind: "none" } })
    runners++
    return new LiveAgent({
      ...requested, agentsMd: "", memorySnapshot: null, runtimeSurfaces: {},
      moduleSelection: testCapabilityModules, awaitModelAccessSettled: async () => {}, captureRuntimeConfig: testRuntimeConfigCapture,
      auditObserver: options.auditObserver,
      onEvent: (event) => { requested.onEvent(event); options.onEvent(event) },
      onNotice: options.onNotice, onSystemMessage: options.onSystemMessage,
    }, async () => client, repoDefinitions(), { request: () => {} })
  }
  return {
    async run() {
      try {
        if (scenario.eagerTool) await loop.tools.resolve()
        const result = await runAgentLoop({ ...loop, ...(scenario.eagerTool ? { systemPrompt: () => stableSystemPrompt("Use the probe"), tools: await fixedRequestToolSurface(new RequestToolMap([["probe", probe]])) } : {}), flushCanonicalMessages: async () => { order.push("flush") } })
        await writer.flush?.()
        output.flush()
        return result
      } finally { dispose() }
    },
    createRunner, dispose, root, connection, providers, client,
    runners: () => runners,
    history, audit, usage, events, notices, authConditions, wires, order, snapshots, availability,
    executions: () => executions,
    tokenizerResolutions: () => tokenizerResolutions,
    tokenizerResolutionsAtConstruction,
  }
}

function assertQuietSuccess(f: Awaited<ReturnType<typeof fixture>>) {
  assertNoVisibleNotice(f.notices)
  expect(f.events.filter((event) => event.type === "model.turn.completed")).toHaveLength(1)
  expect(f.snapshots.join("\n")).not.toMatch(/reconnecting|Sign in|"status":"failed"/)
  expect(f.history.filter((message) => message.kind === "user")).toEqual([])
  expect(f.history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "finished on authorized API" }] })
}

/** A turn that retried its first candidate in place before the silent
 *  fallback served it: the only notices are the reconnect progress the
 *  retries showed, one per retry, and the outcome reads as a clean success. */
function assertReconnectingSuccess(f: Awaited<ReturnType<typeof fixture>>, retries: number) {
  const upserts = f.notices.filter((notice): notice is { type: "upsert"; notice: { presentation: string } } =>
    typeof notice === "object" && notice !== null && "type" in notice && notice.type === "upsert")
  expect(upserts.map((operation) => operation.notice.presentation)).toEqual(Array.from({ length: retries }, () => "provider.reconnect_progress"))
  expect(f.events.filter((event) => event.type === "model.stream.retried")).toHaveLength(retries)
  expect(f.events.filter((event) => event.type === "model.turn.completed")).toHaveLength(1)
  expect(f.snapshots.join("\n")).not.toMatch(/Sign in|"status":"failed"/)
  expect(f.history.filter((message) => message.kind === "user")).toEqual([])
  expect(f.history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "finished on authorized API" }] })
}

function assertNoVisibleNotice(notices: unknown[]) {
  expect(notices).not.toContainEqual(expect.objectContaining({ type: "upsert" }))
  expect(notices.filter(Array.isArray)).toEqual([])
}

function assertAccounting(f: Awaited<ReturnType<typeof fixture>>, measured: boolean) {
  const requests = f.audit.filter((fact) => fact.type === "model.requested")
  const responses = f.audit.filter((fact) => fact.type === "model.response_received")
  expect(requests).toHaveLength(f.wires.length)
  expect(responses).toHaveLength(f.wires.length)
  expect(new Set(requests.map((fact) => fact.payload.requestId)).size).toBe(f.wires.length)
  expect(new Set(requests.map((fact) => fact.payload.turn))).toEqual(new Set([1]))
  for (const fact of requests) expect(fact.payload).toMatchObject({ model: MODEL, identity: { providerSessionKey: "conversation", conversationId: "conversation" } })
  const expected = measured ? f.wires.length : 1
  expect(f.usage).toHaveLength(expected)
  // The fixture prices each wire by its account's ordinal, so a retried
  // account reports the same prompt tokens on every attempt.
  const ordinal = (wire: (typeof f.wires)[number]): number => wire.account === "anthropic_api"
    ? new Set(f.wires.map((entry) => entry.account)).size
    : Number(wire.account.slice("account-".length)) + 1
  expect(f.usage.map((entry) => {
    if (entry.attribution.kind !== "candidate") throw new Error("Expected candidate usage attribution")
    if (entry.coverage === "unmeasured") throw new Error("Expected measured usage")
    return { provider: entry.attribution.providerId, input: entry.tokens.input, output: entry.tokens.output }
  })).toEqual(
    (measured ? f.wires : f.wires.slice(-1)).map((wire) => ({ provider: wire.account === "anthropic_api" ? "anthropic_api" : "github_copilot", input: 10 * ordinal(wire), output: wire.account === "anthropic_api" ? 7 : 0 })),
  )
  for (const entry of f.usage) expect(requests.some((request) => request.payload.requestId === entry.attemptId)).toBe(true)
  // Every attempt's audit closes before the next wire opens, retries included.
  const wirePositions = f.order.flatMap((step, position) => step.startsWith("wire:") ? [position] : [])
  expect(wirePositions).toHaveLength(f.wires.length)
  for (let index = 1; index < f.wires.length; index++) {
    expect(f.order.slice(0, wirePositions[index]).filter((step) => step === "audit:model.response_received")).toHaveLength(index)
  }
}

describe("request-owned fallback through SDK adapters and runtime settlement", () => {
  test("keeps one Claude tokenizer estimate and provider-distinct anchors across Copilot fallback", async () => {
    const f = await fixture({ failures: [wrappedQuota()], model: "claude-fable-5.1" })
    expect(f.tokenizerResolutionsAtConstruction).toBe(0)
    expect(f.tokenizerResolutions()).toBe(1)
    expect(await f.run()).toEqual({ kind: "completed" })
    // Assembly admitted the first request; the run reuses that capture because
    // the composition value and config revision are unchanged, so the tokenizer
    // identity is resolved once for the whole turn.
    expect(f.tokenizerResolutions()).toBe(1)
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
    expect(f.audit.filter((fact) => fact.type === "model.requested").map((fact) => fact.payload.accessProvider)).toEqual([
      "github_copilot",
      "anthropic_api",
    ])
  })

  test("wrapped Copilot quota continues the same logical turn on authorized Anthropic API", async () => {
    const f = await fixture({ failures: [wrappedQuota()], measuredFailures: true })
    expect(await f.run()).toEqual({ kind: "completed" })
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
    expect(f.wires.map((wire) => wire.params.model)).toEqual([MODEL, "claude-sonnet-4-6"])
    assertQuietSuccess(f)
    assertAccounting(f, true)
    expect(f.availability.genericEntryCount()).toBe(1)
  })

  test("a throttled account is retried in place, then hands the turn to the next account before direct API", async () => {
    const f = await fixture({ failures: [new Anthropic.RateLimitError(429, { error: { message: "rate limit exceeded" } }, "rate limit exceeded", new Headers())] })
    expect(await f.run()).toEqual({ kind: "completed" })
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "account-0", "account-0", "account-0", "anthropic_api"])
    assertReconnectingSuccess(f, 3)
    assertAccounting(f, false)
    expect(f.availability.genericEntryCount()).toBe(0)
    expect(f.availability.serviceEntryCount()).toBe(1)
  })

  test("an authentication rejection ends the turn under its own name instead of spending the next account", async () => {
    const f = await fixture({ failures: [new Anthropic.AuthenticationError(401, { error: { message: "invalid credential" } }, "invalid credential", new Headers())] })
    await expect(f.run()).rejects.toMatchObject({ _tag: "ApiError", message: expect.stringContaining("invalid credential") })
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0"])
    expect(f.availability.serviceEntryCount()).toBe(0)
  })

  test("a strict auth mutation failure settles its attempt before independent fallback", async () => {
    const condition = { kind: "malformed", scope: "provider", providerId: "github_copilot", authDirectory: "/profiles/default", revision: "r1" } as const
    const f = await fixture({ failures: [new AuthStoreMutationError([condition])], measuredFailures: true })
    expect(await f.run()).toEqual({ kind: "completed" })
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
    expect(f.authConditions).toEqual([condition])
    expect(f.order.indexOf("audit:model.response_received")).toBeLessThan(f.order.indexOf("wire:anthropic_api"))
    assertAccounting(f, true)
    expect(f.availability.serviceEntryCount()).toBe(0)
  })

  test("an unclassified failure is not evidence about the account: the turn ends where it is", async () => {
    const f = await fixture({ failures: [new Error("unrecognized external failure")] })
    await expect(f.run()).rejects.toMatchObject({ _tag: "ApiError", message: "unrecognized external failure" })
    expect(f.wires.map((wire) => wire.account)).toEqual(["account-0"])
    expect(f.availability.serviceEntryCount()).toBe(0)
  })

  test.each([
    { responses: 1, wires: 2 },
    { responses: 3, wires: 3 },
  ])("a response whose reasoning repeats itself is resampled on the same provider and the last attempt runs without reasoning and is accepted ($responses looping)", async ({ responses, wires }) => {
    const text = readFileSync(join(import.meta.dir, "../../../fixtures/reasoning-repetition/loop.txt"), "utf8")
    const f = await fixture({ failures: [], loopingReasoning: { responses, text }, measuredFailures: true })
    expect(await f.run()).toEqual({ kind: "completed" })

    expect(f.wires.map((wire) => wire.account)).toEqual(Array.from({ length: wires }, () => "anthropic_api"))
    // A resample sends the request it sent before: no continuation message, no looping text.
    for (const wire of f.wires) expect(wire.params.messages).toEqual(f.wires[0]!.params.messages)
    const upserts = f.notices.filter((notice): notice is { type: "upsert"; notice: { title: string; message: string } } =>
      typeof notice === "object" && notice !== null && "type" in notice && notice.type === "upsert")
    expect(upserts.map((operation) => [operation.notice.title, operation.notice.message])).toEqual([
      ["Model repeated itself", "Requesting a fresh response (1/2)."],
      ["Model repeated itself", "Requesting a fresh response without reasoning (2/2)."],
    ].slice(0, wires - 1))
    // Only the attempt after the last resample turns reasoning off; every earlier attempt keeps the session's effort.
    expect(f.wires.map((wire) => wire.params.thinking)).toEqual([
      f.wires[0]!.params.thinking,
      f.wires[0]!.params.thinking,
      { type: "disabled" } as const,
    ].slice(0, wires))
    expect(f.wires[0]!.params.thinking).not.toEqual({ type: "disabled" })
    expect(f.snapshots.join("\n")).not.toMatch(/Reconnecting|"status":"failed"/)
    expect(f.events.filter((event) => event.type === "model.stream.retried")).toHaveLength(0)
    expect(f.history.filter((message) => message.kind === "user")).toEqual([])
    // A stopped attempt's looping deliberation never enters the history, so no later request replays it.
    expect(f.history).toHaveLength(1)
    expect(f.history[0]).not.toHaveProperty("incomplete")
    // Every attempt sent the prompt assembled from the same leaf, so each one's audit reconstructs from that leaf.
    const assembled = f.audit.flatMap((fact) => fact.type === "prompt.assembled" ? [fact.payload] : [])
    expect(assembled).toHaveLength(wires)
    for (const payload of assembled) {
      expect(payload).toMatchObject({ treeLeafEntryId: null, messageCount: assembled[0]!.messageCount, promptSha256: assembled[0]!.promptSha256 })
    }
    // Each stopped attempt is its own request with its own usage.
    const requests = f.audit.filter((fact) => fact.type === "model.requested")
    expect(requests).toHaveLength(wires)
    expect(new Set(requests.map((fact) => fact.payload.requestId)).size).toBe(wires)
    // The audit records the effort that each attempt sent, so the last one reads `off`.
    const sessionEffort = requests[0]!.payload.reasoningEffort
    expect(sessionEffort).not.toBe("off")
    expect(requests.map((fact) => fact.payload.reasoningEffort)).toEqual([sessionEffort, sessionEffort, "off"].slice(0, wires))
    expect(f.usage.map((entry) => entry.attemptId)).toEqual(requests.map((fact) => fact.payload.requestId))
    expect(f.availability.serviceEntryCount()).toBe(0)
    expect(f.availability.genericEntryCount()).toBe(0)
  })

  test("visible text before looping reasoning stays durable and the resample's audit names the leaf its prompt was assembled from", async () => {
    const text = readFileSync(join(import.meta.dir, "../../../fixtures/reasoning-repetition/loop.txt"), "utf8")
    const f = await fixture({ failures: [], loopingReasoning: { responses: 1, text, lead: "text" }, measuredFailures: true })
    expect(await f.run()).toEqual({ kind: "completed" })

    expect(f.wires).toHaveLength(2)
    // The text a person saw stays, without the looping deliberation after it.
    expect(f.history[0]).toEqual(expect.objectContaining({ kind: "assistant", incomplete: true, content: [{ type: "text", text: "visible before the loop" }] }))
    expect(f.history.at(-1)).toMatchObject({ kind: "assistant", content: [{ type: "text", text: "finished on authorized API" }] })
    // The partial moved the tree leaf, but the resample sent the prompt assembled before it, so its audit names that leaf.
    const assembled = f.audit.flatMap((fact) => fact.type === "prompt.assembled" ? [fact.payload] : [])
    expect(assembled).toHaveLength(2)
    for (const payload of assembled) {
      expect(payload).toMatchObject({ treeLeafEntryId: null, messageCount: assembled[0]!.messageCount, promptSha256: assembled[0]!.promptSha256 })
    }
  })

  test("a looping partial with an executed tool call keeps its signed thinking, so the next request replays a valid tool turn", async () => {
    const text = readFileSync(join(import.meta.dir, "../../../fixtures/reasoning-repetition/loop.txt"), "utf8")
    const f = await fixture({ failures: [], eagerTool: true, loopingReasoning: { responses: 1, text, lead: "signed tool call" }, measuredFailures: true })
    expect(await f.run()).toEqual({ kind: "completed" })

    expect(f.executions()).toBe(1)
    const partial = f.history.find((message) => message.kind === "assistant" && message.incomplete === true)
    expect(partial).toBeDefined()
    if (partial?.kind !== "assistant") throw new Error("expected the committed partial")
    // The closed, signed blocks stay in order with the call; the unsigned block where the loop tripped goes.
    expect(partial.content).toEqual([
      { type: "thinking", thinking: "probe first", signature: "sig-plan" },
      expect.objectContaining({ type: "tool_use", id: "executed-tool", name: "probe" }),
      expect.objectContaining({ type: "thinking", signature: "sig-first" }),
    ])
  })

  test("eager tool result commits once before replacement sees history and unfinished preview vanishes", async () => {
    const f = await fixture({ failures: [wrappedQuota()], eagerTool: true })
    expect(await f.run()).toEqual({ kind: "completed" })
    expect(f.executions()).toBe(1)
    expect(f.history.filter((message) => message.kind === "toolResult")).toHaveLength(1)
    expect(JSON.stringify(f.wires[1]?.params.messages)).toContain("actual tool result")
    expect(JSON.stringify(f.wires[1]?.params.messages)).toContain("retained partial")
    expect(JSON.stringify(f.wires[1]?.params.messages)).not.toContain("unfinished-preview")
    expect(f.order.indexOf("canonical:toolResult")).toBeLessThan(f.order.indexOf("wire:anthropic_api"))
    expect(f.snapshots.at(-1)).not.toContain("unfinished-preview")
    assertQuietSuccess(f)
    assertAccounting(f, true)
  })

  test.each(["interactive-chat", "subagent", "workflow-agent"] as const)("shared host constructs one real %s runner across fallback", async (kind) => {
    const f = await fixture({ failures: [wrappedQuota()] })
    try {
      const result = await createAgentHost({ createRunner: f.createRunner }).runTurn({
        createContextOptions: () => ({
          ...testDirectories(f.root), model: MODEL,
          purpose: kind === "subagent" ? { kind, renderAs: "subagent", parentToolUseId: "parent-call" }
            : kind === "workflow-agent" ? { kind, briefScope: { briefId: "test-step" }, workflowAttemptId: "step-1" } : { kind },
          conversation: { kind: "stateless" }, lifecycle: { kind: "one-shot" },
          toolNames: [], onEvent: () => {},
        }),
        message: "work",
        resilience: {},
      })
      expect(result.terminal).toEqual({ kind: "completed" })
      expect(f.runners()).toBe(1)
      expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
      const requests = f.audit.filter((fact) => fact.type === "model.requested")
      expect(requests).toHaveLength(2)
      for (const request of requests) expect(request.payload).toMatchObject({ model: MODEL, turn: 1 })
      if (kind === "subagent") {
        const prompts = f.audit.filter((fact) => fact.type === "prompt.assembled")
        expect(prompts).toHaveLength(2)
        for (const prompt of prompts) expect(prompt.payload).toMatchObject({ parentToolUseId: "parent-call" })
      }
      assertNoVisibleNotice(f.notices)
    } finally { f.dispose() }
  })

  test("session title succeeds through its actual shared host without rebuilding on quota", async () => {
    const f = await fixture({ failures: [wrappedQuota()], model: "claude-haiku-4.5", responseText: "TITLE: Provider fallback tests\nSHORT: Fallback" })
    const titles = Promise.withResolvers<SessionTitles>()
    let updates = 0
    const generation = generateSessionTitle("work", (value) => { if (++updates === 2) titles.resolve(value) }, {
      ...testDirectories(f.root), createRunner: f.createRunner,
      auth: { ...auth, providers: authProviders({ base: auth.providers, without: ["github_copilot"] }),}, model: "claude-haiku-4.5",
    })
    try {
      expect(await titles.promise).toEqual({ full: "Provider fallback tests", short: "Fallback" })
      expect(f.runners()).toBe(1)
      expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
      expect(f.usage).toEqual([])
      assertNoVisibleNotice(f.notices)
    } finally { generation.abort(); f.dispose() }
  })

  test("learning review uses its admitted runtime and one real shared-host child", async () => {
    const f = await fixture({ failures: [wrappedQuota()], responseText: "{\"outcome\":\"independent\"}" })
    try {
      let attempts = 0
      const review = createLearningReviewExecution({
        ...testDirectories(f.root), model: MODEL, moduleSelection: testCapabilityModules(),
        captureProviderConnection: async () => ({
          connection: f.connection, providers: f.providers,
          eligibility: testProviderEligibility(),
          runtimeConfig: testRuntimeConfigCapture(),
          admit: () => ({ createAgent: f.createRunner, createLLMClient: async () => f.client }),
        }),
      })
      expect(await review.request({ systemPrompt: "Return the classification", instruction: "Audit the package", onAttempt: () => { attempts++ } })).toBe("{\"outcome\":\"independent\"}")
      expect(attempts).toBe(1)
      expect(f.runners()).toBe(1)
      expect(f.wires.map((wire) => wire.account)).toEqual(["account-0", "anthropic_api"])
      assertNoVisibleNotice(f.notices)
    } finally { f.dispose() }
  })
})
