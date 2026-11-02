import { afterEach, describe, expect, spyOn, test } from "bun:test"
import type { HeapSnapshot } from "bun"
import { heapStats } from "bun:jsc"
import { Schema } from "effect"
import { closeFixtures, fixture } from "./_project-state-worker-fixture.js"
import { createProjectStateClient, ProjectStateUnavailableError, type ProjectStateClient } from "../../../../src/orchestration/app-service/project-state-client.js"
import { encodeProjectStateResponseFrame, type ProjectStateRequest, type ProjectStateResponseFrame, type ProjectStateResult } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { createWorkflowToolSummaryReader } from "../../../../src/orchestration/modules/workflows/history/tool-summary.js"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store.js"
import { WorkflowSessionFactSchema } from "../../../../src/workflows/vm/session-facts.js"
import { terminalWorkflowFacts } from "../session/_child-session-reconciliation-fixtures.js"
import { createProjectStateCommitWindow } from "../../../../src/orchestration/app-service/project-state-commit-window.js"
import { createEventProjection } from "../../../../src/infra/event-projection.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type EventStoreAppend, type FactQuery, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { storedToolContentReferences } from "../../../../src/infra/tool-content-hydration.js"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage.js"

afterEach(closeFixtures)

function fact(payload: { [key: string]: unknown } = {}): EventStoreAppend {
  return { aggregateId: "session:s", type: "test.fact", version: 1, timestamp: 1, actor: "test", sessionId: "s", payload }
}

