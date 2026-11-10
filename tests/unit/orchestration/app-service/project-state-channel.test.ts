import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { extractContent } from "../../../../src/infra/tool-content.js"
import { hydrateToolContentFact } from "../../../../src/infra/tool-content-hydration.js"
import { InvariantViolation } from "../../../../src/infra/invariant.js"
import { Log } from "../../../../src/infra/log.js"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "../../../../src/infra/internal-process-channel.js"
import { createReattachableProcessEndpoint } from "../../../../src/infra/reattachable-process-endpoint.js"
import { asAsyncEventWriter, CorruptEventRowError, InFlightSwapConflictError, PersistenceWriteRefused, type AsyncGuardedEventWriter, type EventStoreAppend, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { connectProjectStateChannel, serveProjectStateChannel } from "../../../../src/orchestration/app-service/project-state-channel.js"
import { createProjectStateClient, type ProjectStateClient } from "../../../../src/orchestration/app-service/project-state-client.js"
import { createProjectStateSessionManager } from "../../../../src/orchestration/app-service/project-state-sessions.js"
import type { ProjectStateControlOperation, ProjectStateExecutionOperation, ProjectStateRequest, ProjectStateResponseFrame, ProjectStateResult } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { pack } from "msgpackr"
import { PROJECT_STATE_MAX_BYTES, encodeProjectStateRequest, encodeProjectStateResponse, encodeProjectStateResponseFrame, decodeProjectStateResponse, decodeProjectStateRequest, readProjectStateResponseFrame } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { ParentPublicationContendedError } from "../../../../src/orchestration/session/manager.js"
import { WorkflowParentRefusal } from "../../../../src/orchestration/session/child-session-publication.js"
import { buildSessionContent, buildSessionContentManifest, readSessionContentRecords } from "../../../../src/infra/session-content.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { closeFixtures, fixture } from "./_project-state-worker-fixture.js"

afterEach(closeFixtures)

test("content-bound pages preserve all facts and blobs, and an indivisible fact uses content continuations", async () => {
  const { client, store, service } = await fixture()
  const contents = ["a", "b", "c"].map(letter => extractContent(letter.repeat(3 * 1024 * 1024)))
  for (const [index, content] of contents.entries()) {
    if (content.kind !== "reference") throw new Error("missing reference")
    store.append({
      aggregateId: "session:s", type: "tool.execution_output.recorded", sessionId: "s", version: 2, timestamp: 1, actor: "flywheel",
      payload: { toolUseId: `${index}`, output: content.reference }, contentRows: [content.row],
    })
  }
  const enqueue = spyOn(service, "enqueue")
  const slice = await client.readSlice({ aggregateId: "session:s" })
  expect(slice.facts).toHaveLength(3)
  expect(enqueue.mock.calls.map(([, operation]) => operation.kind)).toEqual(["facts.page", "facts.page"])
  for (const content of contents) if (content.kind === "reference") expect(slice.toolContent.resolve("s", content.reference.sha256)).toBe(content.row.content)
  // A toolResult can carry many reference parts, so even one fact can
  // exceed a frame while every individual blob still fits.
  store.append({
    aggregateId: "conversation:c", type: "chat.entries.appended", sessionId: "s", version: 1, timestamp: 1, actor: "flywheel",
    payload: { entries: [{ kind: "message", message: { kind: "toolResult", toolUseId: "all", content: contents.map(content => {
      if (content.kind !== "reference") throw new Error("missing reference")
      return { type: "text_reference", ...content.reference }
    }) } }] },
  })
  enqueue.mockClear()
  const conversation = await client.readSlice({ aggregateId: "conversation:c" })
  expect(conversation.facts).toHaveLength(1)
  expect(enqueue.mock.calls.map(([, operation]) => operation.kind)).toEqual(["facts.page", "content.page"])
  for (const content of contents) if (content.kind === "reference") expect(conversation.toolContent.resolve("s", content.reference.sha256)).toBe(content.row.content)
  enqueue.mockClear()
  const exact = await client.readSlice({ aggregateId: "session:s", limit: 3, order: "desc" })
  expect(exact.facts.map(fact => fact.position)).toEqual(slice.facts.toReversed().map(fact => fact.position))
  for (const content of contents) if (content.kind === "reference") expect(exact.toolContent.resolve("s", content.reference.sha256)).toBe(content.row.content)
  expect(enqueue.mock.calls.map(([, operation]) => operation.kind)).toEqual(["facts.slice", "content.page"])
})

test("tolerant descending reads preserve corrupt facts and defer missing or corrupt content errors until hydration", async () => {
  const { client, store, path } = await fixture()
  const content = extractContent("original ".repeat(500))
  if (content.kind !== "reference") throw new Error("missing reference")
  const result = store.append({
    aggregateId: "session:s", type: "tool.result.recorded", sessionId: "s", version: 2, timestamp: 1, actor: "flywheel",
    payload: { toolUseId: "t", outcome: "ok", content: content.reference }, contentRows: [content.row],
  })
  const broken = store.append({
    aggregateId: "session:s", type: "test.fact", sessionId: "s", version: 1, timestamp: 1, actor: "test", payload: {},
  })
  const db = new Database(path)
  try {
    db.query("update event set payload = ? where position = ?").run("{broken", broken.position)
    db.query("update tool_content set content = ? where session_id = ? and sha256 = ?").run("unproven", "s", content.reference.sha256)
    const slice = await client.readSlice({ aggregateId: "session:s", order: "desc" }, true)
    expect(slice.facts[0]).toBeInstanceOf(CorruptEventRowError)
    expect(slice.facts[1]).toEqual(result)
    expect(slice.toolContent.resolve("s", content.reference.sha256)).toBe("unproven")
    expect(() => hydrateToolContentFact(result, slice.toolContent)).toThrow(InvariantViolation)
    db.query("delete from tool_content where session_id = ? and sha256 = ?").run("s", content.reference.sha256)
    const missing = await client.readSlice({ aggregateId: "session:s" }, true)
    expect(() => missing.toolContent.resolve("s", content.reference.sha256)).toThrow(InvariantViolation)
  } finally { db.close() }
})

function endpointPair(): readonly [InternalProcessEndpoint<unknown, unknown>, InternalProcessEndpoint<unknown, unknown>] {
  const channel = new MessageChannel()
  return [
    createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value }),
    createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value }),
  ]
}

