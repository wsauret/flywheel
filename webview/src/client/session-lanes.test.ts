import assert from "node:assert/strict"
import { test } from "node:test"
import type { FrontendEvent, RuntimeQuery, RuntimeQueryResult, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { RuntimeLaneLost } from "../../../src/protocol/client/connection-failures.js"
import { RuntimeCallTimeout } from "../../../src/protocol/runtime-client-deadlines.js"
import { jest } from "bun:test"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { Layer } from "effect"
import { Socket } from "effect/socket"
import { createRuntimeSession } from "./session.js"
import { headlessClient } from "./session-host-loader-fixture.js"
import { fakeConnection } from "./session-connection-fixture.js"
import type { HostCapabilities } from "../host.js"
import { detailView, tailWindow } from "../../../tests/helpers/runtime-views.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

const CHAT: SessionCatalogRow = { id: "chat-1", kind: "chat", title: "Chat", lifecycleState: "inactive", inputMode: { kind: "chat" }, notices: [], lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/project", totalsLoading: true }

/** A runtime whose lanes the test opens and breaks. `hold` names the reads
 *  that never answer, `lose` the reads that fail with their lane, `catalog`
 *  holds the catalog read until it resolves, and `gone` names the sessions
 *  whose detail says the runtime does not have them. */
function laneConnection(options: { readonly hold?: readonly string[]; readonly lose?: readonly string[]; readonly catalog?: Promise<void>; readonly gone?: readonly string[] } = {}) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes({ open: false })
  const reads: string[] = []
  const base = fakeConnection([])
  const answer = runtimeQuery({
    snapshot: async () => {
      await options.catalog
      return { rows: [CHAT], activeRuntimeCount: 0, errors: [], snapshotPosition: 0, runtimeVersion: "test", runtimeBuildId: null, projectRoot: "/project", chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }
    },
    sessionDetailSnapshot: async (request) => ({ snapshotPosition: 0, views: request.sessionIds.map((sessionId) => ({ sessionId, view: options.gone?.includes(sessionId) ? null : detailView({ ...CHAT, id: sessionId }) })) }),
    updateSnapshot: async () => ({ update: { revision: 1, autoInstall: { persisted: true, forcedOff: false, effective: true }, status: { kind: "installed", version: "1.0.0" } }, snapshotPosition: 0 }),
    modelAssignments: async () => [],
    outputWindow: async () => tailWindow([], { consistencyToken: "lanes" }),
  }, base.query)
  function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>> {
    reads.push(request.type)
    if (options.hold?.includes(request.type)) return new Promise<never>(() => {})
    if (options.lose?.includes(request.type)) return Promise.reject(new RuntimeLaneLost(new Error("the runtime event lane ended")))
    return answer(request)
  }
  const connection: RuntimeConnection = {
    ...base,
    ...lanes.client,
    state: "connecting",
    query,
    resume() {},
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  return {
    connection,
    lanes,
    count: (type: string) => reads.filter((read) => read === type).length,
    reads,
    breakLane() {
      lanes.end()
      for (const listener of listeners) listener(LANE_BREAK)
    },
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

test("the page reads nothing before its first lane, and the first lane reads each workspace reading once", async () => {
  const fake = laneConnection()
  const session = createRuntimeSession({ connection: fake.connection })
  await settle()
  assert.deepEqual(fake.reads, [])

  fake.lanes.open()
  await settle()
  for (const type of ["snapshot", "updateSnapshot", "commandCatalog", "gitSnapshot", "commandUsageSnapshot"]) assert.equal(fake.count(type), 1, type)
  session.dispose()
})

test("a lane break reads nothing, and the next lane reads the workspace again", async () => {
  const fake = laneConnection()
  const original = fake.connection.query
  let snapshots = 0
  fake.connection.query = async request => {
    if (request.type === "snapshot" && ++snapshots === 1) throw RuntimeCallTimeout.forDeadline(5_000)
    return original(request)
  }
  // The fake clock holds recovery callbacks until the test advances them.
  jest.useFakeTimers()
  const session = createRuntimeSession({ connection: fake.connection })
  try {
    fake.lanes.open()
    await settle()
    assert.equal(snapshots, 1)
    assert.ok(jest.getTimerCount() > 0, "the timed-out catalog waits for backoff")
    const before = fake.reads.length

    fake.breakLane()
    await settle()
    assert.equal(fake.reads.length, before)

    fake.lanes.open()
    await settle()
    assert.equal(snapshots, 2, "the next lane reads the catalog without advancing the backoff clock")
    for (const type of ["updateSnapshot", "commandCatalog"]) assert.equal(fake.count(type), 2, type)
  } finally { session.dispose(); jest.useRealTimers() }
})

test("a cold load reads the addressed transcript beside the catalog read, not after it", async () => {
  const fake = laneConnection({ hold: ["snapshot"] })
  const session = createRuntimeSession({ connection: fake.connection, initialSessionId: "chat-1" })
  fake.lanes.open()
  await settle()

  assert.equal(session.sessionId, "chat-1")
  assert.equal(fake.count("outputWindow"), 1, "the transcript read does not wait for the catalog")
  assert.equal(fake.count("snapshot"), 1)
  session.dispose()
})

// The page that a reload or a reopened tab replaced handed over messages it
// had not delivered. Their chat shows them queued at once, not after the
// first lane, which a connection that stays down never opens.
test("a reloaded page that took over waiting messages shows their chat with them queued before any lane opens", async () => {
  const fake = laneConnection()
  const unsent = [{ sessionId: "chat-1", id: "u1", input: { text: "still waiting", submissionIds: ["u1"] }, timestamp: 0 }]
  const session = createRuntimeSession({ connection: fake.connection, initialSessionId: "chat-1", unsent })
  await settle()
  assert.equal(session.sessionId, "chat-1")
  assert.deepEqual(session.localSubmissions.map((entry) => [entry.input.text, entry.delivery.kind]), [["still waiting", "waiting"]])
  assert.equal(session.opening?.failure, undefined)

  fake.lanes.open()
  await settle()
  assert.equal(session.sessionId, "chat-1")
  assert.equal(fake.count("snapshot"), 1)
  session.dispose()
})

test("a cold load whose session the detail says is gone before the catalog answers stays opening, then opens the default chat and says so", async () => {
  const catalog = Promise.withResolvers<void>()
  const fake = laneConnection({ catalog: catalog.promise, gone: ["gone"] })
  const session = createRuntimeSession({ connection: fake.connection, initialSessionId: "gone" })
  fake.lanes.open()
  await settle()
  // The session the pane opens instead is a catalog row, so the pane waits
  // for the catalog rather than saying that the project has no other chat.
  assert.equal(session.sessionId, "gone")
  assert.notEqual(session.opening, undefined)
  assert.deepEqual(session.notices, [])

  catalog.resolve()
  await settle()
  assert.equal(session.sessionId, "chat-1")
  assert.equal(session.opening, undefined)
  assert.deepEqual(session.notices.map(({ title, message }) => ({ title, message })), [
    { title: "Session not found", message: "Flywheel could not find that session, so it opened another chat." },
  ])
  session.dispose()
})

/** A browser page for whole mounts: its visibility, its session storage,
 *  and the page events a test fires. Answers the restore. */
function pageGlobals() {
  const saved = ["document", "sessionStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  const values = new Map<string, string>()
  const visibility = new Set<() => void>()
  const page = { visibilityState: "visible" }
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
  } })
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    get visibilityState() { return page.visibilityState },
    addEventListener(type: string, listener: () => void) { if (type === "visibilitychange") visibility.add(listener) },
    removeEventListener(type: string, listener: () => void) { if (type === "visibilitychange") visibility.delete(listener) },
  } })
  return {
    show(state: "visible" | "hidden") {
      page.visibilityState = state
      for (const listener of visibility) listener()
    },
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor)
        else Reflect.deleteProperty(globalThis, name)
      }
    },
  }
}