describe("commit window", () => {
  function appendOf(aggregateId: string, type = "test.fact", payload: { [key: string]: unknown } = {}): EventStoreAppend {
    return { aggregateId, type, sessionId: aggregateId.split(":").at(-1)!, version: 1, timestamp: 1, actor: "test", payload }
  }

  /** A client with its window, anchored as the executor's startup capture
   *  anchors it, after `history` facts it never heard. */
  async function windowed(history: readonly EventStoreAppend[] = []) {
    const state = await fixture(undefined, undefined, false, [], { commitWindow: true })
    if (history.length > 0) state.store.appendBatch(history)
    await state.client.capturePosition()
    const enqueue = spyOn(state.service, "enqueue")
    /** The state requests made since the last call to either. */
    const operations = () => {
      const sent = enqueue.mock.calls.map(([, operation]) => operation)
      enqueue.mockClear()
      return sent
    }
    return { ...state, operations, requests: () => operations().map((operation) => operation.kind) }
  }

  /** The aggregates of the sequence reads among `operations`. */
  function sequenceReads(operations: ReturnType<Awaited<ReturnType<typeof windowed>>["operations"]>) {
    return operations.flatMap((operation) => operation.kind === "aggregate.sequence" ? [operation.aggregateId] : [])
  }

  /** Every page of `query` in (after, ceiling]. */
  async function readAll(surface: AsyncEventStateReadSurface, query: FactQuery, ceiling: number, after: number) {
    const facts: unknown[] = []
    for (let cursor: number | null = after; cursor !== null;) {
      const page: Awaited<ReturnType<AsyncEventStateReadSurface["readPage"]>> = await surface.readPage(query, ceiling, cursor)
      facts.push(...page.facts)
      cursor = page.continuationPosition
    }
    return facts
  }

  /** The positions of one aggregate's facts, as a held reader folds them. */
  interface Folded { readonly positions: readonly number[] }

  function counter(client: ProjectStateClient, aggregateId: string) {
    return createEventProjection<Folded>(client, {
      aggregateId, factTypes: ["test.fact"],
      initialState: () => ({ positions: [] }),
      reduce: (state, event) => ({ positions: [...state.positions, event.position] }),
    })
  }

  test("a commit costs every held reader one shared capture and no page, whatever the member count or history", async () => {
    for (const [members, history] of [[3, 0], [30, 0], [3, 2_000]] as const) {
      const { client, requests } = await windowed(Array.from({ length: history }, (_, index) => appendOf(`session:m${index % members}`)))
      const projections = Array.from({ length: members }, (_, index) => counter(client, `session:m${index}`))
      await Promise.all(projections.map((projection) => projection.replay()))
      requests()
      const stored = await client.writer.append(appendOf("session:m0"))
      requests()
      await Promise.all(projections.map((projection) => projection.replay()))
      expect(requests()).toEqual(["position.capture"])
      expect(projections[0]!.getState().positions.at(-1)).toBe(stored.position)
      const tail = await client.readSlice({ aggregateId: "session:m0", order: "desc", limit: 1 })
      expect(tail.facts).toEqual([stored])
      expect(requests()).toEqual(["position.capture"])
      await closeFixtures()
    }
  })

  test("local pages and tail slices equal the store's answer", async () => {
    const { client, store, requests } = await windowed([appendOf("session:old")])
    const floor = store.currentPosition()
    let seed = 7
    const random = (bound: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % bound
    }
    const aggregates = ["session:a", "session:b", "workflow:a", "conversation:x", "plain"]
    const types = ["t.one", "t.two", "t.three"]
    for (let batch = 0; batch < 40; batch += 1) {
      await client.writer.appendBatch(Array.from({ length: 1 + random(4) }, () => appendOf(
        aggregates[random(aggregates.length)]!, types[random(types.length)], { value: random(100), absent: undefined, list: [undefined, 1] },
      )))
    }
    const sql = asAsyncEventReadSurface(store)
    const ceiling = store.currentPosition()
    requests()
    let compared = 0
    for (let read = 0; read < 300; read += 1) {
      const pick = <T>(values: readonly T[]) => random(2) === 0 ? undefined : [...new Set(Array.from({ length: 1 + random(2) }, () => values[random(values.length)]!))]
      const aggregateIds = random(3) === 0 ? pick(aggregates) : undefined
      const query: FactQuery = {
        ...(aggregateIds ? { aggregateIds } : random(3) === 0 ? { aggregateId: aggregates[random(aggregates.length)] } : random(3) === 0 ? { aggregatePrefix: ["session:", "workflow:", "conversation:"][random(3)] } : {}),
        ...(random(4) === 0 ? { sessionId: ["a", "b", "x"][random(3)] } : {}),
        ...(pick(types) ? { types: pick(types) } : {}),
        ...(random(4) === 0 ? { afterPosition: floor + random(ceiling - floor) } : {}),
        ...(random(4) === 0 ? { beforePosition: floor + random(ceiling - floor + 2) } : {}),
        ...(random(3) === 0 ? { limit: 1 + random(5) } : {}),
      }
      const after = floor + random(ceiling - floor + 1)
      const page = await readAll(client, query, ceiling, after)
      expect(page).toStrictEqual(await readAll(sql, query, ceiling, after))
      const tail = { ...query, afterPosition: query.afterPosition ?? floor, order: "desc" as const, limit: 1 + random(5) }
      const slice = (await client.readSlice(tail)).facts
      expect(slice).toStrictEqual((await sql.readSlice(tail)).facts)
      compared += page.length + slice.length
    }
    expect(compared).toBeGreaterThan(300)
    expect(requests().filter((kind) => kind !== "position.capture")).toEqual([])
  })

  test("history past the byte budget and a fact past the size cap are read from the store", async () => {
    const { client, store, requests } = await windowed()
    const floor = store.currentPosition()
    const text = "x".repeat(100_000)
    for (let index = 0; index < 90; index += 1) await client.writer.append(appendOf(`session:s${index % 3}`, "test.fact", { text, index }))
    const large = await client.writer.append(appendOf("session:s0", "test.fact", { text: "y".repeat(600_000) }))
    const tail = await client.writer.append(appendOf("session:s1"))
    const sql = asAsyncEventReadSurface(store)
    const ceiling = store.currentPosition()
    requests()
    expect((await client.readPage({ aggregateId: "session:s1" }, ceiling, large.position)).facts).toEqual([tail])
    expect(requests()).toEqual([])
    for (const [query, after] of [[{ aggregateId: "session:s0" }, large.position - 1], [{ types: ["test.fact"] }, floor]] as const) {
      expect(await readAll(client, query, ceiling, after)).toStrictEqual(await readAll(sql, query, ceiling, after))
      expect([...new Set(requests())]).toEqual(["facts.page"])
    }
  })

  test("a commit that no broadcast announced re-anchors the window, and the next read finds it", async () => {
    const { client, path, requests } = await windowed()
    const projection = counter(client, "session:s")
    await client.writer.append(appendOf("session:s"))
    await projection.replay()
    const foreign = createSqliteEventStore(path)
    try {
      const unannounced = foreign.append(appendOf("session:s"))
      requests()
      await projection.replay()
      expect(projection.getState().positions.at(-1)).toBe(unannounced.position)
      expect(requests()).toEqual(["position.capture", "facts.page"])
      const announced = await client.writer.append(appendOf("session:s"))
      requests()
      await projection.replay()
      expect(projection.getState().positions.at(-1)).toBe(announced.position)
      expect(requests()).toEqual(["position.capture"])
      // The head of any response shows an unannounced commit too.
      const shown = foreign.append(appendOf("session:s"))
      await client.countByAggregate("session:other")
      requests()
      await projection.replay()
      expect(projection.getState().positions.at(-1)).toBe(shown.position)
      // The window re-anchored above the projection, so its read pays for no barrier.
      expect(requests()).toEqual(["facts.page"])
    } finally {
      foreign.close()
    }
  })

  test("a lost broadcast or a detached transport never hides a fact from a read", async () => {
    const { client, requests, dropNextStored, detach } = await windowed()
    const projection = counter(client, "session:s")
    await projection.replay()
    const expected: number[] = []
    // A lost broadcast at the top of history: the capture shows it.
    dropNextStored()
    expected.push((await client.writer.append(appendOf("session:s"))).position)
    await projection.replay()
    expect(projection.getState().positions).toEqual(expected)
    // A lost broadcast below a later one: the later one shows the gap.
    dropNextStored()
    expected.push((await client.writer.append(appendOf("session:s"))).position)
    expected.push((await client.writer.append(appendOf("session:s"))).position)
    requests()
    await projection.replay()
    expect(projection.getState().positions).toEqual(expected)
    expect(requests()).toEqual(["facts.page"])
    // A detached transport can lose any broadcast until a read anchors again.
    detach()
    expected.push((await client.writer.append(appendOf("session:s"))).position)
    requests()
    await projection.replay()
    expect(projection.getState().positions).toEqual(expected)
    expect(requests()).toEqual(["facts.page"])
  })

  test("a fact whose broadcast is a degraded substitute is read from the store", async () => {
    const { client, store, requests, failContentStaging } = await windowed()
    const after = store.currentPosition()
    failContentStaging(new Error("disk full"))
    store.append({ ...appendOf("session:s", "tool.result.recorded", {
      toolUseId: "old", outcome: "ok",
      details: { mutation: { version: 1, files: [{ path: "a", change: "modified", unifiedDiff: "-old\n+new\n" }], omissions: [] } },
    }), actor: "flywheel" })
    requests()
    // The read starts before the substitute arrives, so it pays for a capture.
    await expect(client.readPage({ aggregateId: "session:s" }, undefined, after)).rejects.toThrow("disk full")
    expect(requests()).toEqual(["position.capture", "facts.page"])
  })

  test("a read hydrates the tool content of the executor's own well-formed append locally and other content from the store", async () => {
    const { client, store, requests } = await windowed()
    const toolResult = (conversationId: string, text: string) => ConversationTreeStorage.prepareAppend({
      conversationId, sessionId: "s", committed: {}, expectedSeq: 0,
      entries: [{ kind: "message", id: "r", parentId: null, timestamp: "2026-10-25T00:00:00.000Z", message: { kind: "toolResult", toolUseId: "t", content: [{ type: "text", text }] } }],
    })[0]!
    const own = await client.writer.append(toolResult("own", "own ".repeat(1_000)))
    // MCP JSON can escape an unpaired surrogate; the request codec stores a replacement character.
    const unpaired = await client.writer.append(toolResult("unpaired", `${"own ".repeat(1_000)}${JSON.parse('"\\ud800"')}tail`))
    const foreign = store.append(toolResult("foreign", "foreign ".repeat(1_000)))
    const sql = asAsyncEventReadSurface(store)
    requests()
    const kinds: string[][] = []
    for (const appended of [own, unpaired, foreign]) {
      const tail = { aggregateId: appended.aggregateId, order: "desc" as const, limit: 1 }
      const local = await client.readSlice(tail)
      kinds.push(requests())
      const [reference] = storedToolContentReferences(appended)
      expect(local.toolContent.resolve("s", reference!.sha256)).toBe((await sql.readSlice(tail)).toolContent.resolve("s", reference!.sha256)!)
    }
    expect(kinds).toEqual([["position.capture"], ["position.capture", "content.page"], ["position.capture", "content.page"]])
  })

  test("a page that asks for fold evidence is read from the store, which proves it in the same request", async () => {
    const { client, store, requests } = await windowed()
    const floor = store.currentPosition()
    await client.writer.append(appendOf("session:s"))
    const ceiling = store.currentPosition()
    requests()
    const page = await client.readPage({ aggregateId: "session:s" }, ceiling, floor, false, "deferred", { anchorAt: ceiling })
    expect(page.facts.map((stored) => stored.position)).toEqual([ceiling])
    expect(page.foldEvidence).toEqual(store.foldEvidence({ aggregateId: "session:s" }, ceiling))
    expect(page.foldEvidence?.anchor?.position).toBe(ceiling)
    expect(requests()).toEqual(["facts.page"])
  })

  test("a cold read below the window costs one request", async () => {
    const { client, requests } = await windowed([appendOf("session:s"), appendOf("session:s")])
    const page = await client.readPage({ aggregateId: "session:s" }, undefined, 0)
    expect(page.facts).toHaveLength(2)
    expect(requests()).toEqual(["facts.page"])
    const tail = await client.readSlice({ aggregateId: "session:s", order: "desc", limit: 1 })
    expect(tail.facts.map((stored) => stored.position)).toEqual([page.facts[1]!.position])
    expect(requests()).toEqual(["facts.slice"])
  })

  test("a read after a prune of superseded facts equals the store's answer", async () => {
    const { client, store, requests } = await windowed()
    const floor = store.currentPosition()
    for (let index = 0; index < 2; index += 1) await client.writer.append(appendOf("session:s", "queue.state.changed", { index }))
    expect(await client.writer.pruneSupersededEvents("session:s", "queue.state.changed")).toBe(1)
    const sql = asAsyncEventReadSurface(store)
    const ceiling = store.currentPosition()
    const query = { aggregateId: "session:s", types: ["queue.state.changed"] }
    requests()
    expect(await readAll(client, query, ceiling, floor)).toStrictEqual(await readAll(sql, query, ceiling, floor))
    const tail = { ...query, order: "desc" as const, limit: 2 }
    expect((await client.readSlice(tail)).facts).toStrictEqual((await sql.readSlice(tail)).facts)
    expect(requests()).toEqual(["facts.page", "facts.slice"])
  })

  test("a closed transport ends every local read, and no capture that settles later anchors the window again", async () => {
    const { client, store, closeTransport } = await windowed()
    const floor = store.currentPosition()
    await client.writer.append(appendOf("session:s"))
    const ceiling = store.currentPosition()
    closeTransport("worker exited")
    expect(client.available).toBe(false)
    await expect(client.readPage({ aggregateId: "session:s" }, ceiling, floor)).rejects.toBeInstanceOf(ProjectStateUnavailableError)
    await expect(client.readSlice({ aggregateId: "session:s", order: "desc", limit: 1 })).rejects.toBeInstanceOf(ProjectStateUnavailableError)

    // A close drains the reads already sent; the ceiling one of them
    // captured must not anchor the closed window.
    const closing = await windowed([appendOf("session:cold")])
    const remote = closing.client.readPage({ aggregateId: "session:cold" }, undefined, 0)
    const closed = closing.client.close()
    const { upperPosition } = await remote
    await closed
    await expect(closing.client.readPage({ aggregateId: "session:cold" }, upperPosition, upperPosition)).rejects.toBeInstanceOf(ProjectStateUnavailableError)
  })

  test("a conversation's sequence comes from the window, and a session's, a workflow's, or one below the floor from the store", async () => {
    const { client, store, operations } = await windowed([appendOf("conversation:cold"), appendOf("conversation:old")])
    for (const aggregateId of ["conversation:x", "conversation:x", "conversation:old", "session:s", "workflow:w"]) await client.writer.append(appendOf(aggregateId))
    operations()
    const aggregates = ["conversation:x", "conversation:old", "conversation:cold", "conversation:none", "session:s", "workflow:w"]
    for (const aggregateId of aggregates) expect(await client.aggregateSeq(aggregateId)).toBe(store.aggregateSeq(aggregateId))
    expect(sequenceReads(operations())).toEqual(["conversation:cold", "conversation:none", "session:s", "workflow:w"])
  })

  test("a tool-summary replay reads no conversation sequence from the store, whatever the child count", async () => {
    for (const children of [2, 8]) {
      const { client, store, manager, operations } = await windowed()
      const parent = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
      const local = asAsyncEventReadSurface(store)
      const trees = []
      for (let index = 0; index < children; index += 1) {
        const workflowId = `workflow-${index}`
        await manager.publishWorkflow({
          id: workflowId, description: "Review", workflowDefinitionId: "workflow", initialRoles: {},
          launchedFrom: { parentSessionId: parent, conversationId: "parent-conversation", workflowDefinitionId: "workflow", toolUseId: `tool-${index}`, description: "Review" },
          facts: terminalWorkflowFacts("Review", "paused").map((terminal) => Schema.decodeUnknownSync(WorkflowSessionFactSchema)(terminal)),
        })
        store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, type: "queue.state.changed", version: 1, timestamp: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } })
        const stepId = (await loadQueueSnapshotFromReader(local, workflowId))?.attempts[0]?.id
        if (stepId === undefined) throw new Error("expected a current step")
        store.append({ aggregateId: `workflow:${workflowId}`, sessionId: workflowId, type: "step.resume_state.recorded", version: 1, timestamp: 1, actor: "flywheel", payload: { stepId, conversationId: `step-${index}` } })
        const tree = await createConversationTree({ conversationId: `step-${index}`, sessionId: workflowId, store: local, writer: asAsyncEventWriter(store) })
        await tree.appendMessage({ kind: "user", content: "Review the change.", origin: "human" })
        trees.push(tree)
      }
      const summaries = createWorkflowToolSummaryReader(client, parent)
      operations()
      const first = await summaries.replay()
      expect([...first.summaries.values()].map((summary) => summary.status)).toEqual(Array.from({ length: children }, () => "active"))
      // A step's conversation moves, and the next replay reads it again.
      await trees[0]!.appendMessage({ kind: "user", content: "Again.", origin: "human" })
      await summaries.replay()
      const reads = sequenceReads(operations())
      expect(reads.filter((aggregateId) => aggregateId.startsWith("conversation:"))).toEqual([])
      expect(reads.length).toBeGreaterThan(0)
      for (const tree of trees) tree.getStorage().dispose()
      await closeFixtures()
    }
  })
})