function stateHarness() {
  const storedListeners = new Set<(events: readonly StoredFact[]) => void>()
  const sessionListeners = new Set<(change: SessionMetadataChange) => void>()
  const calls: string[] = []
  let closeCalls = 0
  const storedFact: StoredFact = {
    id: "fact-1", aggregateId: "a", type: "test", version: 1, timestamp: 1,
    actor: "test", sessionId: "s", payload: {}, position: 1, seq: 0,
  }
  const sessions = createProjectStateSessionManager({
    async request(command) {
      if (command.kind === "session.read-batch") return { kind: "session.read-batch.result", outcomes: command.reads.map(() => ({ kind: "read" as const, result: { kind: "session.read.result" as const, value: null } })) }
      throw new Error("unsupported session command")
    },
    subscribe(listener) {
      sessionListeners.add(listener)
      return () => { sessionListeners.delete(listener) }
    },
  })
  const control = async (operation: ProjectStateControlOperation): Promise<ProjectStateResult> => {
    calls.push(`control:${operation.kind}`)
    if (operation.kind === "position.capture") {
      for (const listener of storedListeners) listener([storedFact])
      return { kind: "position", position: 1 }
    }
    throw new Error("state failure")
  }
  const execution = async (operation: ProjectStateExecutionOperation): Promise<ProjectStateResult> => {
    calls.push(`execution:${operation.kind}`)
    if (operation.kind === "execution.operation") return control(operation.operation)
    return { kind: "ok" }
  }
  const writer: AsyncGuardedEventWriter = {
    append: async (_event: EventStoreAppend) => storedFact,
    appendBatch: async () => [],
    appendGuarded: async () => ({ kind: "stored", events: [storedFact] }),
    appendBatchGuarded: async () => ({ kind: "stored", events: [] }),
    pruneSupersededEvents: async () => 0,
    pruneSupersededKeyedEvents: async () => 0,
  }
  const state: ProjectStateClient = {
    available: true,
    sessions,
    writer,
    upkeep: {
      pruneRetiredFamilyChunk: async () => 0,
      dropRetiredIndexes: async () => 0,
      retireFinalizedCheckpointPage: async ({ afterRowid }) => ({ kind: "checkpoint-maintenance", afterRowid, examined: 0, retired: 0, complete: true, transactionMs: 0 }),
    },
    onStored(listener) {
      storedListeners.add(listener)
      return () => { storedListeners.delete(listener) }
    },
    control,
    execution,
    // The account's own state client answers the frame the Worker served, with its head.
    // Every execution operation names its project and no control operation does.
    relay: async (_lane, operation, id) => encodeProjectStateResponse({
      id, result: "projectId" in operation ? await execution(operation) : await control(operation), head: 1,
    }),
    capturePosition: async () => 0,
    latestPosition: async () => 0,
    readLatestPayloadByAggregateAndType: async () => null,
    readLatestByAggregateAndTypes: async () => [],
    readInFlight: async () => [],
    sessionsWithInFlight: async () => [],
    inFlightProfileKeys: async () => [],
    countByAggregate: async () => 0,
    aggregateSeq: async () => -1,
    readSlice: async () => ({ facts: [], toolContent: { resolve: () => null } }),
    contentFor: async () => ({ resolve: () => null }),
    readPage: async () => ({ facts: [], upperPosition: 0, continuationPosition: null, toolContent: { resolve: () => null } }),
    async close() { closeCalls += 1 },
  }
  return {
    state, calls, storedFact,
    emitSession(change: SessionMetadataChange) {
      for (const listener of sessionListeners) listener(change)
    },
    get closeCalls() { return closeCalls },
    get subscriptions() { return storedListeners.size + sessionListeners.size },
  }
}

