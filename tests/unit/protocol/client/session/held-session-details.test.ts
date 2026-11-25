import { describe, expect, jest, test } from "bun:test"
import type { AttachedRuntimeClient, FrontendEvent, RuntimeClient, SessionRow } from "../../../../../src/protocol/runtime/app-service-types.js"
import { backgroundReads, type ReadTimers } from "../../../../../src/protocol/client/runtime/background-reads.js"
import { RuntimeLaneLost } from "../../../../../src/protocol/client/runtime/connection-failures.js"
import { createHeldSessionDetails, resolveSessionRoute } from "../../../../../src/protocol/client/session/held-session-details.js"
import type { RuntimeUiPatch } from "../../../../../src/protocol/runtime/runtime-ui-protocol-types.js"
import type { RuntimeSessionDetailSnapshotResult, RuntimeSessionDetailView } from "../../../../../src/protocol/session/session-detail-protocol-types.js"
import { fakeLanes, LANE_BREAK } from "../../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"

const kindOf = (id: string): SessionRow["kind"] => id === "root" ? "chat" : id === "workflow" ? "workflow-agent" : "subagent"
const parentOf = (id: string): string | undefined => id === "root" ? undefined : id === "workflow" ? "root" : "workflow"
/** `parent` null makes a row with no parent. */
function row(id: string, title = id, kind = kindOf(id), parent: string | null = parentOf(id) ?? null): SessionRow {
  const common = {
    id, title, ...(parent === null ? {} : { parentSessionId: parent }),
    lifecycleState: "active" as const, notices: [], lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: "/scratch/project", admittedActions: [], totalsLoading: true as const,
  }
  if (kind === "chat") return { ...common, kind, inputMode: { kind: "chat" } }
  if (kind === "workflow-agent") return { ...common, kind, inputMode: { kind: "message" }, workflowMembership: { kind: "attempt", workflowId: "run", attemptId: `${id}-attempt` } }
  return { ...common, kind, inputMode: { kind: "message" } }
}
function view(id: string, title = id, current = row(id, title)): RuntimeSessionDetailView {
  const detail = {
    id, source: "durable" as const, conversationId: `conv-${id}`, budget: null,
    status: {
      activity: "absent" as const, activityStartedAt: null, settledOutputPosition: null, connectionState: "connected" as const,
      activeSubagentCount: 0, activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
      startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
    },
  }
  if (current.kind === "chat") return { ...detail, kind: current.kind, row: current }
  if (current.kind === "workflow-agent") return { ...detail, kind: current.kind, row: current }
  return { ...detail, kind: current.kind, row: current }
}

/** A detail client whose only read is the detail snapshot `answer` serves.
 *  `deliver` publishes a patch on its lane, and `openLane` opens the next lane. */
function detailClient(answer: (sessionIds: readonly string[]) => Promise<RuntimeSessionDetailSnapshotResult>, dispatch: RuntimeClient["dispatch"] = runtimeDispatch({ "session_detail.release": async () => ({ ok: true }) })) {
  const lanes = fakeLanes()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const subscribe: AttachedRuntimeClient["subscribe"] = (listener) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return {
    query: runtimeQuery({ sessionDetailSnapshot: (request) => answer(request.sessionIds) }),
    dispatch,
    subscribe,
    onLane: lanes.onLane,
    deliver(patch: RuntimeUiPatch): void { for (const listener of listeners) listener({ type: "patch", patch }) },
    openLane: lanes.open,
  }
}

function fixture() {
  const reads: string[] = []
  const released: string[] = []
  let release: (() => void) | undefined
  let gate: Promise<void> | undefined
  const client = detailClient(async (sessionIds) => {
    reads.push(...sessionIds)
    const views = sessionIds.map(sessionId => ({ sessionId, view: view(sessionId) }))
    await gate
    return { snapshotPosition: 0, views }
  }, runtimeDispatch({ "session_detail.release": async (command) => {
    released.push(command.sessionId)
    return { ok: true }
  } }))
  const patch = (id: string, position: number, next: SessionRow | null): RuntimeUiPatch => ({
    cursor: { scope: "session", domain: "session_detail", sessionId: id },
    position, prevPosition: position - 1,
    payload: { kind: "session_detail.changed", row: next },
  })
  return {
    reads, released, client, patch,
    block() { gate = new Promise<void>(resolve => { release = resolve }) },
    unblock() { gate = undefined; release?.() },
  }
}
const settled = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

