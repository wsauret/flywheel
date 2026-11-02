import assert from "node:assert/strict"
import { test } from "node:test"
import type { FrontendEvent, RuntimeQuery, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { RuntimeSilent } from "../../../src/protocol/client/connection-failures.js"
import { RuntimeCallTimeout } from "../../../src/protocol/runtime-client-deadlines.js"
import type { BudgetView } from "../../../src/protocol/budget-protocol-types.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import type { RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "../../../src/protocol/runtime-ui-protocol-types.js"
import type { GitView } from "../../../src/protocol/git-protocol-types.js"
import { createRuntimeSession } from "./session.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { jest } from "bun:test"
import { createSessionReadings } from "./session-readings.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"
import { fakeConnection } from "./session-connection-fixture.js"
import { configView, modulesView } from "../../../tests/helpers/runtime-views.js"
import { recordedQuery, runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"

function status(activity: StatusView["activity"]): StatusView {
  return { activity, activityStartedAt: 0, settledOutputPosition: activity === "idle" ? 0 : null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [] }
}

function budget(tokens: number, averageGenerationTokensPerSecond?: number): BudgetView {
  return { totalsLoading: false, tokens, contextPromptTokens: tokens / 2, cost: 1.25, billedCost: 0.5, priceUnavailable: true, contextPercent: 10, ...(averageGenerationTokensPerSecond === undefined ? {} : { averageGenerationTokensPerSecond }) }
}

const loadingBudget = (): BudgetView => ({ totalsLoading: true })

function totalTokens(value: ReturnType<typeof createRuntimeSession>["budget"]): number | undefined {
  return value?.totalsLoading === false ? value.totalTokens : undefined
}

function generationSpeed(value: ReturnType<typeof createRuntimeSession>["budget"]): number | undefined {
  return value?.totalsLoading === false ? value.averageGenerationTokensPerSecond : undefined
}

function row(id: string): SessionCatalogRow {
  return { id, kind: "chat", title: id, lifecycleState: "active", notices: [], inputMode: { kind: "chat" }, lastUpdated: "2026-09-06T00:00:00.000Z", executionCwd: "/tmp/project", totalsLoading: true }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve()
}

test("initial status and budget failures retry on the same lane and gap patches wait for backoff", async () => {
  jest.useFakeTimers()
  const link = scriptedConnection()
  const original = link.connection.query
  let fails = true
  link.connection.query = async request => {
    if (fails && (request.type === "statusSnapshot" || request.type === "budgetSnapshot")) {
      link.requests.push({ type: request.type, sessionIds: request.sessionIds })
      throw new Error("unavailable")
    }
    return original(request)
  }
  const readings = createSessionReadings({ connection: link.connection, changed() {} })
  try {
    readings.reconcile([row("a")])
    await settle()
    const failingReads = () => link.requests.filter(request => request.type === "statusSnapshot" || request.type === "budgetSnapshot").length
    assert.equal(backgroundReads(link.connection).failing, true)
    assert.equal(failingReads(), 2)
    assert.equal(jest.getTimerCount(), 2)
    for (let position = 20; position < 25; position++) {
      link.patch("budget", "a", position, position - 1, { kind: "budget.updated", budget: budget(position) })
      await settle()
    }
    assert.equal(failingReads(), 2, "gap recovery does not send RPCs during backoff")
    fails = false
    jest.runOnlyPendingTimers()
    await settle()
    assert.equal(link.requests.filter(request => request.type === "statusSnapshot").length, 2)
    assert.equal(link.requests.filter(request => request.type === "budgetSnapshot").length, 2)
    assert.equal(readings.statuses.get("a")?.activity, "generating")
    assert.equal(readings.budgets.get("a")?.totalsLoading, false)
    assert.equal(backgroundReads(link.connection).failing, false)
    fails = true
    readings.reconcile([row("retired")])
    await settle()
    assert.equal(backgroundReads(link.connection).failing, true)
    readings.reconcile([])
    assert.equal(backgroundReads(link.connection).failing, false, "retired first-read failures release their notice")
  } finally { readings.dispose(); jest.useRealTimers() }
})

test("a read that timed out while the runtime was silent raises no notice and still reads again", async () => {
  // The connection takes many seconds to know a silent lane is dead, and a
  // read's deadline passes first. Recovery is invisible, so the notice waits
  // for a failure of the read's own.
  jest.useFakeTimers()
  const link = scriptedConnection()
  const original = link.connection.query
  let silent = true
  link.connection.query = async request => {
    if (silent && request.type === "statusSnapshot") {
      link.requests.push({ type: request.type, sessionIds: request.sessionIds })
      throw new RuntimeSilent(RuntimeCallTimeout.forDeadline(5_000))
    }
    return original(request)
  }
  const readings = createSessionReadings({ connection: link.connection, changed() {} })
  try {
    readings.reconcile([row("a")])
    await settle()
    assert.equal(backgroundReads(link.connection).failing, false)
    assert.equal(jest.getTimerCount(), 1)
    silent = false
    jest.runOnlyPendingTimers()
    await settle()
    assert.equal(readings.statuses.get("a")?.activity, "generating")
    assert.equal(backgroundReads(link.connection).failing, false)
  } finally { readings.dispose(); jest.useRealTimers() }
})

test("failures from separate tasks retry every failed session in one query per domain", async () => {
  jest.useFakeTimers()
  try {
    for (const count of [3, 12]) {
      const link = scriptedConnection()
      const original = link.connection.query
      const failures: PromiseWithResolvers<never>[] = []
      let failing = true
      link.connection.query = request => {
        if (failing && (request.type === "statusSnapshot" || request.type === "budgetSnapshot")) {
          link.requests.push({ type: request.type, sessionIds: request.sessionIds })
          const failure = Promise.withResolvers<never>()
          failures.push(failure)
          return failure.promise
        }
        return original(request)
      }
      const readings = createSessionReadings({ connection: link.connection, changed() {} })
      try {
        const sessions = Array.from({ length: count }, (_, index) => `session-${index}`)
        const rows: SessionCatalogRow[] = []
        for (const id of sessions) {
          rows.push(row(id))
          readings.reconcile(rows)
          await settle()
        }
        assert.equal(failures.length, count * 2)
        for (const failure of failures) failure.reject(RuntimeCallTimeout.forDeadline(5_000))
        await settle()
        assert.equal(jest.getTimerCount(), 2, "each domain owns one backoff timer")
        failing = false
        const before = link.requests.length
        jest.runOnlyPendingTimers()
        await settle()
        for (const type of ["statusSnapshot", "budgetSnapshot"]) {
          const queries = link.requests.slice(before).filter(request => request.type === type)
          assert.equal(queries.length, 1, `${count} failed sessions cost one ${type} retry`)
          assert.deepEqual(queries[0]?.sessionIds, sessions)
        }
        assert.equal(backgroundReads(link.connection).failing, false)
      } finally { readings.dispose() }
    }
  } finally { jest.useRealTimers() }
})

type RuntimeStatusSnapshotResult = { readonly status: StatusView | null; readonly snapshotPosition: number }
type RuntimeBudgetSnapshotResult = { readonly budget: BudgetView | null; readonly snapshotPosition: number }

function scriptedConnection() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const reads: { type: string; sessionId?: string }[] = []
  /** Each read as sent: one per request, with every session it names. */
  const requests: { type: string; sessionIds: readonly string[] }[] = []
  const statuses = new Map<string, RuntimeStatusSnapshotResult | Promise<RuntimeStatusSnapshotResult>>()
  const budgets = new Map<string, RuntimeBudgetSnapshotResult | Promise<RuntimeBudgetSnapshotResult>>()
  // Scripted per-session answers keep the single shape; a batched read
  // answers every session it names at the newest of their positions.
  const asViews = async <View>(sessionIds: readonly string[], answer: (sessionId: string) => Promise<{ readonly snapshotPosition: number; readonly view: View | null }>): Promise<RuntimeSessionViewsResult<View>> => {
    const singles = await Promise.all(sessionIds.map(answer))
    return { snapshotPosition: Math.max(...singles.map((single) => single.snapshotPosition)), views: sessionIds.map((sessionId, index) => ({ sessionId, view: singles[index]?.view ?? null })) }
  }
  const rows = [row("a"), row("b")]
  let threshold = 1000
  let showBuild = false
  let runtime = { version: "test", buildId: "build-1" }
  let git: GitView = { directories: {} }
  let gitPosition = 0
  const base = fakeConnection([])
  const record = (request: RuntimeQuery) => {
    const sessionIds = "sessionIds" in request ? request.sessionIds : []
    if (!("sessionIds" in request)) reads.push({ type: request.type })
    for (const sessionId of sessionIds) reads.push({ type: request.type, sessionId })
    requests.push({ type: request.type, sessionIds })
  }
  const answer = runtimeQuery({
    snapshot: async () => ({ rows, activeRuntimeCount: rows.length, errors: [], snapshotPosition: 0, projectRoot: "/tmp/project", runtimeVersion: runtime.version, runtimeBuildId: runtime.buildId, chatDefault: { kind: "none" }, executor: { kind: "serving" }, service: { kind: "serving" } }),
    gitSnapshot: async () => ({ git, snapshotPosition: 0 }),
    moduleSnapshot: async () => ({ snapshotPosition: 0, capabilities: modulesView() }),
    configSnapshot: async () => ({ snapshotPosition: 0, config: configView({ proactiveCompactionThreshold: threshold, showBuild }) }),
    projectNotificationSnapshot: async () => ({ notifications: [], snapshotPosition: 0 }),
    statusSnapshot: (request) => asViews(request.sessionIds, async (id) => { const { status: view, snapshotPosition } = await (statuses.get(id) ?? { status: status("generating"), snapshotPosition: 10 }); return { view, snapshotPosition } }),
    budgetSnapshot: (request) => asViews(request.sessionIds, async (id) => { const { budget: view, snapshotPosition } = await (budgets.get(id) ?? { budget: budget(100), snapshotPosition: 10 }); return { view, snapshotPosition } }),
    questionSnapshot: async () => ({ views: [], snapshotPosition: 0 }),
  }, base.query)
  const query = recordedQuery(record, answer)
  const connection: RuntimeConnection = {
    ...base,
    ...lanes.client,
    query,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const deliver = (event: FrontendEvent) => { for (const listener of listeners) listener(event) }
  return {
    connection, reads, requests, statuses, budgets,
    setThreshold(next: number) { threshold = next },
    setShowBuild(next: boolean) { showBuild = next },
    setRuntime(next: { version: string; buildId: string }) { runtime = next },
    gitChanged(next: GitView) {
      git = next
      deliver({ type: "patch", patch: { cursor: { scope: "workspace", domain: "git" }, position: gitPosition + 1, prevPosition: gitPosition, payload: { kind: "git.changed", git } } })
      gitPosition++
    },
    listenerCount: () => listeners.size,
    count: (type: string, sessionId?: string) => reads.filter((read) => read.type === type && (sessionId === undefined || read.sessionId === sessionId)).length,
    patch(domain: "budget" | "status" | "session", sessionId: string, position: number, prevPosition: number, payload: RuntimeUiPatchPayload) {
      deliver({ type: "patch", patch: { cursor: { scope: "session", domain, sessionId }, position, prevPosition, payload } })
    },
    reconnect() { lanes.end(); deliver(LANE_BREAK); lanes.open() },
    invalidateAll() { deliver({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 20, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } }) },
    configChanged() { deliver({ type: "patch", patch: { cursor: { scope: "workspace", domain: "config" }, position: 20, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } }) },
    // An edit made outside this client: the patch names the config, and the settings sheet must re-read it.
    externalConfigChanged() { deliver({ type: "patch", patch: { cursor: { scope: "workspace", domain: "config" }, position: 21, prevPosition: 20, payload: { kind: "config.changed", config: configView() } } }) },
  }
}

test("workspace Git updates retain every directory and replace its branch without changing session selection", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const selected = session.sessionId
    link.gitChanged({ directories: { "/scratch/project": { branch: "main" }, "/linked": { branch: "feature", worktreeRoot: "/linked" } } })
    await settle()
    assert.equal(session.git.directories["/linked"]?.branch, "feature")
    assert.equal(session.git.directories["/scratch/project"]?.branch, "main")
    link.gitChanged({ directories: { "/linked": { branch: "switched", worktreeRoot: "/linked" } } })
    await settle()
    assert.equal(session.git.directories["/linked"]?.branch, "switched")
    assert.equal(session.sessionId, selected)
  } finally { session.dispose() }
})