describe("commit window barrier", () => {
  /** A windowed client whose requests the test answers by hand. */
  function manual() {
    const sent: ProjectStateRequest[] = []
    let respond: ((frame: ProjectStateResponseFrame) => boolean) | undefined
    const client = createProjectStateClient({
      send(request) { sent.push(request) },
      onResponse(listener) { respond = listener },
      onClose() {},
      onSessionChange() { return () => {} },
      onStored() { return () => {} },
      close() {},
    }, { commitWindow: true })
    return {
      client,
      /** Answers the newest sent request of `kind`. */
      answer(kind: string, result: ProjectStateResult, head?: number) {
        const request = sent.findLast((candidate) => candidate.operation.kind === kind)
        if (!request) throw new Error(`no ${kind} request`)
        respond?.(encodeProjectStateResponseFrame({ id: request.id, result, ...(head === undefined ? {} : { head }) }))
      },
      captures: () => sent.filter((request) => request.operation.kind === "position.capture").length,
    }
  }

  /** Readers that record the position each barrier resolved to. */
  function readers(client: ProjectStateClient, count: number) {
    const resolved: number[] = []
    const all = Promise.all(Array.from({ length: count }, () => client.capturePosition().then((position) => { resolved.push(position) })))
    return { resolved, all }
  }

  const nextTask = () => new Promise<void>((resolve) => { setImmediate(resolve) })
  const count = (value: number): ProjectStateResult => ({ kind: "count", count: value })

  test("idle readers share one capture at the next task, which answers them without a head", async () => {
    const { client, answer, captures } = manual()
    const timers = spyOn(globalThis, "setTimeout")
    try {
      const { resolved, all } = readers(client, 5)
      await nextTask()
      expect(captures()).toBe(1)
      expect(timers).toHaveBeenCalledTimes(0)
      answer("position.capture", { kind: "position", position: 4 })
      await all
      expect(resolved).toEqual([4, 4, 4, 4, 4])
    } finally {
      timers.mockRestore()
    }
  })

  test("readers that a control request sent after their calls answers cost no capture", async () => {
    const { client, answer, captures } = manual()
    const { resolved, all } = readers(client, 5)
    void client.control({ kind: "aggregate.count", aggregateId: "session:s" })
    await Bun.sleep(5)
    expect(captures()).toBe(0)
    answer("aggregate.count", count(1), 3)
    await all
    expect(resolved).toEqual([3, 3, 3, 3, 3])
  })

  test("a burst while busy costs one capture after the deferral, and no answer to a request sent before the call serves it", async () => {
    const { client, answer, captures } = manual()
    void client.control({ kind: "aggregate.count", aggregateId: "session:s" })
    const { resolved, all } = readers(client, 5)
    await nextTask()
    expect(captures()).toBe(0)
    answer("aggregate.count", count(1), 2)
    await Bun.sleep(5)
    expect(resolved).toEqual([])
    expect(captures()).toBe(1)
    answer("position.capture", { kind: "position", position: 3 }, 3)
    await all
    expect(resolved).toEqual([3, 3, 3, 3, 3])
  })

  test("a covering answer without a head leaves the readers waiting, and the capture follows", async () => {
    const { client, answer, captures } = manual()
    const { resolved, all } = readers(client, 2)
    void client.control({ kind: "aggregate.count", aggregateId: "session:s" })
    await Bun.sleep(5)
    expect(captures()).toBe(0)
    // An answer the account made itself, such as a refusal for pressure.
    answer("aggregate.count", { kind: "refused", reason: "pressure" })
    await nextTask()
    expect(resolved).toEqual([])
    expect(captures()).toBe(1)
    answer("position.capture", { kind: "position", position: 1 }, 1)
    await all
    expect(resolved).toEqual([1, 1])
  })

  test("an execution request does not hold back the capture, but its head serves readers when it answers first", async () => {
    const { client, answer, captures } = manual()
    const { resolved, all } = readers(client, 2)
    void client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    await nextTask()
    expect(captures()).toBe(1)
    answer("generation.admit", { kind: "ok" }, 6)
    await all
    expect(resolved).toEqual([6, 6])
  })
})

