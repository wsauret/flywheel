import { tmpdir } from "node:os"

import { describe, expect, it } from "bun:test"

import { runAgentLoop } from "../../../../../src/orchestration/agent-runtime/loop/agent-loop.js"
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work/background-work.js"
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/background-work/foreground-bash-hold.js"
import { createRequestToolSurface } from "../../../../../src/orchestration/agent-runtime/request/request-tool-surface.js"
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/dispatch/tool-exposure-planner.js"
import { OPENAI_RESPONSES_TOOL_PRESENTATION } from "../../../../../src/orchestration/agent-runtime/llm/provider-description.js"
import { FUNCTION_TOOL_PRESENTATION, type AdmittedModelRequest, type ConversationMessage, type LLMClient, type ProviderStreamEvent, type StreamEvent, type StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js"
import type { ProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js"
import type { RuntimeTool, ToolAttributionIdentity } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { asModelClient, ownHistoryTarget } from "../_model-client.js"
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/modules/module-runtime.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { RequestToolMap, testCapabilityModules, testKernelToolDeps, testRuntimeConfigCapture, plannedRequest } from "../../../../helpers/request-tool-surface.js"
import type { GitAiAttributionService } from "../../../../../src/orchestration/agent-runtime/git-ai-attribution-service.js"
import { chain, fakeAvailability, fakeClient, singletonCandidate, textStream } from "../llm/_provider-chain-harness.js"
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/stream/provider-failure.js"
import { StreamIdleTimeoutError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { CONTINUATION_MESSAGES } from "../../../../../src/orchestration/agent-runtime/request/prompt/continuation-messages.js"
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { messageInput } from "../../../../../src/infra/substrate/events/agent-loop-events.js"

describe("logical tool authorization", () => {
  it.each([
    { appendRequired: false, budget: false },
    { appendRequired: true, budget: false },
    { appendRequired: true, budget: true },
  ])("prepares ordinary provider appends before affordability: %j", async ({ appendRequired, budget }) => {
    const evidence: ReadonlyArray<ConversationMessage>[] = []
    const estimates: Array<number | undefined> = []
    const audited: ReadonlyArray<ConversationMessage>[] = []
    const dispatched: ReadonlyArray<ConversationMessage>[] = []
    const persisted: ConversationMessage[] = []
    const echoed: Array<{ content: string | import("../../../../../src/orchestration/agent-runtime/llm/types.js").ContentBlock[]; origin: string }> = []
    const reminder = { kind: "user", content: "Required provider reminder", origin: "system" } as const
    const saved: ConversationMessage[][] = []
    let admissions = 0
    const attempt = {
      ...fakeClient("openai_api", textStream("unused")),
      ...(appendRequired ? { messagesToAppend(messages: readonly ConversationMessage[], cwd: string) {
        expect(cwd).toBe(tmpdir())
        if (budget && !messages.some((message) => message.kind === "user" && typeof message.content === "string" && message.content.startsWith("Budget exhausted"))) return []
        return messages.some((message) => message.kind === "user" && message.content === reminder.content) ? [] : [reminder]
      } } : {}),
    }
    const client = chain({
      candidateAttributions: () => {
        admissions += 1
        return [{ candidate: singletonCandidate("openai_api"), wireModelId: attempt.model, dataUse: "standard" }]
      },
      availability: fakeAvailability({}).availability,
      requestAdmission: { subscriptionSpendAuthorizationFor: () => undefined },
      affordability: new Map([["openai_api", {
        evaluate: async ({ request }) => {
          evidence.push(request.messages)
          estimates.push(request.tokenClasses.estimatedPromptTokens)
          if (appendRequired) expect(saved.at(-1)).toContainEqual(reminder)
          return { kind: "eligible" as const }
        },
      }]]),
      build: async () => ({
        ...attempt,
        async *streamWithTools(options: StreamOptions) {
          dispatched.push(options.messages)
          if (!budget && dispatched.length === 1) {
            yield { kind: "text_delta" as const, text: "partial", blockKey: "text" }
            throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("stalled", "idle"))
          }
          yield { kind: "text_delta" as const, text: "done", blockKey: "text" }
          yield { kind: "done" as const, stopReason: "end_turn" as const }
        },
      }),
    })
    const surface = await createRequestToolSurface(
      () => ({ eligibleTools: new RequestToolMap(), tools: new RequestToolMap(), omitted: [], usable: new Set(), turnedOff: [], registrationIds: new Map(), registrationIdentities: new Map(), kernel: testKernelToolDeps() }), testCapabilityModules, testRuntimeConfigCapture,
    )
    await runAgentLoop({
      client, initialPlannedAttempt: attempt, tools: surface,
      ...(budget ? { maxLLMCalls: 0 } : {}),
      systemPrompt: () => stableSystemPrompt("literal"), instruction: "work",
      executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      persistence: { history: { append: (message) => { persisted.push(message) } } }, seed: { kind: "fresh" },
      onUserMessage: (content, origin) => { echoed.push({ content, origin }) },
      flushCanonicalMessages: async () => { saved.push([...persisted]) },
      onEvent: () => {}, providerSessionKey: "provider-session", promptCacheKey: "provider-session", artifactScopeId: "artifact-scope", retrievalSessionId: "retrieval-session",
      requestAudit: {
        recordRequest(input) {
          audited.push(input.messages)
          expect(input.messageCount).toBe(input.messages.length)
          expect(estimates.at(-1)).toBe(input.estimatedContextTokens)
          return { requestId: input.requestId, turn: input.turn }
        },
        recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
      },
    })
    expect(admissions).toBe(1)
    expect(dispatched).toHaveLength(budget ? 1 : 2)
    expect(evidence).toHaveLength(budget ? 1 : 2)
    expect(persisted.filter((message) => message.kind === "user" && message.content === reminder.content)).toHaveLength(appendRequired ? 1 : 0)
    expect(echoed.filter(({ content }) => content === reminder.content)).toEqual(appendRequired ? [{ content: reminder.content, origin: "system" }] : [])
    expect(estimates[0]).toBeGreaterThan(0)
    for (let index = 0; index < dispatched.length; index += 1) {
      expect(audited[index]).toBe(evidence[index])
      expect(dispatched[index]).toBe(evidence[index])
      expect(dispatched[index]?.filter((message) => message.kind === "user" && message.content === reminder.content)).toHaveLength(appendRequired ? 1 : 0)
    }
    if (!budget) {
      // The stall notice is recorded once after the partial answer, and the retry's input extends the stalled one.
      const stallNotice: ConversationMessage = { kind: "user", content: CONTINUATION_MESSAGES.stream_stalled, origin: "system" }
      expect(dispatched[1]?.slice(0, dispatched[0]!.length)).toEqual([...dispatched[0]!])
      expect(dispatched[1]?.slice(dispatched[0]!.length)).toMatchObject([{ kind: "assistant", content: [{ type: "text", text: "partial" }] }, stallNotice])
      expect(persisted.filter((message) => message.kind === "user" && message.content === CONTINUATION_MESSAGES.stream_stalled)).toEqual([stallNotice])
    }
  })
})

/** Runs one loop over a single candidate whose streams stall when `stalls` says so, and records what each request
 *  sent, the history, and how many save points preceded each send. */
async function runSingleCandidate(input: { stalls: (request: number) => boolean; turnContext?: string; prior?: ConversationMessage[] }) {
  const dispatched: ReadonlyArray<ConversationMessage>[] = []
  const persisted: ConversationMessage[] = []
  const flushesBeforeSend: number[] = []
  let flushes = 0
  const attempt = fakeClient("openai_api", textStream("unused"))
  const client = chain({
    candidateAttributions: () => [{ candidate: singletonCandidate("openai_api"), wireModelId: attempt.model, dataUse: "standard" }],
    availability: fakeAvailability({}).availability,
    requestAdmission: { subscriptionSpendAuthorizationFor: () => undefined },
    affordability: new Map([["openai_api", { evaluate: async () => ({ kind: "eligible" as const }) }]]),
    build: async () => ({
      ...attempt,
      async *streamWithTools(options: StreamOptions) {
        dispatched.push(options.messages)
        flushesBeforeSend.push(flushes)
        yield { kind: "text_delta" as const, text: "partial", blockKey: "text" }
        if (input.stalls(dispatched.length)) throw normalizeProviderAttemptFailure(new StreamIdleTimeoutError("stalled", "idle"))
        yield { kind: "done" as const, stopReason: "end_turn" as const }
      },
    }),
  })
  const surface = await createRequestToolSurface(
    () => ({ eligibleTools: new RequestToolMap(), tools: new RequestToolMap(), omitted: [], usable: new Set(), turnedOff: [], registrationIds: new Map(), registrationIdentities: new Map(), kernel: testKernelToolDeps() }), testCapabilityModules, testRuntimeConfigCapture,
  )
  const run = runAgentLoop({
    client, initialPlannedAttempt: attempt, tools: surface,
    systemPrompt: () => stableSystemPrompt("literal"), instruction: input.prior ? null : "work",
    ...(input.turnContext === undefined ? {} : { initialRequestContext: input.turnContext }),
    executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
    persistence: { history: { append: (message) => { persisted.push(message) } } },
    seed: input.prior ? { kind: "resume", priorMessages: input.prior } : { kind: "fresh" },
    flushCanonicalMessages: async () => { flushes += 1 },
    onEvent: () => {}, providerSessionKey: "provider-session", promptCacheKey: "provider-session", artifactScopeId: "artifact-scope", retrievalSessionId: "retrieval-session",
  })
  const failure = await run.then(() => undefined, (error: unknown) => error)
  return { dispatched, persisted, flushesBeforeSend, failure }
}

const isStallNotice = (message: ConversationMessage): boolean => message.kind === "user" && message.content === CONTINUATION_MESSAGES.stream_stalled

describe("stall recovery", () => {
  it("records a stall notice only for a request that recovers from the stall", async () => {
    const { dispatched, persisted, failure } = await runSingleCandidate({ stalls: () => true })
    expect(failure).toBeDefined()
    expect(dispatched.length).toBeGreaterThan(1)
    for (let index = 0; index < dispatched.length; index += 1) {
      expect(dispatched[index]!.filter(isStallNotice)).toHaveLength(index)
      if (index > 0) expect(dispatched[index]!.slice(0, dispatched[index - 1]!.length)).toEqual([...dispatched[index - 1]!])
    }
    // The walk gave up after the last stall, so no notice follows the last sent request.
    expect(persisted.filter(isStallNotice)).toHaveLength(dispatched.length - 1)
    expect(persisted.slice(dispatched.at(-1)!.length).some(isStallNotice)).toBe(false)
  })
})

describe("turn context save points", () => {
  it("records turn context with no save point beyond the request's own, at any history length", async () => {
    const history = (turns: number): ConversationMessage[] => Array.from({ length: turns }, (_, index): ConversationMessage[] => [
      { kind: "user", content: `question ${index}`, origin: "human" },
      { kind: "assistant", content: [{ type: "text", text: `answer ${index}` }] },
    ]).flat().concat([{ kind: "user", content: "next", origin: "human" }])
    const counts = await Promise.all([1, 200].flatMap((turns) => [undefined, "Turn guidance."].map(async (turnContext) => {
      const { dispatched, flushesBeforeSend } = await runSingleCandidate({ stalls: () => false, prior: history(turns), ...(turnContext === undefined ? {} : { turnContext }) })
      expect(dispatched[0]!.filter((message) => message.kind === "user" && message.content === "Turn guidance.")).toHaveLength(turnContext === undefined ? 0 : 1)
      return flushesBeforeSend[0]
    })))
    expect(new Set(counts).size).toBe(1)
  })
})

describe("per-request persistent-process policy", () => {
  it("rechecks live policy after advertising the pinned schema", async () => {
    const tasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
    const background = createBackgroundExecutionOwner(tasks)
    const foregroundBashHold = createForegroundBashHoldController(() => {})
    const surface = await createRequestToolSurface(() => plannedRequest(planToolExposure({
      kernel: testKernelToolDeps({
        userDataRoot: tmpdir(),
        capabilities: { available: (capability) => capability === "background-commands" },
        backgroundTasks: tasks,
        shell: background.shell,
        foregroundBashHold,
        persistentProcesses: true,
        persistentProcessesAdvertised: true,
      }),
      modules: NO_MODULE_RUNTIMES,
    })), testCapabilityModules, testRuntimeConfigCapture)
    let allowed = true
    let launches = 0
    let calls = 0
    const manager = {
      launch: async () => { launches += 1; throw new Error("revoked launch must not reach the manager") },
      list: async () => [],
      read: async () => { throw new Error("unused") },
      stop: async () => "already_exited" as const,
      release: async () => {},
      close: () => {},
    }
    const client = asModelClient({
      accessProvider: "anthropic_api" as const,
      modelFamily: "anthropic" as const,
      model: "test-model",
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        expect(JSON.stringify(options.tools)).toContain("persist_after_exit")
        if (calls++ > 0) {
          yield { kind: "text_delta", text: "done", blockKey: "text" }
          yield { kind: "done", stopReason: "end_turn" }
          return
        }
        allowed = false
        yield { kind: "tool_use", toolCall: { id: "tc_persistent", name: "bash", input: { command: "bun server.ts", background: true, persist_after_exit: true } } }
        yield { kind: "done", stopReason: "tool_use" }
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    })
    const results: string[] = []

    try {
      await runAgentLoop({
        client,
        tools: surface,
        systemPrompt: () => stableSystemPrompt("test"),
        instruction: "start server",
        executionCwd: tmpdir(),
        userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
        providerSessionKey: "provider-session", promptCacheKey: "provider-session",
        artifactScopeId: "artifact-scope",
        retrievalSessionId: "retrieval-session",
        persistence: { history: { append: () => {} } },
        seed: { kind: "fresh" },
        onEvent: (event) => {
          if (event.kind === "tool_result") results.push(event.content.map((part) => part.type === "text" ? part.text : "").join(""))
        },
        completeOnIdle: {},
        background,
        persistentProcesses: manager,
        allowPersistentProcesses: () => allowed,
      })
    } finally {
      foregroundBashHold.dispose()
      await background.close()
    }

    expect(launches).toBe(0)
    expect(results).toContain("Persistent execution is disabled. Enable allow_persistent_processes or start the runtime with --allow-persistent-processes.")
  })

  it("persists canonical calls and copies request attribution before response retirement", async () => {
    const bash: RuntimeTool = {
      name: "bash",
      action: "ui_meta",
      description: "bash tool",
      inputSchema: { type: "object", properties: { command: { type: "string" } } },
      isConcurrencySafe: true,
      execute: async () => ({ content: "ran", outcome: "ok" }),
    }
    const surface = await createRequestToolSurface(
      () => ({
        eligibleTools: new RequestToolMap([["bash", bash]]),
        tools: new RequestToolMap([["bash", bash]]),
        omitted: [],
        usable: new Set(["bash"]), turnedOff: [],
        registrationIds: new Map([["bash", "bash"]]),
        registrationIdentities: new Map([["bash", "bash"]]),
        kernel: testKernelToolDeps(),
      }),
      testCapabilityModules,
      testRuntimeConfigCapture,
    )
    let request = 0
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "openai_api",
      modelFamily: "openai",
      model: "gpt-6-luna",
      toolPresentation: OPENAI_RESPONSES_TOOL_PRESENTATION,
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
        if (request++ === 0) {
          yield { kind: "tool_use", toolCall: { id: "tc_bash", name: "Bash", input: { command: "pwd" } } }
          yield { kind: "tool_use", toolCall: { id: "tc_exec", name: "exec", input: { command: "pwd" } } }
          yield { kind: "done", stopReason: "tool_use" }
          return
        }
        yield { kind: "text_delta", text: "done", blockKey: "text" }
        yield { kind: "done", stopReason: "end_turn" }
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    }
    const canonical: ConversationMessage[] = []
    const events: StreamEvent[] = []
    const interactionProfileIds: string[] = []
    const requestAudit: ProviderRequestAuditWriter = {
      recordRequest(input) {
        interactionProfileIds.push(input.interactionProfileId)
        return { requestId: `request-${interactionProfileIds.length}`, turn: input.turn }
      },
      recordResponse() {}, recordUsage() {}, recordStreamStarted() {}, recordStreamEvent() {}, recordStreamCompleted() {},
    }
    const service: GitAiAttributionService = {
      canonicalRepositoryRoot: tmpdir(),
      status: () => ({ kind: "available" }),
      subscribe: () => () => {},
      checkAvailability: async () => ({ kind: "available" }),
      registerRequest: () => {},
      direct: () => {},
      dispose: async () => {},
    }
    const identity: ToolAttributionIdentity = Object.freeze({ service, repositoryRoot: tmpdir(), requestId: "request-1", profileId: "work", enabled: true, conversationId: "conversation-1", model: "served-model", transcriptBytes: 0, transcript: () => ({ messages: [] }) })
    let availableIdentity: ToolAttributionIdentity | undefined = identity

    const attributionAdmissions: string[] = []
    await runAgentLoop({
      client: asModelClient(client),
      tools: surface,
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      persistence: { history: { append: (message) => { canonical.push(message) } } },
      seed: { kind: "fresh" },
      onEvent: (event) => { events.push(event) },
      providerSessionKey: "provider-session", promptCacheKey: "provider-session",
      artifactScopeId: "artifact-scope",
      retrievalSessionId: "retrieval-session",
      requestAudit,
      requestAttribution: {
        resolve: (requestId) => {
          attributionAdmissions.push(requestId)
          return requestId === "request-1" ? availableIdentity : undefined
        },
        retire: () => { availableIdentity = undefined },
      },
    })

    expect(canonical.find((message) => message.kind === "assistant")).toMatchObject({
      content: [
        { type: "tool_use", id: "tc_bash", name: "bash" },
        { type: "tool_use", id: "tc_exec", name: "exec" },
      ],
    })
    expect(events).toContainEqual(expect.objectContaining({
      kind: "tool_use",
      toolCall: expect.objectContaining({ id: "tc_bash", name: "bash", repairedFrom: "Bash" }),
    }))
    // The surface plans 'bash', so the call that the dispatcher repaired from 'Bash' is admitted and runs.
    expect(events.find((event) => event.kind === "tool_result" && event.toolUseId === "tc_bash")).toMatchObject({ outcome: "ok", content: [{ type: "text", text: "ran" }] })
    expect(interactionProfileIds).toEqual(["default", "default"])
    expect(attributionAdmissions).toEqual(["request-1", "request-1"])
  })

  it("refuses a repaired call to a tool that needs a module that the request's captured module set disables", async () => {
    let executions = 0
    const skillManage: RuntimeTool = {
      name: "skill_manage",
      action: "ui_meta",
      description: "skill package tool",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => { executions += 1; return { content: "written", outcome: "ok" } },
    }
    const surface = await createRequestToolSurface(
      () => ({
        eligibleTools: new RequestToolMap([["skill_manage", skillManage]]),
        tools: new RequestToolMap([["skill_manage", skillManage]]),
        omitted: [],
        usable: new Set(["skill_manage"]), turnedOff: [],
        registrationIds: new Map([["skill_manage", "skill_manage"]]),
        registrationIdentities: new Map([["skill_manage", "skill_manage"]]),
        kernel: testKernelToolDeps(),
      }),
      () => composeFirstPartyModules(undefined, ["skills"]),
      testRuntimeConfigCapture,
    )
    let request = 0
    const client: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
        if (request++ === 0) {
          yield { kind: "tool_use", toolCall: { id: "tc_skill_manage", name: "SkillManage", input: {} } }
          yield { kind: "done", stopReason: "tool_use" }
          return
        }
        yield { kind: "text_delta", text: "done", blockKey: "text" }
        yield { kind: "done", stopReason: "end_turn" }
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    }
    const events: StreamEvent[] = []

    await runAgentLoop({
      client: asModelClient(client),
      tools: surface,
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "remember",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: (event) => { events.push(event) },
      providerSessionKey: "provider-session", promptCacheKey: "provider-session",
      artifactScopeId: "artifact-scope",
      retrievalSessionId: "retrieval-session",
    })

    expect(events).toContainEqual(expect.objectContaining({ kind: "tool_use", toolCall: expect.objectContaining({ id: "tc_skill_manage", name: "skill_manage", repairedFrom: "SkillManage" }) }))
    expect(events.find((event) => event.kind === "tool_result" && event.toolUseId === "tc_skill_manage")).toMatchObject({
      outcome: "error",
      content: [{ type: "text", text: "skills is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml" }],
    })
    expect(executions).toBe(0)
  })
})