/** Mounts the whole client on `fake`, as a host does on a page load. */
function mountPage(fake: ReturnType<typeof laneConnection>, capabilities: HostCapabilities = {}) {
  headlessClient.setConnection(fake.connection)
  return headlessClient.mountForTest({
    socket: Socket.layerWebSocket("ws://localhost").pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
    capabilities,
  })
}

// The page goes away as a browser unloads it: one pagehide, which the host
// answers only through its capability, never by disposing the client itself.
test("a reloaded page reads the transcript of the session it showed in its first burst, before the catalog answers", async () => {
  const page = pageGlobals()
  try {
    const before = laneConnection()
    let closes = 0
    const close = before.connection.close
    before.connection.close = async () => { closes += 1; await close.call(before.connection) }
    mountPage(before, { releaseOnPageHide: true })
    before.lanes.open()
    await settle()
    assert.equal(headlessClient.session.sessionId, "chat-1")
    dispatchEvent(new Event("pagehide"))
    assert.equal(closes, 1, "the page lets its client go when it hides")

    const after = laneConnection({ hold: ["snapshot"] })
    const second = mountPage(after)
    after.lanes.open()
    await settle()
    assert.equal(headlessClient.session.sessionId, "chat-1")
    assert.equal(after.count("outputWindow"), 1, "the transcript read does not wait for the catalog")
    assert.equal(after.count("snapshot"), 1)
    second.dispose()
  } finally { page.restore() }
})

test("a page saves the reader's place while it is hidden and forgets it when it is shown again", async () => {
  const page = pageGlobals()
  try {
    const before = laneConnection()
    const first = mountPage(before)
    before.lanes.open()
    await settle()
    page.show("hidden")
    page.show("visible")
    // A page that came back was not discarded, so a later mount in it, such
    // as the phone's for another project, opens only what it is asked for.
    first.dispose()

    const after = laneConnection({ hold: ["snapshot"] })
    const second = mountPage(after)
    after.lanes.open()
    await settle()
    assert.equal(headlessClient.session.sessionId, undefined)
    assert.equal(after.count("outputWindow"), 0)
    second.dispose()

    // A page hidden and then discarded restores its place on the next load.
    const kept = laneConnection()
    const third = mountPage(kept)
    kept.lanes.open()
    await settle()
    page.show("hidden")
    third.dispose()
    const reloaded = laneConnection({ hold: ["snapshot"] })
    const fourth = mountPage(reloaded)
    reloaded.lanes.open()
    await settle()
    assert.equal(headlessClient.session.sessionId, "chat-1")
    assert.equal(reloaded.count("outputWindow"), 1)
    fourth.dispose()
  } finally { page.restore() }
})

test("a workspace read lost with its lane shows no failure", async () => {
  const diagnostics: string[] = []
  const fake = laneConnection({ lose: [
    "snapshot", "authStatusSnapshot", "updateSnapshot", "commandCatalog", "configSnapshot", "gitSnapshot", "commandUsageSnapshot", "modelAssignments",
    "moduleSnapshot", "gitAiAttributionSnapshot", "definitionStalenessSnapshot", "mcpStatusSnapshot", "papercutCountSnapshot", "projectNotificationSnapshot", "remoteSnapshot",
  ] })
  const session = createRuntimeSession({ connection: fake.connection, onDiagnostic: (message) => { diagnostics.push(message) } })
  fake.lanes.open()
  await settle()
  assert.deepEqual(diagnostics, [])
  session.dispose()
})