test("50 budget patches and an invalidation for a session this page does not follow do not query or change the selected budget", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const before = link.count("budgetSnapshot")
    for (let index = 0; index < 50; index += 1) link.patch("budget", "unheld", index + 11, index + 10, { kind: "budget.updated", budget: budget(999) })
    link.patch("budget", "unheld", 61, 60, { kind: "runtime.invalidate", reason: "overflow" })
    await settle()
    assert.equal(link.count("budgetSnapshot"), before)
    assert.equal(totalTokens(session.budget), 100)
  } finally { session.dispose() }
})

test("a card that watches an unlisted child reads its status, hears its patches, and stops following it on release", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const heard: (StatusView | undefined)[] = []
    const release = session.subscribeStatus("child", (view) => { heard.push(view) })
    await settle()
    assert.equal(link.count("statusSnapshot", "child"), 1)
    assert.equal(heard.at(-1)?.activity, "generating")

    link.patch("status", "child", 11, 10, { kind: "status.updated", status: { ...status("idle"), waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "a", name: "a" }] } })
    await settle()
    assert.deepEqual(heard.at(-1)?.replyWaits, [{ sessionId: "a", name: "a" }])

    release()
    const count = heard.length
    link.patch("status", "child", 12, 11, { kind: "status.updated", status: status("generating") })
    await settle()
    assert.equal(heard.length, count)
    assert.equal(session.statuses.has("child"), false)
  } finally { session.dispose() }
})

