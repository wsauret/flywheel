import { describe, expect, test, afterEach, spyOn } from "bun:test"
import { cleanup, closeFixtures, enqueue, fixture, served } from "./_project-state-worker-fixture.js"
import { Database } from "bun:sqlite"
import { pack } from "msgpackr"
import { encodeProjectStateRequest, encodeProjectStateResponse, PROJECT_STATE_MAX_BYTES, type ProjectStateContentReference, type ProjectStateControlOperation } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, InFlightSwapConflictError, type EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { createConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { extractContent } from "../../../../src/infra/tool-content.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { durableCatalogRowFromSession, projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import { chatEntry, fakeSessionStore } from "./_frontend-projection-fixtures.js"
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock.js"
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildSessionContent } from "../../../../src/infra/session-content.js"

afterEach(closeFixtures)

function fact(payload: { [key: string]: unknown } = {}): EventStoreAppend {
  return { aggregateId: "session:s", type: "test.fact", sessionId: "s", version: 1, timestamp: 1, actor: "test", payload }
}

describe("project state worker scheduler", () => {
  test("exclusive startup recovers the previous image before execution is admitted", async () => {
    let previousImage = ""
    const { client, manager } = await fixture(undefined, async ({ manager: seedManager }) => {
      previousImage = await seedManager.createChat({ name: "previous image", initialState: "active" })
    }, false, [process.pid])
    expect(await manager.read(previousImage)).toMatchObject({ lifecycleState: "inactive" })
    const held = await manager.createChat({ name: "current owner", initialState: "active" })
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    expect(await manager.read(held)).toMatchObject({ lifecycleState: "active" })
  })

  test("acknowledges a committed near-limit write without echoing its payload", async () => {
    const { client, store } = await fixture()
    const payload = { text: "x".repeat(100_000) }
    const operation = (text: string): ProjectStateControlOperation => ({
      kind: "append", item: { sessionId: "s", events: Array.from({ length: 8 }, () => fact({ text })),
        inFlight: [{ op: "swap", kind: "checkpoint", key: "one", expectedRaw: '{"old":true}', payload: null }] },
    })
    store.putInFlight("s", "checkpoint", "one", { old: true })
    const sample = encodeProjectStateRequest({ id: 1, lane: "control", operation: operation(payload.text) }).byteLength
    const text = "x".repeat(payload.text.length + Math.floor((PROJECT_STATE_MAX_BYTES - sample) / 8))
    const request = { id: 1, lane: "control" as const, operation: operation(text) }
    const bytes = encodeProjectStateRequest(request).byteLength
    const result = await client.control(request.operation)
    expect(result.kind).toBe("stored")
    expect(encodeProjectStateResponse({ id: 1, result }).byteLength).toBeLessThan(1024)
    expect(bytes).toBeGreaterThan(PROJECT_STATE_MAX_BYTES - 8)
    expect(store.countByAggregate("session:s")).toBe(8)
    expect(store.readInFlight("s", ["checkpoint"])).toEqual([])
  })

  test("reads large accepted in-flight checkpoints and several accepted cells with one payload representation", async () => {
    const { client } = await fixture()
    const cells = ["one", "two", "three"].map((key) => ({ key, payload: { text: "x".repeat(key === "one" ? 5_200_000 : 2_200_000) } }))
    for (const { key, payload } of cells) {
      await client.control({ kind: "append", item: { sessionId: "s", events: [],
        inFlight: [{ op: "put", kind: "checkpoint", key, payload }] } })
    }
    const records = await client.readInFlight("s", ["checkpoint"])
    expect(records).toHaveLength(cells.length)
    for (const record of records) {
      expect(record.payload).toEqual(cells.find(({ key }) => key === record.key)!.payload)
      expect(JSON.parse(record.raw)).toEqual(record.payload)
    }
  })
  test("serves the session reads of one tick as one request with each reader's own result", async () => {
    const { client, manager, service } = await fixture()
    const first = await manager.createChat({ name: "first", initialState: "inactive" })
    const second = await manager.createChat({ name: "second", initialState: "inactive" })
    const reads = [
      () => client.sessions.listForIds([first]),
      () => client.sessions.listForIds([second, "missing"]),
      () => client.sessions.read(first),
      () => client.sessions.listActive(),
    ]
    const commands = [
      { kind: "session.list-for-ids", ids: [first] },
      { kind: "session.list-for-ids", ids: [second, "missing"] },
      { kind: "session.read", id: first },
      { kind: "session.list-active" },
    ] as const
    const enqueued = spyOn(service, "enqueue")
    const sent = () => enqueued.mock.calls.map(([, operation]) => operation)
    const alone = []
    for (const read of reads) alone.push(await read())
    expect(sent()).toEqual(commands.map((command) => ({ kind: "session.control", command: { kind: "session.read-batch", reads: [command] } })))
    enqueued.mockClear()

    const batched = await Promise.all(reads.map((read) => read()))

    expect(sent()).toEqual([{ kind: "session.control", command: { kind: "session.read-batch", reads: commands } }])
    expect(batched).toEqual(alone)
  })

  test("committed retained admission changes notify before acknowledgement, conflicts do not", async () => {
    const { client } = await fixture()
    const changes: SessionMetadataChange[] = []
    const unsubscribe = client.sessions.subscribe((change) => changes.push(change))
    try {
      for (const kind of ["workflow.launch", "session.planned_continuation"]) {
        const before = changes.length
        const item = { sessionId: "s", events: [], inFlight: [{ op: "swap" as const, kind, key: "pending", expectedRaw: null, payload: { version: 1 } }] }
        expect(await client.control({ kind: "append", item })).toMatchObject({ kind: "stored", settlements: [{ kind: "stored" }] })
        expect(changes.slice(before)).toEqual([{ kind: "changed", sessionIds: ["s"] }])
        expect(await client.control({ kind: "append", item })).toMatchObject({ kind: "stored", settlements: [{ kind: "rejected" }] })
        expect(changes).toHaveLength(before + 1)
        await client.control({ kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "drop", kind, key: "pending" }] } })
        expect(changes).toHaveLength(before + 2)
      }
      const before = changes.length
      await client.control({ kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "put", kind: "unrelated", key: "pending", payload: {} }] } })
      expect(changes).toHaveLength(before)
    } finally {
      unsubscribe()
    }
  })
  test("fences ordinary writes at execution time without blocking account writes", async () => {
    const { client, store } = await fixture()
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    const write = (generation: number) => client.execution({
      kind: "execution.operation", projectId: "p", generation,
      operation: { kind: "append", item: { sessionId: "s", events: [fact({ generation })] } },
    })
    expect((await write(1)).kind).toBe("stored")
    await client.execution({ kind: "generation.close", projectId: "p", generation: 1 })
    expect(await write(1)).toEqual({ kind: "refused", reason: "closed-generation" })
    expect(await client.execution({ kind: "generation.admit", projectId: "p", generation: 2 })).toMatchObject({ kind: "refused", reason: "unsafe-recovery" })
    await client.execution({ kind: "generation.recover", projectId: "p", generation: 1 })
    expect((await client.control({ kind: "append", item: { sessionId: "s", events: [fact({ account: true })] } })).kind).toBe("stored")
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 2 })
    expect((await write(2)).kind).toBe("stored")
    expect(store.read({ aggregateId: "session:s" }).map((row) => row.payload)).toEqual([
      { generation: 1 }, { account: true }, { generation: 2 },
    ])
  })

  test("a recovery hears which sessions a person was interrupting when the account ended the generation", async () => {
    const recovered: (readonly string[])[] = []
    const { client } = await fixture(async (ids) => { recovered.push(ids) })
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    await client.execution({ kind: "generation.close", projectId: "p", generation: 1 })
    expect(await client.execution({ kind: "generation.recover", projectId: "p", generation: 1, interruptedSessionIds: ["one"] })).toEqual({ kind: "ok" })
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 2 })
    await client.execution({ kind: "generation.close", projectId: "p", generation: 2 })
    await client.execution({ kind: "generation.recover", projectId: "p", generation: 2 })
    expect(recovered).toEqual([["one"], []])
  })

  test("a recovery that cannot write fails as a write, and only unreadable history refuses as unsafe", async () => {
    const failures = [
      Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }),
      new Error("recovery pass failed", { cause: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) }),
      new Error("Corrupt event row 7"),
    ]
    const { client } = await fixture(async () => { throw failures.shift() })
    await client.execution({ kind: "generation.admit", projectId: "p", generation: 1 })
    await client.execution({ kind: "generation.close", projectId: "p", generation: 1 })
    // A failed recovery stays pending, so each retry runs the pass again.
    const recover = () => client.execution({ kind: "generation.recover", projectId: "p", generation: 1 })
    expect(await recover()).toMatchObject({ kind: "failed", error: { message: "database or disk is full" } })
    const second = await recover()
    expect(second.kind === "failed" ? second.error.message : second.kind).toContain("database is locked")
    expect(await recover()).toEqual({ kind: "refused", reason: "unsafe-recovery", message: "Corrupt event row 7" })
  })
})