describe("per-request provider admission", () => {
  it("uses one admitted request for planning and dispatch without a role-specific provider runtime, then admits again after tools", async () => {
    let admissions = 0
    let facadePlans = 0
    let requestNumber = 0
    const attempt: LLMClient = { historyTarget: ownHistoryTarget,
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      model: "test-model",
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      contextLimit: 100_000,
      outputLimit: 8_000,
      supportsReasoning: false,
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
      async *streamWithTools() { throw new Error("provider adapter is reached through the admitted request") },
    }
    const client = {
      model: attempt.model,
      modelFamily: attempt.modelFamily,
      async admitRequest(): Promise<AdmittedModelRequest> {
        admissions += 1
        const admittedNumber = ++requestNumber
        return {
          candidateAttributions: [],
          plannedAttempt: async () => attempt,
          prepare: async () => { throw new Error("this fake serves sends only") },
          async run({ execute, prepare }) {
            const prepared = await prepare(attempt)
            const result = await execute({ attempt, prepared, sample: 1, repetitionGuard: "detect", client: { ...attempt, async *streamWithTools() {
            if (admittedNumber === 1) {
              yield { kind: "tool_use", toolCall: { id: "tc", name: "noop", input: {} } }
              yield { kind: "done", stopReason: "tool_use" }
            } else {
              yield { kind: "text_delta", text: "done", blockKey: "text" }
              yield { kind: "done", stopReason: "end_turn" }
            }
            } } })
            if (result.kind !== "success") throw result.failure
            return result.value
          },
        }
      },
      async plannedAttempt() { facadePlans += 1; return attempt },
    }
    const noop: RuntimeTool = {
      name: "noop",
      action: "ui_meta",
      description: "noop",
      inputSchema: { type: "object", properties: {} },
      isConcurrencySafe: true,
      execute: async () => ({ content: "ok", outcome: "ok" }),
    }
    const surface = await createRequestToolSurface(
      () => ({ eligibleTools: new RequestToolMap([["noop", noop]]), tools: new RequestToolMap([["noop", noop]]), omitted: [], usable: new Set(["noop"]), turnedOff: [], registrationIds: new Map([["noop", "noop"]]), registrationIdentities: new Map([["noop", "noop"]]), kernel: testKernelToolDeps() }),
      testCapabilityModules,
      testRuntimeConfigCapture,
    )

    await runAgentLoop({
      client,
      initialPlannedAttempt: attempt,
      tools: surface,
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      providerSessionKey: "provider-session", promptCacheKey: "provider-session",
      artifactScopeId: "artifact-scope",
      retrievalSessionId: "retrieval-session",
    })

    expect(admissions).toBe(2)
    expect(facadePlans).toBe(0)
  })

  it("adopts a message sent to a parked loop before the next request's admission settles", async () => {
    const base = new RequestToolMap()
    let resolves = 0
    const admissionStarted = Promise.withResolvers<void>()
    const admissionGate = Promise.withResolvers<void>()
    // The first request admits at once. The request the message starts waits,
    // as an admission that reads remote usage evidence does.
    const surface = {
      async resolve() {
        resolves += 1
        if (resolves === 2) {
          admissionStarted.resolve()
          await admissionGate.promise
        }
        return base.resolve()
      },
      current: () => base.current(),
    }
    const streamed: ConversationMessage[][] = []
    const client = asModelClient({
      accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test-model",
      contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false, 
      async *streamWithTools(options: StreamOptions) {
        streamed.push([...options.messages])
        yield { kind: "text_delta", text: `answer ${streamed.length}`, blockKey: "text" }
        yield { kind: "done", stopReason: "end_turn" }
      },
      priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    })
    const recorded: string[] = []
    const adopted = Promise.withResolvers<void>()
    const sent = Promise.withResolvers<ReturnType<typeof messageInput> | null>()
    let parks = 0
    const run = runAgentLoop({
      client, tools: surface,
      systemPrompt: () => stableSystemPrompt("test"), instruction: "work",
      executionCwd: tmpdir(), userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      persistence: { history: { append: () => {} } }, seed: { kind: "fresh" },
      onEvent: () => {}, providerSessionKey: "provider-session", promptCacheKey: "provider-session", artifactScopeId: "artifact-scope", retrievalSessionId: "retrieval-session",
      onUserMessage: (content) => {
        recorded.push(String(content))
        if (content === "second") adopted.resolve()
      },
      inputSource: {
        drainPending: () => null,
        prepareWaitForInput: () => ({
          commit: async () => (parks++ === 0 ? sent.promise : null),
          cancel: async () => {},
        }),
      },
    })
    // The loop answers "work", parks, and takes this message from its park.
    sent.resolve(messageInput("second"))
    const first = await Promise.race([
      adopted.promise.then(() => "adopted" as const),
      admissionStarted.promise.then(() => Bun.sleep(20)).then(() => "admission-blocked" as const),
    ])
    expect(first).toBe("adopted")
    // The admission is still held: no request has carried the message yet.
    expect(streamed).toHaveLength(1)
    admissionGate.resolve()
    await run
    expect(recorded).toEqual(["work", "second"])
    expect(streamed).toHaveLength(2)
    expect(streamed[1]?.filter((message) => message.kind === "user" && message.content === "second")).toHaveLength(1)
  })
})