test("the list and every lane read all followed statuses in one read and all followed budgets in one read", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const batches = (from: number) => link.requests.slice(from).filter((request) => request.type === "statusSnapshot" || request.type === "budgetSnapshot").map((request) => `${request.type} ${[...request.sessionIds].sort().join(",")}`)
    assert.deepEqual(batches(0).sort(), ["budgetSnapshot a,b", "statusSnapshot a,b"])
    const from = link.requests.length
    link.reconnect()
    await settle()
    assert.deepEqual(batches(from).sort(), ["budgetSnapshot a,b", "statusSnapshot a,b"])
    assert.equal(session.statuses.get("b")?.activity, "generating")
    assert.equal(totalTokens(session.budget), 100)
  } finally { session.dispose() }
})

test("global invalidation refreshes resident status and selected budget without reconnecting", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  await settle()
  await session.select("a")
  await settle()
  const beforeBudget = link.count("budgetSnapshot", "a")
  const beforeStatus = link.count("statusSnapshot", "b")
  link.invalidateAll()
  await settle()
  assert.ok(link.count("budgetSnapshot", "a") > beforeBudget)
  assert.ok(link.count("statusSnapshot", "b") > beforeStatus)
  session.dispose()
})

test("budget payloads apply directly in cursor order with config-derived thresholds", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const before = link.count("budgetSnapshot")
    link.patch("budget", "a", 11, 10, { kind: "budget.updated", budget: budget(200, 18.24) })
    assert.deepEqual(session.budget, { totalsLoading: false, totalTokens: 200, contextPromptTokens: 100, cost: 1.25, billedCost: 0.5, priceUnavailable: true, contextPercent: 10, compactionThreshold: 1000, averageGenerationTokensPerSecond: 18.24 })
    link.patch("budget", "a", 9, 8, { kind: "budget.removed" })
    assert.equal(totalTokens(session.budget), 200)
    link.patch("budget", "a", 12, 11, { kind: "budget.updated", budget: budget(300) })
    link.patch("budget", "a", 13, 12, { kind: "budget.updated", budget: budget(400, 24.56) })
    assert.equal(totalTokens(session.budget), 400)
    assert.equal(generationSpeed(session.budget), 24.56)
    link.setThreshold(0)
    link.configChanged()
    await settle()
    assert.equal(session.budget?.compactionThreshold, 0)
    assert.equal(link.count("budgetSnapshot"), before)
    link.patch("budget", "a", 14, 13, { kind: "budget.removed" })
    assert.equal(session.budget, undefined)
  } finally { session.dispose() }
})

