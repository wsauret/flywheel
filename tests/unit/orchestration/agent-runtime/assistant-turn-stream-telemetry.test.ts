import { describe, expect, spyOn, test } from "bun:test"

import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js"
import { createRequestStreamTelemetry } from "../../../../src/orchestration/agent-runtime/stream-telemetry.js"
import type { ProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js"
import { FUNCTION_TOOL_PRESENTATION, type LLMClient, type ModelClient, type ProviderStreamEvent, type StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { asModelClient, attemptHistoryTarget, ownHistoryTarget } from "./_model-client.js"
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js"
import type { AssistantTurnResult } from "../../../../src/orchestration/agent-runtime/assistant-turn-result.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { createAssistantAttempt, type AssistantAttemptInput } from "../../../../src/orchestration/agent-runtime/assistant-turn-attempt.js"

type TurnInput = Parameters<typeof streamAssistantTurn>[0]
type TurnResult = Awaited<ReturnType<typeof streamAssistantTurn>>

const runTurn = (input: Omit<TurnInput, "executionCwd" | "staleMasking" | "requestContext"> & Partial<Pick<TurnInput, "staleMasking" | "requestContext">>) => streamAssistantTurn({ executionCwd: "/scratch", staleMasking: undefined, requestContext: undefined, ...input })

function assertCompleted(result: TurnResult): asserts result is AssistantTurnResult {
  if ("kind" in result && result.kind === "deferred_hard_cap") throw new Error("expected a completed assistant turn")
}

function fakeClient(stream: () => AsyncGenerator<ProviderStreamEvent>): ModelClient {
  const adapter: LLMClient = { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
    streamWithTools: (_opts: StreamOptions) => stream(),
  }
  return asModelClient(adapter)
}

interface RecordingAudit {
  writer: ProviderRequestAuditWriter
  recorded: string[]
}

function recordingAudit(): RecordingAudit {
  const recorded: string[] = []
  const writer: ProviderRequestAuditWriter = {
    recordRequest: (input) => { recorded.push("model.requested"); return { requestId: input.requestId, turn: input.turn } },
    recordResponse() { recorded.push("model.response_received") },
    recordUsage() { recorded.push("model.usage.recorded") },
    recordStreamStarted() { recorded.push("model.stream.started") },
    recordStreamEvent() { recorded.push("model.stream.event_observed") },
    recordStreamCompleted() { recorded.push("model.stream.completed") },
    recordStreamSummary() { recorded.push("model.stream.summary.recorded") },
  }
  return { writer, recorded }
}

async function measureOutput(events: readonly (readonly [number, ProviderStreamEvent])[], prepare = async () => {}) {
  let now = 0
  const clock = spyOn(performance, "now").mockImplementation(() => now)
  const counted: string[] = []
  const summaries: Parameters<NonNullable<ProviderRequestAuditWriter["recordStreamSummary"]>>[1][] = []
  const telemetry = createRequestStreamTelemetry({
    ...recordingAudit().writer,
    recordStreamSummary(_handle, summary) { summaries.push(summary) },
  }, { requestId: "measurement", turn: 1 }, {
    prepare,
    tokenizer: () => ({ identity: "O200kBase", count(text: string) { counted.push(text); return text.length } }),
  })!
  try {
    for (const [at, event] of events) {
      now = at
      await telemetry.observeNormalized(event)
      expect(counted).toEqual([])
    }
    now += 100_000
    await telemetry.complete("ok")
    await telemetry.complete("ok")
    expect(summaries).toHaveLength(1)
    return { generation: summaries[0]!.generation, counted, summaries }
  } finally {
    clock.mockRestore()
  }
}

describe("streamAssistantTurn telemetry", () => {
  test("fences a handoff before asynchronous telemetry can delay its publication", async () => {
    const telemetryEntered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let fenced = false
    let published = false
    const writer = {
      ...recordingAudit().writer,
      recordStreamEvent(_handle: unknown, event: { kind: string }) {
        if (event.kind !== "tool_input_start") return
        telemetryEntered.resolve()
        return release.promise
      },
    }
    const attempt = await makeAttempt(writer, async function* () {
      yield { kind: "tool_input_start", toolUseId: "handoff-call", name: "handoff" }
      yield { kind: "done", stopReason: "end_turn" }
    }, { onHandoffStarted: () => { fenced = true }, onEvent: (event) => { if (event.kind === "tool_input_start") published = true } })
    const streaming = attempt.stream()
    await telemetryEntered.promise
    expect(fenced).toBe(true)
    expect(published).toBe(false)
    release.resolve()
    await streaming
    await attempt.close()
  })
  test("counts assembled blocks once, independently of chunk boundaries and terminal replacement", async () => {
    const first = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "hello " }],
      [2000, { kind: "text_delta", blockKey: "a", text: "world" }],
      [9000, { kind: "text_terminal", blockKey: "a", content: "hello world" }],
    ])
    const second = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "h" }],
      [1500, { kind: "text_delta", blockKey: "a", text: "ello wor" }],
      [2000, { kind: "text_delta", blockKey: "a", text: "ld" }],
    ])
    expect(first.generation).toEqual({ kind: "recorded", basis: "O200kBase", outputTokens: 11, durationMs: 1000, measuredBlocks: 1, excludedBlocks: 0 })
    expect(second.generation).toEqual(first.generation)
    expect(first.counted).toEqual(["hello world"])
    expect(second.counted).toEqual(first.counted)
    const replaced = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "old" }],
      [2000, { kind: "text_delta", blockKey: "a", text: " text" }],
      [9000, { kind: "text_terminal", blockKey: "a", content: "new" }],
    ])
    expect(replaced.counted).toEqual(["new"])
    expect(replaced.generation).toMatchObject({ outputTokens: 3, durationMs: 1000 })
  })

  test("unions overlapping output intervals and excludes reasoning, waiting and inter-block gaps", async () => {
    const result = await measureOutput([
      [100, { kind: "thinking_delta", blockKey: "r", text: "reasoning" }],
      [1000, { kind: "text_delta", blockKey: "a", text: "ab" }],
      [2000, { kind: "text_delta", blockKey: "a", text: "cd" }],
      [2900, { kind: "tool_input_delta", toolUseId: "t", partialJson: '{ "b": 1 }', generationTiming: { first: 1500, last: 2500, chunks: 2 } }],
      [3000, { kind: "tool_use", toolCall: { id: "t", name: "tool", input: { b: 1 } } }],
      [4000, { kind: "thinking_delta", blockKey: "r2", text: "more reasoning" }],
      [5000, { kind: "text_delta", blockKey: "b", text: "ef" }],
      [5500, { kind: "text_complete", blockKey: "a" }],
      [6000, { kind: "text_delta", blockKey: "b", text: "gh" }],
      [9000, { kind: "done", stopReason: "end_turn" }],
    ])
    expect(result.counted).toEqual(["abcd", '{ "b": 1 }', "efgh"])
    expect(result.generation).toMatchObject({ outputTokens: 18, durationMs: 2500, measuredBlocks: 3, excludedBlocks: 0 })
    const stall = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "x" }],
      [11000, { kind: "text_delta", blockKey: "a", text: "y" }],
    ])
    expect(stall.generation).toMatchObject({ durationMs: 10000 })
  })

  test("excludes single chunks, terminal-only output and zero-duration blocks from both totals", async () => {
    const result = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "single", text: "single" }],
      [1100, { kind: "text_terminal", blockKey: "terminal", content: "terminal" }],
      [1200, { kind: "tool_use", toolCall: { id: "terminal-tool", name: "tool", input: { a: 1 } } }],
      [1500, { kind: "text_delta", blockKey: "zero", text: "a" }],
      [1500, { kind: "text_delta", blockKey: "zero", text: "b" }],
    ])
    expect(result.counted).toEqual([])
    expect(result.generation).toEqual({ kind: "recorded", basis: "O200kBase", outputTokens: 0, durationMs: 0, measuredBlocks: 0, excludedBlocks: 4 })
    const mixed = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "a" }],
      [1500, { kind: "text_delta", blockKey: "single", text: "excluded" }],
      [2000, { kind: "text_delta", blockKey: "a", text: "b" }],
    ])
    expect(mixed.generation).toMatchObject({ outputTokens: 2, durationMs: 1000, measuredBlocks: 1, excludedBlocks: 1 })
  })

  test("measures original custom chunks without synthetic framing or presentation escaping", async () => {
    const single = await measureOutput([
      [0, { kind: "tool_input_delta", toolUseId: "t", partialJson: '{"input":"', generationText: "" }],
      [1000, { kind: "tool_input_delta", toolUseId: "t", partialJson: '\\n\\"hi\\"', generationText: '\n"hi"' }],
      [10000, { kind: "tool_input_delta", toolUseId: "t", partialJson: '"}', generationText: "" }],
    ])
    expect(single.generation).toMatchObject({ outputTokens: 0, durationMs: 0, excludedBlocks: 1 })
    for (const suffixTime of [2001, 10000]) {
      const streamed = await measureOutput([
        [0, { kind: "tool_input_delta", toolUseId: "t", partialJson: '{"input":"', generationText: "" }],
        [1000, { kind: "tool_input_delta", toolUseId: "t", partialJson: '\\n', generationText: "\n" }],
        [2000, { kind: "tool_input_delta", toolUseId: "t", partialJson: '\\"hi\\"', generationText: '"hi"' }],
        [suffixTime, { kind: "tool_input_delta", toolUseId: "t", partialJson: '"}', generationText: "" }],
      ])
      expect(streamed.counted).toEqual(['\n"hi"'])
      expect(streamed.generation).toMatchObject({ outputTokens: 5, durationMs: 1000, measuredBlocks: 1, excludedBlocks: 0 })
      expect(JSON.stringify(streamed.summaries)).not.toContain(JSON.stringify('\n"hi"'))
    }
  })

  test("records unavailable measurement when tokenizer preparation fails without losing ordinary telemetry", async () => {
    const result = await measureOutput([
      [1000, { kind: "text_delta", blockKey: "a", text: "hello" }],
      [2000, { kind: "text_delta", blockKey: "a", text: " world" }],
    ], async () => { throw new Error("asset unavailable") })
    expect(result.generation).toEqual({ kind: "unavailable", reason: "tokenizer-preparation-failed" })
    expect(result.summaries[0]).toMatchObject({ rawEventCount: 2, outcome: "ok" })
    expect(result.counted).toEqual([])
  })

  test("acknowledges one summary at stream exit after usage, leaving response closure delayed", async () => {
    const { writer, recorded } = recordingAudit()
    const started = Promise.withResolvers<void>()
    const released = Promise.withResolvers<void>()
    const attempt = await makeAttempt({
      ...writer,
      async recordStreamSummary() {
        recorded.push("summary-started")
        started.resolve()
        await released.promise
        recorded.push("summary-acknowledged")
      },
    }, async function* () {
      yield { kind: "text_delta", text: "hello", blockKey: "a" }
      yield { kind: "done", stopReason: "end_turn" }
    }, {
      usageSettlement: {
        profileId: "test", budgetStreamId: "stream", identity: { providerSessionKey: "key" },
        settlement: {
          begin: async () => {},
          checkpoint: async () => {},
          recover: async () => {},
          settle: async () => { recorded.push("usage-settled") },
        },
      },
    })
    let returned = false
    const streaming = attempt.stream().then((result) => { returned = true; return result })
    // The stream must reach the summary without the owner closing the attempt.
    expect(await Promise.race([started.promise.then(() => true), streaming.then(() => false)])).toBe(true)
    expect(returned).toBe(false)
    expect(recorded.indexOf("usage-settled")).toBeLessThan(recorded.indexOf("summary-started"))
    expect(recorded).not.toContain("model.response_received")
    released.resolve()
    await streaming
    expect(recorded).not.toContain("model.response_received")
    await attempt.close()
    await attempt.close()
    expect(recorded.filter((kind) => kind === "summary-acknowledged")).toHaveLength(1)
    expect(recorded.filter((kind) => kind === "model.response_received")).toHaveLength(1)
  })

  test("records a transport's context on the request's audit response, also when the stream then fails, and forwards it to no consumer", async () => {
    const context = { identity: "claude-engine", additions: [{ part: "system", kind: "billing", at: 0 }], hiddenRequests: [{ source: "message_start", status: 200 }], notRecorded: [] } as const
    const responses: Parameters<ProviderRequestAuditWriter["recordResponse"]>[1][] = []
    const forwarded: string[] = []
    const attempt = await makeAttempt({
      ...recordingAudit().writer,
      recordResponse(_handle, input) { responses.push(input) },
    }, async function* () {
      yield { kind: "transport_context", context }
      throw new Error("the transport stopped")
    }, { onEvent: (event) => { forwarded.push(event.kind) } })
    await attempt.stream()
    // The failure stays local to the attempt; its response is recorded before close rethrows it.
    await expect(attempt.close()).rejects.toThrow("the transport stopped")
    expect(responses).toEqual([expect.objectContaining({ outcome: "stream_error", transportContext: context })])
    expect(forwarded).not.toContain("transport_context")
  })

  test("keeps a summary write failure local until close, preserving partial tools and response recording", async () => {
    const { writer, recorded } = recordingAudit()
    const failed = new Error("summary not acknowledged")
    const attempt = await makeAttempt({
      ...writer,
      recordStreamSummary() { throw failed },
    }, async function* () {
      yield { kind: "tool_use", toolCall: { id: "t", name: "echo", input: {} } }
      yield { kind: "done", stopReason: "tool_use" }
    })
    const result = await attempt.stream()
    expect(result.toolCalls.map((call) => call.id)).toEqual(["t"])
    expect(attempt.failure()).toBeUndefined()
    expect(recorded).not.toContain("model.response_received")
    await expect(attempt.close()).rejects.toBe(failed)
    expect(recorded).toContain("model.response_received")
  })

  test("attributes separate attempts without bridging waits and records observed output on interruption and failure", async () => {
    let now = 0
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    const requests: Parameters<ProviderRequestAuditWriter["recordRequest"]>[0][] = []
    const summaries: { requestId: string; generation: Parameters<NonNullable<ProviderRequestAuditWriter["recordStreamSummary"]>>[1]["generation"] }[] = []
    const writer: ProviderRequestAuditWriter = {
      ...recordingAudit().writer,
      recordRequest(input) { requests.push(input); return { requestId: input.requestId, turn: input.turn } },
      recordStreamSummary(handle, summary) { summaries.push({ requestId: handle.requestId, generation: summary.generation }) },
    }
    const failure = new Error("stream failed after output")
    async function* outputStream(start: number, interrupted: boolean): AsyncGenerator<ProviderStreamEvent> {
      now = start
      yield { kind: "text_delta", blockKey: "a", text: "hello " }
      now = start + 1000
      yield { kind: "text_delta", blockKey: "a", text: "world" }
      if (!interrupted) throw failure
      yield { kind: "done", stopReason: "end_turn" }
    }
    try {
      for (const [start, model, effort, interrupted] of [[1000, "model-a", "medium", true], [100000, "model-b", "high", false]] as const) {
        const controller = new AbortController()
        const attempt = await makeAttempt(writer, outputStream.bind(undefined, start, interrupted), {
          reasoningEffort: effort, signal: controller.signal,
          onEvent(event) { if (interrupted && event.kind === "text_delta" && event.text === "world") controller.abort() },
        }, model)
        expect((await attempt.stream()).outcome.kind).toBe(interrupted ? "aborted" : "stream_error")
        if (interrupted) await attempt.close()
        else await expect(attempt.close()).rejects.toBe(failure)
      }
      expect(requests.map((request) => [request.attribution.model, request.reasoningEffort])).toEqual([["model-a", "medium"], ["model-b", "high"]])
      expect(requests[0]!.requestId).not.toBe(requests[1]!.requestId)
      expect(summaries.map((summary) => summary.requestId)).toEqual(requests.map((request) => request.requestId))
      expect(summaries.map((summary) => summary.generation)).toEqual([
        { kind: "recorded", basis: "O200kBase", outputTokens: 2, durationMs: 1000, measuredBlocks: 1, excludedBlocks: 0 },
        { kind: "recorded", basis: "O200kBase", outputTokens: 2, durationMs: 1000, measuredBlocks: 1, excludedBlocks: 0 },
      ])
    } finally {
      clock.mockRestore()
    }
  })

  test("does not convert an internal token-counting defect into measurement unavailability", async () => {
    const failure = new Error("counting defect")
    let summaries = 0
    const telemetry = createRequestStreamTelemetry({
      ...recordingAudit().writer,
      recordStreamSummary() { summaries++ },
    }, { requestId: "counting-defect", turn: 1 }, {
      prepare: async () => {},
      tokenizer: () => ({ identity: "O200kBase", count() { throw failure } }),
    })!
    let now = 1000
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    try {
      await telemetry.observeNormalized({ kind: "text_delta", text: "a", blockKey: "a" })
      now = 2000
      await telemetry.observeNormalized({ kind: "text_delta", text: "b", blockKey: "a" })
      await expect(telemetry.complete("ok")).rejects.toBe(failure)
      expect(summaries).toBe(0)
    } finally {
      clock.mockRestore()
    }
  })

  test("preserves exact visible timing, transitions, and watchdog summaries", async () => {
    let now = 0
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    const summaries: Parameters<NonNullable<ProviderRequestAuditWriter["recordStreamSummary"]>>[1][] = []
    const { writer } = recordingAudit()
    try {
      const telemetry = createRequestStreamTelemetry({
        ...writer,
        recordStreamSummary(_handle, summary) { summaries.push(summary) },
      }, { requestId: "exact-timings", turn: 1 })!
      for (const [elapsed, kind] of [[0, "thinking_delta"], [10, "text_delta"], [1000, "tool_input_delta"], [6000, "text_delta"], [17000, "thinking_delta"]] as const) {
        now = elapsed
        await telemetry.observe({ source: "normalized", kind })
      }
      now = 17001
      await telemetry.observe({ source: "watchdog", kind: "thinking_stall", metadata: { elapsedMs: 6000 } })
      await telemetry.complete("ok")
      await telemetry.complete("ok")
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({
        rawEventCount: 6,
        firstVisibleDeltaMs: 0,
        countsBySource: { normalized: 5, watchdog: 1 },
        countsByKind: { thinking_delta: 2, text_delta: 2, tool_input_delta: 1, thinking_stall: 1 },
        interDelta: { count: 4, meanMs: 4250, p50Ms: 5000, p90Ms: 11000, p99Ms: 11000, maxMs: 11000, ge1s: 2, ge2s: 2, ge5s: 2, ge10s: 1 },
        watchdog: { thinkingStallCount: 1, maxStallMs: 6000 },
        bigGapTransitions: [
          { transition: "text_delta->thinking_delta", count: 1 },
          { transition: "tool_input_delta->text_delta", count: 1 },
        ],
      })
    } finally {
      clock.mockRestore()
    }
  })

  test("a stream event record carries the size and hash of its text, never the text", async () => {
    const metadata: unknown[] = []
    const telemetry = createRequestStreamTelemetry({
      ...recordingAudit().writer,
      recordStreamEvent(_handle, input) { metadata.push(input.metadata) },
    }, { requestId: "no-content", turn: 1 })!
    const text = "a sentence the model wrote, which belongs in the event store and nowhere else"
    await telemetry.observeNormalized({ kind: "text_delta", text, blockKey: "block-1" })

    expect(metadata).toEqual([{ text: { chars: text.length, bytes: Buffer.byteLength(text), xxhash32: Bun.hash.xxHash32(text, 0).toString(16) } }])
  })

  test("high-volume raw stream telemetry is budgeted and summarized before completion", async () => {
    const order: string[] = []
    const rawKinds: string[] = []
    let summary: { rawEventCount: number; countsByKind: { [kind: string]: number }; recovery: { streamRetryCount: number } } | undefined
    const writer: ProviderRequestAuditWriter = {
      recordRequest: (input) => ({ requestId: "request-budget", turn: input.turn }),
      recordResponse() {},
      recordUsage() {},
      recordStreamStarted() { order.push("started") },
      recordStreamEvent(_handle, input) { rawKinds.push(input.kind) },
      recordStreamCompleted() { order.push("completed") },
      recordStreamSummary(_handle, input) {
        order.push("summary")
        summary = input
      },
    }
    const telemetry = createRequestStreamTelemetry(writer, { requestId: "request-budget", turn: 1 })
    expect(telemetry).toBeDefined()

    for (let i = 0; i < 650; i++) {
      await telemetry!.observeNormalized({ kind: "text_delta", text: "x", blockKey: `text:${i}` })
    }
    await telemetry!.observeNormalized({ kind: "stream_retry", attempt: 1, maxAttempts: 1, reason: "blip", delayMs: 1, error: { message: "blip" } })
    await telemetry!.complete("ok")

    expect(rawKinds.length).toBeLessThan(650)
    expect(rawKinds).toContain("stream_retry")
    expect(summary).toMatchObject({
      rawEventCount: 651,
      countsByKind: { stream_retry: 1, text_delta: 650 },
      recovery: { streamRetryCount: 1 },
    })
    expect(order.indexOf("summary")).toBeLessThan(order.indexOf("completed"))
  })

  test("a streamed turn records the audit sequence with the summary before completion", async () => {
    const { writer, recorded } = recordingAudit()

    const result = await runTurn({
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      client: fakeClient(async function* () {
        yield { kind: "text_delta", text: "hello", blockKey: "hello" }
        yield { kind: "done", stopReason: "end_turn" }
      }),
      messages: [{ kind: "user", content: "x" }],
      tools: [],
      systemPrompt: stableSystemPrompt("system"),
      reasoningEffort: undefined,
      signal: undefined,
      cacheRetention: "1h",
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: writer,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 0,
      onEvent: () => {},
    })

    assertCompleted(result)
    expect(result.outcome).toEqual({ kind: "ok", stopReason: "end_turn" })
    expect(recorded[0]).toBe("model.requested")
    expect(recorded.indexOf("model.stream.summary.recorded")).toBeGreaterThan(-1)
    expect(recorded.indexOf("model.stream.summary.recorded")).toBeLessThan(recorded.indexOf("model.stream.completed"))
    expect(recorded.indexOf("model.stream.completed")).toBeLessThan(recorded.indexOf("model.response_received"))
  })
})