describe("commit window memory", () => {
  function storedOf(position: number, aggregateId: string, payload: { [key: string]: unknown }): StoredFact {
    return { position, id: String(position), aggregateId, seq: position, type: "test.fact", version: 1, timestamp: 1, actor: "test", sessionId: "s", payload }
  }

  /** A weak reference to the newest fact of `aggregateId` that a reader got
   *  from `window`. The read's result gives the fact up, so a stale copy of
   *  the result on the stack cannot refer to it. */
  function newestRead(window: ReturnType<typeof createProjectStateCommitWindow>, aggregateId: string, position: number): WeakRef<StoredFact> {
    return new WeakRef(window.slice({ aggregateId, order: "desc", limit: 1 }, position)!.pop()!)
  }

  /** Weak references to the facts a reader got from the window, which the
   *  window then evicts behind a newer fact of the same key. Each payload
   *  holds an `evictedRead` key, which names it in a heap snapshot. */
  function evictedReads(window: ReturnType<typeof createProjectStateCommitWindow>): WeakRef<StoredFact>[] {
    window.observe(0)
    const text = "x".repeat(100_000)
    const refs: WeakRef<StoredFact>[] = []
    let position = 0
    for (let index = 0; index < 40; index += 1) {
      window.receive([storedOf(++position, `session:k${index % 4}`, { evictedRead: { index } })])
      refs.push(newestRead(window, `session:k${index % 4}`, position))
    }
    for (let index = 0; index < 90; index += 1) window.receive([storedOf(++position, `session:k${index % 4}`, { text })])
    // The oldest facts left the held suffix, so an oldest-first read goes remote.
    expect(window.slice({ aggregateId: "session:k0", order: "asc", limit: 1 }, position)).toBeUndefined()
    return refs
  }

  /** For each fact with an `evictedRead` payload that a WeakRef refers to,
   *  the sorted class names of the heap objects that refer to the fact or to
   *  its payload, other than the fact itself. A fact that only the stack
   *  keeps alive, such as an input to `receive`, has no WeakRef referrer and
   *  is not listed. */
  function evictedReadReferrers({ nodes, nodeClassNames, edges, edgeTypes, edgeNames }: HeapSnapshot): string[][] {
    const classOf = new Map<number, string>()
    // A node is [id, size, class name index, flags].
    for (let node = 0; node < nodes.length; node += 4) classOf.set(nodes[node]!, nodeClassNames[nodes[node + 2]!]!)
    // An edge is [from, to, type index, data], and the data of a property edge is its name index.
    const property = (edge: number, name: string) => edgeTypes[edges[edge + 2]!] === "Property" && edgeNames[edges[edge + 3]!] === name
    const marked = new Set<number>()
    for (let edge = 0; edge < edges.length; edge += 4) if (property(edge, "evictedRead")) marked.add(edges[edge]!)
    /** The read of each marked payload. */
    const readOf = new Map<number, number>()
    for (let edge = 0; edge < edges.length; edge += 4) if (property(edge, "payload") && marked.has(edges[edge + 1]!)) readOf.set(edges[edge + 1]!, edges[edge]!)
    const referrers = new Map<number, string[]>(Array.from(readOf.values(), (read) => [read, []]))
    for (let edge = 0; edge < edges.length; edge += 4) {
      const [from, to] = [edges[edge]!, edges[edge + 1]!]
      const read = referrers.has(to) ? to : readOf.get(to)
      if (read !== undefined && from !== read) referrers.get(read)!.push(classOf.get(from)!)
    }
    return [...referrers.values()].map((classes) => classes.sort()).filter((classes) => classes.includes("WeakRef"))
  }

  test("an evicted fact releases its payload", async () => {
    const window = createProjectStateCommitWindow()
    const refs = evictedReads(window)
    // A WeakRef keeps its fact until the job that made it ends.
    await Bun.sleep(0)
    Bun.gc(true)
    const alive = refs.filter((ref) => ref.deref() !== undefined)
    // JSC scans the stack conservatively, so a stale stack slot can keep a fact
    // alive that no heap object refers to, and liveness alone cannot show what
    // keeps it. A heap snapshot records each reference that a heap object
    // holds, and none for a stack slot. The deref above makes each WeakRef keep
    // its live fact through this job, so the snapshot holds every live read.
    expect(alive.length === 0 ? [] : evictedReadReferrers(Bun.generateHeapSnapshot())).toEqual(alive.map(() => ["WeakRef"]))
    window.close()
  })

  /** The heap the window retains after it heard `count` facts and served
   *  newest-first reads of every session, in MiB. */
  function retainedMiB(count: number, sessions: number, payload: (position: number) => { [key: string]: unknown }, content?: (position: number) => string): number {
    Bun.gc(true)
    const before = heapStats().heapSize
    const window = createProjectStateCommitWindow()
    window.observe(0)
    for (let position = 1; position <= count; position += 1) {
      const session = `s${position % sessions}-${"x".repeat(16)}`
      window.receive([{ ...storedOf(position, `conversation:${session}`, payload(position)), id: `id-${position}-${"x".repeat(16)}`, type: `t${position % 20}`, sessionId: session }])
      const text = content?.(position)
      if (text !== undefined) window.holdContent(position, [{ sha256: position.toString(16).padStart(64, "0"), content: text, bytes: text.length }])
    }
    let read = 0
    for (let index = 0; index < sessions; index += 1) read += window.slice({ sessionId: `s${index}-${"x".repeat(16)}`, order: "desc", limit: 5 }, count)?.length ?? 0
    expect(read).toBe(sessions * 5)
    Bun.gc(true)
    const retained = (heapStats().heapSize - before) / 1024 / 1024
    window.close()
    return retained
  }

  // The budget is 8 MiB of retained heap; the margin absorbs heap noise.
  test("many small facts retain at most the byte budget", () => {
    expect(retainedMiB(30_000, 160, (position) => ({ kind: "k", text: `${"x".repeat(100)}${position}` }))).toBeLessThan(10)
  })

  test("large structured facts retain at most the byte budget after reads", () => {
    const values = Array.from({ length: 200_000 }, (_, index) => index % 10)
    expect(retainedMiB(40, 1, () => ({ input: { values } }))).toBeLessThan(10)
  })

  test("facts of two-byte text retain at most the byte budget", () => {
    expect(retainedMiB(400, 4, (position) => ({ text: `${"日本".repeat(20_000)}${position}` }))).toBeLessThan(10)
  })

  test("facts with held tool content retain at most the byte budget", () => {
    expect(retainedMiB(4_000, 160, (position) => ({ kind: "k", position }), (position) => `${"c".repeat(4_000)}${position}`)).toBeLessThan(10)
  })
})

describe("commit notification order", () => {
  test("answers a request only after the commit notifications of the commits before it", async () => {
    const { store, client, storedNotifications, holdContentStaging } = await fixture()
    const staging = Promise.withResolvers<void>()
    holdContentStaging(staging.promise)
    // Its notification stages historical evidence, so it waits on the gate.
    const committed = store.append({ ...fact({
      toolUseId: "old", outcome: "ok",
      details: { mutation: { version: 1, files: [{ path: "a", change: "modified", unifiedDiff: "-old\n+new\n" }], omissions: [] } },
    }), type: "tool.result.recorded", actor: "flywheel" })
    const notifiedAtResponse = client.capturePosition().then((position) => ({
      position, notified: storedNotifications.flat().some((event) => event.position === committed.position),
    }))
    await Bun.sleep(1)
    staging.resolve()
    expect(await notifiedAtResponse).toEqual({ position: committed.position, notified: true })
  })

  test("a failed commit notification fails no response", async () => {
    const { client, failNextStored } = await fixture()
    failNextStored()
    const stored = await client.writer.append(fact())
    expect(await client.capturePosition()).toBe(stored.position)
  })
})
