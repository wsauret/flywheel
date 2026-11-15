import { describe, expect, test } from "bun:test"
import type { FrontendEvent, SessionCatalogError, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import type { RuntimeBackgroundSummaryResult } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { fixture, never, privateExecutor } from "./_project-control-client-fixture.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { composeModuleServices, moduleServiceKey } from "../../../../src/infra/module-service.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { composeAccountModuleProtocolRuntimes } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { createLeadControl } from "../../../../src/orchestration/modules/lead/control.js"
import { leadModule } from "../../../../src/orchestration/modules/lead/module.js"

function listedRow(metadata: DurableSessionCatalogRow): SessionCatalogRow {
  const row = projectSessionCatalogRow(metadata)
  if (row.kind !== "chat") throw new Error(`fixture ${metadata.id} is a child, which has no catalog row`)
  return row
}

describe("account project control catalog", () => {
  test("targeted refresh replaces only requested metadata errors and invalidates only on change", async () => {
    const f = fixture()
    const bus = createRuntimeUiBus()
    const one = durableRow("one", { label: "One" })
    const errors = [
      { sessionId: "one", scope: "metadata" as const, reason: "old metadata" },
      { sessionId: "one", scope: "output" as const, reason: "output warning" },
      { sessionId: "other", scope: "metadata" as const, reason: "other metadata" },
    ] as const
    const targetedError = { sessionId: "one", scope: "metadata" as const, reason: "new metadata" }
    let targetedErrors = [targetedError]
    const client = createProjectControlClient({
      ...f.options,
      bus,
      history: {
        ...f.options.history,
        snapshot: async () => ({ rows: [listedRow(one)], errors, totalsLoading: true, generationSpeeds: {} }),
      },
      state: {
        ...f.options.state,
        sessions: {
          ...f.options.state.sessions,
          listForIds: async () => ({ sessions: [one], errors: targetedErrors }),
        },
      },
    })
    const events: FrontendEvent[] = []
    client.subscribe((event) => events.push(event))
    await client.query({ type: "snapshot" })

    f.notify({ kind: "changed", sessionIds: ["one"] })
    const refreshed = await client.query({ type: "snapshot" })
    await bus.drain()
    expect(refreshed.errors).toEqual([errors[1], errors[2], targetedError])
    const invalidations = () => events.filter((event) => event.type === "patch" && event.patch.payload.kind === "runtime.invalidate")
    expect(invalidations()).toHaveLength(1)
    expect(invalidations()[0]).toMatchObject({ patch: { cursor: sessionCursor("one") } })

    f.notify({ kind: "changed", sessionIds: ["one"] })
    await client.query({ type: "snapshot" })
    await bus.drain()
    expect(invalidations()).toHaveLength(1)

    targetedErrors = []
    f.notify({ kind: "changed", sessionIds: ["one"] })
    await client.query({ type: "snapshot" })
    await bus.drain()
    expect(invalidations()).toHaveLength(2)

    f.notify({ kind: "deleted", sessionId: "one" })
    const deleted = await client.query({ type: "snapshot" })
    expect(deleted.errors).toEqual([errors[2]])
    await client.close()
    await bus.clear()
  })

  test("deleting a session listed only by its errors tells clients to read the snapshot without it", async () => {
    const f = fixture()
    const bus = createRuntimeUiBus()
    const unreadable = { sessionId: "broken", scope: "metadata" as const, reason: "corrupt event row" }
    const client = createProjectControlClient({
      ...f.options,
      bus,
      history: { ...f.options.history, snapshot: async () => ({ rows: [], errors: [unreadable], totalsLoading: true, generationSpeeds: {} }) },
    })
    const events: FrontendEvent[] = []
    client.subscribe((event) => events.push(event))
    expect((await client.query({ type: "snapshot" })).errors).toEqual([unreadable])

    f.notify({ kind: "deleted", sessionId: "broken" })
    const deleted = await client.query({ type: "snapshot" })
    await bus.drain()

    expect(deleted.errors).toEqual([])
    expect(events.filter((event) => event.type === "patch" && event.patch.payload.kind === "runtime.invalidate"))
      .toMatchObject([{ patch: { cursor: sessionCursor("broken") } }])
    await client.close()
    await bus.clear()
  })

test("a failed history baseline keeps the changes heard meanwhile and is read again by the next catalog step", async () => {
    const f = fixture()
    f.metadata.set("one", durableRow("one", { label: "One" }))
    const deadline = new Error("history deadline")
    let baselines = 0
    const heard = Promise.withResolvers<void>()
    const client = createProjectControlClient({
      ...f.options,
      history: {
        ...f.options.history,
        async snapshot() {
          if (++baselines === 1) throw deadline
          return { rows: [listedRow(durableRow("one", { label: "One" }))], errors: [], totalsLoading: true, generationSpeeds: {} }
        },
      },
      state: { ...f.options.state, sessions: { ...f.options.state.sessions, async listForIds(ids) {
        if (ids.includes("three")) heard.resolve()
        return f.options.state.sessions.listForIds(ids)
      } } },
    })
    f.metadata.set("one", durableRow("one", { label: "Renamed" }))
    f.metadata.set("two", durableRow("two", { label: "Two" }))
    f.notify({ kind: "changed", sessionIds: ["one", "two"] })
    await expect(client.query({ type: "snapshot" })).rejects.toBe(deadline)
    expect(f.failures).toEqual([deadline])

    // A change heard after the failure schedules its own step, which reads
    // the baseline again and then applies every change still queued.
    f.metadata.set("three", durableRow("three", { label: "Three" }))
    f.notify({ kind: "changed", sessionIds: ["three"] })
    await heard.promise
    const snapshot = await client.query({ type: "snapshot" })
    expect(baselines).toBe(2)
    expect(snapshot.rows.map((row) => [row.id, row.title])).toEqual([["one", "Renamed"], ["two", "Two"], ["three", "Three"]])
    await client.close()
  })

  test("a summary that completes after the baseline publishes its budget warning", async () => {
    const f = fixture()
    const bus = createRuntimeUiBus()
    f.metadata.set("one", durableRow("one", { label: "One" }))
    const totals = Promise.withResolvers<RuntimeBackgroundSummaryResult>()
    const client = createProjectControlClient({ ...f.options, bus, history: { ...f.options.history, waitForTotals: () => totals.promise } })
    const invalidated = Promise.withResolvers<void>()
    client.subscribe((event) => {
      if (event.type === "patch" && event.patch.payload.kind === "runtime.invalidate") invalidated.resolve()
    })
    const loading = await client.query({ type: "snapshot" })
    expect(loading.rows[0]?.totalsLoading).toBe(true)
    expect(loading.errors).toEqual([])

    const budget: SessionCatalogError = { sessionId: "one", scope: "budget", reason: "price table unreadable" }
    totals.resolve({
      rows: [{ ...listedRow(durableRow("one", { label: "One" })), totalsLoading: false, totalCost: 1, totalBilledCost: 1, priceUnavailable: false, totalTokens: 100, contextPercent: 10, contextPromptTokens: 100, durationMs: 50 }],
      // A metadata error belongs to the targeted metadata read, not to this summary.
      errors: [budget, { sessionId: "one", scope: "metadata", reason: "not the summary's" }],
      totalsLoading: false,
      generationSpeeds: {},
    })
    await invalidated.promise
    const ready = await client.query({ type: "snapshot" })
    expect(ready.rows[0]?.totalsLoading).toBe(false)
    expect(ready.errors).toEqual([budget])
    await client.close()
    await bus.clear()
  })

  test("renaming a degraded workflow agent keeps its degradation, membership, and admitted actions", async () => {
    const f = fixture()
    const workflowMembership = { kind: "attempt", workflowId: "run", attemptId: "step" } as const
    const flow = durableRow("flow", { kind: "workflow-agent", command: "workflow-agent", workflowMembership, degraded: true, unavailableFields: ["createdAt"] })
    f.metadata.set("flow", flow)
    const warning: SessionCatalogError = { sessionId: "flow", scope: "metadata", reason: "createdAt unreadable" }
    const client = createProjectControlClient({ ...f.options, state: { ...f.options.state, sessions: { ...f.options.state.sessions,
      listForIds: async (ids) => ({ sessions: ids.flatMap((id) => f.metadata.get(id) ?? []), errors: ids.includes("flow") ? [warning] : [] }),
    } } })
    await client.query({ type: "snapshot" })
    const renamed = await client.dispatch({ type: "session.rename", sessionId: "flow", title: "Renamed flow" })
    const expected = { title: "Renamed flow", degraded: true, unavailableFields: ["createdAt"], workflowMembership, admittedActions: ["session.delete"] }
    expect(renamed).toEqual({ ok: true, sessionId: "flow" })
    const metadata = f.metadata.get("flow")
    if (!metadata) throw new Error("Renamed workflow metadata is missing")
    expect(projectSessionCatalogRow(metadata)).toMatchObject(expected)
    const snapshot = await client.query({ type: "snapshot" })
    expect(snapshot.rows).toEqual([])
    expect(snapshot.errors).toEqual([warning])
    await client.close()
  })

  test("paused close controls settle on durable state without an executor, and tell the control parts of each close of a known chat", async () => {
    const executor = privateExecutor()
    const f = fixture(executor.client)
    const closes: unknown[] = []
    const client = createProjectControlClient({ ...f.options, executionPaused: () => true, onPausedChatClosed: (close) => { closes.push(close) } })
    f.metadata.set("open", durableRow("open", { label: "Open", lifecycleState: "active" }))
    expect(await client.dispatch({ type: "session.close", sessionId: "open" })).toMatchObject({ ok: true, sessionCatalogRow: { lifecycleState: "inactive" } })
    expect(await client.dispatch({ type: "session.close", sessionId: "unknown" })).toEqual({ ok: true, sessionId: "unknown" })
    await client.dispatch({ type: "session.close", sessionId: "open", atRest: true })
    expect(closes).toEqual([{ sessionId: "open", tabClose: false }, { sessionId: "open", tabClose: true }])
    expect(await client.dispatch({ type: "session.discard_transient", sessionId: "open" })).toEqual({ ok: true, sessionId: "open", sessionRemoved: false })
    expect(executor.commands).toEqual([])
    await client.close()
    await executor.bus.clear()
  })

  test("a row the executor answers and a person's sessionDetail read void that row's baseline, so the account's next equal row reaches the caller", async () => {
    const executor = privateExecutor()
    const metadata = durableRow("one", { label: "One", lifecycleState: "active" })
    // The executor's row carries a title older than the durable metadata.
    const executorRow: SessionCatalogRow = {
      ...listedRow(durableRow("one", { label: "Stale", lifecycleState: "active" })),
      totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalTokens: 7, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
    }
    const dispatch = runtimeDispatch({ "session.close": async (command) => ({ ok: true, sessionId: command.sessionId, sessionCatalogRow: executorRow }) })
    const query = runtimeQuery({ sessionDetail: async () => ({ view: null }) })
    const f = fixture({ ...executor.client, dispatch, query })
    f.metadata.set("one", metadata)
    const bus = createRuntimeUiBus({ publishOnChange: true })
    const client = createProjectControlClient({ ...f.options, bus })
    const rows: SessionCatalogRow[] = []
    client.subscribe((event) => { if (event.type === "patch" && event.patch.payload.kind === "session.updated") rows.push(event.patch.payload.row) })
    const relay = async (): Promise<void> => {
      executor.bus.publish({ cursor: sessionCursor("one"), payload: { kind: "session.updated", row: executorRow } })
      await executor.bus.drain()
      await bus.drain()
    }
    await client.query({ type: "snapshot" })
    await relay()
    await relay()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ title: "One", totalTokens: 7 })
    expect(await client.dispatch({ type: "session.close", sessionId: "one" })).toMatchObject({ sessionCatalogRow: executorRow })
    await relay()
    expect(rows).toHaveLength(2)
    await client.query({ type: "sessionDetail", sessionId: "one" })
    await relay()
    expect(rows).toHaveLength(3)
    expect(rows[2]).toEqual(rows[0]!)
    await client.close()
    await Promise.all([bus.clear(), executor.bus.clear()])
  })

  // The client that shows a new chat activates it, so the open itself asks
  // the executor for nothing and the chat gets one attach under that hold.
  test("an open attaches no runner, and a failed activation keeps its committed session", async () => {
    const executor = privateExecutor()
    const refused = new Error("activation unavailable")
    const dispatched: string[] = []
    const f = fixture({ ...executor.client, dispatch: async (command) => { dispatched.push(command.type); throw refused } })
    const client = createProjectControlClient(f.options)
    const opened = await client.dispatch({ type: "chat.open" })
    expect(opened).toMatchObject({ ok: true })
    await client.query({ type: "snapshot" })
    expect(dispatched).toEqual([])
    if (!opened.ok || opened.sessionId === undefined) throw new Error("open failed")
    expect(await client.dispatch({ type: "session.activate", sessionId: opened.sessionId })).toMatchObject({ ok: true })
    await client.query({ type: "snapshot" })
    await client.close()
    expect(dispatched).toEqual(["session.activate"])
    expect(f.failures).toContain(refused)
    expect(f.metadata.size).toBe(1)
    await executor.bus.clear()
  })

  // The first tab of a launch is the lead, which the account answers from its own state and the chat open that
  // `chat.open` runs, so the launch never waits for a busy executor (ARCH-STRUCTURE-045).
  for (const executorDispatch of ["throws", "never resolves"] as const) {
    test(`lead.open on launch answers the lead chat with its row and designates it while the executor's dispatch ${executorDispatch}`, async () => {
      const dispatched: string[] = []
      const f = fixture({ ...privateExecutor().client, dispatch: (command) => {
        dispatched.push(command.type)
        return executorDispatch === "throws" ? Promise.reject(new Error("executor busy")) : never()
      } })
      const directory = mkdtempSync(join(tmpdir(), "lead-control-"))
      const store = createSqliteEventStore(join(directory, "events.sqlite"))
      try {
        // The production wiring of project-control-runtime.ts: the control part's chat ports are the facade's own.
        const ports = { openChat: (chat: { readonly name: string }) => client.openChat(chat), chatRow: (sessionId: string) => client.chatRow(sessionId), onChatClosed: () => () => {} }
        const control = createLeadControl({
          projectionReader: asAsyncEventReadSurface(store), eventWriter: asAsyncEventWriter(store), onStored: store.onStored,
          publish: () => undefined, onSelectionChanged: () => () => {}, modules: composeModuleServices([]), enabled: () => true, ...ports,
        })
        const accountModules = composeAccountModuleProtocolRuntimes([leadModule], {
          modules: composeModuleServices([[moduleServiceKey("lead", "control"), control]]), publish: () => undefined, snapshotPosition: () => 0,
        }, () => ["lead"])
        const client = createProjectControlClient({ ...f.options, accountModules })

        const opened = await client.dispatch({ type: "lead.open", reason: "launch" })
        if (!opened.ok || opened.sessionId === null) throw new Error("expected the lead to open")
        expect(opened).toMatchObject({ created: true, row: { id: opened.sessionId, kind: "chat", title: "Lead" } })
        // A chat opened with a name is born with that name as the person's choice, so no generated title replaces it.
        expect(f.creates).toEqual([expect.objectContaining({ id: opened.sessionId, name: "Lead", userNamed: true })])
        expect(store.read({ aggregateId: "lead" }).map((fact) => [fact.type, fact.payload])).toEqual([["lead.chat.designated", { sessionId: opened.sessionId }]])
        expect(await client.dispatch({ type: "lead.open", reason: "launch" })).toMatchObject({ ok: true, sessionId: opened.sessionId, created: false })
        expect(dispatched).toEqual([])
        await control.dispose()
        await client.close()
      } finally {
        store.close()
        rmSync(directory, { recursive: true, force: true })
      }
    })
  }

  // A client whose open was lost with its connection sends the same open
  // again on the next lane. The copy can arrive while the first one still
  // creates, or after it: either way it answers the one chat that exists.
  test("an open that names its chat creates that chat once and answers every copy with it", async () => {
    const f = fixture()
    const client = createProjectControlClient(f.options)
    const creating = Promise.withResolvers<void>()
    f.blockCreate(creating.promise)
    const first = client.dispatch({ type: "chat.open", sessionId: "0123456789ab" })
    const copy = client.dispatch({ type: "chat.open", sessionId: "0123456789ab" })
    creating.resolve()
    expect(await first).toMatchObject({ ok: true, sessionId: "0123456789ab", sessionCatalogRow: { id: "0123456789ab", title: "New Chat" } })
    expect(await copy).toMatchObject({ ok: true, sessionId: "0123456789ab", sessionCatalogRow: { id: "0123456789ab" } })
    const created = f.creates.length
    expect(await client.dispatch({ type: "chat.open", sessionId: "0123456789ab" })).toMatchObject({ ok: true, sessionId: "0123456789ab" })
    expect(f.creates).toHaveLength(created)
    expect([...f.metadata.keys()]).toEqual(["0123456789ab"])
    await client.close()
  })
})
