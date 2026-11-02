import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { closeFixtures, fixture } from "./_project-state-worker-fixture.js"
import { extractContent } from "../../../../src/infra/tool-content.js"
import { hydrateToolContentFact } from "../../../../src/infra/tool-content-hydration.js"
import {
  createProjectStateClient,
  ProjectStateUnavailableError,
  ProjectStateRefusedError,
  type ProjectStateClientTransport,
} from "../../../../src/orchestration/app-service/project-state-client.js"
import { spawnProjectStateWorker } from "../../../../src/orchestration/app-service/project-state-worker-spawner.js"
import { decodeProjectStateRequest, encodeProjectStateClosed, encodeProjectStateRequest, encodeProjectStateResponseFrame, type ProjectStateRequest, type ProjectStateResponse, type ProjectStateResponseFrame } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { CorruptEventRowError, type EventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { WorkerGenerationBudgetExhausted, WorkerRoleAlreadyLive } from "../../../../src/infra/bounded-worker-spawner.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { startProjectStateStandby } from "../../../../src/orchestration/app-service/project-state-standby.js"
import { ServeStartupFailure, startRefusalOf } from "../../../../src/protocol/serve-handshake.js"
import { pack, unpack } from "msgpackr"
import { buildSessionContent, type SessionContentNodeRow } from "../../../../src/infra/session-content.js"

afterEach(closeFixtures)

function transportHarness() {
  let receive: ((frame: ProjectStateResponseFrame) => boolean) | undefined
  let close: ((reason: string) => void) | undefined
  const sent: ProjectStateRequest[] = []
  const transport: ProjectStateClientTransport = {
    send(request) { sent.push(request) },
    onResponse(listener) { receive = listener },
    onClose(listener) { close = listener },
    onSessionChange() { return () => {} },
    onStored() { return () => {} },
    close() {},
  }
  return {
    transport,
    sent,
    respond(response: ProjectStateResponse) { return receive?.(encodeProjectStateResponseFrame(response)) },
    lose(reason = "worker closed") { close?.(reason) },
  }
}

describe("project state client", () => {
  test("refuses an oversized evidence stage before sending it", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const nodes: SessionContentNodeRow[] = []
    const text = Array.from({ length: 400 }, (_, index) => `${index}${"\0".repeat(1_000)}`).join("")
    await buildSessionContent(text, async (rows) => { nodes.push(...rows) })
    await expect(client.writer.stageSessionContentNodes!("s", nodes)).rejects.toMatchObject({ name: "PersistenceWriteRefused", limitBytes: 1_048_576 })
    expect(harness.sent).toHaveLength(0)
    await client.close()
  })
  test("admits the complete request at the limit and refuses one byte above without sending", async () => {
    const operation = { kind: "generation.admit", projectId: "p", generation: 1 } as const
    const bytes = pack({ id: 1, lane: "execution", operation }).byteLength
    for (const offset of [-1, 0, 1]) {
      const harness = transportHarness()
      const client = createProjectStateClient(harness.transport, { maxQueuedBytes: bytes + offset })
      const result = client.execution(operation)
      if (offset < 0) {
        expect(harness.sent).toHaveLength(0)
        await expect(result).rejects.toMatchObject({ name: "PersistenceWriteRefused", encodedBytes: bytes, limitBytes: bytes - 1 })
      } else {
        expect(harness.sent).toHaveLength(1)
        harness.respond({ id: 1, result: { kind: "ok" } })
        await expect(result).resolves.toEqual({ kind: "ok" })
      }
      await client.close()
    }
  })

  test("sends one payload representation and restores exact JSON and swap tokens", async () => {
    const harness = transportHarness()
    const frames: Uint8Array[] = []
    const client = createProjectStateClient({
      ...harness.transport,
      send(request, encoded) { frames.push(encoded); harness.transport.send(request, encoded) },
    })
    const event: EventStoreAppend = {
      aggregateId: "session:s", sessionId: "s", type: "test.fact", version: 1, actor: "test", timestamp: 1,
      payload: { text: "é\n" }, payloadJson: '{"text":"é\\n"}',
      inFlight: [{ op: "swap", kind: "tool", key: "k", expectedRaw: '{ "old": true }', payload: { next: true } }],
    }
    const pending = client.writer.append(event)
    const wire = unpack(frames[0]!)
    expect(wire.operation.item.events[0]).not.toHaveProperty("payload")
    expect(wire.operation.item.events[0].payloadJson).toBe(event.payloadJson)
    expect(wire.operation.item.events[0].inFlight[0]).not.toHaveProperty("payload")
    expect(decodeProjectStateRequest(frames[0], "control")?.operation).toMatchObject({
      item: { events: [{ payload: event.payload, payloadJson: event.payloadJson, inFlight: [{ expectedRaw: '{ "old": true }', payload: { next: true } }] }] },
    })
    harness.respond({ id: 1, result: { kind: "stored", settlements: [{ kind: "stored", receipts: [{ id: "e", seq: 0, position: 1 }] }] } })
    await expect(pending).resolves.toEqual({ aggregateId: "session:s", sessionId: "s", type: "test.fact", version: 1, actor: "test", timestamp: 1, payload: event.payload, id: "e", seq: 0, position: 1 })
    await client.close()
  })
  test("execution saturation leaves independent control admission", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport, { maxQueuedItems: 1, maxQueuedBytes: 128 })
    const execution = client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    await expect(client.execution({ kind: "generation.close", projectId: "p", generation: 1 })).resolves.toEqual({ kind: "refused", reason: "pressure" })
    const control = client.capturePosition()
    expect(harness.sent.map((request) => request.lane)).toEqual(["execution", "control"])
    harness.respond({ id: 2, result: { kind: "position", position: 7 } })
    harness.respond({ id: 1, result: { kind: "ok" } })
    await expect(control).resolves.toBe(7)
    await execution
    await client.close()
  })

  test("execution byte pressure cannot spend the control byte budget", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport, { maxQueuedBytes: encodeProjectStateRequest({ id: 1, lane: "execution", operation: { kind: "generation.admit", projectId: "p", generation: 1 } }).byteLength })
    const execution = client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    await expect(client.execution({ kind: "generation.close", projectId: "p", generation: 1 })).resolves.toEqual({ kind: "refused", reason: "pressure" })
    const control = client.capturePosition()
    harness.respond({ id: 2, result: { kind: "position", position: 7 } })
    harness.respond({ id: 1, result: { kind: "ok" } })
    await expect(control).resolves.toBe(7)
    await execution
    await client.close()
  })

  test("read refusal is terminal and retains its typed reason", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const page = client.readPage({}, 3, 0)
    harness.respond({ id: 1, result: { kind: "refused", reason: "oversize" } })
    await expect(page).rejects.toBeInstanceOf(ProjectStateRefusedError)
    expect(harness.sent).toHaveLength(1)
    await client.close()
  })

  test("maps exact typed reads without changing their arguments", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const fact = {
      aggregateId: "a", type: "one", version: 1, timestamp: 1, actor: "test",
      sessionId: "s", payload: { value: 1 }, position: 2, id: "e", seq: 0,
    }
    const cases = [
      {
        start: () => client.readLatestPayloadByAggregateAndType("a", "one"),
        operation: { kind: "facts.latest-payload", aggregateId: "a", type: "one" },
        result: { kind: "latest-payload", payload: "{\"value\":1}" },
        expected: "{\"value\":1}",
      },
      {
        start: () => client.readLatestByAggregateAndTypes("a", ["one", "two"]),
        operation: { kind: "facts.latest-by-types", aggregateId: "a", types: ["one", "two"] },
        result: { kind: "fact-list", facts: [fact] },
        expected: [fact],
      },
      {
        start: () => client.readInFlight("s", ["tool", "review"]),
        operation: { kind: "in-flight.read", sessionId: "s", kinds: ["tool", "review"] },
        result: { kind: "in-flight", records: [{ kind: "tool", key: "k", payload: { value: 1 }, raw: "{\"value\":1}" }] },
        expected: [{ kind: "tool", key: "k", payload: { value: 1 }, raw: "{\"value\":1}" }],
      },
      {
        start: () => client.sessionsWithInFlight("tool"),
        operation: { kind: "in-flight.sessions", inFlightKind: "tool" },
        result: { kind: "session-ids", sessionIds: ["s"] },
        expected: ["s"],
      },
      {
        start: () => client.hasInFlightProfile("usage.settlement", "profile"),
        operation: { kind: "in-flight.profile", inFlightKind: "usage.settlement", profileId: "profile" },
        result: { kind: "in-flight.profile", found: true }, expected: true,
      },
      {
        start: () => client.countByAggregate("a"),
        operation: { kind: "aggregate.count", aggregateId: "a" },
        result: { kind: "count", count: 3 },
        expected: 3,
      },
      {
        start: () => client.aggregateSeq("a"),
        operation: { kind: "aggregate.sequence", aggregateId: "a" },
        result: { kind: "sequence", sequence: 4 },
        expected: 4,
      },
    ] satisfies {
      start: () => Promise<string | number | boolean | readonly (object | string)[] | null | undefined>
      operation: ProjectStateRequest["operation"]
      result: ProjectStateResponse["result"]
      expected: unknown
    }[]

    for (const entry of cases) {
      const pending = entry.start()
      const request = harness.sent.at(-1)!
      expect(request.operation).toEqual(entry.operation)
      harness.respond({ id: request.id, result: entry.result })
      expect(await pending).toEqual(entry.expected)
    }
    await client.close()
  })

  test("preserves an exact fact slice query and hydrates its referenced content", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const query = { aggregateId: "a", order: "desc" as const, limit: 1 }
    const pending = client.readSlice(query)
    const request = harness.sent[0]!
    expect(request.operation).toEqual({
      kind: "facts.slice", query, tolerant: false,
      maxRows: 256, maxBytes: 8 * 1024 * 1024,
    })
    harness.respond({
      id: request.id,
      result: {
        kind: "fact-slice",
        contentRows: [],
        facts: [{
          aggregateId: "a", type: "one", version: 1, timestamp: 1, actor: "test",
          sessionId: "s", payload: {}, position: 2, id: "e", seq: 0,
        }],
        encodedBytes: 1,
      },
    })
    await expect(pending).resolves.toMatchObject({ facts: [{ position: 2 }] })
    await client.close()
  })

  test("defers page content until the indexed reader requests the selected facts", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const text = "selected child body"
    const reference = contentEvidence(text)
    const fact: StoredFact = {
      aggregateId: "session:s", sessionId: "s", type: "tool.result.recorded", version: 2,
      actor: "flywheel", timestamp: 1, position: 1, seq: 0, id: "result",
      payload: { toolUseId: "child", outcome: "ok", content: reference },
    }
    const pending = client.readPage({ aggregateId: "session:s" }, 1, 0, false, "deferred")
    harness.respond({
      id: harness.sent[0]!.id,
      result: { kind: "facts", facts: [fact], contentRows: [], upperPosition: 1, continuationPosition: null, encodedBytes: 1 },
    })
    expect((await pending).facts).toEqual([fact])
    expect(harness.sent.map((request) => request.operation.kind)).toEqual(["facts.page"])
    const selected = client.contentFor([fact])
    const request = harness.sent[1]!
    if (request.operation.kind !== "content.page") throw new Error("Expected selected content request")
    expect(request.operation.references).toEqual([{
      sessionId: "s", reference, fact: { eventType: fact.type, eventPosition: 1, aggregateId: fact.aggregateId },
    }])
    harness.respond({
      id: request.id,
      result: { kind: "content", rows: [{ reference: request.operation.references[0]!, content: text }], continuationOffset: null, encodedBytes: text.length },
    })
    expect((await selected).resolve("s", reference.sha256)).toBe(text)
    await client.close()
  })

  test("close joins admitted requests before closing transport and is idempotent", async () => {
    const harness = transportHarness()
    let closes = 0
    harness.transport.close = () => { closes += 1 }
    const client = createProjectStateClient(harness.transport)
    const pending = client.capturePosition()
    const closed = client.close()
    expect(client.close()).toBe(closed)
    expect(client.available).toBe(false)
    await Promise.resolve()
    expect(closes).toBe(0)
    await expect(client.capturePosition()).rejects.toBeInstanceOf(ProjectStateUnavailableError)
    harness.respond({ id: 1, result: { kind: "position", position: 2 } })
    await expect(pending).resolves.toBe(2)
    await closed
    expect(closes).toBe(1)
  })

  test("worker loss during disposal settles requests and the close join", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const pending = client.capturePosition()
    const closed = client.close()
    harness.lose("lost during close")
    await expect(pending).rejects.toThrow("lost during close")
    await closed
  })

  test("transport disposal failure is retained by the idempotent close promise", async () => {
    const harness = transportHarness()
    const failure = new Error("database close failed")
    harness.transport.close = () => { throw failure }
    const client = createProjectStateClient(harness.transport)
    const closed = client.close()
    await expect(closed).rejects.toBe(failure)
    expect(client.close()).toBe(closed)
  })

  test("session proxy forwards commands and releases change subscription on close", async () => {
    let receive: ((frame: ProjectStateResponseFrame) => boolean) | undefined
    let change: ((change: SessionMetadataChange) => void) | undefined
    let unsubscribed = 0
    const client = createProjectStateClient({
      send(request) {
        expect(request.operation).toEqual({ kind: "session.control", command: { kind: "session.read-batch", reads: [{ kind: "session.read", id: "s" }] } })
        receive?.(encodeProjectStateResponseFrame({ id: request.id, result: { kind: "session-result", result: { kind: "session.read-batch.result", outcomes: [{ kind: "read", result: { kind: "session.read.result", value: null } }] } } }))
      },
      onResponse(listener) { receive = listener },
      onClose() {},
      onStored() { return () => {} },
      onSessionChange(listener) {
        change = listener
        return () => { unsubscribed += 1; change = undefined }
      },
      close() {},
    })
    const changes: SessionMetadataChange[] = []
    client.sessions.subscribe((value) => changes.push(value))

    expect(await client.sessions.read("s")).toBeNull()
    change?.({ kind: "changed", sessionIds: ["s"] })
    await client.close()
    change?.({ kind: "deleted", sessionId: "s" })

    expect(changes).toEqual([{ kind: "changed", sessionIds: ["s"] }])
    expect(unsubscribed).toBe(1)
  })

  test("synchronous transport failure releases admission", async () => {
    const harness = transportHarness()
    const send = harness.transport.send
    harness.transport.send = () => { throw new Error("port closed") }
    const client = createProjectStateClient(harness.transport, { maxQueuedItems: 1 })
    await expect(client.capturePosition()).rejects.toThrow("port closed")
    harness.transport.send = send
    const pending = client.capturePosition()
    harness.respond({ id: 2, result: { kind: "position", position: 3 } })
    await expect(pending).resolves.toBe(3)
    await client.close()
  })

  test("keeps an append batch indivisible and settles it from one response", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const item = {
      sessionId: "s1",
      events: [
        { aggregateId: "session:s1", type: "one", version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {} },
        { aggregateId: "session:s1", type: "two", version: 1, timestamp: 2, actor: "test", sessionId: "s1", payload: {} },
      ],
    } as const

    const pending = client.control({ kind: "append.batch", items: [item] })
    expect(harness.sent).toHaveLength(1)
    expect(harness.sent[0]?.operation).toEqual({ kind: "append.batch", items: [item] })
    harness.respond({ id: harness.sent[0]!.id, result: { kind: "stored", settlements: [{ kind: "stored", receipts: [] }] } })

    await expect(pending).resolves.toEqual({ kind: "stored", settlements: [{ kind: "stored", receipts: [] }] })
  })

  test("writer maps append, atomic cross-session batch, and maintenance operations", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const first = { aggregateId: "session:s1", type: "one", version: 1, timestamp: 1, actor: "test", sessionId: "s1", payload: {} } satisfies EventStoreAppend
    const second = { ...first, aggregateId: "session:s2", type: "two", sessionId: "s2" }

    const append = client.writer.append(first)
    expect(harness.sent[0]?.operation).toEqual({ kind: "append", item: { sessionId: "s1", events: [first] } })
    harness.respond({ id: harness.sent[0]!.id, result: { kind: "stored", settlements: [{ kind: "stored", receipts: [{ id: "1", position: 1, seq: 0 }] }] } })
    await expect(append).resolves.toEqual({ ...first, id: "1", position: 1, seq: 0 })

    const batch = client.writer.appendBatch([first, second])
    expect(harness.sent[1]?.operation).toEqual({ kind: "append.batch", items: [{ sessionId: "s1", events: [first, second] }] })
    harness.respond({ id: harness.sent[1]!.id, result: { kind: "stored", settlements: [{ kind: "stored", receipts: [{ id: "2", position: 2, seq: 1 }, { id: "3", position: 3, seq: 0 }] }] } })
    await expect(batch).resolves.toEqual([{ ...first, id: "2", position: 2, seq: 1 }, { ...second, id: "3", position: 3, seq: 0 }])

    const operations = [
      client.writer.pruneSupersededEvents("a", "t"),
      client.writer.pruneSupersededKeyedEvents!("a", "t", "$.key"),
    ]
    expect(harness.sent.slice(2).map(({ operation }) => operation)).toEqual([
      { kind: "maintenance.prune", aggregateId: "a", eventType: "t" },
      { kind: "maintenance.prune-keyed", aggregateId: "a", eventType: "t", payloadKey: "$.key" },
    ])
    for (const request of harness.sent.slice(2)) harness.respond({ id: request.id, result: { kind: "maintenance", affected: request.id } })
    await expect(Promise.all(operations)).resolves.toEqual([3, 4])
  })

  test("writer exposes refusal and typed settlement failures without retrying", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport, { maxQueuedItems: 1 })
    const event = { aggregateId: "a", type: "t", version: 1, timestamp: 1, actor: "test", sessionId: "s", payload: {} } satisfies EventStoreAppend
    const pending = client.writer.append(event)
    await expect(client.writer.append(event)).rejects.toMatchObject({ name: "ProjectStateRefusedError", reason: "pressure" })
    const failure = new Error("append failed")
    harness.respond({ id: harness.sent[0]!.id, result: { kind: "stored", settlements: [{ kind: "rejected", error: failure }] } })
    await expect(pending).rejects.toEqual(failure)
    expect(harness.sent).toHaveLength(1)
  })

  test("rejects oversize work before transport admission", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport, { maxQueuedBytes: 32 })
    const pending = client.control({
      kind: "session.control",
      command: { kind: "session.update-label", id: "s1", labels: { label: "x".repeat(128), shortLabel: "x" }, source: "user" },
    })

    await expect(pending).rejects.toMatchObject({ name: "PersistenceWriteRefused", limitBytes: 32 })
    expect(harness.sent).toEqual([])
  })

  test("worker loss rejects pending control and execution requests without fallback", async () => {
    const harness = transportHarness()
    const client = createProjectStateClient(harness.transport)
    const control = client.control({ kind: "position.capture" })
    const execution = client.execution({ kind: "generation.admit", projectId: "p1", generation: 1 })
    harness.lose()

    await expect(control).rejects.toBeInstanceOf(ProjectStateUnavailableError)
    await expect(execution).rejects.toBeInstanceOf(ProjectStateUnavailableError)
    expect(client.available).toBe(false)
  })

  test("an eager aggregate read captures facts and reference-site content in one request", async () => {
    const { client, store, service } = await fixture()
    const evidence = contentEvidence("handoff body")
    const handoff = { stepId: "step", stepName: "Step", definitionId: "d", workflowDefinitionId: "w", content: { summary: "done" }, ...evidence }
    store.append({ aggregateId: "workflow:s", type: "handoff.written", sessionId: "s", version: 1, timestamp: 1, actor: "worker", payload: handoff })
    const extracted = extractContent("child result ".repeat(256))
    if (extracted.kind !== "reference") throw new Error("missing reference")
    store.append({
      aggregateId: "session:s", type: "tool.result.recorded", sessionId: "s", version: 2, timestamp: 1, actor: "flywheel",
      payload: { toolUseId: "t", outcome: "ok", parentToolUseId: "p", content: extracted.reference }, contentRows: [extracted.row],
    })
    const enqueue = spyOn(service, "enqueue")

    const workflow = await client.readSlice({ aggregateId: "workflow:s" }, true)
    expect(workflow.facts).toMatchObject([{ type: "handoff.written", payload: handoff }])
    expect(enqueue.mock.calls.map(([, operation]) => operation.kind)).toEqual(["facts.page"])

    enqueue.mockClear()
    const session = await client.readSlice({ aggregateId: "session:s" })
    expect(enqueue.mock.calls.map(([, operation]) => operation.kind)).toEqual(["facts.page"])
    const [result] = session.facts
    if (!result || result instanceof CorruptEventRowError) throw new Error("missing tool result")
    expect(hydrateToolContentFact(result, session.toolContent).payload.content).toBe(extracted.row.content)
    for (const read of [
      () => client.readSlice({ aggregateId: "session:s", limit: 1, order: "desc" }),
      () => client.readPage({ aggregateId: "session:s" }, store.currentPosition(), 0),
    ]) {
      enqueue.mockClear()
      const page = await read()
      expect(enqueue.mock.calls).toHaveLength(1)
      expect(page.toolContent.resolve("s", extracted.reference.sha256)).toBe(extracted.row.content)
    }
  })

  test("a deferred page that asks for fold evidence carries the evidence of its scope and no content", async () => {
    // The commit window holds facts but no evidence, so the page must come from the state Worker.
    const { client, store, service } = await fixture(undefined, undefined, false, [], { commitWindow: true })
    const extracted = extractContent("child result ".repeat(256))
    if (extracted.kind !== "reference") throw new Error("missing reference")
    const result = store.append({
      aggregateId: "session:s", type: "tool.result.recorded", sessionId: "s", version: 2, timestamp: 1, actor: "flywheel",
      payload: { toolUseId: "t", outcome: "ok", parentToolUseId: "p", content: extracted.reference }, contentRows: [extracted.row],
    })
    const enqueue = service.enqueue.bind(service)
    const served: unknown[] = []
    spyOn(service, "enqueue").mockImplementation(async (...args) => {
      const answer = await enqueue(...args)
      served.push(answer.result)
      return answer
    })

    const page = await client.readPage({ aggregateId: "session:s" }, undefined, 0, false, "deferred", { anchorAt: result.position })

    expect(page.foldEvidence).toEqual({ head: store.currentPosition(), generation: 0, anchor: { position: result.position, id: result.id } })
    expect(page.facts).toMatchObject([{ position: result.position }])
    expect(page.toolContent.resolve("s", extracted.reference.sha256)).toBeNull()
    expect(served).toMatchObject([{ kind: "facts", contentRows: [] }])
  })

})

