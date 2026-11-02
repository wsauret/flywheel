import { expect, test } from "bun:test"
import { createProjectControlClient, type ProjectControlClientOptions, type ProjectControlExecutor } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { textBlock, settle } from "../../protocol/client/_transcript-store-fixtures.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { sessionCursor } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { Schema } from "effect"
import { ExecutorGenerationChangedError, RuntimeStatusSnapshotResultSchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { servingAccountService } from "../../../helpers/account-service-state.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"

const status: StatusView = {
  activity: "idle", activityStartedAt: 0, settledOutputPosition: 0, connectionState: "connected", activeSubagentCount: 0,
  waitingOnBackgroundWork: false, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [],
  startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0,
  compactionStartedAt: null,
  replyWaits: [],
}
const unused = async (): Promise<never> => { throw new Error("unexpected operation") }

async function fixture(privateOffset = 99, publicOffset = 0, preAttachment = false) {
  const catalogRow = projectSessionCatalogRow(durableRow("live"))
  if (catalogRow.kind !== "chat") throw new Error("expected chat")
  const liveRow = { ...catalogRow, activity: "idle" as const }
  let privateBus = createRuntimeUiBus()
  const publicBus = createRuntimeUiBus()
  const bump = (bus: typeof privateBus, count: number) => {
    for (let i = 0; i < count; i++) bus.publish({ cursor: { scope: "workspace", domain: "chat_default" }, payload: { kind: "chat_default.changed", chatDefault: { kind: "pending" } } })
  }
  bump(privateBus, privateOffset)
  bump(publicBus, publicOffset)
  let currentStatus = status
  let content = "initial"
  let dropped = false
  let reset: (() => void) | undefined
  let repair: (() => Promise<void>) | undefined
  let holdRead: (() => Promise<void>) | undefined
  let holdStatus: (() => Promise<void>) | undefined
  let reads = 0
  let snapshots = 0
  const adoptedDefaults: string[] = []
  let receive: ((event: FrontendEvent) => void) | undefined
  const output = (text = "final") => {
    content = text
    return privateBus.publish({ cursor: outputCursor("live"), payload: { kind: "output.delta", delta: { blocks: [{ kind: "upsert", index: 0, blockId: "text:answer", block: textBlock("answer", content) }], visibleMessageCount: 1 } } })
  }
  if (preAttachment) currentStatus = { ...status, settledOutputPosition: output().position }
  const query = runtimeQuery({
    statusSnapshot: async (request) => {
      const view = currentStatus
      await holdStatus?.()
      return { snapshotPosition: 900, views: request.sessionIds.map((sessionId) => ({ sessionId, view })) }
    },
    snapshot: async () => {
      snapshots += 1
      return { snapshotPosition: 900, rows: [liveRow], errors: [], activeRuntimeCount: 0, projectRoot: "/workspace", runtimeVersion: "test", runtimeBuildId: null, chatDefault: snapshots % 2 === 1 ? { kind: "none" } : { kind: "pending" }, executor: { kind: "serving" }, service: { kind: "serving" } }
    },
    outputWindow: async () => {
      reads++
      const block = textBlock("answer", content)
      await holdRead?.()
      return {
        snapshotPosition: privateBus.snapshotPosition({ kind: "cursor", cursor: outputCursor("live") }),
        totalBlocks: 1, visibleMessageCount: 1,
        range: { kind: "ok", consistencyToken: "fixture", anchor: { kind: "tail" }, blocks: [block], streamingToolText: {}, streamingOutputChars: 0,
          window: { startBlockIndex: 0, endBlockIndex: 0, hasBefore: false, hasAfter: false, contentBytes: 0 } },
      }
    },
  })
  const executor: ProjectControlExecutor & { onOutputGap(listener: () => Promise<void>): () => void } = {
    query, dispatch: unused, hideSession: unused, async close() {},
    onOutputGap(listener) { repair = listener; return () => { repair = undefined } },
    subscribe(listener) {
      receive = (event: FrontendEvent) => {
        if (dropped && event.type === "patch" && event.patch.cursor.domain === "output") return
        listener(event)
      }
      privateBus.addListener(receive)
      return () => { if (receive) privateBus.removeListener(receive) }
    },
  }
  const options: ProjectControlClientOptions = {
    executor, bus: publicBus, directories: { projectRoot: "/workspace" }, executionCwd: "/workspace", runtimeVersion: "test", runtimeBuildId: null,
    onExecutionReset(listener) { reset = listener; return () => { reset = undefined } },
    chatDefault: () => ({ kind: "pending" }), setChatDefault(value) { adoptedDefaults.push(value.kind) }, onError(error) { throw error }, endIfWedged: unused, executorState: () => ({ kind: "serving" }),
    updates: { status: () => { throw new Error("unexpected update read") }, setAutoInstall: unused, subscribe: () => () => {} },
    service: servingAccountService(),
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
    awaitGenerationRecovery: async () => {}, authProfiles: { inspect() { throw new Error("unexpected auth") } },
    state: { ...asAsyncEventReadSurface(inMemoryEventReader([])), onStored: () => () => {}, sessions: {
      allocateId: () => "id", createChat: unused, listForIds: async () => ({ sessions: [], errors: [] }),
      read: unused, updateLabel: unused, updateLifecycleState: unused, subscribe: () => () => {}, interruptOwed: unused,
    } },
    history: { start() {}, dispose: async () => {}, recall: unused, transcriptSearch: unused, snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }), sessionSummaryImmediate: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }), waitForTotals: unused,
      sessionDetail: async () => ({ view: null }), sessionChangeSummary: unused, moduleSnapshot: unused },
  }
  const client = createProjectControlClient(options)
  const events: FrontendEvent[] = []
  client.subscribe((event) => events.push(event))
  await client.query({ type: "snapshot" })
  // Establish the executor's live catalog presentation before testing output coordinates.
  privateBus.publish({ cursor: sessionCursor("live"), payload: { kind: "session.added", row: liveRow } })
  await privateBus.drain()
  await publicBus.drain()
  const publicStart = publicOffset + 1
  events.length = 0
  const idle = (position: number) => {
    currentStatus = { ...status, settledOutputPosition: position }
    privateBus.publish({ cursor: statusCursor("live"), payload: { kind: "status.updated", status: currentStatus } })
  }
  // A terminal reads this client through its lane, which is open here.
  const lanes = fakeLanes()
  const attached = { query: client.query, subscribe: client.subscribe, ...lanes.client }
  return { client, attached, events, publicStart, get privateBus() { return privateBus }, publicBus, output, idle, bump,
    setStatus(position: number) { currentStatus = { ...status, settledOutputPosition: position } },
    drop(value: boolean) { dropped = value },
    reset() { if (!reset) throw new Error("missing reset"); reset() },
    async replace() {
      if (!reset || !receive) throw new Error("missing generation subscription")
      reset()
      await privateBus.clear()
      privateBus = createRuntimeUiBus()
      privateBus.addListener(receive)
    },
    repair() { if (!repair) throw new Error("missing repair"); return repair() },
    holdRead(value: (() => Promise<void>) | undefined) { holdRead = value },
    holdStatus(value: (() => Promise<void>) | undefined) { holdStatus = value },
    reads: () => reads,
    adoptedDefaults,
    resetSubscribed: () => reset !== undefined,
    async drain() { await privateBus.drain(); await publicBus.drain() },
    async close() { await client.close(); await privateBus.clear(); await publicBus.clear() },
  }
}

