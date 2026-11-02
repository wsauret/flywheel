import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { DebugLog, scanDebugLogFiles } from "../../../../src/infra/debug-log.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { createEventStoreWriterLane } from "../../../../src/infra/event-store-writer-lane"
import {
  buildProviderRequestFacts,
  type ConversationDedup,
  recordProviderRequest,
  recordProviderResponse,
  recordProviderStreamCompleted,
  recordProviderStreamEvent,
  recordProviderStreamStarted,
  recordProviderUsage,
} from "../../../../src/orchestration/session/provider-request-audit-recorder"
import { parseProviderRequestAuditFact, readProviderRequestAuditFact, type ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts"
import { loadProviderRequestAuditFromEvents } from "../../../../src/orchestration/session/provider-request-audit-projection"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { hashSystemPrompt, hashToolSurface } from "../../../../src/orchestration/session/provider-request-audit-hash"
import { createProviderRequestAuditWriter } from "../../../../src/orchestration/agent-runtime/llm/provider-request-audit"

const roots = new Set<string>()

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-audit-recorder-test-"))
  roots.add(dir)
  return dir
}

function jsonlFiles(baseDir: string): string[] {
  const logDir = path.join(baseDir, ".flywheel", "log")
  return fs
    .readdirSync(logDir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => path.join(logDir, name))
}

afterEach(async () => {
  await DebugLog.close()
  for (const root of roots) {
    fs.rmSync(root, { recursive: true, force: true })
  }
  roots.clear()
})

function tool(name: string) {
  return { name, registrationId: `${name}.native`, executableId: name, description: `${name} tool`, input_schema: { type: "object" } }
}

const requestBase = {
  requestId: "00000000-0000-4000-8000-000000000001",
  identity: { providerSessionKey: "provider-1", conversationId: "conv-1" },
  promptKind: "chat",
  systemPrompt: "system",
  messageCount: 1,
  attemptStaticTokens: 12,
  estimatedContextTokens: 42,
  contextWindow: 100_000,
  tools: [tool("read")],
  omittedTools: [{ name: "bash", reason: "not selected" }],
  model: "claude-test",
  accessProvider: "anthropic_api",
  accessProviderCandidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" },
  modelFamily: "anthropic",
  interactionProfileId: "default",
} as const