/** Installs a recording Worker constructor for one test; the caller restores it. */
function recordingWorkers() {
  const original = globalThis.Worker
  const workers: RecordingWorker[] = []
  class RecordingWorker extends EventTarget {
    terminated = false
    shutdownError: Error | null = null
    readonly frames: string[] = []
    constructor() { super(); workers.push(this) }
    postMessage(message: { flywheel: string; executionCwd?: string; controlPort?: MessagePort; executionPort?: MessagePort }) {
      this.frames.push(message.flywheel)
      if (message.flywheel === "state.init") {
        expect(message.executionCwd).toBe("/execution")
        message.controlPort?.close()
        message.executionPort?.close()
      }
      if (message.flywheel === "state.close") this.dispatchEvent(new MessageEvent("message", { data: encodeProjectStateClosed(this.shutdownError) }))
    }
    terminate() {
      this.terminated = true
      this.dispatchEvent(new Event("close"))
    }
  }
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: RecordingWorker })
  return { workers, restore: () => Object.defineProperty(globalThis, "Worker", { configurable: true, value: original }) }
}

const PROJECT = { projectRoot: "project", userDataRoot: "user-data", accountHome: "account-home" }

test("a project acquisition retains its generation budget and replacement waits for joined termination", async () => {
  const { workers, restore } = recordingWorkers()
  try {
    const owner = spawnProjectStateWorker(PROJECT, "/execution", "worker.ts")
    for (let generation = 0; generation < 3; generation += 1) {
      const client = owner.acquire()
      expect(() => owner.acquire()).toThrow(WorkerRoleAlreadyLive)
      if (generation === 1) workers[generation]!.shutdownError = new Error("close failed")
      const worker = workers[generation]!
      // Termination is observed, not assumed: the join waits for the close below.
      worker.terminate = () => { worker.terminated = true }
      const closed = client.close()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(worker.terminated).toBe(true)
      expect(() => owner.acquire()).toThrow(WorkerRoleAlreadyLive)
      worker.dispatchEvent(new Event("close"))
      if (generation === 1) await expect(closed).rejects.toThrow("close failed")
      else await closed
    }
    expect(() => owner.acquire()).toThrow(WorkerGenerationBudgetExhausted)
    expect(workers).toHaveLength(3)
  } finally {
    restore()
  }
})