test.each([[99, 0], [0, 99]])("settlement uses actual public output positions with private offset %i and public offset %i", async (privateOffset, publicOffset) => {
  const f = await fixture(privateOffset, publicOffset)
  try {
    const output = f.output()
    f.idle(output.position)
    await f.drain()
    const patches = f.events.flatMap((event) => event.type === "patch" ? [event.patch] : [])
    const publishedOutput = patches.find((patch) => patch.cursor.domain === "output")
    const publishedStatus = patches.find((patch) => patch.payload.kind === "status.updated")
    expect(publishedOutput?.position).toBe(f.publicStart + 1)
    expect(publishedStatus?.payload).toMatchObject({ status: { settledOutputPosition: f.publicStart + 1 } })
    expect(await f.client.query({ type: "statusSnapshot", sessionIds: ["live"] })).toMatchObject({ views: [{ view: { settledOutputPosition: f.publicStart + 1 } }] })
  } finally { await f.close() }
})

async function barrier(f: Awaited<ReturnType<typeof fixture>>) {
  const result = await f.client.query({ type: "statusSnapshot", sessionIds: ["live"] })
  expect(Schema.decodeUnknownSync(RuntimeStatusSnapshotResultSchema)(Schema.encodeUnknownSync(RuntimeStatusSnapshotResultSchema)(result))).toEqual(result)
  return result.views[0]?.view?.settledOutputPosition
}