test("a real budget gap reads the session at once and replays the patches held during the read", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const pending = Promise.withResolvers<RuntimeBudgetSnapshotResult>()
    link.budgets.set("a", pending.promise)
    const before = link.count("budgetSnapshot")
    link.patch("budget", "a", 12, 11, { kind: "budget.updated", budget: budget(12) })
    assert.equal(totalTokens(session.budget), 100)
    assert.equal(link.count("budgetSnapshot"), before + 1)
    for (let position = 13; position <= 20; position += 1) link.patch("budget", "a", position, position - 1, { kind: "budget.updated", budget: budget(position) })
    assert.equal(totalTokens(session.budget), 100)
    pending.resolve({ budget: budget(12), snapshotPosition: 12 })
    await settle()
    assert.equal(totalTokens(session.budget), 20)
    link.patch("budget", "a", 18, 17, { kind: "runtime.invalidate", reason: "overflow" })
    await settle()
    assert.equal(link.count("budgetSnapshot"), before + 1)
  } finally { session.dispose() }
})

test("status snapshots and patches share ordered intake, including held removals", async () => {
  const link = scriptedConnection()
  const pending = Promise.withResolvers<RuntimeStatusSnapshotResult>()
  link.statuses.set("a", pending.promise)
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    link.patch("status", "a", 11, 10, { kind: "status.updated", status: status("generating") })
    assert.equal(session.activity, undefined)
    pending.resolve({ status: status("idle"), snapshotPosition: 10 })
    await settle()
    assert.equal(session.activity, "generating")
    const before = link.count("statusSnapshot")
    link.patch("status", "a", 10, 9, { kind: "status.updated", status: status("idle") })
    assert.equal(session.activity, "generating")
    assert.equal(link.count("statusSnapshot"), before)
    // A gap reads the session at once, and a removal that arrives during the
    // read waits behind it.
    const recovery = Promise.withResolvers<RuntimeStatusSnapshotResult>()
    link.statuses.set("a", recovery.promise)
    link.patch("status", "a", 13, 12, { kind: "status.updated", status: status("idle") })
    assert.equal(link.count("statusSnapshot"), before + 1)
    link.patch("status", "a", 14, 13, { kind: "status.removed" })
    assert.equal(session.activity, "generating")
    recovery.resolve({ status: status("idle"), snapshotPosition: 13 })
    await settle()
    assert.equal(session.activity, undefined)
    assert.equal(link.count("statusSnapshot"), before + 1)
  } finally { session.dispose() }
})

