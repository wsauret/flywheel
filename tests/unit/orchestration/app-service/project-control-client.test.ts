import { describe, expect, test } from "bun:test"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent, RuntimeQueryResult, RuntimeChatDefault } from "../../../../src/protocol/app-service-types.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { budgetCursor, type BudgetView } from "../../../../src/protocol/budget-protocol-types.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { durableRow, listedRow, executionRow } from "./_frontend-projection-fixtures.js"
import { fixture, generationFact, never, privateExecutor } from "./_project-control-client-fixture.js"
import { RUNTIME_UI_PATCH_FIXTURES } from "../../protocol/runtime-ui-patch-fixtures.js"
import { Schema } from "effect"
import { FrontendMutationSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { protocolBackgroundSchema } from "../../../../src/protocol/modules.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

/** The status the executor publishes for a session it holds at rest. */
const idleStatus: StatusView = {
  activity: "idle", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false,
  activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null,
  accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
}

describe("account project control client", () => {
  test("a listed chat publishes the budget its summary states, speed included, and a stored stream summary refreshes it", async () => {
    const f = fixture()
    f.metadata.set("one", durableRow("one"))
    let speed = 100
    let summaryReads = 0
    const client = createProjectControlClient({ ...f.options, history: {
      ...f.options.history,
      async sessionSummaryImmediate(ids) {
        summaryReads++
        return { rows: ids.map((id) => executionRow(durableRow(id), 0)), errors: [], totalsLoading: false, generationSpeeds: Object.fromEntries(ids.map((id) => [id, speed])) }
      },
    } })
    const budgets: BudgetView[] = []
    client.subscribe((event) => {
      if (event.type === "patch" && event.patch.payload.kind === "budget.updated") budgets.push(event.patch.payload.budget)
    })
    const published = (expected: number) => new Promise<void>((resolve) => {
      const stop = client.subscribe((event) => {
        if (event.type === "patch" && event.patch.payload.kind === "budget.updated" && event.patch.payload.budget.averageGenerationTokensPerSecond === expected) {
          stop()
          resolve()
        }
      })
    })
    const first = published(100)
    await client.query({ type: "snapshot" })
    await first
    expect(budgets.at(-1)).toMatchObject({ totalsLoading: false, averageGenerationTokensPerSecond: 100 })
    const reads = summaryReads
    speed = 20
    const refreshed = published(20)
    const fact = generationFact(1, "one", 100, 5000)
    f.facts.push(fact)
    f.stored.emit([fact])
    await refreshed
    expect(summaryReads).toBe(reads + 1)
    await client.close()
  })
  test.each([3, 100])("a budget snapshot of %i sessions passes the executor's budgets on and reads no history pages", async (sessionCount) => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const sessionIds = Array.from({ length: sessionCount }, (_, index) => `s${index}`)
    for (const sessionId of sessionIds) f.metadata.set(sessionId, durableRow(sessionId))
    const budget = { totalsLoading: false as const, tokens: 10, cost: 0.07, billedCost: 0, priceUnavailable: false, contextPercent: 6, contextPromptTokens: 100, averageGenerationTokensPerSecond: 50 }
    const query = runtimeQuery({ budgetSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: budget })) }) })
    let historyReads = 0
    const client = createProjectControlClient({ ...f.options, executor: { ...executor.client, query }, state: {
      ...f.options.state,
      async readPage(...args) {
        historyReads++
        return f.options.state.readPage(...args)
      },
    } })
    await client.query({ type: "snapshot" })
    for (const sessionId of sessionIds) {
      executor.bus.publish({ cursor: statusCursor(sessionId), payload: { kind: "status.updated", status: idleStatus } })
      f.facts.push(generationFact(f.facts.length + 1, sessionId, 100, 1000))
    }
    await executor.bus.drain()
    const answer = await client.query({ type: "budgetSnapshot", sessionIds })
    expect(answer.views).toEqual(sessionIds.map((sessionId) => ({ sessionId, view: budget })))
    expect(historyReads).toBe(0)
    await client.close()
    await executor.bus.clear()
  })
  test("inactive passive reads wait for generation recovery and use account history", async () => {
    const f = fixture()
    f.metadata.set("history", durableRow("history", { lifecycleState: "inactive" }))
    const recovery = Promise.withResolvers<void>()
    const recoveryEntered = Promise.withResolvers<void>()
    let historyReads = 0
    const client = createProjectControlClient({
      ...f.options,
      executionPaused: () => true,
      awaitGenerationRecovery: async () => {
        recoveryEntered.resolve()
        await recovery.promise
      },
      history: {
        ...f.options.history,
        async moduleSnapshot(domain, workflowId) {
          historyReads++
          expect(String(domain)).toBe("workflow_view")
          expect(workflowId).toBe("history")
          return Schema.decodeUnknownSync(protocolBackgroundSchema(domain))({ view: null })
        },
      },
      executor: {
        query: () => Promise.reject(new Error("inactive read reached executor")),
        dispatch: () => never(),
        hideSession: () => never(),
        subscribe: () => () => {},
        async close() {},
      },
    })
    const baseline = client.query({ type: "snapshot" })
    await recoveryEntered.promise
    expect(historyReads).toBe(0)
    recovery.resolve()
    await baseline

    const read = client.query({ type: "workflowViewSnapshot", workflowId: "history" })
    expect(await read).toMatchObject({ view: null })
    expect(historyReads).toBe(1)
    await client.close()
  })

  test.each([
    [{ kind: "model", model: "openai/gpt-5", effort: "medium" as const }, { kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" as const }],
    [{ kind: "model", model: "openai/gpt-5", effort: "medium" as const }, { kind: "none" }],
  ] as const)("repairs execution stats and chat default %p before globally invalidating", async (initialDefault, repairedDefault) => {
    const executor = privateExecutor()
    let repair: (() => Promise<void>) | undefined
    const f = fixture()
    f.options.setChatDefault(initialDefault)
    const query = runtimeQuery({
      statusSnapshot: async (request) => ({ snapshotPosition: 900, views: request.sessionIds.map((sessionId) => ({ sessionId, view: null })) }),
      snapshot: async () => ({ rows: [{ ...executionRow(durableRow("local-1", { label: "Old" }), 123), activity: "generating" }], errors: [], activeRuntimeCount: 1, snapshotPosition: 900, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null, chatDefault: repairedDefault, executor: { kind: "serving" }, service: { kind: "serving" } }),
    })
    const client = createProjectControlClient({ ...f.options, executor: {
      ...executor.client,
      onOutputGap(listener) { repair = listener; return () => { repair = undefined } },
      query,
    } })
    await client.dispatch({ type: "chat.open" })
    await client.dispatch({ type: "session.rename", sessionId: "local-1", title: "Current" })
    const repaired = Promise.withResolvers<void>()
    client.subscribe((event) => {
      if (event.type !== "patch" || event.patch.payload.kind !== "runtime.invalidate") return
      expect(event.patch.cursor).toEqual({ scope: "workspace", domain: "runtime" })
      void client.query({ type: "snapshot" }).then((snapshot) => {
        expect(snapshot.rows[0]).toMatchObject({ title: "Current", totalTokens: 123, activity: "generating" })
        expect(snapshot.chatDefault).toEqual(repairedDefault)
        repaired.resolve()
      })
    })
    expect(repair).toBeDefined()
    await repair!()
    await repaired.promise
    await client.close()
  })

  test("plus, snapshot, rename and selection do not wait for executor readiness", async () => {
    const f = fixture()
    const client = createProjectControlClient(f.options)
    const events: FrontendEvent[] = []
    client.subscribe((event) => events.push(event))
    expect(events).toEqual([])
    const opened = await client.dispatch({ type: "chat.open" })
    expect(opened).toMatchObject({ ok: true, sessionId: "local-1", sessionCatalogRow: { title: "New Chat", activity: "absent", lifecycleState: "active" } })
    expect(f.creates).toEqual([{ id: "local-1", conversationId: "local-2", name: "New Chat", executionCwd: "/workspace", initialState: "active", authProfileId: "first" }])
    f.metadata.set("local-1", { ...f.metadata.get("local-1")!, shortLabel: "Original tab" })
    const writes: unknown[] = []
    const updateLabel = f.options.state.sessions.updateLabel
    f.options.state.sessions.updateLabel = async (id, labels, source) => {
      writes.push(labels)
      return updateLabel(id, labels, source)
    }
    expect(await client.dispatch({ type: "session.rename", sessionId: "local-1", title: "Chosen session name" })).toMatchObject({ ok: true, sessionCatalogRow: { title: "Chosen session name", shortTitle: "Original tab" } })
    expect(writes).toEqual([{ label: "Chosen session name" }])
    const shortRename = Schema.decodeUnknownSync(FrontendMutationSchema)({ type: "session.rename", sessionId: "local-1", shortTitle: "12345678901234567890" })
    expect(await client.dispatch(shortRename)).toMatchObject({ ok: true, sessionCatalogRow: { title: "Chosen session name", shortTitle: "12345678901234" } })
    expect(await client.dispatch({ type: "session.rename", sessionId: "local-1", title: "Long description ".repeat(10) })).toMatchObject({ ok: true, sessionCatalogRow: { title: "Long description ".repeat(10).trim(), shortTitle: "12345678901234" } })
    expect(await client.dispatch({ type: "session.activate", sessionId: "local-1" })).toMatchObject({ ok: true })
    expect(await client.query({ type: "snapshot" })).toMatchObject({ rows: [{ id: "local-1", title: "Long description ".repeat(10).trim(), shortTitle: "12345678901234" }], activeRuntimeCount: 0, runtimeVersion: "test-version" })
    await client.close()
    expect(f.changes.size).toBe(0)
    expect(f.stored.listenerCount()).toBe(0)
    expect(f.failures).toEqual([])
    expect(f.metadata.size).toBe(1)
  })

  test("optional presentation work follows real public subscriber demand", async () => {
    const f = fixture()
    const demand: boolean[] = []
    const client = createProjectControlClient({
      ...f.options,
      onPublicSubscriptionChange: (active) => demand.push(active),
    })

    await client.query({ type: "snapshot" })
    expect(demand).toEqual([])
    const first = client.subscribe(() => {})
    const second = client.subscribe(() => {})
    expect(demand).toEqual([true])
    first()
    expect(demand).toEqual([true])
    second()
    expect(demand).toEqual([true, false])
    await client.close()
  })

  test("passive catalog and budget views settle from one account-history replacement", async () => {
    const f = fixture()
    f.metadata.set("history", durableRow("history", { lifecycleState: "inactive" }))
    const replay = Promise.withResolvers<void>()
    let immediateReads = 0
    let settledReads = 0
    let recoveryWaits = 0
    let totalsReady = false
    const metadata = (id: string): DurableSessionCatalogRow => {
      const row = f.metadata.get(id)
      if (!row) throw new Error(`missing metadata for ${id}`)
      return row
    }
    const client = createProjectControlClient({
      ...f.options,
      awaitGenerationRecovery: async () => { recoveryWaits++ },
      history: {
        ...f.options.history,
        async sessionSummaryImmediate(sessionIds) {
          immediateReads++
          if (totalsReady) {
            return {
              rows: sessionIds.map((id) => executionRow(metadata(id), 30, 2)),
              errors: [],
              totalsLoading: false,
              generationSpeeds: {},
            }
          }
          return {
            rows: sessionIds.map((id) => projectSessionCatalogRow(metadata(id))),
            errors: [],
            totalsLoading: true,
            generationSpeeds: {},
          }
        },
        async waitForTotals(sessionIds) {
          settledReads++
          await replay.promise
          return {
            rows: sessionIds.map((id) => executionRow(metadata(id), 30, 2)),
            errors: [],
            totalsLoading: false,
            generationSpeeds: {},
          }
        },
      },
    })
    const events: FrontendEvent[] = []
    client.subscribe((event) => events.push(event))

    expect((await client.query({ type: "snapshot" })).rows[0]).toMatchObject({ id: "history", totalsLoading: true })
    totalsReady = true
    replay.resolve()
    for (let attempts = 0; attempts < 20 && !events.some((event) => event.type === "patch" && event.patch.payload.kind === "budget.updated" && !event.patch.payload.budget.totalsLoading); attempts++) await Bun.sleep(0)

    expect((await client.query({ type: "snapshot" })).rows[0]).toMatchObject({ id: "history", totalsLoading: false, totalTokens: 30 })
    const patches = events.flatMap((event) => event.type === "patch" ? [event.patch] : [])
    expect(patches.some((patch) => patch.cursor.scope === "session" && patch.cursor.domain === "session" && patch.cursor.sessionId === "history" && patch.payload.kind === "session.updated")).toBe(true)
    expect(patches.some((patch) => JSON.stringify(patch.cursor) === JSON.stringify(budgetCursor("history")) && patch.payload.kind === "budget.updated" && !patch.payload.budget.totalsLoading && patch.payload.budget.tokens === 30)).toBe(true)
    expect(immediateReads).toBe(2)
    expect(settledReads).toBe(1)
    expect(recoveryWaits).toBe(4)
    expect(patches.map((patch) => patch.position)).toEqual(patches.map((_, index) => index + 1))
    await client.close()
  })

  test("profile selection is captured before durable creation waits", async () => {
    const f = fixture()
    const barrier = Promise.withResolvers<void>()
    f.blockCreate(barrier.promise)
    const client = createProjectControlClient(f.options)
    const opening = client.dispatch({ type: "chat.open" })
    f.profile({ id: "second", persistedId: "second" })
    barrier.resolve()
    await opening
    expect(f.creates[0]?.authProfileId).toBe("first")
    await client.close()
  })

  test("a new chat records the environment-selected profile that serves it, and an unavailable profile refuses the open", async () => {
    const f = fixture()
    f.profile({ id: "second", persistedId: "missing", source: "environment" })
    const client = createProjectControlClient(f.options)
    await client.dispatch({ type: "chat.open" })
    expect(f.creates[0]?.authProfileId).toBe("second")
    f.profile({ id: "missing" })
    await expect(client.dispatch({ type: "chat.open" })).rejects.toThrow("auth profile does not exist: missing")
    expect(f.creates.length).toBe(1)
    await client.close()
  })

  test("private positions are reminted and metadata refresh retains activity and known totals while exact totals load", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const bus = createRuntimeUiBus()
    const client = createProjectControlClient({ ...f.options, bus })
    const events: FrontendEvent[] = []
    client.subscribe((event) => events.push(event))
    void client.query({ type: "statusSnapshot", sessionIds: ["local-1"] })
    await client.dispatch({ type: "chat.open" })
    const metadata = f.metadata.get("local-1")
    if (!metadata) throw new Error("missing row")
    const privatePatch = executor.bus.publish({ cursor: sessionCursor(metadata.id), payload: { kind: "session.updated", row: { ...executionRow(metadata, 99, 1), activity: "generating" } } })
    await executor.bus.drain()
    await client.dispatch({ type: "session.rename", sessionId: metadata.id, title: "Renamed" })
    const snapshot = await client.query({ type: "snapshot" })
    expect(snapshot.rows[0]).toMatchObject({ title: "Renamed", totalsLoading: false, totalTokens: 99, totalCost: 1, activity: "generating" })
    await bus.drain()
    const patches = events.flatMap((event) => event.type === "patch" ? [event.patch] : [])
    expect(patches.length).toBeGreaterThan(2)
    expect(patches.some((patch) => patch.payload.kind === privatePatch.payload.kind
      && patch.payload.kind === "session.updated"
      && patch.payload.row.activity === "generating"
      && !patch.payload.row.totalsLoading
      && patch.payload.row.totalTokens === 99)).toBe(true)
    expect(patches.map((patch) => patch.position)).toEqual(patches.map((_, index) => index + 1))
    expect(patches.map((patch) => patch.prevPosition)).toEqual(patches.map((_, index) => index))
    expect(executor.commands.every((command) => command.type === "session.activate")).toBe(true)
    await client.close()
    expect(executor.closes()).toBe(0)
    expect(bus.publish({ cursor: sessionCursor("other"), payload: { kind: "session.removed" } }).position).toBeGreaterThan(1)
    await Promise.all([bus.clear(), executor.bus.clear()])
  })

  test("account snapshots seed and update the canonical chat default before publishing its patch", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const initial = { kind: "model", model: "openai/gpt-5", effort: "medium" as const } satisfies RuntimeChatDefault
    f.options.setChatDefault(initial)
    const client = createProjectControlClient(f.options)
    expect((await client.query({ type: "snapshot" })).chatDefault).toEqual(initial)
    const observed: RuntimeChatDefault[] = []
    client.subscribe((event) => {
      if (event.type === "patch" && event.patch.payload.kind === "chat_default.changed") {
        observed.push(f.options.chatDefault())
      }
    })
    const replacement = { kind: "model", model: "anthropic/claude-sonnet-4", effort: "high" as const } satisfies RuntimeChatDefault
    executor.bus.publish({
      cursor: { scope: "workspace", domain: "chat_default" },
      payload: { kind: "chat_default.changed", chatDefault: replacement },
    })
    await executor.bus.drain()

    expect(observed).toEqual([replacement])
    expect((await client.query({ type: "snapshot" })).chatDefault).toEqual(replacement)
    await client.close()
    await executor.bus.clear()
  })

  test("forwarded query baselines use the account watermark before waiting", async () => {
    const executor = privateExecutor()
    const reply = Promise.withResolvers<RuntimeQueryResult<{ type: "statusSnapshot"; sessionIds: readonly string[] }>>()
    const entered = Promise.withResolvers<void>()
    const query = runtimeQuery({
      statusSnapshot: async () => {
        entered.resolve()
        return reply.promise
      },
    })
    const f = fixture({ ...executor.client, query })
    const bus = createRuntimeUiBus()
    const client = createProjectControlClient({ ...f.options, bus })
    await client.query({ type: "snapshot" })
    executor.bus.publish({ cursor: statusCursor("one"), payload: { kind: "status.updated", status: idleStatus } })
    await executor.bus.drain()
    const { snapshotPosition: watermark } = await client.query({ type: "snapshot" })
    const waiting = client.query({ type: "statusSnapshot", sessionIds: ["one"] })
    await entered.promise
    bus.publish({ cursor: sessionCursor("one"), payload: { kind: "session.removed" } })
    reply.resolve({ views: [{ sessionId: "one", view: null }], snapshotPosition: 999 })
    expect(await waiting).toEqual({ snapshotPosition: watermark, views: [{ sessionId: "one", view: null }] })
    expect(watermark).toBeLessThan((await client.query({ type: "snapshot" })).snapshotPosition)
    await client.close()
    await Promise.all([bus.clear(), executor.bus.clear()])
  })

  test("a forwarded authStatusSnapshot voids the relayed auth baseline; a configSnapshot read keeps the row baseline", async () => {
    const executor = privateExecutor()
    const auth = RUNTIME_UI_PATCH_FIXTURES["auth.changed"]
    const config = RUNTIME_UI_PATCH_FIXTURES["config.changed"]
    const row = RUNTIME_UI_PATCH_FIXTURES["session.updated"]
    const query = runtimeQuery({
      authStatusSnapshot: async () => ({ auth: auth.payload.auth, snapshotPosition: 999 }),
      configSnapshot: async () => ({ config: config.payload.config, snapshotPosition: 999 }),
    })
    const f = fixture({ ...executor.client, query })
    const bus = createRuntimeUiBus({ publishOnChange: true })
    const client = createProjectControlClient({ ...f.options, bus })
    const kinds: string[] = []
    client.subscribe((event) => { if (event.type === "patch") kinds.push(event.patch.payload.kind) })
    const relay = async (patch: typeof auth | typeof row): Promise<void> => {
      executor.bus.publish({ cursor: patch.cursor, payload: patch.payload })
      await executor.bus.drain()
      await bus.drain()
    }
    await client.query({ type: "snapshot" })
    await relay(auth)
    await relay(row)
    await relay(auth)
    await relay(row)
    expect(kinds).toEqual(["auth.changed", "session.updated"])
    await client.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
    await client.query({ type: "configSnapshot" })
    await relay(auth)
    await relay(row)
    expect(kinds).toEqual(["auth.changed", "session.updated", "auth.changed"])
    await client.close()
    await Promise.all([bus.clear(), executor.bus.clear()])
  })

  test("state changes delivered during baseline loading survive the snapshot", async () => {
    const f = fixture()
    const baseline = Promise.withResolvers<Awaited<ReturnType<typeof f.options.history.snapshot>>>()
    const client = createProjectControlClient({
      ...f.options,
      history: { ...f.options.history, snapshot: () => baseline.promise },
    })
    f.metadata.set("one", durableRow("one", { label: "new" }))
    f.notify({ kind: "changed", sessionIds: ["one"] })
    const snapshot = client.query({ type: "snapshot" })
    baseline.resolve({ rows: [listedRow(durableRow("one", { label: "old" }))], errors: [], totalsLoading: true, generationSpeeds: {} })
    expect((await snapshot).rows[0]?.title).toBe("new")
    await client.close()
  })

  test("eager history baseline keeps chat totals, degradation, errors, and fresher executor activity while excluding children", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const recovery = Promise.withResolvers<void>()
    const recoveryEntered = Promise.withResolvers<void>()
    let baselineReads = 0
    const metadata = durableRow("chat", {
      degraded: true,
      unavailableFields: ["createdAt"],
    })
    const historyRow = {
      ...executionRow(metadata, 41, 3),
      admittedActions: ["chat.resume", "session.delete"] as const,
    }
    const childRow = projectSessionCatalogRow(durableRow("child", { kind: "subagent" }))
    const workflowRow = projectSessionCatalogRow(durableRow("workflow", { kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" } }))
    const baselineError = { sessionId: "chat", scope: "metadata" as const, reason: "partial metadata" }
    const client = createProjectControlClient({
      ...f.options,
      executor: executor.client,
      awaitGenerationRecovery: async () => {
        recoveryEntered.resolve()
        await recovery.promise
      },
      history: {
        ...f.options.history,
        async snapshot() {
          baselineReads++
          return { rows: [historyRow, childRow, workflowRow], errors: [baselineError], totalsLoading: false, generationSpeeds: {} }
        },
      },
    })

    await recoveryEntered.promise
    expect(baselineReads).toBe(0)
    await Promise.resolve()
    executor.bus.publish({
      cursor: sessionCursor("chat"),
      payload: { kind: "session.updated", row: { ...historyRow, activity: "generating" } },
    })
    await executor.bus.drain()
    recovery.resolve()
    const snapshot = await client.query({ type: "snapshot" })

    expect(baselineReads).toBe(1)
    expect(snapshot.rows).toHaveLength(1)
    expect(snapshot.rows[0]).toMatchObject({
      id: "chat",
      admittedActions: ["chat.resume", "session.delete"],
      totalsLoading: false,
      totalTokens: 41,
      totalCost: 3,
      degraded: true,
      unavailableFields: ["createdAt"],
      activity: "generating",
    })
    expect(snapshot.errors).toEqual([baselineError])

    f.metadata.set("chat", { ...metadata, label: "Renamed chat" })
    f.notify({ kind: "changed", sessionIds: ["chat"] })
    expect((await client.query({ type: "snapshot" })).rows[0]).toMatchObject({
      title: "Renamed chat",
      activity: "generating",
      totalTokens: 41,
    })
    await client.close()
    await executor.bus.clear()
  })

  test("delayed executor rows cannot replace newer durable metadata", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const old = durableRow("one", { childSessionIds: ["old-child"], lastUpdated: "2026-01-01T00:00:00Z" })
    f.metadata.set("one", old)
    const client = createProjectControlClient(f.options)
    await client.query({ type: "snapshot" })
    f.metadata.set("one", { ...old, childSessionIds: ["new-child"], lastUpdated: "2026-02-01T00:00:00Z" })
    f.notify({ kind: "changed", sessionIds: ["one"] })
    await client.query({ type: "snapshot" })
    executor.bus.publish({ cursor: sessionCursor("one"), payload: { kind: "session.updated", row: { ...executionRow(old, 42), activity: "generating" } } })
    await executor.bus.drain()
    expect((await client.query({ type: "snapshot" })).rows[0]).toMatchObject({
      childSessionIds: ["new-child"], lastUpdated: "2026-02-01T00:00:00Z", activity: "generating", totalTokens: 42,
    })
    await client.close()
    await executor.bus.clear()
  })

  test("an initial message retains the executor's exact admission path", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const client = createProjectControlClient(f.options)
    void client.dispatch({ type: "chat.open", initialMessage: "hello" })
    await client.query({ type: "snapshot" })
    expect(executor.commands).toEqual([{ type: "chat.open", initialMessage: "hello" }])
    expect(f.creates).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

})