test("pre-attachment output requires each client's own fresh recovery, not account-only watermarks", async () => {
  const f = await fixture(99, 0, true)
  try {
    const pending = await barrier(f)
    expect(typeof pending).toBe("object")
    f.bump(f.publicBus, 150)
    await f.drain()
    const before = (await f.client.query({ type: "snapshot" })).snapshotPosition
    await f.client.query({ type: "outputWindow", sessionId: "live", request: { range: { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 1024 } } })
    expect(await barrier(f)).toEqual(pending)
    expect((await f.client.query({ type: "snapshot" })).snapshotPosition).toBe(before)
    f.output("next")
    await f.drain()
    const output = f.events.flatMap((event) => event.type === "patch" && event.patch.cursor.domain === "output" ? [event.patch] : []).at(-1)
    expect(output?.payload.kind).toBe("runtime.invalidate")
  } finally { await f.close() }
})

test("status query racing a private output reply cannot acknowledge another client's old transcript", async () => {
  const f = await fixture()
  const first = createTranscriptStore({ connection: f.attached, sessionId: "live" })
  const second = createTranscriptStore({ connection: f.attached, sessionId: "live" })
  try {
    await settle()
    f.drop(true)
    const final = f.output()
    f.idle(final.position)
    await f.drain()
    const pending = await barrier(f)
    if (!pending || typeof pending !== "object") throw new Error("expected recovery requirement")
    const before = (await f.client.query({ type: "snapshot" })).snapshotPosition
    first.recoverSettlement(pending.recovery)
    await settle()
    expect(first.view.blocks).toEqual([textBlock("answer", "final")])
    expect(first.settledOutputRecovery).toBe(pending.recovery)
    expect(second.view.blocks).toEqual([textBlock("answer", "initial")])
    expect(second.settledOutputRecovery).toBeUndefined()
    expect(await barrier(f)).toEqual(pending)
    expect((await f.client.query({ type: "snapshot" })).snapshotPosition).toBe(before)
    second.recoverSettlement(pending.recovery)
    await settle()
    expect(second.view.blocks).toEqual(first.view.blocks)
    expect(second.settledOutputRecovery).toBe(pending.recovery)
  } finally { first.dispose(); second.dispose(); await f.close() }
})

test("an in-flight stale tail cannot satisfy settlement; the fresh read merges and replays later output", async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  f.holdRead(async () => { entered.resolve(); await gate.promise })
  const store = createTranscriptStore({ connection: f.attached, sessionId: "live" })
  try {
    await entered.promise
    f.drop(true)
    const final = f.output()
    f.setStatus(final.position)
    await f.drain()
    const pending = await barrier(f)
    if (!pending || typeof pending !== "object") throw new Error("expected recovery requirement")
    store.recoverSettlement(pending.recovery)
    expect(f.reads()).toBe(1)
    expect(store.settledOutputRecovery).toBeUndefined()
    const freshGate = Promise.withResolvers<void>()
    const freshEntered = Promise.withResolvers<void>()
    f.holdRead(async () => { freshEntered.resolve(); await freshGate.promise })
    gate.resolve()
    await freshEntered.promise
    expect(store.view.blocks).toEqual([textBlock("answer", "initial")])
    expect(store.settledOutputRecovery).toBeUndefined()
    f.drop(false)
    f.output("later")
    await f.drain()
    f.holdRead(undefined)
    freshGate.resolve()
    await settle()
    expect(store.view.blocks).toEqual([textBlock("answer", "later")])
    expect(store.settledOutputRecovery).toBe(pending.recovery)
  } finally { gate.resolve(); store.dispose(); await f.close() }
})