test("a start the state Worker reports as failed reaches requests in its own words and keeps its refusal", async () => {
  const { workers, restore } = recordingWorkers()
  try {
    const client = spawnProjectStateWorker(PROJECT, "/execution", "worker.ts").acquire()
    const read = client.control({ kind: "position.capture" })
    const refusal = { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 } as const
    const failure = new Error("project state workspace preparation failed", { cause: new ServeStartupFailure("a newer release wrote workspace state epoch 99", refusal) })
    workers[0]!.dispatchEvent(new MessageEvent("message", { data: structuredClone(encodeProjectStateClosed(failure)) }))

    const error = await read.then(() => undefined, (cause: unknown) => cause)
    expect(error).toBeInstanceOf(ProjectStateUnavailableError)
    expect(error).toMatchObject({ message: "project state is unavailable: project state workspace preparation failed: a newer release wrote workspace state epoch 99" })
    expect(startRefusalOf(error)).toEqual(refusal)
    expect(client.available).toBe(false)
  } finally {
    restore()
  }
})

test("the first acquisition takes the pre-started Worker without spending the project's budget", async () => {
  const { workers, restore } = recordingWorkers()
  try {
    const standby = startProjectStateStandby("worker.ts")
    const owner = spawnProjectStateWorker(PROJECT, "/execution", "worker.ts", undefined, standby)
    const first = owner.acquire()
    expect(workers).toHaveLength(1)
    expect(workers[0]!.frames).toEqual(["state.preload", "state.init"])
    await first.close()
    for (let generation = 0; generation < 3; generation += 1) await owner.acquire().close()
    expect(() => owner.acquire()).toThrow(WorkerGenerationBudgetExhausted)
    expect(workers).toHaveLength(4)
    expect(workers.slice(1).map((worker) => worker.frames[0])).toEqual(["state.init", "state.init", "state.init"])
  } finally {
    restore()
  }
})