/** A retry clock whose timers fire only when the test runs them, so a timer
 *  that other work in the same process starts never reaches this test. */
function manualClock() {
  const live = new Map<ReturnType<typeof setTimeout>, () => void>()
  const timers: ReadTimers = {
    setTimeout(fire) {
      // A real handle, already cleared, stands in for each manual timer.
      const handle = setTimeout(() => {}, 0)
      clearTimeout(handle)
      live.set(handle, fire)
      return handle
    },
    clearTimeout(handle) { live.delete(handle) },
  }
  return {
    timers,
    get pending() { return live.size },
    runAll() {
      const due = [...live.values()]
      live.clear()
      for (const fire of due) fire()
    },
  }
}

/** A detail client whose reads fail while `failing` is true. */
function failingClient() {
  const reads: string[] = []
  const control = { failing: true }
  const client = detailClient(async (sessionIds) => {
    reads.push(...sessionIds)
    if (control.failing) throw new Error("unavailable")
    return { snapshotPosition: 0, views: sessionIds.map(sessionId => ({ sessionId, view: view(sessionId) })) }
  })
  return { reads, client, control }
}

describe("held session details", () => {
  test("a new lane reads every held session again and clears a failed read's error", async () => {
    const runtime = fixture()
    const original = runtime.client.query
    let fails = false
    runtime.client.query = async request => {
      const snapshot = await original(request)
      if (fails && request.type === "sessionDetailSnapshot" && request.sessionIds.includes("leaf")) throw new Error("unavailable")
      return snapshot
    }
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      await held.hold("leaf")
      fails = true
      runtime.client.openLane()
      await settled()
      expect(held.state("leaf")?.error).toBe("unavailable")
      fails = false
      const before = runtime.reads.length
      runtime.client.openLane()
      await settled()
      expect(runtime.reads.slice(before)).toEqual(["leaf", "workflow", "root"])
      expect(held.state("leaf")?.error).toBeUndefined()
    } finally { held.dispose() }
  })
  test("held workflow chains follow ordered detail without reading unseen children", async () => {
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      runtime.client.deliver(runtime.patch("unseen", 9, row("unseen", "Unseen")))
      expect(runtime.reads).toEqual([])
      await held.hold("leaf")
      expect(runtime.reads).toEqual(["leaf", "workflow", "root"])
      expect(held.get("workflow")?.kind).toBe("workflow-agent")
      runtime.client.deliver(runtime.patch("workflow", 1, row("workflow", "Renamed")))
      expect(held.get("workflow")?.title).toBe("Renamed")
      // A row change keeps the rest of the detail its read seeded.
      expect(held.view("workflow")).toMatchObject({ source: "durable", row: { title: "Renamed" } })
      held.retainChains(["root"])
      runtime.client.openLane()
      await Promise.resolve()
      expect(runtime.reads).toEqual(["leaf", "workflow", "root", "root"])
      expect(held.rows).toEqual([])
    } finally { held.dispose() }
  })

  test("a session hold reads only that session, and a row of another kind is read again", async () => {
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      expect(held.state("leaf")).toBeUndefined()
      expect(await held.holdSession("leaf")).toEqual({ kind: "held" })
      expect(runtime.reads).toEqual(["leaf"])
      expect(held.state("leaf")).toEqual({ loaded: true })
      runtime.client.deliver(runtime.patch("leaf", 1, row("leaf", "Workflow member now", "workflow-agent")))
      await settled()
      expect(runtime.reads).toEqual(["leaf", "leaf"])
      // The read that the kind change started seeded the cursor again.
      runtime.client.deliver(runtime.patch("leaf", 1, null))
      expect(held.view("leaf")).toBeUndefined()
      expect(held.lost("leaf")?.id).toBe("leaf")
    } finally { held.dispose() }
  })

  test("pending detail snapshots replay newer patches and cannot revive a released hold", async () => {
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      runtime.block()
      const first = held.hold("root")
      runtime.client.deliver(runtime.patch("root", 1, row("root", "Current")))
      runtime.unblock()
      await first
      expect(held.detail("root")?.title).toBe("Current")
      held.forget("root")
      runtime.block()
      const obsolete = held.hold("root")
      held.forget("root")
      runtime.unblock()
      expect((await obsolete).kind).toBe("released")
      expect(held.detail("root")).toBeUndefined()
    } finally { held.dispose() }
  })

  test("a forgotten detail is released once its read answered, and never while this client holds it again", async () => {
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    await held.hold("leaf")
    held.retainChains(["workflow"])
    await settled()
    expect(runtime.released).toEqual(["leaf"])
    // A hold taken again while the forgotten read is in flight keeps the
    // runtime's hold of that detail.
    runtime.block()
    const forgotten = held.hold("other")
    held.forget("other")
    const again = held.hold("other")
    runtime.unblock()
    await Promise.all([forgotten, again])
    await settled()
    expect(runtime.released).toEqual(["leaf"])
    held.dispose()
    await settled()
    expect(runtime.released.toSorted()).toEqual(["leaf", "other", "root", "workflow"])
  })

  test("a failed hold names its cause, and a hold superseded by a refresh answers with the refresh", async () => {
    let answer: "fail" | "gate" | "row" = "fail"
    const gates: (() => void)[] = []
    const client = detailClient(async (sessionIds) => {
      const mode = answer
      if (mode === "fail") throw new Error("detail read timed out")
      if (mode === "gate") await new Promise<void>((resolve) => { gates.push(resolve) })
      if (mode === "gate") throw new Error("lane released")
      return { snapshotPosition: 0, views: sessionIds.map((sessionId) => ({ sessionId, view: view("root", sessionId) })) }
    })
    const held = createHeldSessionDetails({ client, onChange() {} })
    try {
      const failed = await held.hold("child")
      expect(failed.kind).toBe("failed")
      expect(failed.kind === "failed" ? String(failed.cause) : "").toMatch(/detail read timed out/)
      expect(held.state("child")).toEqual({ loaded: false, error: "detail read timed out" })

      // A reconnect refresh supersedes the read in flight, and the open that
      // waited on it gets the refresh's answer instead of a silent failure.
      held.forget("child")
      answer = "gate"
      const superseded = held.hold("child")
      await Promise.resolve()
      answer = "row"
      client.openLane()
      for (const release of gates) release()
      expect(await superseded).toEqual({ kind: "held" })
      expect(held.detail("child")?.title).toBe("child")
      expect(held.state("child")).toEqual({ loaded: true })
    } finally { held.dispose() }
  })

  test("a read that outlasts the hold deadline still seeds and applies the patches that arrived meanwhile", async () => {
    jest.useFakeTimers()
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      runtime.block()
      const holding = held.holdSession("leaf")
      await Promise.resolve()
      runtime.client.deliver(runtime.patch("leaf", 1, row("leaf", "early")))
      jest.advanceTimersByTime(2_000)
      runtime.client.deliver(runtime.patch("leaf", 2, row("leaf", "later")))
      expect(runtime.reads).toEqual(["leaf"])
      runtime.unblock()
      expect(await holding).toEqual({ kind: "held" })
      expect(held.get("leaf")?.title).toBe("later")
    } finally { held.dispose(); jest.useRealTimers() }
  })

  test("a failed read still recovers the patches it held", async () => {
    jest.useFakeTimers()
    let fails = true
    const reads: string[] = []
    const client = detailClient(async (sessionIds) => {
      reads.push(...sessionIds)
      if (fails) { fails = false; throw new Error("unavailable") }
      return { snapshotPosition: 0, views: sessionIds.map(sessionId => ({ sessionId, view: view(sessionId) })) }
    })
    const held = createHeldSessionDetails({ client, onChange() {} })
    try {
      const holding = held.holdSession("leaf")
      client.deliver(fixture().patch("leaf", 1, row("leaf", "early")))
      expect((await holding).kind).toBe("failed")
      jest.advanceTimersByTime(2_000)
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
      expect(reads).toEqual(["leaf", "leaf"])
      expect(held.state("leaf")).toEqual({ loaded: true })
    } finally { held.dispose(); jest.useRealTimers() }
  })

  test("a detail read lost with its lane answers with the next lane's read and shows no failure", async () => {
    const diagnostics: string[] = []
    let lose = true
    const client = detailClient(async (sessionIds) => {
      if (lose) { lose = false; throw new RuntimeLaneLost(new Error("the runtime event lane ended")) }
      return { snapshotPosition: 0, views: sessionIds.map(sessionId => ({ sessionId, view: view("leaf", "leaf", row("leaf", "leaf", "subagent", null)) })) }
    })
    const held = createHeldSessionDetails({ client, onChange() {} })
    backgroundReads(client).diagnose((message) => { diagnostics.push(message) })
    try {
      const opening = held.hold("leaf")
      await settled()
      // The next lane reads every held detail again.
      client.openLane()
      expect(await opening).toEqual({ kind: "held" })
      expect(diagnostics).toEqual([])
      expect(backgroundReads(client).failing).toBe(false)
    } finally {
      held.dispose()
    }
  })

  test("a held read that fails retries after the backoff and its error clears when the read answers", async () => {
    const clock = manualClock()
    const runtime = failingClient()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {}, timers: clock.timers })
    try {
      expect((await held.holdSession("leaf")).kind).toBe("failed")
      expect(held.state("leaf")).toEqual({ loaded: false, error: "unavailable" })
      expect(backgroundReads(runtime.client).failing).toBe(true)
      expect(clock.pending).toBe(1)
      runtime.control.failing = false
      clock.runAll()
      await settled()
      expect(runtime.reads).toEqual(["leaf", "leaf"])
      expect(held.state("leaf")).toEqual({ loaded: true })
      expect(held.detail("leaf")?.id).toBe("leaf")
      expect(backgroundReads(runtime.client).failing).toBe(false)
      expect(clock.pending).toBe(0)
    } finally { held.dispose() }
  })

  test("a lane break cancels the pending retry", async () => {
    const clock = manualClock()
    const runtime = failingClient()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {}, timers: clock.timers })
    try {
      await held.holdSession("leaf")
      expect(clock.pending).toBe(1)
      if (LANE_BREAK.type !== "patch") throw new Error("the lane break is a patch")
      runtime.client.deliver(LANE_BREAK.patch)
      expect(clock.pending).toBe(0)
      // The connection's health explains a broken lane, not the notice.
      expect(backgroundReads(runtime.client).failing).toBe(false)
      clock.runAll()
      await settled()
      expect(runtime.reads).toEqual(["leaf"])
    } finally { held.dispose() }
  })

  test("disposing cancels the pending retry and releases the notice", async () => {
    const clock = manualClock()
    const runtime = failingClient()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {}, timers: clock.timers })
    await held.holdSession("leaf")
    expect(clock.pending).toBe(1)
    held.dispose()
    expect(clock.pending).toBe(0)
    expect(backgroundReads(runtime.client).failing).toBe(false)
    await settled()
    expect(runtime.reads).toEqual(["leaf"])
  })
})

describe("session routes", () => {
  const rows = new Map<string, SessionRow>([
    ["root", row("root")],
    ["workflow", row("workflow")],
    ["leaf", row("leaf")],
    ["loop-a", { ...row("loop-a"), parentSessionId: "loop-b" }],
    ["loop-b", { ...row("loop-b"), parentSessionId: "loop-a" }],
  ])
  const read = async (id: string) => rows.get(id)

  test("names the root chat and the children from it down to the session", async () => {
    expect<unknown>(await resolveSessionRoute(read, "leaf")).toEqual({ root: rows.get("root"), children: [{ id: "workflow", kind: "workflow-agent" }, { id: "leaf", kind: "subagent" }] })
    expect((await resolveSessionRoute(read, "root"))?.children).toEqual([])
  })

  test("answers nothing for an unknown link or a chain that returns to itself", async () => {
    expect(await resolveSessionRoute(read, "gone")).toBeUndefined()
    expect(await resolveSessionRoute(read, "loop-a")).toBeUndefined()
  })
})
