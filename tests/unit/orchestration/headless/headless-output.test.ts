import { describe, expect, it, spyOn } from "bun:test"
import { Schema } from "effect"
import { PersistenceWriteRefused } from "../../../../src/infra/event-store-types.js"
import { runHeadlessTask } from "../../../../src/orchestration/headless/run-headless-task.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { fakeModelsClient } from "../../../helpers/model-tier-fixtures.js"
import { makeWorkflowDeps } from "./_headless-run-fixtures.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import {
  createHeadlessOutputObserver,
  encodeHeadlessOutputRecord,
  formatLegacyTaskOutput,
  HeadlessOutputRecordSchema,
  normalizeHeadlessEvent,
} from "../../../../src/orchestration/headless/headless-output.js"

const decodeRecord = Schema.decodeUnknownSync(HeadlessOutputRecordSchema, { onExcessProperty: "error" })
const createDirectory = temporaryDirectories()

function memorySink(blockFirst = false) {
  const chunks: string[] = []
  let listener: (() => void) | undefined
  let blocked = blockFirst
  return {
    chunks,
    sink: {
      write(chunk: string) {
        chunks.push(chunk)
        if (!blocked) return true
        blocked = false
        return false
      },
      once(_event: "drain", next: () => void) { listener = next },
    },
    blockNextWrite() { blocked = true },
    drain() { listener?.() },
  }
}