test("a pre-started Worker that failed leaves the first acquisition to spawn its own, and disposal joins it", async () => {
  const { workers, restore } = recordingWorkers()
  try {
    const standby = startProjectStateStandby("worker.ts")
    const failed = workers[0]!
    // Termination is observed, not assumed: the join waits for the close below.
    failed.terminate = () => { failed.terminated = true }
    failed.dispatchEvent(new ErrorEvent("error", { message: "import failed" }))
    expect(failed.terminated).toBe(true)
    let disposed = false
    const disposal = standby.dispose().then(() => { disposed = true })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(disposed).toBe(false)
    failed.dispatchEvent(new Event("close"))
    await disposal
    const owner = spawnProjectStateWorker(PROJECT, "/execution", "worker.ts", undefined, standby)
    const client = owner.acquire()
    expect(workers).toHaveLength(2)
    expect(workers[1]!.frames).toEqual(["state.init"])
    await client.close()
  } finally {
    restore()
  }
})

test("the service's disposal terminates an untaken pre-started Worker and leaves a taken one to its project", async () => {
  const { workers, restore } = recordingWorkers()
  try {
    const untaken = startProjectStateStandby("worker.ts")
    await untaken.dispose()
    expect(workers[0]!.terminated).toBe(true)
    expect(untaken.take()).toBeUndefined()

    const taken = startProjectStateStandby("worker.ts")
    expect(taken.take()).toBeDefined()
    await taken.dispose()
    expect(workers[1]!.terminated).toBe(false)
  } finally {
    restore()
  }
})