test("final private gap recovery needs no subsequent token or status event", async () => {
  const f = await fixture()
  const store = createTranscriptStore({ connection: f.attached, sessionId: "live" })
  try {
    await settle()
    f.drop(true)
    const final = f.output()
    f.idle(final.position)
    await f.drain()
    const pending = await barrier(f)
    expect(typeof pending).toBe("object")
    await f.repair()
    await f.drain()
    await settle()
    const repaired = await barrier(f)
    if (!repaired || typeof repaired !== "object") throw new Error("expected recovery requirement")
    expect(repaired).not.toEqual(pending)
    store.recoverSettlement(repaired.recovery)
    await settle()
    expect(store.view.blocks).toEqual([textBlock("answer", "final")])
    expect(store.settledOutputRecovery).toBe(repaired.recovery)
  } finally { store.dispose(); await f.close() }
})

test("replacement clears coverage while the account sequence continues, and close releases reset subscription", async () => {
  const f = await fixture()
  try {
    const output = f.output()
    f.setStatus(output.position)
    await f.drain()
    expect(await barrier(f)).toBe(f.publicStart + 1)
    await f.replace()
    await f.drain()
    expect(await barrier(f)).toMatchObject({ recovery: expect.any(String) })
    const next = f.output("replacement")
    expect(next.position).toBe(1)
    f.setStatus(next.position)
    await f.drain()
    expect(await barrier(f)).toBe(f.publicStart + 3)
    f.privateBus.publish({ cursor: statusCursor("live"), payload: { kind: "status.removed" } })
    await f.drain()
    expect(await barrier(f)).toMatchObject({ recovery: expect.any(String) })
  } finally { await f.close() }
  expect(f.resetSubscribed()).toBe(false)
})

test("live, passive and mixed status batches keep request order and public anchors", async () => {
  const f = await fixture()
  try {
    const row = projectSessionCatalogRow(durableRow("passive", { lifecycleState: "inactive" }))
    if (row.kind !== "chat") throw new Error("expected chat catalog row")
    f.privateBus.publish({ cursor: sessionCursor("passive"), payload: { kind: "session.added", row } })
    const output = f.output()
    f.setStatus(output.position)
    await f.drain()
    const snapshotPosition = (await f.client.query({ type: "snapshot" })).snapshotPosition
    const live = await f.client.query({ type: "statusSnapshot", sessionIds: ["live"] })
    const passive = await f.client.query({ type: "statusSnapshot", sessionIds: ["passive"] })
    const mixed = await f.client.query({ type: "statusSnapshot", sessionIds: ["passive", "live"] })
    expect(live.views[0]?.view?.settledOutputPosition).toBe(f.publicStart + 2)
    expect(passive.views).toEqual([{ sessionId: "passive", view: null }])
    expect(mixed).toEqual({ snapshotPosition, views: [...passive.views, ...live.views] })
    expect((await f.client.query({ type: "snapshot" })).snapshotPosition).toBe(snapshotPosition)
  } finally { await f.close() }
})

test("generation replacement rejects a status reply captured in the previous coordinate space", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const gate = Promise.withResolvers<void>()
  try {
    f.setStatus(100)
    f.holdStatus(async () => { entered.resolve(); await gate.promise })
    const read = barrier(f)
    await entered.promise
    f.reset()
    gate.resolve()
    await expect(read).rejects.toBeInstanceOf(ExecutorGenerationChangedError)
  } finally { gate.resolve(); await f.close() }
})