test("reconnect reseeds selected budget and every resident status despite an unchanged catalog", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    assert.equal(session.busy, true)
    const selected = Promise.withResolvers<RuntimeStatusSnapshotResult>()
    const unselected = Promise.withResolvers<RuntimeStatusSnapshotResult>()
    const cost = Promise.withResolvers<RuntimeBudgetSnapshotResult>()
    link.statuses.set("a", selected.promise)
    link.statuses.set("b", unselected.promise)
    link.budgets.set("a", cost.promise)
    const before = link.count("statusSnapshot")
    link.reconnect()
    await settle()
    assert.equal(link.count("statusSnapshot"), before + 2)
    assert.equal(session.busy, true)
    assert.equal(session.statuses.get("b")?.activity, "generating")
    assert.equal(totalTokens(session.budget), 100)
    selected.resolve({ status: status("idle"), snapshotPosition: 1 })
    unselected.resolve({ status: status("idle"), snapshotPosition: 1 })
    cost.resolve({ budget: budget(20), snapshotPosition: 1 })
    await settle()
    assert.equal(session.busy, false)
    assert.equal(session.statuses.get("b")?.activity, "idle")
    assert.equal(totalTokens(session.budget), 20)
    link.patch("status", "b", 2, 1, { kind: "status.updated", status: status("generating") })
    assert.equal(session.statuses.get("b")?.activity, "generating")
  } finally { session.dispose() }
})

