import { describe, expect, test } from "bun:test"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import type { RuntimeQuery, SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { fixture, privateExecutor } from "./_project-control-client-fixture.js"
import { fixture as generationsFixture, settle } from "./_executor-generations-fixture.js"
import { readAskerOf } from "../../../../src/orchestration/app-service/project-executor-generations.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const HISTORY_FILES = 1
const EXECUTOR_FILES = 2

function listedRow(metadata: DurableSessionCatalogRow): SessionCatalogRow {
  const row = projectSessionCatalogRow(metadata)
  if (row.kind !== "chat") throw new Error(`fixture ${metadata.id} is a child, which has no catalog row`)
  return row
}

function statusView(activity: StatusView["activity"], keptCommand = false): StatusView {
  return {
    activity,
    settledOutputPosition: null,
    activityStartedAt: null,
    connectionState: "connected",
    activeSubagentCount: 0,
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: keptCommand ? [{ id: "command", description: "command", toolUseId: "tool", startedAtMs: 1 }] : [],
    activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
    startedAt: 1,
    streamingStartedAt: 1,
    accumulatedActiveMs: 2,
    compactionStartedAt: null, replyWaits: [],
  }
}

/** A client over a private executor and a history that each answer a
 *  session's change summary with their own count, so each read names the
 *  owner that answered it. Only the executor serves image bodies. */
function routingHarness(
  executorRows: readonly SessionCatalogRow[] = [],
  executorStatuses: ReadonlyMap<string, StatusView> = new Map(),
) {
  const executor = privateExecutor()
  const f = fixture()
  for (const id of ["live", "released"]) f.metadata.set(id, durableRow(id, { lifecycleState: "active" }))
  let reset: (() => void) | undefined
  let repair: (() => Promise<void>) | undefined
  let historyDetailReads = 0
  const query = runtimeQuery({
    outputBlockBody: async (request) => ({ blockId: request.request.blockId, images: [{ mediaType: "image/png", data: "AA==" }] }),
    sessionChangeSummary: async () => ({ snapshotPosition: 900, fileCount: EXECUTOR_FILES, unknownFileMutationGaps: 0 }),
    snapshot: async () => ({ rows: [...executorRows], errors: [], activeRuntimeCount: 0, snapshotPosition: 900, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
    statusSnapshot: async (request) => ({ snapshotPosition: 900, views: request.sessionIds.map((sessionId) => ({ sessionId, view: executorStatuses.get(sessionId) ?? null })) }),
  })
  const client = createProjectControlClient({
    ...f.options,
    executor: {
      ...executor.client,
      query,
      onOutputGap(listener) { repair = listener; return () => { repair = undefined } },
    },
    onExecutionReset: (listener) => { reset = listener; return () => {} },
    history: {
      ...f.options.history,
      sessionChangeSummary: async () => ({ fileCount: HISTORY_FILES, unknownFileMutationGaps: 0 }),
      sessionDetail: async () => { historyDetailReads += 1; return { view: null } },
    },
  })
  return {
    client,
    executor,
    durable: (id: string) => f.metadata.get(id)!,
    reset: () => reset?.(),
    repair: () => repair!(),
    historyDetailReads: () => historyDetailReads,
    owner: async (sessionId: string) => {
      const summary = await client.query({ type: "sessionChangeSummary", sessionId })
      return summary.fileCount === HISTORY_FILES ? "history" : "executor"
    },
    publish: async (sessionId: string, payload: { readonly kind: "status.updated"; readonly status: StatusView } | { readonly kind: "status.removed" }) => {
      executor.bus.publish({ cursor: statusCursor(sessionId), payload })
      await executor.bus.drain()
    },
    close: async () => {
      await client.close()
      await executor.bus.clear()
    },
  }
}

/** Which owner serves a session's durable reads: the executor while it
 *  publishes a status for the session or a person's input is in flight,
 *  durable history for every other session. A transcript read always
 *  reaches the executor. */
describe("project control client history routing", () => {
  test.each(["mutationFiles", "mutationPatchWindow"] as const)("a public %s read wakes a paused executor without a preceding transcript read", async (type) => {
    const g = generationsFixture()
    await settle()
    g.latest().die("stopped by signal SIGKILL")
    await settle()
    const f = fixture()
    let historyWaits = 0
    let servedGeneration: number | undefined
    const hash = "a".repeat(64)
    const manifest = { version: 1 as const, root: hash, bytes: 0, entries: 0 }
    const reference = { version: 1 as const, root: hash, bytes: 0, sha256: hash }
    const request = type === "mutationFiles"
      ? { type, sessionId: "released", manifest, offset: 0, maxFiles: 1, maxBytes: 1024 }
      : { type, sessionId: "released", reference, offset: 0, maxBytes: 1024 }
    const missing = { kind: "unavailable" as const, sessionId: "released", requestedOffset: 0, reason: "missing" as const }
    const unavailable = type === "mutationFiles" ? { ...missing, manifest } : { ...missing, reference }
    const serve = async (input: RuntimeQuery) => { servedGeneration = (await g.generations.serving(readAskerOf(input))).generation }
    const query = runtimeQuery({
      mutationFiles: async (input) => { await serve(input); return { ...missing, manifest } },
      mutationPatchWindow: async (input) => { await serve(input); return { ...missing, reference } },
    })
    const client = createProjectControlClient({
      ...f.options,
      executor: { ...privateExecutor().client, query },
      executionPaused: () => g.generations.current.recovery !== undefined,
      awaitGenerationRecovery: async () => { historyWaits += 1; await g.generations.current.recovery?.attempt },
    })
    try {
      await settle()
      historyWaits = 0
      const result = client.query(request).catch((error: unknown) => error)
      await settle()
      await g.clock.advance(1000)
      expect(await result).toEqual(unavailable)
      expect(servedGeneration).toBe(2)
      expect(g.executors).toHaveLength(2)
      expect(historyWaits).toBe(0)
    } finally {
      await client.close()
      await g.generations.close()
    }
  })

  test("a transcript read of a session the executor does not hold reaches the executor", async () => {
    const h = routingHarness()
    await h.client.query({ type: "snapshot" })
    expect(await h.owner("live")).toBe("history")

    expect(await h.client.query({ type: "outputBlockBody", sessionId: "live", request: { blockId: "userMessage:live-user" } })).toMatchObject({ images: [{ data: "AA==" }] })
    expect(h.historyDetailReads()).toBe(0)
    await h.close()
  })

  test.each([["idle", false], ["awaiting_user", false], ["generating", false], ["absent", true], ["absent", false]] as const)("a freshly activated %s session keeps executor reads (kept command: %s)", async (activity, kept) => {
    const executor = privateExecutor()
    const send = Promise.withResolvers<{ ok: true; sessionId: string }>()
    const secondSend = Promise.withResolvers<{ ok: true; sessionId: string }>()
    const f = fixture()
    const durable = durableRow("live", { lifecycleState: "active", ...(kept ? { kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" } } as const : {}) })
    f.metadata.set("live", durable)
    let historyDetailReads = 0
    const query = runtimeQuery({
      sessionChangeSummary: async () => ({ snapshotPosition: 999, fileCount: EXECUTOR_FILES, unknownFileMutationGaps: 0 }),
      outputWindow: async (request) => ({
        snapshotPosition: 999,
        totalBlocks: 1,
        visibleMessageCount: 1,
        range: {
          kind: "ok",
          consistencyToken: "live",
          anchor: request.request.range.anchor,
          window: { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 9 },
          blocks: [{ kind: "text", id: "live-tail", content: "streaming", timestamp: 1 }],
          streamingToolText: {}, streamingOutputChars: 0,
        },
      }),
      statusSnapshot: async (request) => ({
        views: request.sessionIds.map((sessionId) => ({ sessionId, view: statusView(activity, kept) })),
        snapshotPosition: 999,
      }),
    })
    const dispatch = runtimeDispatch({ "session.send": (command) => command.input === "second" ? secondSend.promise : send.promise }, executor.client.dispatch)
    const client = createProjectControlClient({
      ...f.options,
      executor: {
        ...executor.client,
        query,
        dispatch,
      },
      history: {
        ...f.options.history,
        sessionChangeSummary: async () => ({ fileCount: HISTORY_FILES, unknownFileMutationGaps: 0 }),
        sessionDetail: ({ sessionId }) => {
          historyDetailReads += 1
          return f.options.history.sessionDetail({ sessionId })
        },
      },
    })
    await client.query({ type: "snapshot" })
    const sending = activity === "absent" && !kept
    // A held runner and a released session that still owes a command's output
    // both carry an executor status; an in-flight send carries none.
    if (!sending) executor.bus.publish({
      cursor: statusCursor("live"),
      payload: { kind: "status.updated", status: statusView(activity, kept) },
    })
    await executor.bus.drain()

    const heldSend = sending ? client.dispatch({ type: "session.send", sessionId: "live", input: "steer" }) : undefined
    const heldSecond = sending ? client.dispatch({ type: "session.send", sessionId: "live", input: "second" }).catch((error: unknown) => error) : undefined
    const summaryRequest = { type: "sessionChangeSummary", sessionId: "live" } as const
    expect(await client.query(summaryRequest)).toMatchObject({ fileCount: EXECUTOR_FILES })
    expect(await client.query({ type: "outputWindow", sessionId: "live", request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 32_000 } } })).toMatchObject({
      range: { blocks: [{ id: "live-tail", content: "streaming" }] },
    })
    expect(await client.query({ type: "statusSnapshot", sessionIds: ["live"] })).toMatchObject({
      views: [{ sessionId: "live", view: { activity } }],
    })
    expect(historyDetailReads).toBe(0)

    send.resolve({ ok: true, sessionId: "live" })
    await heldSend
    if (heldSecond) {
      expect(await client.query(summaryRequest)).toMatchObject({ fileCount: EXECUTOR_FILES })
      const error = new Error("send failed")
      secondSend.reject(error)
      expect(await heldSecond).toBe(error)
      expect(await client.query(summaryRequest)).toMatchObject({ fileCount: HISTORY_FILES })
    }
    expect(historyDetailReads).toBe(0)
    await client.close()
    await executor.bus.clear()
  })

  test("an attached runner's idle catalog row reads the executor before any status arrives", async () => {
    const h = routingHarness()
    await h.client.query({ type: "snapshot" })
    expect(await h.owner("live")).toBe("history")

    h.executor.bus.publish({ cursor: sessionCursor("live"), payload: { kind: "session.updated", row: { ...listedRow(h.durable("live")), activity: "idle" } } })
    await h.executor.bus.drain()

    expect(await h.owner("live")).toBe("executor")
    expect(h.historyDetailReads()).toBe(0)
    await h.close()
  })

  test("status.removed routes a session back to history", async () => {
    const h = routingHarness()
    await h.client.query({ type: "snapshot" })
    await h.publish("live", { kind: "status.updated", status: statusView("idle") })
    expect(await h.owner("live")).toBe("executor")

    await h.publish("live", { kind: "status.removed" })

    expect(await h.owner("live")).toBe("history")
    expect(h.historyDetailReads()).toBe(0)
    await h.close()
  })

  test("an executor generation reset routes reads to history until a new status arrives", async () => {
    const h = routingHarness()
    await h.client.query({ type: "snapshot" })
    await h.publish("live", { kind: "status.updated", status: statusView("idle") })
    expect(await h.owner("live")).toBe("executor")

    h.reset()
    expect(await h.owner("live")).toBe("history")

    await h.publish("live", { kind: "status.updated", status: statusView("idle") })
    expect(await h.owner("live")).toBe("executor")
    expect(h.historyDetailReads()).toBe(0)
    await h.close()
  })

  test("gap repair holds every session the executor reports a status for, whatever its catalog activity", async () => {
    const h = routingHarness([
      { ...listedRow(durableRow("live", { lifecycleState: "active" })), activity: "idle" },
      { ...listedRow(durableRow("released", { lifecycleState: "active" })), activity: "absent" },
    ], new Map([["live", statusView("idle")], ["released", statusView("absent", true)]]))
    await h.client.query({ type: "snapshot" })
    expect(await h.owner("live")).toBe("history")
    expect(await h.owner("released")).toBe("history")

    await h.repair()

    expect(await h.owner("live")).toBe("executor")
    expect(await h.owner("released")).toBe("executor")
    expect(h.historyDetailReads()).toBe(0)
    await h.close()
  })
})