describe("project state read and write boundary", () => {
  test("contains historical conversion failures in stored notifications without blocking later appends", async () => {
    const { store, client, storedNotifications, failContentStaging } = await fixture()
    failContentStaging(new Error("disk full"))
    store.append({ ...fact({
      toolUseId: "old", outcome: "ok",
      details: { mutation: { version: 1, files: [{ path: "a", change: "modified", unifiedDiff: "-old\n+new\n" }], omissions: [] } },
    }), type: "tool.result.recorded", actor: "flywheel" })
    const appended = await client.control({ kind: "append", item: { sessionId: "other", events: [{ ...fact({ valid: true }), aggregateId: "session:other", sessionId: "other" }] } })
    expect(appended.kind).toBe("stored")
    expect(storedNotifications.flat()).toContainEqual(expect.objectContaining({ type: "tool.result.recorded", payload: { kind: "degraded", reason: "Mutation evidence could not be staged" } }))
    expect(JSON.stringify(storedNotifications)).not.toContain("unifiedDiff")
    await expect(client.readSlice({ sessionId: "s", types: ["tool.result.recorded"] })).rejects.toThrow("disk full")
    expect((await client.readSlice({ sessionId: "other" })).facts).toHaveLength(1)
  })
  test("normalizes historical inline mutations before encoding exact state reads", async () => {
    const { store, client, storedNotifications } = await fixture()
    const payload = {
      toolUseId: "old-edit", outcome: "ok",
      details: { mutation: { version: 1, files: [{ path: "file.ts", change: "modified", unifiedDiff: "-old\n+new\n" }], omissions: [] } },
    }
    store.append({ ...fact(payload), type: "tool.result.recorded", actor: "flywheel" })
    const slice = await client.readSlice({ aggregateId: "session:s", types: ["tool.result.recorded"] })
    const recovered = slice.facts[0]
    expect(recovered).not.toBeInstanceOf(Error)
    if (!recovered || recovered instanceof Error) throw new Error("missing recovered result")
    expect(recovered.version).toBe(3)
    expect(recovered.payload.details).not.toHaveProperty("mutation")
    expect(recovered.payload.details).toHaveProperty("mutationEvidence.retainedFiles", 1)
    expect(store.read({ types: ["tool.result.recorded"] })[0]?.payload).toEqual(payload)
    for (const operation of [
      { kind: "facts.latest-payload", aggregateId: "session:s", type: "tool.result.recorded" },
      { kind: "facts.latest-by-types", aggregateId: "session:s", types: ["tool.result.recorded"] },
      { kind: "facts.page", query: { aggregateId: "session:s" }, upperPosition: store.currentPosition(), maxRows: 10, maxBytes: 4096 },
    ] as const) {
      const response = await client.control(operation)
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(4096)
      expect(JSON.stringify(response)).toContain("mutationEvidence")
      expect(JSON.stringify(response)).not.toContain("unifiedDiff")
    }
    const result = await client.control({ kind: "append", item: { sessionId: "s", events: [] } })
    expect(result.kind).toBe("stored")
    expect(JSON.stringify(storedNotifications)).toContain("mutationEvidence")
    expect(JSON.stringify(storedNotifications)).not.toContain("unifiedDiff")
    const appended = await client.control({ kind: "append", item: { sessionId: "s", events: [{ ...fact(payload), type: "tool.result.recorded", actor: "flywheel" }] } })
    expect(appended).toMatchObject({ kind: "stored", settlements: [{ kind: "stored", receipts: [{ version: 3, payload: { details: { mutationEvidence: { retainedFiles: 1 } } } }] }] })
    expect(JSON.stringify(appended)).not.toContain("unifiedDiff")
  })
  test("stages immutable evidence and serves exact byte windows within complete response budgets", async () => {
    const { client } = await fixture()
    const text = '"\0\né🙂'.repeat(20_000)
    const reference = await buildSessionContent(text, async (nodes) => {
      expect(await client.control({ kind: "content.stage", sessionId: "s", nodes })).toEqual({ kind: "ok" })
    })
    const pieces: Buffer[] = []
    let offset: number | null = 0
    while (offset !== null) {
      const result = await client.control({ kind: "content.range", sessionId: "s", reference, offset, length: 65_536, maxBytes: 1024 })
      expect(encodeProjectStateResponse({ id: Number.MAX_SAFE_INTEGER, result }).byteLength).toBeLessThanOrEqual(1024)
      expect(result.kind).toBe("content.range")
      if (result.kind !== "content.range" || result.range.kind !== "available") throw new Error("evidence unavailable")
      expect(result.reference).toEqual(reference)
      expect(result.requestedOffset).toBe(offset)
      expect(result.range.offset).toBe(offset)
      pieces.push(Buffer.from(result.range.base64, "base64"))
      if (result.range.nextOffset !== null) expect(result.range.nextOffset).toBeGreaterThan(offset)
      offset = result.range.nextOffset
    }
    expect(Buffer.concat(pieces).equals(Buffer.from(text))).toBe(true)
    expect(new Bun.CryptoHasher("sha256").update(Buffer.concat(pieces)).digest("hex")).toBe(reference.sha256)
  })
  test("reports missing and corrupt evidence and refuses an indivisible node over the response budget", async () => {
    const { client, path } = await fixture()
    const reference = await buildSessionContent("exact evidence".repeat(100), nodes => client.writer.stageSessionContentNodes!("s", nodes))
    const missing = { ...reference, root: "0".repeat(64) }
    expect(await client.control({ kind: "content.node", sessionId: "s", sha256: missing.root, maxBytes: 1024 })).toMatchObject({ kind: "content.node", value: { kind: "unavailable", reason: "missing" } })
    expect(await client.readSessionContentRange!("s", missing, 0, 100)).toEqual({ kind: "unavailable", reason: "missing" })
    expect(await client.control({ kind: "content.node", sessionId: "s", sha256: reference.root, maxBytes: 256 })).toEqual({ kind: "refused", reason: "oversize" })
    const db = new Database(path)
    try {
      db.query("update tool_content set content = ? where session_id = ? and sha256 = ?").run("{broken", "s", reference.root)
    } finally { db.close() }
    expect(await client.control({ kind: "content.node", sessionId: "s", sha256: reference.root, maxBytes: 1024 })).toMatchObject({ kind: "content.node", value: { kind: "unavailable", reason: "corrupt" } })
    expect(await client.readSessionContentRange!("s", reference, 0, 100)).toEqual({ kind: "unavailable", reason: "corrupt" })
  })
  test("startup, chat creation, and deferred recovery never fold the full metadata family", async () => {
    const { client, manager, store } = await fixture(undefined, async ({ store: seedStore, manager: seedManager, directory }) => {
      await seedManager.createChat({
        id: "parent",
        conversationId: "parent-conversation",
        name: "parent",
        initialState: "inactive",
      })
      await seedManager.createChat({
        id: "damaged-active",
        conversationId: "damaged-conversation",
        name: "damaged",
        initialState: "active",
      })
      removeOwnerPid("damaged-active", directory)
      seedStore.append({
        aggregateId: "session:damaged-active",
        sessionId: "damaged-active",
        type: "chat.tree.created",
        version: 1,
        timestamp: Date.now(),
        actor: "flywheel",
        payload: { damaged: true },
      })
      const created = buildDurableSubagentCreated({
        childSessionId: "orphan",
        childRunId: "orphan-run",
        conversationId: "orphan-conversation",
        parentSessionId: "parent",
        parentConversationId: "parent-conversation",
        parentToolCallId: "parent-tool",
        persona: { name: "explorer", kind: "persona" },
        capabilityGrant: {
          operation: "subagent",
          required: [],
          capabilities: [],
          moduleIds: [],
          requireWorkflowConfirmation: false,
          workflowsMode: "off",
          identity: "test",
        },
        admittedModuleIds: [],
        skillsRevision: 1,
        model: "test/model",
        tools: ["read"],
        executionCwd: directory,
        budget: { maxTurns: 10, maxTokens: 1000 },
        parentDepth: 0,
        description: "orphan",
      })
      await seedManager.publishSubagent({
        id: "orphan",
        conversationId: "orphan-conversation",
        description: "orphan",
        launchedFrom: {
          parentSessionId: "parent",
          conversationId: "parent-conversation",
          toolUseId: "parent-tool",
        },
        initialRoles: {},
        runBinding: prepareSessionFactAppend("orphan", created),
        assignment: "inspect",
        promptFact: prepareSessionFactAppend("orphan", buildSubagentPrompted({
          childRunId: "orphan-run",
          prompt: "inspect",
          task: "inspect",
          toolNames: ["read"],
        })),
      })
      await seedManager.updateLifecycleState("orphan", "inactive")
      removeOwnerPid("orphan", directory)
    }, true)

    expect(await client.control({ kind: "position.capture" })).toMatchObject({ kind: "position" })
    expect(await manager.read("damaged-active")).toMatchObject({ lifecycleState: "inactive" })
    await expect(client.sessions.createChat({
      id: "new-chat",
      conversationId: "new-conversation",
      name: "new",
    })).resolves.toBe("new-chat")
    await expect(client.sessions.recoverStaleSessions()).resolves.toBe(1)
    expect(loadSubagentRunsFromEvents(store.read({
      aggregateId: "session:orphan",
      types: SUBAGENT_RUN_FACT_TYPES,
    })).at(-1)).toMatchObject({
      childRunId: "orphan-run",
      status: "interrupted",
      interruptionReason: "runtime_restarted",
    })
  })

  test("a terminal batch settles a child's metadata while the catalog never lists or patches the child", async () => {
    const { client, directory } = await fixture()
    const started = "2026-01-01T00:00:00.000Z"
    await client.writer.append(buildSessionMetadataAppend("child", buildSessionCreatedFact({
      kind: "subagent", command: "subagent", label: "child", conversationId: "child-conversation",
      lifecycleState: "active", createdAt: started, lastUpdated: started, activatedAt: started,
      executionCwd: directory, launchedFrom: { parentSessionId: "parent", toolUseId: "tool" },
    })))
    const entries = new Map([["child", { ...chatEntry({ runnerState: "streaming" }), kind: "subagent" as const }]])
    const sessionStore = fakeSessionStore(entries)
    const projection = createFrontendProjection({ sessionStore, manager: client.sessions, projectRoot: directory, maxSnapshotHz: 1000 })
    const changes: string[] = []
    projection.subscribe((batch) => { for (const change of batch) changes.push(change.kind === "removed" ? change.sessionId : change.row.id) })
    try {
      // A child is never a catalog row (ARCH-PROTOCOL-048): its row is read through
      // session detail, where the metadata the state worker settles is authority.
      // What the row admits comes from the run evidence the detail read adds;
      // projected from metadata alone, a child admits deletion only.
      expect((await projection.snapshot()).rows).toEqual([])
      expect(await projection.liveCatalogRow("child")).toBeNull()
      const active = await client.sessions.read("child")
      if (active?.kind !== "subagent") throw new Error("Missing subagent")
      expect(projectSessionCatalogRow(durableCatalogRowFromSession("child", active, directory))).toMatchObject({ kind: "subagent", lifecycleState: "active", admittedActions: ["session.delete"] })
      entries.delete("child")
      sessionStore.emitChange("child")
      await Bun.sleep(5)
      await client.writer.appendBatch([
        buildSessionMetadataAppend("child", {
          type: "session.lifecycle.changed", version: 1, actor: "flywheel",
          payload: { lifecycleState: "inactive", lastUpdated: "2026-01-01T00:00:02.000Z" },
        }),
        { ...fact({ result: "PARENT_DONE" }), aggregateId: "session:parent", sessionId: "parent" },
      ])
      await Bun.sleep(5)
      const inactive = await client.sessions.read("child")
      if (inactive?.kind !== "subagent") throw new Error("Missing subagent")
      expect(projectSessionCatalogRow(durableCatalogRowFromSession("child", inactive, directory))).toMatchObject({ lifecycleState: "inactive", admittedActions: ["session.delete"] })
      expect(await projection.catalogRow("child")).toBeNull()
      expect(changes).toEqual([])
    } finally {
      projection.dispose()
    }
  })

  test("writer preserves batch atomicity, typed rejection, and maintenance behavior through the service", async () => {
    const { store, client } = await fixture()
    const first = await client.writer.append(fact({ requestId: "first" }))
    expect(first.position).toBe(1)

    const batch = [
      { ...fact({ requestId: "keep" }), expectedSeq: 1 },
      { ...fact({ requestId: "never-stored" }), aggregateId: "session:other", sessionId: "other", expectedSeq: 2 },
    ]
    await expect(client.writer.appendBatchGuarded(batch)).resolves.toMatchObject({ kind: "conflict" })
    expect(store.currentPosition()).toBe(1)

    expect(await client.writer.pruneSupersededEvents("session:s", "queue.state.changed")).toBe(0)
    expect(await client.writer.pruneSupersededKeyedEvents?.("session:s", "step.resume_revert.recorded", "$.attemptId")).toBe(0)
  })

  test("store upkeep runs one bounded step per request and never deletes a live family", async () => {
    const { store, client, path } = await fixture()
    store.append({ ...fact(), type: "file.read" })
    store.append({ ...fact(), type: "file.read" })
    const live = store.append(fact())
    const db = new Database(path)
    db.exec("create index event_parent_tool_fact_idx on event(aggregate_id, type, position)")
    db.close()

    expect(await client.upkeep.pruneRetiredFamilyChunk("file.read")).toBe(2)
    expect(await client.upkeep.pruneRetiredFamilyChunk("file.read")).toBe(0)
    await expect(client.upkeep.pruneRetiredFamilyChunk("test.fact")).rejects.toThrow("test.fact is not a retired fact family")
    expect(await client.upkeep.dropRetiredIndexes()).toBe(1)
    expect(await client.upkeep.dropRetiredIndexes()).toBe(0)
    expect(store.read({}).map((event) => event.position)).toEqual([live.position])
    const checkpoint = {
      version: 2, conversationId: "c", toolUseId: "nested", parentToolUseId: "parent", toolName: "read",
      budgetExempt: true, registrationOrdinal: 0, content: [{ type: "text", text: "output" }], outcome: "ok",
    }
    store.putInFlight("s", "finalized-tool-result", "c:nested", checkpoint)
    store.append({ ...fact(), actor: "flywheel", type: "tool.result.recorded", payload: { toolUseId: "nested", outcome: "ok" } })
    const childTree = await createConversationTree({
      conversationId: "c", sessionId: "s", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
    })
    try {
      await childTree.appendMessage({ kind: "user", content: "read" })
      await childTree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "nested", name: "read", input: {} }] })
      await childTree.appendMessage({ kind: "toolResult", toolUseId: "nested", content: [{ type: "text", text: "output" }] })
    } finally {
      childTree.getStorage().dispose()
    }
    const { planFinalizedToolResultCheckpointPage } = await import("../../../../src/orchestration/migrations/finalized-tool-result-checkpoints")
    const plan = planFinalizedToolResultCheckpointPage(path, 0)
    expect(await client.upkeep.retireFinalizedCheckpointPage({ afterRowid: 0, ...plan })).toMatchObject({
      kind: "checkpoint-maintenance", retired: 1, examined: 1, complete: true,
    })
    expect(store.readInFlight("s", "finalized-tool-result")).toEqual([])
  })

  test("pages progress within byte and row limits and stop at the captured ceiling", async () => {
    const { store, client } = await fixture()
    const first = store.append(fact({ value: 1 }))
    const second = store.append(fact({ value: 2 }))
    const ceiling = await client.capturePosition()
    store.append(fact({ value: 3 }))
    const bytes = pack(first).byteLength
    const page = await client.control({ kind: "facts.page", query: {}, upperPosition: ceiling, afterPosition: 0, maxRows: 2, maxBytes: bytes })
    expect(page).toEqual({ kind: "facts", facts: [first], contentRows: [], upperPosition: ceiling, continuationPosition: first.position, encodedBytes: bytes })
    const last = await client.control({ kind: "facts.page", query: {}, upperPosition: ceiling, afterPosition: first.position, maxRows: 1, maxBytes: 4096 })
    expect(last).toMatchObject({ kind: "facts", facts: [second], continuationPosition: null })
  })

  test("zero budgets are invalid and indivisible oversize facts and blobs refuse without unchanged continuations", async () => {
    const { store, service, client } = await fixture()
    const extracted = extractContent("x".repeat(4096))
    if (extracted.kind !== "reference") throw new Error("missing reference")
    const stored = store.append({ ...fact({ text: "x".repeat(512) }), contentRows: [extracted.row] })
    for (const [maxRows, maxBytes] of [[0, 32], [1, 0]] as const) {
      await expect(enqueue(service, "control", { kind: "facts.page", query: {}, upperPosition: stored.position, maxRows, maxBytes })).resolves.toEqual({ kind: "refused", reason: "invalid" })
    }
    await expect(client.control({ kind: "facts.page", query: {}, upperPosition: stored.position, maxRows: 1, maxBytes: 32 })).resolves.toEqual({ kind: "refused", reason: "oversize" })
    await expect(client.control({
      kind: "content.page", references: [{ sessionId: "s", reference: extracted.reference, fact: { aggregateId: stored.aggregateId, eventType: stored.type, eventPosition: stored.position } }],
      maxRows: 1, maxBytes: 1024,
    })).resolves.toEqual({ kind: "refused", reason: "oversize" })
  })

  test("content pages charge reference metadata and either advance or refuse an oversized next blob", async () => {
    const { store, client } = await fixture()
    const first = extractContent("a".repeat(3000))
    const second = extractContent("b".repeat(5000))
    if (first.kind !== "reference" || second.kind !== "reference") throw new Error("missing references")
    const stored = store.append({ ...fact(), contentRows: [first.row, second.row] })
    const identity = { aggregateId: stored.aggregateId, eventType: stored.type, eventPosition: stored.position }
    const references = [first, second].map(({ reference }): ProjectStateContentReference => ({ sessionId: "s", reference, fact: identity }))
    const firstReference = references[0]
    if (!firstReference) throw new Error("missing first reference")
    const bytes = pack({ reference: firstReference, content: first.row.content }).byteLength
    const request: Extract<ProjectStateControlOperation, { readonly kind: "content.page" }> = { kind: "content.page", references, maxRows: 2, maxBytes: bytes }
    const page = await client.control(request)
    expect(page.kind).toBe("content")
    if (page.kind !== "content") throw new Error("content page was refused")
    expect(page.rows).toEqual([{ reference: firstReference, content: first.row.content }])
    expect(page.continuationOffset).toBe(1)
    expect(page.encodedBytes).toBe(bytes)
    await expect(client.control({ ...request, offset: 1 })).resolves.toEqual({ kind: "refused", reason: "oversize" })
  })

  test("execution operations preserve exact conflict types and atomic in-flight updates", async () => {
    const { store, client } = await fixture()
    const generation = { projectId: "p", generation: 1 }
    await expect(client.execution({ kind: "generation.admit", ...generation })).resolves.toEqual({ kind: "ok" })
    await expect(client.execution({
      kind: "execution.operation", ...generation,
      operation: { kind: "append", item: { sessionId: "s", events: [], inFlight: [{ op: "put", kind: "tool", key: "k", payload: { stage: "started" } }] } },
    })).resolves.toMatchObject({ kind: "stored", settlements: [{ kind: "stored", receipts: [] }] })
    const raw = store.readInFlight("s", "tool")[0]!.raw
    expect(raw).toBe('{"stage":"started"}')
    const refused = await client.execution({
      kind: "execution.operation", ...generation,
      operation: { kind: "append", item: { sessionId: "s", events: [fact()], inFlight: [{ op: "swap", kind: "tool", key: "k", expectedRaw: "wrong", payload: null }] } },
    })
    if (refused.kind !== "stored" || refused.settlements[0]?.kind !== "rejected") throw new Error("missing rejection")
    expect(refused.settlements[0].error).toBeInstanceOf(InFlightSwapConflictError)
    expect(store.currentPosition()).toBe(0)
    expect(store.readInFlight("s", "tool")[0]?.raw).toBe(raw)
    const terminal = await client.execution({
      kind: "execution.operation", ...generation,
      operation: { kind: "append", item: { sessionId: "s", events: [fact()], inFlight: [{ op: "swap", kind: "tool", key: "k", expectedRaw: raw, payload: null }] } },
    })
    expect(terminal).toMatchObject({ kind: "stored", settlements: [{ kind: "stored" }] })
    expect(store.readLatestPayloadByAggregateAndType("session:s", "test.fact")).toBe("{}")
    expect(store.readInFlight("s", "tool")).toEqual([])
    const conflict = await client.control({ kind: "append", item: { sessionId: "s", events: [{ ...fact(), expectedSeq: 0 }] } })
    if (conflict.kind !== "stored" || conflict.settlements[0]?.kind !== "conflict") throw new Error("missing seq conflict")
    expect(conflict.settlements[0].conflict).toEqual({ aggregateId: "session:s", expectedSeq: 0, actualSeq: 1 })
    await client.execution({ kind: "generation.close", ...generation })
    await expect(client.execution({ kind: "generation.admit", ...generation })).resolves.toMatchObject({ kind: "refused", reason: "closed-generation" })
  })

  test("service disposal waits for admitted work and closes SQLite once", async () => {
    const { store, service } = await fixture()
    let closes = 0
    const originalClose = store.close
    store.close = () => { closes += 1; originalClose() }
    const first = enqueue(service, "control", { kind: "append", item: { sessionId: "s", events: [fact()] } })
    const second = enqueue(service, "control", { kind: "position.capture" })
    const closed = service.close()
    expect(service.close()).toBe(closed)
    expect(closes).toBe(0)
    await expect(first).resolves.toMatchObject({ kind: "stored" })
    await expect(second).resolves.toEqual({ kind: "position", position: 1 })
    await closed
    expect(closes).toBe(1)
  })

  test("every response carries a head that its commit notifications reached first", async () => {
    const { store, service, storedNotifications, holdContentStaging } = await fixture()
    const notified = () => Math.max(0, ...storedNotifications.flat().map((event) => event.position))
    const appended = await served(service, "control", { kind: "append", item: { sessionId: "s", events: [fact()] } })
    expect(appended.head).toBe(store.currentPosition())
    expect(notified()).toBe(store.currentPosition())
    const staging = Promise.withResolvers<void>()
    holdContentStaging(staging.promise)
    // Its notification stages historical evidence, so it waits on the gate.
    const committed = store.append({ ...fact({
      toolUseId: "old", outcome: "ok",
      details: { mutation: { version: 1, files: [{ path: "a", change: "modified", unifiedDiff: "-old\n+new\n" }], omissions: [] } },
    }), type: "tool.result.recorded", actor: "flywheel" })
    let answered = false
    const answer = served(service, "control", { kind: "aggregate.count", aggregateId: "session:s" }).then((response) => {
      answered = true
      return { ...response, notified: notified() }
    })
    await Bun.sleep(1)
    expect(answered).toBe(false)
    staging.resolve()
    expect(await answer).toEqual({ result: { kind: "count", count: 2 }, head: committed.position, notified: committed.position })
  })

  test("database disposal failure remains observable without retrying close", async () => {
    const { store, service, client } = await fixture()
    const close = store.close
    const failure = new Error("sqlite close failed")
    let calls = 0
    store.close = () => { calls += 1; close(); throw failure }
    await expect(service.close()).rejects.toBe(failure)
    await expect(service.close()).rejects.toBe(failure)
    await expect(client.close()).rejects.toBe(failure)
    expect(calls).toBe(1)
    // The rejected close is already verified; cleanup must still remove the fixture.
    const remove = cleanup.pop()!
    cleanup.push(async () => { try { await remove() } catch (error) { if (error !== failure) throw error } })
  })
})