test("a status patch for a session this page neither lists nor holds starts no read and keeps no status", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    // The bus broadcasts every running child's status; an unopened child costs nothing here.
    link.patch("status", "unheld-child", 11, 10, { kind: "status.updated", status: status("generating") })
    link.patch("status", "unheld-child", 12, 11, { kind: "runtime.invalidate", reason: "overflow" })
    await settle()
    assert.equal(link.count("statusSnapshot", "unheld-child"), 0)
    assert.equal(session.statuses.has("unheld-child"), false)
  } finally { session.dispose() }
})

test("the selected session follows its own status patches before any list names it", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    await session.select("unlisted-chat")
    await settle()
    // A catalog change reconciles the listed rows, which do not name the selection yet.
    link.patch("session", "a", 1, 0, { kind: "session.updated", row: row("a") })
    await settle()
    link.patch("status", "unlisted-chat", 11, 10, { kind: "status.updated", status: status("idle") })
    assert.equal(session.statuses.get("unlisted-chat")?.activity, "idle")
  } finally { session.dispose() }
})

test("unselected status invalidation refreshes only its session and holds later patches", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const pending = Promise.withResolvers<RuntimeStatusSnapshotResult>()
    link.statuses.set("b", pending.promise)
    const before = link.count("statusSnapshot", "a")
    link.patch("status", "b", 11, 10, { kind: "runtime.invalidate", reason: "overflow" })
    await settle()
    link.patch("status", "b", 13, 12, { kind: "status.removed" })
    assert.equal(session.statuses.get("b")?.activity, "generating")
    pending.resolve({ status: status("idle"), snapshotPosition: 12 })
    await settle()
    assert.equal(session.statuses.has("b"), false)
    assert.equal(link.count("statusSnapshot", "a"), before)
    assert.equal(link.count("statusSnapshot", "b"), 2)
  } finally { session.dispose() }
})

test("a listed session keeps its budget across a switch away and back, follows its patches while hidden, and reads nothing for the return", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    assert.equal(totalTokens(session.budget), 100)
    await session.select("b")
    await settle()
    link.patch("budget", "a", 11, 10, { kind: "budget.updated", budget: budget(300) })
    const before = link.count("budgetSnapshot", "a")
    void session.select("a")
    // The gauge shows the known budget in the tap, not after a read.
    assert.equal(totalTokens(session.budget), 300)
    await settle()
    assert.equal(link.count("budgetSnapshot", "a"), before)
  } finally { session.dispose() }
})

test("disposal retires every budget and status read", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  await settle()
  const pending = Promise.withResolvers<RuntimeBudgetSnapshotResult>()
  const statusPending = Promise.withResolvers<RuntimeStatusSnapshotResult>()
  link.budgets.set("a", pending.promise)
  link.statuses.set("a", statusPending.promise)
  link.reconnect()
  await settle()
  let changes = 0
  session.onChange(() => { changes += 1 })
  session.dispose()
  assert.equal(link.listenerCount(), 0)
  pending.resolve({ budget: budget(999), snapshotPosition: 40 })
  statusPending.resolve({ status: status("idle"), snapshotPosition: 40 })
  await settle()
  assert.equal(totalTokens(session.budget), 100)
  assert.equal(session.activity, "generating")
  assert.equal(changes, 0)
})

test("catalog removal retires status ownership and a new admission cannot adopt the old read", async () => {
  const link = scriptedConnection()
  const pending = Promise.withResolvers<RuntimeStatusSnapshotResult>()
  link.statuses.set("b", pending.promise)
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    link.patch("session", "b", 1, 0, { kind: "session.removed" })
    link.statuses.set("b", { status: status("idle"), snapshotPosition: 20 })
    link.patch("session", "b", 2, 1, { kind: "session.added", row: row("b") })
    await settle()
    pending.resolve({ status: status("generating"), snapshotPosition: 10 })
    await settle()
    assert.equal(session.statuses.get("b")?.activity, "idle")
    assert.equal(link.count("statusSnapshot", "b"), 2)
  } finally { session.dispose() }
})

