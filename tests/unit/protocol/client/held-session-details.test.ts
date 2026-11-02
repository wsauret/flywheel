import { describe, expect, test } from "bun:test"
import type { RuntimeClient, SessionRow } from "../../../../src/protocol/app-service-types.js"
import { RuntimeLaneLost } from "../../../../src/protocol/client/connection-failures.js"
import { createHeldSessionDetails, resolveSessionRoute } from "../../../../src/protocol/client/held-session-details.js"
import type { RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import type { RuntimeSessionDetailSnapshotResult, RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"

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

/** A detail client whose only read is the detail snapshot `answer` serves. */
function detailClient(answer: (sessionIds: readonly string[]) => Promise<RuntimeSessionDetailSnapshotResult>, dispatch: RuntimeClient["dispatch"] = runtimeDispatch({ "session_detail.release": async () => ({ ok: true }) })): Pick<RuntimeClient, "query" | "dispatch"> {
  return { query: runtimeQuery({ sessionDetailSnapshot: (request) => answer(request.sessionIds) }), dispatch }
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

describe("held session details", () => {
  test("targeted refresh reads only named held sessions, not their healthy parents or unknown ids", async () => {
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
      held.refresh(["leaf"])
      await settled()
      expect(held.state("leaf")?.error).toBe("unavailable")
      fails = false
      const before = runtime.reads.length
      held.refresh(["leaf", "unheld"])
      await settled()
      expect(runtime.reads.slice(before)).toEqual(["leaf"])
      expect(held.state("leaf")?.error).toBeUndefined()
      expect(held.has("unheld")).toBe(false)
      held.refresh()
      await settled()
      expect(runtime.reads.slice(before + 1)).toEqual(["leaf", "workflow", "root"])
    } finally { held.dispose() }
  })
  test("held workflow chains follow ordered detail without reading unseen children", async () => {
    const runtime = fixture()
    const held = createHeldSessionDetails({ client: runtime.client, onChange() {} })
    try {
      held.accept(runtime.patch("unseen", 9, row("unseen", "Unseen")))
      expect(runtime.reads).toEqual([])
      await held.hold("leaf")
      expect(runtime.reads).toEqual(["leaf", "workflow", "root"])
      expect(held.get("workflow")?.kind).toBe("workflow-agent")
      held.accept(runtime.patch("workflow", 1, row("workflow", "Renamed")))
      expect(held.get("workflow")?.title).toBe("Renamed")
      // A row change keeps the rest of the detail its read seeded.
      expect(held.view("workflow")).toMatchObject({ source: "durable", row: { title: "Renamed" } })
      held.retainChains(["root"])
      held.refresh()
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
      held.accept(runtime.patch("leaf", 1, row("leaf", "Workflow member now", "workflow-agent")))
      await settled()
      expect(runtime.reads).toEqual(["leaf", "leaf"])
      // The read that the kind change started seeded the cursor again.
      held.accept(runtime.patch("leaf", 1, null))
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
      held.accept(runtime.patch("root", 1, row("root", "Current")))
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
      held.refresh()
      for (const release of gates) release()
      expect(await superseded).toEqual({ kind: "held" })
      expect(held.detail("child")?.title).toBe("child")
      expect(held.state("child")).toEqual({ loaded: true })
    } finally { held.dispose() }
  })

  test("a detail read lost with its lane answers with the next lane's read and shows no failure", async () => {
    const diagnostics: string[] = []
    let lose = true
    const client = detailClient(async (sessionIds) => {
      if (lose) { lose = false; throw new RuntimeLaneLost(new Error("the runtime event lane ended")) }
      return { snapshotPosition: 0, views: sessionIds.map(sessionId => ({ sessionId, view: view("leaf", "leaf", row("leaf", "leaf", "subagent", null)) })) }
    })
    const held = createHeldSessionDetails({ client, onChange() {}, onDiagnostic: (message) => { diagnostics.push(message) } })
    try {
      const opening = held.hold("leaf")
      await settled()
      // The next lane reads every held detail again.
      held.refresh()
      expect(await opening).toEqual({ kind: "held" })
      expect(diagnostics).toEqual([])
    } finally {
      held.dispose()
    }
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