test("an append retires a cell that another session holds in its own commit unit", async () => {
  const { store, client } = await fixture()
  await client.control({ kind: "append", item: { sessionId: "workflow", events: [], inFlight: [{ op: "put", kind: "held", key: "k", payload: { text: "next agent" } }, { op: "put", kind: "held", key: "d", payload: {} }] } })
  const agentFact = { aggregateId: "session:agent", type: "test.fact", sessionId: "agent", version: 1, timestamp: 1, actor: "test", payload: {} }
  const raw = store.readInFlight("workflow", "held").find(({ key }) => key === "k")!.raw
  const stale = await client.control({ kind: "append", item: { sessionId: "agent", events: [agentFact], inFlight: [{ op: "swap", kind: "held", key: "k", expectedRaw: "stale", payload: null, sessionId: "workflow" }] } })
  if (stale.kind !== "stored" || stale.settlements[0]?.kind !== "rejected") throw new Error("missing rejection")
  expect(stale.settlements[0].error).toMatchObject({ sessionId: "workflow", kind: "held", key: "k" })
  expect(store.currentPosition()).toBe(0)
  const committed = await client.control({ kind: "append", item: { sessionId: "agent", events: [agentFact], inFlight: [{ op: "swap", kind: "held", key: "k", expectedRaw: raw, payload: null, sessionId: "workflow" }, { op: "drop", kind: "held", key: "d", sessionId: "workflow" }] } })
  expect(committed).toMatchObject({ kind: "stored", settlements: [{ kind: "stored" }] })
  expect(store.readLatestPayloadByAggregateAndType("session:agent", "test.fact")).toBe("{}")
  expect(store.readInFlight("workflow", "held")).toEqual([])
})