test("a reconnect supersedes pending status reads and snapshots cover stale held payloads", async () => {
  const link = scriptedConnection()
  const old = Promise.withResolvers<RuntimeStatusSnapshotResult>()
  link.statuses.set("a", old.promise)
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    const fresh = Promise.withResolvers<RuntimeStatusSnapshotResult>()
    link.statuses.set("a", fresh.promise)
    link.reconnect()
    await settle()
    link.patch("status", "a", 11, 10, { kind: "status.updated", status: status("generating") })
    fresh.resolve({ status: status("idle"), snapshotPosition: 12 })
    await settle()
    assert.equal(session.busy, false)
    old.resolve({ status: status("generating"), snapshotPosition: 10 })
    await settle()
    assert.equal(session.activity, "idle")
    link.patch("status", "a", 13, 12, { kind: "status.updated", status: status("generating") })
    assert.equal(session.busy, true)
  } finally { session.dispose() }
})

test("a reconnect adopts the current runtime identity and an external config change refreshes showBuild, with no remount", async () => {
  const link = scriptedConnection()
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    assert.equal(session.runtimeVersion, "test")
    assert.equal(session.runtimeBuildId, "build-1")
    assert.equal(session.settings?.showBuild, false)
    link.setRuntime({ version: "next", buildId: "build-2" })
    link.reconnect()
    await settle()
    assert.equal(session.runtimeVersion, "next")
    assert.equal(session.runtimeBuildId, "build-2")
    link.setShowBuild(true)
    link.externalConfigChanged()
    await settle()
    assert.equal(session.settings?.showBuild, true)
  } finally { session.dispose() }
})

test("selected budget invalidation preserves its reading on failure and reconnect can recover null", async () => {
  const link = scriptedConnection()
  const diagnostics: string[] = []
  const session = createRuntimeSession({ connection: link.connection, onDiagnostic: (message) => { diagnostics.push(message) } })
  try {
    await settle()
    const pending = Promise.withResolvers<RuntimeBudgetSnapshotResult>()
    link.budgets.set("a", pending.promise)
    link.patch("budget", "a", 11, 10, { kind: "runtime.invalidate", reason: "overflow" })
    await settle()
    assert.equal(link.count("budgetSnapshot", "a"), 2)
    assert.equal(totalTokens(session.budget), 100)
    pending.reject(new Error("offline"))
    await settle()
    assert.ok(diagnostics.includes("budget read failed"))
    assert.equal(totalTokens(session.budget), 100)
    link.budgets.set("a", { budget: null, snapshotPosition: 12 })
    link.reconnect()
    await settle()
    assert.equal(session.budget, undefined)
  } finally { session.dispose() }
})

test("a loading budget keeps the known one until a complete replacement, across reconnects too", async () => {
  const link = scriptedConnection()
  link.budgets.set("a", { budget: budget(100, 18.24), snapshotPosition: 10 })
  const session = createRuntimeSession({ connection: link.connection })
  try {
    await settle()
    link.patch("budget", "a", 11, 10, { kind: "budget.updated", budget: loadingBudget() })
    assert.equal(totalTokens(session.budget), 100)
    assert.equal(generationSpeed(session.budget), 18.24)
    link.patch("budget", "a", 12, 11, { kind: "budget.updated", budget: budget(200, 24.56) })
    assert.equal(totalTokens(session.budget), 200)

    const replacement = Promise.withResolvers<RuntimeBudgetSnapshotResult>()
    link.budgets.set("a", replacement.promise)
    link.reconnect()
    await settle()
    link.patch("budget", "a", 13, 12, { kind: "budget.updated", budget: loadingBudget() })
    link.patch("budget", "a", 15, 14, { kind: "budget.updated", budget: budget(400, 31.25) })
    replacement.resolve({ budget: budget(300, 26), snapshotPosition: 14 })
    await settle()
    assert.equal(totalTokens(session.budget), 400)
    assert.equal(generationSpeed(session.budget), 31.25)

    // A runtime reattached to after a replacement has not read the totals yet.
    link.budgets.set("a", { budget: loadingBudget(), snapshotPosition: 20 })
    link.reconnect()
    await settle()
    assert.equal(totalTokens(session.budget), 400)
    assert.equal(generationSpeed(session.budget), 31.25)
    await session.select("b")
    await settle()
    assert.equal(generationSpeed(session.budget), undefined)
  } finally {
    session.dispose()
  }
})