describe("provider request audit recorder", () => {
  test("publishes all request evidence in one durable batch before observers run", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()))
    const commits: string[][] = []
    const lane = createEventStoreWriterLane({
      commitItems(items) {
        commits.push(items.flatMap((item) => item.events.map((event) => event.type)))
        return store.commitItems(items)
      },
    })
    const writer = createSessionFactWriter({ sessionId: "atomic-audit", writer: lane, lane: lane.lease({ kind: "session", sessionId: "atomic-audit" }) })
    const input = { ...requestBase, turn: 1, messages: [], contextApplication: { identity: "application-1", applications: [] } }
    const expected = buildProviderRequestFacts(input, {}).facts.map((fact) => fact.type)
    const observed: string[] = []
    try {
      await recordProviderRequest({ writer, observe: (fact) => {
        expect(store.read({ aggregateId: "session:atomic-audit" }).map((stored) => stored.type)).toEqual(expected)
        observed.push(fact.type)
      } }, input, {})

      expect(commits).toEqual([expected])
      expect(observed).toEqual(expected)
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  test("an invalid final request fact leaves no partial evidence or dedup state", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()))
    const writer = createSessionFactWriter({ sessionId: "invalid-audit", writer: asAsyncEventWriter(store) })
    const dedup: ConversationDedup = {}
    const observed: ProviderRequestAuditFact[] = []
    try {
      await expect(recordProviderRequest({ writer, observe: (fact) => { observed.push(fact) } }, {
        ...requestBase, turn: 1, messages: [], model: "",
      }, dedup)).rejects.toThrow()

      expect(store.read({ aggregateId: "session:invalid-audit" })).toEqual([])
      expect(observed).toEqual([])
      expect(dedup).toEqual({})
    } finally {
      store.close()
    }
  })

  test("a failed commit publishes no observation or dedup advance and retry retains complete evidence", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()))
    let failing = true
    const lane = createEventStoreWriterLane({ commitItems(items) {
      if (failing) throw new Error("disk unavailable")
      return store.commitItems(items)
    } })
    const writer = createSessionFactWriter({ sessionId: "retry-audit", writer: lane })
    const input = { ...requestBase, turn: 1, messages: [] }
    const dedup: ConversationDedup = {}
    const observed: ProviderRequestAuditFact[] = []
    const audit = { writer, observe: (fact: ProviderRequestAuditFact) => { observed.push(fact) } }
    try {
      await expect(recordProviderRequest(audit, input, dedup)).rejects.toThrow("disk unavailable")
      expect(store.read({ aggregateId: "session:retry-audit" })).toEqual([])
      expect(observed).toEqual([])
      expect(dedup).toEqual({})

      failing = false
      await recordProviderRequest(audit, input, dedup)
      expect(observed.map((fact) => fact.type)).toEqual(buildProviderRequestFacts(input, {}).facts.map((fact) => fact.type))
      expect(dedup.systemPromptHash).toBe(hashSystemPrompt(input.systemPrompt))
    } finally {
      await lane.dispose()
      store.close()
    }
  })

  test("persists replayable request audit facts while raw stream telemetry stays diagnostic", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    DebugLog.setVerbose(false)
    const sessionId = "session-stream"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const audit = { sessionId, writer }

    const requestId = await recordProviderRequest(audit, {
      ...requestBase,
      turn: 1,
      messages: [{ role: "user", content: "x" }],
      treeLeafEntryId: "leaf-1",
    }, {})
    recordProviderStreamStarted(audit, { requestId, identity: { providerSessionKey: "provider-1", conversationId: "conv-1" }, turn: 1 })
    recordProviderStreamEvent(audit, {
      requestId, identity: { providerSessionKey: "provider-1", conversationId: "conv-1" }, turn: 1,
      sequence: 1, source: "provider", kind: "ping", elapsedMs: 10, sincePreviousMs: 10, metadata: { heartbeat: true },
    })
    recordProviderStreamCompleted(audit, {
      requestId, turn: 1, durationMs: 30, eventCount: 1, outcome: "ok", lastEventKind: "ping", stallCount: 0,
    })
    await recordProviderResponse(audit, {
      requestId, identity: { providerSessionKey: "provider-1", conversationId: "conv-1" }, turn: 1, outcome: "ok", durationMs: 20, stopReason: "end_turn",
    })
    await recordProviderUsage(audit, {
      requestId, identity: { providerSessionKey: "provider-1", conversationId: "conv-1" }, turn: 1,
      inputTokens: 100, outputTokens: 25, cacheReadInputTokens: 50, cacheCreationInputTokens: 10,
      reasoningTokens: 5, promptTokens: 160, deltaCostUsd: 0.123,
    })
    const usageFact = store.read({ aggregateId: `session:${sessionId}` }).find((fact) => fact.type === "model.usage.recorded")
    expect(usageFact).toMatchObject({
      version: 4,
      payload: {
        requestId,
        attemptId: requestId,
        inputTokens: 100,
        outputTokens: 25,
        cacheReadInputTokens: 50,
        cacheCreationInputTokens: 10,
        reasoningTokens: 5,
        promptTokens: 160,
      },
    })
    expect(usageFact?.payload).not.toHaveProperty("deltaCostUsd")
    await DebugLog.close()

    expect(store.read({ aggregateId: `session:${sessionId}` }).map((fact) => fact.type)).toEqual([
      "prompt.assembled",
      "tool_surface.selected",
      "model.requested",
      "model.response_received",
      "model.usage.recorded",
    ])
    writer.dispose()
    store.close()

    // A stream that finished well and fast writes nothing at the default
    // level: the durable facts above hold its timing.
    expect([...scanDebugLogFiles(jsonlFiles(baseDir), { sessionId })]).toEqual([])
  })

  test("records a provider stream's completion at the default level only when it failed, stalled, or ran slow", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    DebugLog.setVerbose(false)
    const audit = { sessionId: "session-completions" }
    const completion = { turn: 1, eventCount: 4, lastEventKind: "done" }

    recordProviderStreamCompleted(audit, { ...completion, requestId: "fast", durationMs: 900, outcome: "ok", stallCount: 0 })
    recordProviderStreamCompleted(audit, { ...completion, requestId: "interrupted", durationMs: 900, outcome: "aborted", stallCount: 0 })
    recordProviderStreamCompleted(audit, { ...completion, requestId: "failed", durationMs: 900, outcome: "stream_error", stallCount: 0 })
    recordProviderStreamCompleted(audit, { ...completion, requestId: "stalled", durationMs: 900, outcome: "ok", stallCount: 2 })
    recordProviderStreamCompleted(audit, { ...completion, requestId: "slow", durationMs: 180_000, outcome: "ok", stallCount: 0 })
    await DebugLog.close()

    const records = [...scanDebugLogFiles(jsonlFiles(baseDir), { sessionId: "session-completions" })]
    expect(records.map((record) => [record.type, record.version])).toEqual([
      ["model.stream.completed", 3],
      ["model.stream.completed", 3],
      ["model.stream.completed", 3],
    ])
    expect(records.map((record) => record.payload)).toEqual([
      { requestId: "failed", turn: 1, durationMs: 900, eventCount: 4, outcome: "stream_error", lastEventKind: "done" },
      { requestId: "stalled", turn: 1, durationMs: 900, eventCount: 4, outcome: "ok", lastEventKind: "done", stallCount: 2 },
      { requestId: "slow", turn: 1, durationMs: 180_000, eventCount: 4, outcome: "ok", lastEventKind: "done" },
    ])
  })

  test("the per-stream-event family lands once verbose diagnostics are on", async () => {
    const baseDir = makeTmpDir()
    await DebugLog.init({ dir: baseDir })
    DebugLog.setVerbose(true)

    const requestId = "req-stream-verbose"
    recordProviderStreamEvent({ sessionId: "session-stream-verbose" }, {
      requestId, identity: { providerSessionKey: "provider-1", conversationId: "conv-1" }, turn: 1,
      sequence: 1, source: "provider", kind: "ping", elapsedMs: 10, sincePreviousMs: 10, metadata: { heartbeat: true },
    })
    await DebugLog.close()
    DebugLog.setVerbose(false)

    const records = [...scanDebugLogFiles(jsonlFiles(baseDir), { sessionId: "session-stream-verbose" })]
    expect(records.map((record) => record.type)).toEqual(["model.stream.event_observed"])
    expect(records[0]?.payload).toMatchObject({ requestId, kind: "ping", sequence: 1, metadata: { heartbeat: true } })
  })

  test("records the Tier-1 Ref shape: tree pointer, hashes, sha, no message bodies", async () => {
    const observed: ProviderRequestAuditFact[] = []
    await recordProviderRequest({ observe: (fact) => { observed.push(fact) } }, {
      ...requestBase,
      turn: 2,
      messages: [{ role: "user", content: "hello" }],
      parentToolUseId: "tool-parent",
      treeLeafEntryId: "leaf-7",
    }, {})

    const prompt = observed.find((fact) => fact.type === "prompt.assembled")
    if (!prompt || prompt.type !== "prompt.assembled") throw new Error("prompt.assembled fact missing")
    expect(prompt.payload).toMatchObject({
      identity: { providerSessionKey: "provider-1", conversationId: "conv-1" },
      turn: 2,
      systemPromptHash: hashSystemPrompt("system"),
      toolSurfaceHash: hashToolSurface([tool("read")], [{ name: "bash", reason: "not selected" }]),
      treeLeafEntryId: "leaf-7",
      parentToolUseId: "tool-parent",
    })
    expect(prompt.payload).not.toHaveProperty("requestPurpose")
    expect("messages" in prompt.payload).toBe(false)
    expect(prompt.payload.promptSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test("unchanged system prompt and tool surface are recorded once per conversation", async () => {
    const observed: ProviderRequestAuditFact[] = []
    const audit = { observe: (fact: ProviderRequestAuditFact) => { observed.push(fact) } }
    const registers = new Map<string, ConversationDedup>()
    const dedupFor = (conversationId: string): ConversationDedup => {
      const existing = registers.get(conversationId) ?? {}
      registers.set(conversationId, existing)
      return existing
    }

    await recordProviderRequest(audit, { ...requestBase, turn: 1, messages: [{ role: "user", content: "a" }] }, dedupFor("conv-1"))
    await recordProviderRequest(audit, { ...requestBase, turn: 2, messages: [{ role: "user", content: "b" }] }, dedupFor("conv-1"))
    // Same conversation, system prompt changes: body re-emitted.
    await recordProviderRequest(audit, { ...requestBase, systemPrompt: "system-v2", turn: 3, messages: [{ role: "user", content: "c" }] }, dedupFor("conv-1"))
    // Different conversation: first time, full body.
    await recordProviderRequest(audit, { ...requestBase, identity: { providerSessionKey: "provider-2", conversationId: "conv-2" }, turn: 1, messages: [{ role: "user", content: "d" }] }, dedupFor("conv-2"))

    const surfaceFacts = observed.filter((fact) => fact.type === "tool_surface.selected")
    expect(surfaceFacts).toHaveLength(2)

    const promptFacts = observed.filter((fact) => fact.type === "prompt.assembled")
    const withSystemBody = promptFacts.filter((fact) => fact.type === "prompt.assembled" && typeof fact.payload.systemPrompt === "string")
    expect(withSystemBody).toHaveLength(3)
  })

  test("rejects a context-application identity that names a different transformer sequence", async () => {
    const observed: ProviderRequestAuditFact[] = []
    const audit = { observe: (fact: ProviderRequestAuditFact) => { observed.push(fact) } }
    const application = {
      applicationId: "application-1",
      transformerId: "transformer-1",
      seam: "modelContext",
      order: 10,
      outcome: "error" as const,
      inputHash: "a".repeat(64),
      outputHash: "b".repeat(64),
    }
    const input = {
      ...requestBase,
      identity: { providerSessionKey: "provider-transformer", conversationId: "conv-transformer" },
      messages: [{ role: "user", content: "secret message bytes" }],
      contextApplication: { identity: "context-application-1", applications: [application] },
    }
    const dedup: ConversationDedup = {}

    await recordProviderRequest(audit, { ...input, turn: 1 }, dedup)
    await recordProviderRequest(audit, { ...input, turn: 2 }, dedup)
    expect(dedup.contextApplicationIdentity).toBe("context-application-1")
    expect(dedup.contextApplicationDigest).toMatch(/^[a-f0-9]{64}$/)
    await expect(recordProviderRequest(audit, {
      ...input,
      turn: 3,
      contextApplication: {
        identity: "context-application-1",
        applications: [{ ...application, outputHash: "c".repeat(64) }],
      },
    }, dedup)).rejects.toThrow("names a different transformer sequence")
    expect(observed.filter((fact) => fact.payload.turn === 3)).toEqual([])

    expect(observed.map((fact) => fact.type)).toEqual([
      "prompt.assembled", "tool_surface.selected", "context.application.recorded", "context.transformer.applied", "model.requested",
      "prompt.assembled", "model.requested",
    ])
  })

  test("recorded provider options omit arbitrary and identifying values while retaining behavior controls", async () => {
    const baseDir = makeTmpDir()
    const sessionId = "session-privacy"
    const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
    const audit = createProviderRequestAuditWriter({
      sessionId,
      writer,
      identity: { providerSessionKey: "provider-privacy", conversationId: "conv-privacy" },
      promptKind: "chat",
    })

    await audit.recordRequest({
      requestId: "00000000-0000-4000-8000-000000000003",
      turn: 1,
      interactionProfileId: "default",
      attribution: { accessProvider: "anthropic_api", accessProviderCandidate: { kind: "singleton", providerId: "anthropic_api", spendMode: "direct_api" }, modelFamily: "anthropic", model: "claude-test", contextLimit: 100_000 },
      systemPrompt: "system",
      messages: [{ kind: "user", content: "hello" }],
      tools: [tool("read")],
      omittedTools: [],
      messageCount: 1,
      attemptStaticTokens: 12,
      estimatedContextTokens: 42,
      reasoningEffort: "medium",
      cacheRetention: "1h",
      cacheKey: undefined,
      providerOptions: {
        openai: { parallel_tool_calls: false, text_verbosity: "low", extra_body: { access_token: "tok-private-openai", customer_email: "person@example.com" } },
        anthropic: { thinking_display: "summarized", speed: "fast", user_id: "private-user-123", extra_body: { api_key: "sk-private-anthropic", patient_name: "Alice Example" } },
        google: { temperature: 0.4, thinking_budgets: { low: 128 }, extra_body: { bearer: "private-google-token", address: "1 Private Lane" } },
      },
      staleMasking: undefined,
      requestContext: undefined,
    })

    const events = store.read({ aggregateId: `session:${sessionId}` })
    const recordedBytes = JSON.stringify(events)
    expect(recordedBytes).not.toContain("extra_body")
    expect(recordedBytes).not.toContain("user_id")
    for (const privateValue of ["tok-private-openai", "person@example.com", "private-user-123", "sk-private-anthropic", "Alice Example", "private-google-token", "1 Private Lane"]) {
      expect(recordedBytes).not.toContain(privateValue)
    }

    const requested = events.find((event) => event.type === "model.requested")
    expect(requested?.payload).toMatchObject({
      providerOptions: {
        openai: { parallel_tool_calls: false, text_verbosity: "low" },
        anthropic: { thinking_display: "summarized", speed: "fast" },
        google: { temperature: 0.4, thinking_budgets: { low: 128 } },
      },
    })
    writer.dispose()
    store.close()
  })

test("records exact candidate attribution for bundled and static catalogs", () => {
  for (const [turn, catalogProvenance] of [[1, "bundled"], [2, "static"]] as const) {
    const facts = buildProviderRequestFacts({
      ...requestBase,
      turn,
      messages: [{ role: "user", content: "x" }],
      accessProviderCandidate: { kind: "subscription", providerId: "chatgpt", instanceId: `account-${turn}`, spendMode: "included" },
      catalogProvenance,
    }, {}).facts;
    expect(facts.find((fact) => fact.type === "model.requested")).toMatchObject({
      version: 6,
      payload: {
        accessProviderCandidate: { kind: "subscription", providerId: "chatgpt", instanceId: `account-${turn}`, spendMode: "included" },
        catalogProvenance,
      },
    });
  }
});

test("parses historical model.requested versions one through three", () => {
  const base = { requestId: "req-old", conversationId: "conv-old", turn: 1, model: "model", accessProvider: "openai_api", modelFamily: "openai" };
  expect(parseProviderRequestAuditFact({ type: "model.requested", version: 1, actor: "flywheel", payload: base }).version).toBe(1);
  expect(parseProviderRequestAuditFact({ type: "model.requested", version: 2, actor: "flywheel", payload: { ...base, interactionProfileId: "default" } }).version).toBe(2);
  expect(parseProviderRequestAuditFact({ type: "model.requested", version: 3, actor: "flywheel", payload: { ...base, interactionProfileId: "default" } }).version).toBe(3);
});

test("reads the retired gpt-6-luna profile ids that earlier builds recorded, and writes the default profile", () => {
  const retiredGeneration = [5, 6].join(".")
  const facts = buildProviderRequestFacts({
    ...requestBase, turn: 1, model: "gpt-6-luna", interactionProfileId: "default", messages: [],
  }, {}).facts
  const written = facts.find((fact) => fact.type === "model.requested")
  if (!written || written.type !== "model.requested") throw new Error("Expected request evidence")
  expect(written).toMatchObject({ version: 6, payload: { interactionProfileId: "default" } })
  for (const [suffix, neutral] of [["", "luna-native-v1"], ["-shell", "luna-shell-v1"]] as const) {
    const legacy = `gpt-${retiredGeneration}-luna${suffix}-v1`
    // A v6 fact that a build before 2026-10-30 wrote for gpt-6-luna.
    const current = { ...written, payload: { ...written.payload, interactionProfileId: neutral } }
    expect(parseProviderRequestAuditFact(current).payload).toMatchObject({ interactionProfileId: neutral })
    expect(() => parseProviderRequestAuditFact({ ...current, payload: { ...current.payload, interactionProfileId: legacy } })).toThrow(legacy)
    const stored = facts.map((fact, position) => ({
      ...(fact.type === "model.requested" ? { ...fact, payload: { ...fact.payload, interactionProfileId: neutral } } : fact),
      id: `event-${position}`, aggregateId: "session:test", sessionId: "test", seq: position + 1,
      timestamp: position, position: position + 1,
    }))
    expect(loadProviderRequestAuditFromEvents(stored)[0]?.request?.interactionProfileId).toBe(neutral)
    const storedRequest = stored.find((fact) => fact.type === "model.requested")
    if (!storedRequest) throw new Error("Expected stored request evidence")
    for (const version of [2, 3, 4, 5]) {
      const historical = {
        ...storedRequest, version,
        payload: {
          requestId: "profile-request", turn: 1, model: "gpt-6-luna", accessProvider: "openai_api", modelFamily: "openai",
          ...(version === 5 ? { identity: { providerSessionKey: "conv-1", conversationId: "conv-1" } } : { conversationId: "conv-1" }),
          ...(version === 4 ? { accessProviderCandidate: { kind: "singleton", providerId: "openai_api", spendMode: "direct_api" } } : {}),
          interactionProfileId: legacy,
        },
      }
      const before = JSON.stringify(historical)
      expect(readProviderRequestAuditFact(historical).payload).toMatchObject({ interactionProfileId: neutral })
      expect(JSON.stringify(historical)).toBe(before)
      for (const unknown of ["unknown", "gpt-6-other-v1", `${legacy}-extra`, "gpt-future-luna-v1"]) {
        expect(() => readProviderRequestAuditFact({ ...historical, payload: { ...historical.payload, interactionProfileId: unknown } })).toThrow(InvariantViolation)
      }
    }
  }
})

test("records a response with what a transport added as version 3, and still parses a version 2 response, which predates it", async () => {
  const response = { requestId: "req-old", identity: { providerSessionKey: "p", conversationId: "conv-old" }, turn: 1, outcome: "ok", durationMs: 1 } as const;
  const transportContext = { identity: "claude-engine", additions: [{ part: "header", kind: "anthropic-beta", value: "oauth-2025-04-20" }], hiddenRequests: [], notRecorded: [] } as const;
  const written: ProviderRequestAuditFact[] = [];
  await recordProviderResponse({ observe: (fact) => { written.push(fact); } }, { ...response, transportContext });
  expect(written).toEqual([expect.objectContaining({ type: "model.response_received", version: 3, payload: expect.objectContaining({ transportContext }) })]);
  expect(parseProviderRequestAuditFact({ type: "model.response_received", version: 2, actor: "provider", payload: response }).version).toBe(2);
});

})