test("recovery coalesces changing requirements and disposal releases client proof", async () => {
  const f = await fixture()
  const store = createTranscriptStore({ connection: f.attached, sessionId: "live" })
  const gate = Promise.withResolvers<void>()
  try {
    await settle()
    f.drop(true)
    f.holdRead(() => gate.promise)
    let last = ""
    for (let index = 0; index < 50; index++) {
      f.setStatus(f.output(String(index)).position)
      await f.drain()
      const pending = await barrier(f)
      if (!pending || typeof pending !== "object") throw new Error("expected recovery requirement")
      last = pending.recovery
      store.recoverSettlement(last)
    }
    expect(f.reads()).toBe(2)
    f.holdRead(undefined)
    gate.resolve()
    await settle()
    expect(f.reads()).toBe(3)
    expect(store.settledOutputRecovery).toBe(last)
    expect(store.view.blocks).toEqual([textBlock("answer", "49")])
    store.dispose()
    expect(store.settledOutputRecovery).toBeUndefined()
  } finally { gate.resolve(); store.dispose(); await f.close() }
})

test("a failed settlement read uses ordinary recovery on reconnect without a new status", async () => {
  const f = await fixture(99, 0, true)
  const store = createTranscriptStore({ connection: f.attached, sessionId: "live", recoveryMaxAttempts: 1 })
  try {
    await settle()
    const pending = await barrier(f)
    if (!pending || typeof pending !== "object") throw new Error("expected recovery requirement")
    f.holdRead(async () => { throw new Error("temporarily unavailable") })
    store.recoverSettlement(pending.recovery)
    await settle()
    expect(store.status).toBe("recovery-failed")
    expect(store.settledOutputRecovery).toBeUndefined()
    f.holdRead(undefined)
    await store.refresh()
    expect(store.status).toBe("ready")
    expect(store.settledOutputRecovery).toBe(pending.recovery)
  } finally { store.dispose(); await f.close() }
})

function publicPatches(f: Awaited<ReturnType<typeof fixture>>) {
  return f.events.flatMap((event) => event.type === "patch" ? [event.patch] : [])
}

test("a gap repair invalidates every client once and each session's next output is its new baseline", async () => {
  const f = await fixture()
  try {
    f.output("covered")
    await f.drain()
    f.drop(true)
    f.output("lost")
    await f.drain()
    f.drop(false)
    await f.repair()
    f.output("after")
    await f.drain()
    const patches = publicPatches(f)
    expect(patches.filter((patch) => patch.cursor.domain === "runtime" && patch.payload.kind === "runtime.invalidate")).toHaveLength(1)
    const outputs = patches.filter((patch) => patch.cursor.domain === "output")
    expect(outputs.at(-1)?.payload.kind).toBe("output.delta")
    expect(outputs.filter((patch) => patch.payload.kind === "runtime.invalidate")).toHaveLength(0)
  } finally { await f.close() }
})

test("a private rebase reaches clients as a rebase even when its session has no coverage", async () => {
  const f = await fixture()
  try {
    f.output()
    f.privateBus.publish({ cursor: statusCursor("live"), payload: { kind: "status.removed" } })
    await f.drain()
    f.privateBus.publish({ cursor: outputCursor("live"), payload: { kind: "runtime.invalidate", reason: "rebase" } })
    await f.drain()
    const last = publicPatches(f).filter((patch) => patch.cursor.domain === "output").at(-1)
    expect(last?.payload).toEqual({ kind: "runtime.invalidate", reason: "rebase" })
  } finally { await f.close() }
})

test("a hole in retained coverage still becomes an invalidation while the repair is pending", async () => {
  const f = await fixture()
  try {
    f.output("covered")
    await f.drain()
    f.drop(true)
    f.output("lost")
    await f.drain()
    f.drop(false)
    f.output("after")
    await f.drain()
    const last = publicPatches(f).filter((patch) => patch.cursor.domain === "output").at(-1)
    expect(last?.payload).toEqual({ kind: "runtime.invalidate", reason: "overflow" })
  } finally { await f.close() }
})

test("a later gap supersedes a repair still reading its snapshot, and the later one completes", async () => {
  const f = await fixture()
  try {
    const first = f.repair()
    const second = f.repair()
    await Promise.all([first, second])
    await f.drain()
    expect(publicPatches(f).filter((patch) => patch.cursor.domain === "runtime" && patch.payload.kind === "runtime.invalidate")).toHaveLength(1)
    // The first snapshot answers "none", the second "pending": only the later repair adopts.
    expect(f.adoptedDefaults).toEqual(["pending"])
  } finally { await f.close() }
})