describe("headless output contract", () => {
  it("normalizes measured chat usage without producer-only fields", () => {
    const usage = normalizeHeadlessEvent({ id: "usage-event-1", type: "model.usage.measured", sessionId: "session-1", timestamp: 42, data: { usage_entry: { attemptId: "00000000-0000-4000-8000-000000000001", occurredAt: "2026-09-02T00:00:00.000Z", profileId: "test", attribution: { kind: "unattributed" }, spendMode: "direct_api", credentialLineage: "10000000-0000-4000-8000-000000000001", model: "test", tokens: { input: 11, output: 7, cacheRead: 5, cacheWrite: 0, reasoning: 0 }, classification: "real_spend", price: { kind: "priced", estimatedUsd: 0.1, rateCard: {}, provenance: "test" }, currency: "USD", coverage: "complete" }, budget_stream_id: "session-1" } })
    expect(usage).toMatchObject({ kind: "chat.usage", inputTokens: 11, outputTokens: 7, cacheReadTokens: 5 })
  })

  it("omits absent envelope values and all unknown events", () => {
    const event = {
      id: "event-1", type: "agent.run.started", version: 1, data: { stepIndex: 1 },
      sessionId: "", timestamp: 0,
    } as const
    expect(normalizeHeadlessEvent(event)).toBeUndefined()
    expect(encodeHeadlessOutputRecord({ kind: "chat.turn.completed", version: 4, timestamp: 0 })).toBe("{\"kind\":\"chat.turn.completed\",\"version\":4,\"timestamp\":0}\n")
  })

  it("closes progress before publishing exactly one terminal record last", async () => {
    const output = memorySink()
    const bus = new EventBus()
    const observer = createHeadlessOutputObserver(output.sink)
    observer.connect(bus)
    createEmit(bus)("model.turn.completed", { sessionId: "session-1", data: {} })
    await observer.close()
    await observer.publishTaskTerminal({ completed: true, projectRoot: "/project", sessionId: "session-1", termination: { version: 2, deadlineFired: false } })
    await observer.publishTaskTerminal({ completed: false, projectRoot: "/ignored", termination: { version: 2, deadlineFired: false } })
    createEmit(bus)("model.turn.completed", { sessionId: "session-1", data: {} })

    const records = output.chunks.map((line) => decodeRecord(JSON.parse(line)))
    expect(records.map(({ kind }) => kind)).toEqual(["chat.turn.completed", "chat.terminal"])
  })

  it("publishes task result fields through an explicit secret-safe terminal shape", async () => {
    const output = memorySink()
    const observer = createHeadlessOutputObserver(output.sink)
    await observer.publishTaskTerminal({
      completed: false,
      projectRoot: "/project",
      sessionId: "session-1",
      finalMessage: "final answer",
      usage: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, reasoningTokens: 5, costUsd: 0.01 },
      termination: { version: 2, terminal: { kind: "api_error", message: "sensitive provider response", copy: { presentation: "provider.rate_limited", title: "Rate limited", message: "internal copy" }, recovery: { kind: "none" } }, deadlineFired: true },
      report: { model: "model-name", effort: "low", sourceArchiveSha256: "a".repeat(64), toolSurfaces: [{ toolSurfaceHash: "hash", tools: ["read"] }] },
      error: "sensitive diagnostic",
    })

    const record = decodeRecord(JSON.parse(output.chunks[0] ?? "{}"))
    expect(record).toEqual({
      kind: "chat.terminal",
      version: 4,
      sessionId: "session-1",
      completed: false,
      projectRoot: "/project",
      finalMessage: "final answer",
      usage: { requests: 1, inputTokens: 2, outputTokens: 3, cacheReadTokens: 4, reasoningTokens: 5, costUsd: 0.01 },
      termination: { version: 2, terminal: { kind: "api_error" }, deadlineFired: true },
      report: { model: "model-name", effort: "low", sourceArchiveSha256: "a".repeat(64), toolSurfaces: [{ toolSurfaceHash: "hash", tools: ["read"] }] },
    })
    expect(output.chunks[0]).not.toContain("sensitive provider response")
    expect(output.chunks[0]).not.toContain("sensitive diagnostic")
    expect(output.chunks[0]).not.toContain("internal copy")
  })

  it("publishes a local catalog miss as model_unavailable, apart from a provider api_error", async () => {
    const output = memorySink()
    await createHeadlessOutputObserver(output.sink).publishTaskTerminal({
      completed: false,
      projectRoot: "/project",
      termination: { version: 2, terminal: { kind: "model_unavailable", message: "No captured provider catalog maps \"nonexistent-model-9\" to a wire model id.", missing: "offering" }, deadlineFired: false },
    })

    const record = decodeRecord(JSON.parse(output.chunks[0] ?? "{}"))
    expect(record).toMatchObject({ termination: { terminal: { kind: "model_unavailable" } } })
  })
  it("maps a local persistence refusal to an aborted v2 terminal without publishing its internal error", async () => {
    const output = memorySink()
    await createHeadlessOutputObserver(output.sink).publishTaskTerminal({
      completed: false, projectRoot: "/project",
      termination: { version: 2, terminal: { kind: "local_persistence_error", error: new PersistenceWriteRefused(129, 128) }, deadlineFired: false },
    })
    expect(decodeRecord(JSON.parse(output.chunks[0] ?? "{}"))).toEqual({
      kind: "chat.terminal", version: 4, completed: false, projectRoot: "/project",
      termination: { version: 2, terminal: { kind: "aborted" }, deadlineFired: false },
    })
  })
  it("reports the exact local persistence cause through the headless stderr entrypoint", async () => {
    const error = new PersistenceWriteRefused(129, 128, "final-result")
    const stderr = spyOn(process.stderr, "write").mockReturnValue(true)
    try {
      const result = await runHeadlessTask("work", {
        modelsClient: fakeModelsClient,
        directories: testDirectories(createDirectory("headless-local-refusal-")),
        launcher: { spawnOwned: async () => { throw new Error("unused") }, adoptOwned: async () => { throw new Error("unused") }, open() { return this }, close: async () => ({ settled: true as const }) },
        prepareWorkflowDeps: async () => makeWorkflowDeps(() => ({
          send() {}, abort() {}, end() {}, done: Promise.reject(error),
        })),
      })
      expect(result.completed).toBe(false)
      expect(result.termination.terminal).toEqual({ kind: "local_persistence_error", error })
      expect(stderr.mock.calls.map(([chunk]) => String(chunk)).join("")).toBe(
        "Headless task did not complete: Local persistence limit exceeded. Flywheel could not save this operation: its encoded request is 129 bytes; the limit is 128 bytes. The file changes already settled. Their final tool result could not be saved.\n",
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it("bounds lossy progress while backpressured and waits before terminal", async () => {
    const output = memorySink(true)
    const bus = new EventBus()
    const observer = createHeadlessOutputObserver(output.sink)
    observer.connect(bus)
    const emit = createEmit(bus)
    for (let index = 0; index < 100; index += 1) emit("model.turn.completed", { sessionId: "session-1", data: {} })
    const terminal = observer.publishTaskTerminal({ completed: true, projectRoot: "/project", termination: { version: 2, deadlineFired: false } })
    expect(output.chunks).toHaveLength(1)
    output.drain()
    await terminal
    expect(output.chunks.length).toBeLessThanOrEqual(66)
    expect(JSON.parse(output.chunks.at(-1) ?? "{}").kind).toBe("chat.terminal")
  })

  it("waits for a new drain when progress has drained but the terminal write is backpressured", async () => {
    const output = memorySink(true)
    const bus = new EventBus()
    const observer = createHeadlessOutputObserver(output.sink)
    observer.connect(bus)
    createEmit(bus)("model.turn.completed", { sessionId: "session-1", data: {} })
    const closing = observer.close()
    output.drain()
    await closing
    output.blockNextWrite()
    const result = { completed: true, projectRoot: "/project", termination: { version: 2 as const, deadlineFired: false } }
    let published = false
    const terminal = observer.publishTaskTerminal(result).then(() => { published = true })

    await Bun.sleep(0)
    expect(output.chunks).toHaveLength(2)
    expect(published).toBe(false)
    await observer.publishTaskTerminal(result)
    output.drain()
    await terminal
    expect(published).toBe(true)
    await observer.publishTaskTerminal(result)
    const records = output.chunks.map((line) => decodeRecord(JSON.parse(line)))
    expect(records.map(({ kind }) => kind)).toEqual(["chat.turn.completed", "chat.terminal"])
    expect(records[1]).toEqual({ kind: "chat.terminal", version: 4, ...result })
  })

  it("keeps exact legacy bytes frozen", () => {
    expect(formatLegacyTaskOutput({ completed: true, projectRoot: "/p", finalMessage: "finished", termination: { version: 2, deadlineFired: false } })).toBe("finished\n{\"completed\":true,\"projectRoot\":\"/p\",\"termination\":{\"version\":2,\"deadlineFired\":false}}\n")
    expect(formatLegacyTaskOutput({ completed: false, projectRoot: "/p", termination: { version: 2, terminal: { kind: "api_error", message: "raw", copy: { presentation: "provider.rate_limited", title: "Rate limited", message: "internal copy" }, recovery: { kind: "none" } }, deadlineFired: false } })).toBe("{\"completed\":false,\"projectRoot\":\"/p\",\"termination\":{\"version\":2,\"terminal\":{\"kind\":\"api_error\",\"message\":\"raw\"},\"deadlineFired\":false}}\n")
  })
})