async function makeAttempt(writer: ProviderRequestAuditWriter, stream: () => AsyncGenerator<ProviderStreamEvent>, overrides: Partial<AssistantAttemptInput> = {}, model = "test-model") {
  const serving = {
    ...await fakeClient(stream).plannedAttempt(undefined), model,
    accessProviderCandidate: { kind: "singleton" as const, providerId: "anthropic_api", spendMode: "direct_api" as const },
    credentialLineage: "00000000-0000-4000-8000-000000000003",
  }
  const input: AssistantAttemptInput = {
    interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
    messages: [{ kind: "user", content: "x" }],
    tools: [], systemPrompt: stableSystemPrompt("system"),
    reasoningEffort: undefined, signal: undefined, cacheRetention: "1h",
    providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: writer,
    staleMasking: undefined, requestContext: undefined, turn: 1, messageCount: 1,
    estimatedContextTokens: 0, onEvent: () => {}, ...overrides,
  }
  return createAssistantAttempt({
    attempt: serving, client: { historyTarget: () => attemptHistoryTarget(serving), streamWithTools: stream },
    prepared: {
      attempt: serving, messages: input.messages, tools: [], systemPrompt: input.systemPrompt!,
      providerOptions: undefined, cacheRetention: "1h",
      tokenClasses: { estimatedPromptTokens: 0, cacheRetention: "1h" },
    },
  }, input, undefined)
}