describe("project state channel", () => {
  test("round trips staged trees and manifest pages through the admitted generation without content.page", async () => {
    const { client: owner, store } = await fixture()
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const peer = { kind: "executor", projectId: "p", generation: 1 } as const
    expect(await owner.execution({ kind: "generation.admit", projectId: "p", generation: 1 })).toEqual({ kind: "ok" })
    const operations: string[] = []
    const frames: number[] = []
    const dispose = serveProjectStateChannel(owner, {
      ...ownerEndpoint,
      send(message) {
        if (message instanceof Uint8Array) frames.push(message.byteLength)
        return ownerEndpoint.send(message)
      },
    }, peer)
    const client = connectProjectStateChannel({
      ...executorEndpoint,
      send(message) {
        if (message instanceof Uint8Array) {
          frames.push(message.byteLength)
          const request = decodeProjectStateRequest(message)
          if (!request) throw new Error("invalid evidence request")
          operations.push(request.operation.kind === "execution.operation" ? request.operation.operation.kind : request.operation.kind)
        }
        return executorEndpoint.send(message)
      },
    }, peer)
    const writer = createSessionFactWriter({ sessionId: "s", writer: client.writer })
    const localWriter = createSessionFactWriter({ sessionId: "local", writer: asAsyncEventWriter(store) })
    try {
      const text = 'é🙂"\0'.repeat(20_000)
      const reference = await buildSessionContent(text, nodes => writer.stageSessionContentNodes!(nodes))
      const pieces: Buffer[] = []
      let offset: number | null = 0
      while (offset !== null) {
        const range = await client.readSessionContentRange!("s", reference, offset, 65_536)
        if (range.kind !== "available") throw new Error("missing evidence")
        pieces.push(Buffer.from(range.base64, "base64"))
        offset = range.nextOffset
      }
      expect(Buffer.concat(pieces).equals(Buffer.from(text))).toBe(true)
      const records = Array.from({ length: 600 }, (_, index) => JSON.stringify({ path: `file-${index}`, value: "x".repeat(180) }))
      const manifest = await buildSessionContentManifest(records, nodes => writer.stageSessionContentNodes!(nodes))
      const actual: string[] = []
      offset = 0
      while (offset !== null) {
        const page = await readSessionContentRecords(manifest, offset, 97, hash => client.readSessionContentNode!("s", hash))
        if (page.kind !== "available") throw new Error("missing manifest")
        actual.push(...page.records)
        if (page.nextOffset !== null) expect(page.nextOffset).toBeGreaterThan(offset)
        offset = page.nextOffset
      }
      expect(actual).toEqual(records)
      const local = await buildSessionContent("local evidence", nodes => localWriter.stageSessionContentNodes!(nodes))
      expect(await client.readSessionContentRange!("local", local, 0, 100)).toMatchObject({ kind: "available", base64: Buffer.from("local evidence").toString("base64") })
      expect(operations).toContain("content.stage")
      expect(operations).toContain("content.node")
      expect(operations).not.toContain("content.page")
      expect(frames.every(bytes => bytes <= PROJECT_STATE_MAX_BYTES)).toBe(true)
      await owner.execution({ kind: "generation.close", projectId: "p", generation: 1 })
      const refused = await client.control({ kind: "content.stage", sessionId: "s", nodes: [] })
      expect(refused).toEqual({ kind: "refused", reason: "closed-generation" })
    } finally {
      writer.dispose()
      localWriter.dispose()
      await client.close()
      await dispose()
      await closeFixtures()
    }
  })
  test("preserves large responses and owns exact-size frames after encoder growth", () => {
    const response = { id: 1, result: { kind: "latest-payload", payload: "x".repeat(PROJECT_STATE_MAX_BYTES) } } as const
    const encoded = encodeProjectStateResponse(response)
    expect(encoded.byteLength).toBeGreaterThan(PROJECT_STATE_MAX_BYTES)
    expect(decodeProjectStateResponse(encoded)).toEqual(response)
    const smallResponse = { id: 2, result: { kind: "position", position: 1 } } as const
    const request = { id: 3, lane: "control", operation: { kind: "position.capture" } } as const
    const responseBytes = encodeProjectStateResponse(smallResponse)
    const requestBytes = encodeProjectStateRequest(request)
    for (const frame of [encoded, responseBytes, requestBytes]) {
      expect(frame.buffer.byteLength).toBe(frame.byteLength)
    }
    expect(responseBytes.buffer).not.toBe(requestBytes.buffer)
    expect(decodeProjectStateResponse(responseBytes)).toEqual(smallResponse)
    expect(decodeProjectStateRequest(requestBytes)).toEqual(request)
  })

  test("round trips guarded conflicts and exact rejected errors through structured clone", () => {
    const conflict = decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({
      id: 1, result: { kind: "stored", settlements: [{ kind: "conflict", conflict: { aggregateId: "a", expectedSeq: 2, actualSeq: 3 } }] },
    })))
    expect(conflict?.result).toMatchObject({ kind: "stored", settlements: [{ kind: "conflict", conflict: { aggregateId: "a", expectedSeq: 2, actualSeq: 3 } }] })
    for (const error of [
      new PersistenceWriteRefused(129, 128, "publication"),
      new InFlightSwapConflictError("s", "tool", "k"),
      new ParentPublicationContendedError("Parent session changed during workflow publication after 3 attempts"),
      new WorkflowParentRefusal("Workflow parent chat-1 is not the host-attested chat conversation"),
    ]) {
      const response = decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({
        id: 1, result: { kind: "stored", settlements: [{ kind: "rejected", error }] },
      })))
      if (response?.result.kind !== "stored") throw new Error("missing settlement")
      const settlement = response.result.settlements[0]
      if (settlement?.kind !== "rejected") throw new Error("missing rejection")
      expect(settlement.error).toBeInstanceOf(error.constructor)
      expect(settlement.error).toMatchObject(error)
      const failed = decodeProjectStateResponse(structuredClone(encodeProjectStateResponse({ id: 1, result: { kind: "failed", error } })))
      if (failed?.result.kind !== "failed") throw new Error("missing failure")
      expect(failed.result.error).toBeInstanceOf(error.constructor)
      expect(failed.result.error).toMatchObject({ name: error.name, message: error.message })
    }
  })
  test("counts the generation wrapper before sending requests below, at, and above the limit", async () => {
    for (const offset of [-1, 0, 1]) {
      const [ownerEndpoint, executorEndpoint] = endpointPair()
      const account = stateHarness()
      const peer = { kind: "executor", projectId: "p", generation: 1 } as const
      const dispose = serveProjectStateChannel(account.state, ownerEndpoint, peer)
      let sends = 0
      const client = connectProjectStateChannel({ ...executorEndpoint, send(message) { sends++; return executorEndpoint.send(message) } }, peer)
      const makeWire = (text: string) => ({
        id: 1, lane: "execution",
        operation: { kind: "execution.operation", projectId: "p", generation: 1, operation: {
          kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "put", kind: "tool", key: "k", payloadJson: JSON.stringify({ text }) }] },
        } },
      })
      const sample = "x".repeat(100_000)
      const text = "x".repeat(PROJECT_STATE_MAX_BYTES + offset - (pack(makeWire(sample)).byteLength - sample.length))
      const bytes = pack(makeWire(text)).byteLength
      expect(bytes).toBe(PROJECT_STATE_MAX_BYTES + offset)
      const writing = client.control({ kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "put", kind: "tool", key: "k", payload: { text } }] } })
      if (offset > 0) {
        await expect(writing).rejects.toMatchObject({ name: "PersistenceWriteRefused", encodedBytes: bytes, limitBytes: PROJECT_STATE_MAX_BYTES })
        expect(sends).toBe(0)
        expect(account.calls).toEqual([])
      } else {
        await expect(writing).resolves.toMatchObject({ kind: "failed", error: new Error("state failure") })
        expect(sends).toBe(1)
        expect(account.calls).toEqual(["execution:execution.operation", "control:append"])
      }
      await client.close()
      await dispose()
    }
  })
  test("orders notifications before acknowledgements and joins without owning account state", async () => {
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const account = stateHarness()
    const dispose = serveProjectStateChannel(account.state, ownerEndpoint, { kind: "executor", projectId: "p", generation: 1 })
    const client = connectProjectStateChannel(executorEndpoint, { kind: "executor", projectId: "p", generation: 1 })
    const observed: string[] = []
    client.onStored(() => observed.push("stored"))
    const sessionChanged = Promise.withResolvers<void>()
    client.sessions.subscribe((change) => {
      observed.push(`session:${change.kind}`)
      sessionChanged.resolve()
    })

    const position = client.capturePosition().then((value) => {
      observed.push("ack")
      return value
    })
    await expect(position).resolves.toBe(1)
    expect(observed).toEqual(["stored", "ack"])

    account.emitSession({ kind: "changed", sessionIds: ["s"] })
    await sessionChanged.promise
    expect(observed).toEqual(["stored", "ack", "session:changed"])

    // This code now runs inside the client port's message dispatch. Bun's
    // `expect(promise).resolves` waits in a nested event loop, which cannot
    // deliver another message to the port whose dispatch it runs in, so the
    // reply must be awaited as a plain promise.
    expect(await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })).toMatchObject({ kind: "refused", reason: "invalid" })
    expect(account.calls).not.toContain("execution:generation.admit")
    const failure = await client.control({ kind: "append", item: { sessionId: "s", events: [] } })
    expect(failure.kind).toBe("failed")
    if (failure.kind !== "failed") throw new Error("missing typed failure")
    expect(failure.error).toEqual(new Error("state failure"))

    await client.close()
    await dispose()
    expect(account.closeCalls).toBe(0)
    expect(account.subscriptions).toBe(0)
  })

  test("a maintenance peer writes on the account's control lane, hears no broadcast, and admits no generation", async () => {
    const [ownerEndpoint, peerEndpoint] = endpointPair()
    const account = stateHarness()
    const dispose = serveProjectStateChannel(account.state, ownerEndpoint, { kind: "maintenance", projectId: "p" })
    const client = connectProjectStateChannel(peerEndpoint, { kind: "maintenance", projectId: "p" })
    const observed: string[] = []
    client.onStored(() => observed.push("stored"))

    expect(await client.capturePosition()).toBe(1)
    const write = await client.control({ kind: "maintenance.prune-retired", eventType: "file.read" })
    expect(write.kind).toBe("failed")
    expect(await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })).toMatchObject({ kind: "refused", reason: "invalid" })

    expect(account.calls).toEqual(["control:position.capture", "control:maintenance.prune-retired"])
    expect(observed).toEqual([])
    await client.close()
    await dispose()
    expect(account.subscriptions).toBe(0)
  })

  test("relays the state Worker's head, and an answer the account makes itself carries none", async () => {
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const account = stateHarness()
    const dispose = serveProjectStateChannel(account.state, ownerEndpoint, { kind: "executor", projectId: "p", generation: 1 })
    const requests = [
      { id: 1, lane: "control", operation: { kind: "position.capture" } },
      // Refused by the account: a peer cannot admit a generation.
      { id: 2, lane: "execution", operation: { kind: "generation.admit", projectId: "p", generation: 1 } },
      // Failed in the account: its state client threw.
      { id: 3, lane: "control", operation: { kind: "aggregate.count", aggregateId: "a" } },
    ] as const
    const responses: { id: number; head?: number }[] = []
    const answered = Promise.withResolvers<void>()
    executorEndpoint.onMessage((value) => {
      const response = value instanceof Uint8Array ? decodeProjectStateResponse(value) : undefined
      if (!response) return
      responses.push({ id: response.id, ...(response.head === undefined ? {} : { head: response.head }) })
      if (responses.length === requests.length) answered.resolve()
    })
    for (const request of requests) await executorEndpoint.send(encodeProjectStateRequest(request))
    await answered.promise
    expect(responses.sort((left, right) => left.id - right.id)).toEqual([{ id: 1, head: 1 }, { id: 2 }, { id: 3 }])
    await dispose()
    executorEndpoint.close()
  })

  test("relays the Worker's response unread: its body byte for byte under the executor's request id, read only by the executor", async () => {
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const workerRequests: ProjectStateRequest[] = []
    let workerAnswers: ((frame: ProjectStateResponseFrame) => boolean) | undefined
    let loseWorker: ((reason: string) => void) | undefined
    let requested = Promise.withResolvers<void>()
    const account = createProjectStateClient({
      send(request) { workerRequests.push(request); requested.resolve() },
      onResponse(listener) { workerAnswers = listener },
      onClose(listener) { loseWorker = listener },
      onSessionChange() { return () => {} },
      onStored() { return () => {} },
      close() {},
    })
    const dispose = serveProjectStateChannel(account, ownerEndpoint, { kind: "executor", projectId: "p", generation: 1 })
    const received: Uint8Array[] = []
    let arrived = Promise.withResolvers<void>()
    executorEndpoint.onMessage((value) => {
      if (!(value instanceof Uint8Array)) return
      received.push(value)
      arrived.resolve()
    })
    /** Sends the executor's request `id` and answers the Worker request it causes with `body`. */
    async function relayed(id: number, workerFrame: (workerId: number) => Uint8Array, evidence?: { readonly anchorAt: number }): Promise<Uint8Array> {
      requested = Promise.withResolvers()
      arrived = Promise.withResolvers()
      await executorEndpoint.send(encodeProjectStateRequest({ id, lane: "control", operation: { kind: "facts.page", query: { aggregateId: "a" }, maxRows: 1, maxBytes: 1024, ...(evidence ? { evidence } : {}) } }))
      await requested.promise
      // The account read nothing of the body, so it never refuses the frame.
      expect(workerAnswers?.(readProjectStateResponseFrame(workerFrame(workerRequests.at(-1)!.id))!)).toBe(true)
      await arrived.promise
      return received.at(-1)!
    }

    const result = { kind: "facts", facts: [stateHarness().storedFact], contentRows: [], upperPosition: 5, continuationPosition: null, encodedBytes: 1 } as const
    let served: ProjectStateResponseFrame | undefined
    const page = await relayed(7, (workerId) => (served = encodeProjectStateResponseFrame({ id: workerId, head: 5, result })).bytes)
    const frame = readProjectStateResponseFrame(page)
    expect(frame?.id).toBe(7)
    expect(page.subarray(frame?.bodyOffset)).toEqual(served!.bytes.subarray(served!.bodyOffset))
    expect(decodeProjectStateResponse(page)).toEqual({ id: 7, head: 5, result })

    // A page that asks for fold evidence: the account admits the request with
    // it, and the evidence in the answer's body reaches the executor.
    const proven = { ...result, foldEvidence: { head: 5, generation: 2, anchor: { position: 5, id: "evt_5" } } } as const
    const provenPage = await relayed(12, (workerId) => encodeProjectStateResponseFrame({ id: workerId, head: 5, result: proven }).bytes, { anchorAt: 5 })
    expect(workerRequests.at(-1)?.operation).toMatchObject({ kind: "facts.page", evidence: { anchorAt: 5 } })
    expect(decodeProjectStateResponse(provenPage)).toEqual({ id: 12, head: 5, result: proven })

    // The body's exact bytes arrive even where msgpackr would encode them
    // differently: a map32 header in place of the map16 header it chooses.
    const canonical = served!.bytes.subarray(served!.bodyOffset)
    expect([...canonical.subarray(0, 3)]).toEqual([0xde, 0x00, 0x02])
    const wide = new Uint8Array([0xdf, 0x00, 0x00, 0x00, 0x02, ...canonical.subarray(3)])
    const widePage = await relayed(10, (workerId) => new Uint8Array(Buffer.concat([pack(workerId), wide])))
    expect(widePage.subarray(readProjectStateResponseFrame(widePage)?.bodyOffset)).toEqual(wide)
    expect(decodeProjectStateResponse(widePage)).toEqual({ id: 10, head: 5, result })

    // Bytes that are not MessagePack at all (0xc1 is never used) still reach
    // the executor unchanged, and the executor refuses them.
    const garbage = new Uint8Array([0xc1, 0xff, 0x00])
    const garbled = await relayed(11, (workerId) => new Uint8Array(Buffer.concat([pack(workerId), garbage])))
    expect(garbled.subarray(readProjectStateResponseFrame(garbled)?.bodyOffset)).toEqual(garbage)
    expect(decodeProjectStateResponse(garbled)).toBeUndefined()

    // A body no reader accepts still reaches the executor, whose decode is the
    // boundary that refuses it; a body the account consumes itself is read there.
    const unreadable = (workerId: number) => new Uint8Array(Buffer.concat([pack(workerId), pack({ result: { kind: "unknown" } })]))
    const invalid = await relayed(8, unreadable)
    expect(readProjectStateResponseFrame(invalid)?.id).toBe(8)
    expect(decodeProjectStateResponse(invalid)).toBeUndefined()
    const own = account.countByAggregate("a")
    expect(workerAnswers?.(readProjectStateResponseFrame(unreadable(workerRequests.at(-1)!.id))!)).toBe(false)

    // A Worker that goes away fails the relayed request in its own words.
    arrived = Promise.withResolvers()
    requested = Promise.withResolvers()
    await executorEndpoint.send(encodeProjectStateRequest({ id: 9, lane: "control", operation: { kind: "position.capture" } }))
    await requested.promise
    loseWorker?.("worker closed")
    await expect(own).rejects.toMatchObject({ name: "ProjectStateUnavailableError" })
    await arrived.promise
    expect(decodeProjectStateResponse(received.at(-1))).toMatchObject({ id: 9, result: { kind: "failed", error: { message: "project state is unavailable: worker closed" } } })
    await dispose()
    executorEndpoint.close()
  })

  test("invalid request closes the channel without invoking account state", async () => {
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const account = stateHarness()
    const dispose = serveProjectStateChannel(account.state, ownerEndpoint, { kind: "executor", projectId: "p", generation: 1 })

    await executorEndpoint.send({ id: 1, lane: "execution", operation: { kind: "position.capture" } })
    await ownerEndpoint.closed

    expect(account.calls).toEqual([])
    await dispose()
    executorEndpoint.close()
  })

  test("a broadcast reaches its listeners without meeting the response decoder", () => {
    let deliver: ((message: unknown) => void | Promise<void>) | undefined
    const endpoint: InternalProcessEndpoint<unknown, unknown> = {
      closed: Promise.resolve(),
      send: async () => {},
      onMessage(handler) { deliver = handler; return () => {} },
      onClose() { return () => {} },
      close() {},
    }
    const client = connectProjectStateChannel(endpoint, { kind: "executor", projectId: "p", generation: 1 })
    const delivered: (readonly StoredFact[])[] = []
    client.onStored((events) => delivered.push(events))
    const fact = stateHarness().storedFact
    // A strict struct decode lists the input's own keys once to find excess
    // keys, so the count of key listings is the count of decoders it met.
    let traversals = 0
    const broadcast = new Proxy({ flywheel: "state.stored", events: [fact] }, {
      ownKeys(target) { traversals += 1; return Reflect.ownKeys(target) },
    })
    void deliver?.(broadcast)
    expect(delivered).toEqual([[fact]])
    expect(traversals).toBe(1)
  })

  test("an append acknowledgement carries only what the store assigned, and the client completes the facts the store holds", async () => {
    const { client: owner, store } = await fixture()
    const [ownerEndpoint, executorEndpoint] = endpointPair()
    const peer = { kind: "executor", projectId: "p", generation: 1 } as const
    expect(await owner.execution({ kind: "generation.admit", projectId: "p", generation: 1 })).toEqual({ kind: "ok" })
    const responses: Uint8Array[] = []
    const dispose = serveProjectStateChannel(owner, {
      ...ownerEndpoint,
      send(message) {
        if (message instanceof Uint8Array) responses.push(message)
        return ownerEndpoint.send(message)
      },
    }, peer)
    const client = connectProjectStateChannel(executorEndpoint, peer)
    try {
      const marker = "payload-the-appender-already-holds"
      const event = { aggregateId: "session:s", type: "test.fact", sessionId: "s", version: 1, timestamp: 1, actor: "test", payload: { text: marker } }
      // A workflow definition record keeps optional output fields as keys set to `undefined`.
      const definitionRecord = { text: marker, output: { summary: "s", commands: undefined } }
      const stored = await client.writer.appendBatch([event, { ...event, timestamp: 2, runId: "run", payload: definitionRecord }])
      expect(responses.length).toBeGreaterThan(0)
      expect(responses.some((bytes) => Buffer.from(bytes).includes(marker))).toBe(false)
      expect(stored).toStrictEqual(store.read({ aggregateId: "session:s" }))
    } finally {
      await client.close()
      await dispose()
    }
  })
})

test("a request in flight when the transport detaches fails with an unknown outcome instead of waiting forever", async () => {
  const channel = new MessageChannel()
  const live = createMessagePortProcessEndpoint<unknown, unknown>({ port: channel.port1, decode: (value) => value })
  const peer = createMessagePortProcessEndpoint<unknown, unknown>({ port: channel.port2, decode: (value) => value })
  const facade = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
  facade.attach(live)
  const client = connectProjectStateChannel(facade, { kind: "maintenance", projectId: "p" })
  // The peer never answers: the account died mid-request or the bytes were lost.
  const pending = client.control({ kind: "position.capture" })
  await Bun.sleep(5)
  peer.close("socket reset")
  await live.closed
  const result = await pending
  expect(result.kind).toBe("failed")
  if (result.kind === "failed") expect(result.error.message).toContain("outcome is unknown")
  facade.close("test over")
})

test("a notification in flight when the executor's transport goes away is not the channel's failure", async () => {
  // A transport whose sends settle only when the test says so, as a socket
  // does: the message is handed over, then the peer is found gone.
  const inFlight: PromiseWithResolvers<void>[] = []
  const closeHandlers = new Set<(error: Error) => void>()
  const transport: InternalProcessEndpoint<unknown, unknown> = {
    closed: new Promise<void>(() => {}),
    send: () => { const settlement = Promise.withResolvers<void>(); inFlight.push(settlement); return settlement.promise },
    onMessage: () => () => {},
    onClose: (handler) => { closeHandlers.add(handler); return () => { closeHandlers.delete(handler) } },
    close: () => {},
  }
  const facade = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 10_000 })
  facade.attach(transport)
  const harness = stateHarness()
  const logger = Log.create({ service: "project-state-channel" })
  const errors: unknown[] = []
  const originalError = logger.error
  logger.error = (message) => { errors.push(message) }
  const close = serveProjectStateChannel(harness.state, facade, { kind: "executor", projectId: "p", generation: 1 })
  try {
    harness.emitSession({ kind: "changed", sessionIds: ["s"] })
    expect(inFlight).toHaveLength(1)
    // The executor stopped: its socket closes with the notification in flight.
    const lost = new Error("internal process endpoint peer closed")
    for (const handler of closeHandlers) handler(lost)
    expect(facade.attached).toBe(false)
    inFlight[0]?.reject(lost)
    await Bun.sleep(5)
    expect(errors).toEqual([])
  } finally {
    logger.error = originalError
    facade.close("test over")
    await close()
  }
})
