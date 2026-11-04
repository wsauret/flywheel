import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"

import type { ChildSessionRow, FrontendOutputBlock, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import { createMutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"
import type { TranscriptStore, TranscriptView } from "../../../src/protocol/client/transcript-store.js"
import { EMPTY_TRANSCRIPT_VIEW } from "../../../src/protocol/client/transcript-store-paging.js"
import { fakeRuntimeSession } from "../app/client-context-fixture.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { statusView as idleStatus } from "../../../tests/helpers/runtime-views.js"
import type { RuntimeSession } from "./session.js"
import { createViewProjection, summaryOf } from "./view-state.js"

/** Stands in for every transcript member the view projection does not call. */
const unused = (): never => { throw new Error("the view projection does not call this member") }

const created: RuntimeSession[] = []
afterEach(() => { for (const held of created.splice(0)) held.dispose() })

/** The real idle session with `members` in place of its own; disposed after each test. */
function session(members: Partial<RuntimeSession>): RuntimeSession {
  const held = fakeRuntimeSession(members)
  created.push(held)
  return held
}

/** A ready transcript showing `view` over the empty window. */
function transcript(view: Partial<TranscriptView>): TranscriptStore {
  return {
    mutationEvidence: createMutationEvidenceReader({ connection: { query: unused }, sessionId: "selected" }),
    view: { ...EMPTY_TRANSCRIPT_VIEW, ...view },
    windowGeneration: 0,
    settledOutputRecovery: undefined,
    recoverSettlement: unused,
    status: "ready",
    windowCurrent: false,
    unavailable: undefined,
    hydrateBody: unused,
    releaseBodies: unused,
    hydrateGroup: unused,
    jumpToLatest: unused,
    refresh: unused,
    open: unused,
    openAround: unused,
    loadOlder: unused,
    loadNewer: unused,
    dropBefore: unused,
    onChange: unused,
    dispose: unused,
  }
}

function statusView(overrides: Partial<StatusView>): StatusView {
  return { ...idleStatus(), ...overrides }
}

const buildViewState = createViewProjection()

test("the intro branch follows the open session's directory and falls back only when no directory is known", () => {
  const git = { directories: { "/project": { branch: "main" }, "/linked/package": { branch: "feature", worktreeRoot: "/linked" } } }
  assert.equal(buildViewState(session({ projectRoot: "/project", git, executionCwd: "/linked/package" })).branch, "feature")
  assert.equal(buildViewState(session({ projectRoot: "/project", git, executionCwd: "/plain" })).branch, undefined)
  assert.equal(buildViewState(session({ projectRoot: "/project", git, executionCwd: undefined })).branch, "main")
  assert.equal(buildViewState(session({ projectRoot: "/project", git: { directories: { ...git.directories, "/linked/package": { branch: "switched" } } }, executionCwd: "/linked/package" })).branch, "switched")
})

test("view summaries treat totals loading as replacement state", () => {
  const base = {
    id: "session-a", kind: "chat" as const, title: "Session A", lifecycleState: "inactive" as const,
    notices: [], inputMode: { kind: "chat" as const }, lastUpdated: "2026-09-18T12:00:00.000Z",
    executionCwd: "/tmp/project",
  }
  const loading = buildViewState(session({ sessions: [{ ...base, totalsLoading: true }] })).sessions[0]
  assert.equal(loading?.totalsLoading, true)
  const ready = buildViewState(session({ sessions: [{
    ...base, totalsLoading: false, totalCost: 1.25, totalBilledCost: 0.5, priceUnavailable: false,
    totalTokens: 100, contextPercent: 10, contextPromptTokens: 50, durationMs: 1000,
  }] })).sessions[0]
  assert.notEqual(ready, loading)
  assert.equal(ready?.totalsLoading, false)
  assert.equal(ready?.totalCost, 1.25)
  assert.equal(ready?.priceUnavailable, false)
})

describe("view state stage", () => {
  test("starts until the first project snapshot lands, whatever the runtime is doing", () => {
    assert.equal(buildViewState(session({ health: { kind: "faulted", since: 1 }, projectRoot: undefined })).stage, "starting")
    assert.equal(buildViewState(session({ health: { kind: "healthy" }, projectRoot: undefined })).stage, "starting")
  })

  test("stays ready through a lost runtime once a snapshot has landed, and carries the fault", () => {
    const frame = buildViewState(session({ projectRoot: "/project", health: { kind: "faulted", since: 1, cause: "gone" } }))
    assert.equal(frame.stage, "ready")
    assert.deepEqual(frame.health, { kind: "faulted", since: 1, cause: "gone" })
  })
})

// One notices array for every row, because a summary keeps its identity only while its notices are the same reference.
const NO_NOTICES: SessionCatalogRow["notices"] = []
const row = (id: string): Extract<SessionCatalogRow, { readonly totalsLoading: false }> => ({
  id, title: id, kind: "chat", lifecycleState: "active", lastUpdated: "2026-09-06T00:00:00Z", notices: NO_NOTICES, inputMode: { kind: "chat" },
  executionCwd: "/project", totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
})

describe("view state sessions", () => {
  test("replaces only the row whose reading changed", () => {
    const rows = [row("a"), row("b")]
    const project = createViewProjection()
    const first = project(session({ sessions: rows }))
    const working = new Map<string, StatusView>([["b", statusView({ activity: "generating" })]])
    const second = project(session({ sessions: rows, statuses: working }))
    assert.notEqual(second.sessions, first.sessions)
    assert.equal(second.sessions[0], first.sessions[0])
    assert.notEqual(second.sessions[1], first.sessions[1])
    assert.equal(second.sessions[1]?.working, true)
  })
  test("keeps a parent session working while it waits on background work", () => {
    const statuses = new Map<string, StatusView>([[
      "a",
      statusView({ waitingOnBackgroundWork: true }),
    ]])

    for (const lifecycleState of ["active", "inactive"] as const) {
      const frame = createViewProjection()(session({ sessions: [{ ...row("a"), lifecycleState }], statuses }))
      assert.equal(frame.sessions[0]?.working, true)
    }
  })

  test("a selected session waiting on background work is interruptible though not busy", () => {
    const waiting = statusView({ activeSubagentCount: 1, waitingOnBackgroundWork: true })
    const settled = statusView({ activeSubagentCount: 1 })

    const frame = createViewProjection()(session({ sessionId: "a", sessions: [row("a")], statuses: new Map([["a", waiting]]) }))
    assert.equal(frame.busy, false)
    assert.equal(frame.interruptible, true)
    assert.equal(frame.waitingOn, "Waiting")
    // An interrupted park waits for the person, not for the work.
    assert.equal(createViewProjection()(session({ sessionId: "a", sessions: [row("a")], statuses: new Map([["a", settled]]) })).interruptible, false)
  })
})

describe("view state session titles", () => {
  const titled = (titles: { readonly title: string; readonly shortTitle?: string }): SessionCatalogRow => ({ ...row("a"), ...titles })
  test("leads with the short title and keeps the longer description under it", () => {
    const [summary] = createViewProjection()(session({ sessions: [titled({ title: "Fix the session list on the phone", shortTitle: "Phone session list" })] })).sessions
    assert.equal(summary?.title, "Phone session list")
    assert.equal(summary?.shortTitle, "Phone session list")
    assert.equal(summary?.subtitle, "Fix the session list on the phone")
  })
  test("shows one line when the session has no short title or the two agree", () => {
    const project = createViewProjection()
    const absent = project(session({ sessions: [titled({ title: "Only title" })] })).sessions[0]
    assert.equal(absent?.subtitle, undefined)
    assert.equal(absent?.shortTitle, undefined)
    const empty = project(session({ sessions: [titled({ title: "Only title", shortTitle: "" })] })).sessions[0]
    assert.equal(empty?.title, "Only title")
    assert.equal(empty?.subtitle, undefined)
    assert.equal(empty?.shortTitle, undefined)
    const equal = project(session({ sessions: [titled({ title: "Same", shortTitle: "Same" })] })).sessions[0]
    assert.equal(equal?.subtitle, undefined)
    assert.equal(equal?.shortTitle, "Same")
    const long = project(session({ sessions: [titled({ title: "Original description" })] })).sessions[0]
    assert.equal(long?.title, "Original descr")
    assert.equal(long?.subtitle, "Original description")
    const edited = project(session({ sessions: [titled({ title: "Edited description", shortTitle: "Original descr" })] })).sessions[0]
    assert.equal(edited?.title, "Original descr")
  })
})

describe("view state summary identity", () => {
  test("keeps a summary while the catalog row changes only in what the list does not draw", () => {
    const project = createViewProjection()
    const first = project(session({ sessions: [{ ...row("a"), totalTokens: 10 }] }))
    const second = project(session({ sessions: [{ ...row("a"), totalTokens: 20 }] }))
    assert.equal(second.sessions, first.sessions)
    assert.equal(second.sessions[0], first.sessions[0])
  })
  test("replaces a summary whose drawn fields changed", () => {
    const project = createViewProjection()
    const first = project(session({ sessions: [row("a")] }))
    const second = project(session({ sessions: [{ ...row("a"), diffStats: { added: 1, modified: 0, removed: 0 } }] }))
    assert.notEqual(second.sessions[0], first.sessions[0])
    assert.deepEqual(second.sessions[0]?.diffStats, { added: 1, modified: 0, removed: 0 })
    const notices: SessionCatalogRow["notices"] = [{ id: "error", scope: "session", presentation: "transcript.unavailable", severity: "error", title: "Unavailable", message: "Unavailable", startedAt: 1, updatedAt: 1 }]
    const updated = project(session({
      sessions: [{ ...row("a"), notices, admittedActions: ["chat.resume"] }],
      pendingQuestions: new Map([["a", { kind: "question", toolUseId: "q", questions: [], timestamp: 100 }]]),
    })).sessions[0]
    assert.notEqual(updated, second.sessions[0])
    assert.equal(updated?.notices, notices)
    assert.equal(updated?.awaitingAnswer, true)
    assert.deepEqual(updated?.admittedActions, ["chat.resume"])
  })
})

describe("view state activity anchors", () => {
  const status = (settledOutputPosition: number | null) => statusView({ settledOutputPosition })

  test("projects causal anchors only from the selected status and transcript owners", () => {
    const statuses = new Map([["selected", status(12)], ["other", status(99)]])
    const selected = session({
      sessionId: "selected",
      statuses,
      transcript: transcript({ appliedOutputPosition: 10 }),
    })

    const frame = buildViewState(selected)
    assert.equal(frame.processStatus, selected.statuses.get("selected"))
    assert.equal(frame.activityStartedAt, 0)
    assert.equal(frame.settledOutputPosition, 12)
    assert.equal(frame.appliedOutputPosition, 10)
    assert.equal(buildViewState(session({ sessionId: "selected", statuses: new Map() })).settledOutputPosition, null)
    assert.equal(buildViewState(session({ sessionId: "selected", statuses: new Map() })).appliedOutputPosition, null)
    const unselected = buildViewState(session({ statuses: new Map([["selected", status(12)]]), transcript: selected.transcript }))
    assert.equal(unselected.settledOutputPosition, null)
    assert.equal(unselected.appliedOutputPosition, null)
    assert.equal(unselected.processStatus, undefined)
    const running = { ...status(12), activeBackgroundCommands: [{ id: "process-1", toolUseId: "bash-1", description: "Shell", startedAtMs: 0 }], activeForegroundBashToolCallIds: ["bash-2"] }
    statuses.set("selected", running)
    assert.equal(buildViewState(selected).processStatus, running)
    const settled = status(12)
    statuses.set("selected", settled)
    assert.equal(buildViewState(selected).processStatus, settled)
  })
})

describe("view state transcript count", () => {
  test("projects count-only updates without replacing unchanged blocks", () => {
    const blocks: FrontendOutputBlock[] = []
    const frame = buildViewState(session({
      sessionId: "selected",
      transcript: transcript({ appliedOutputPosition: 10, blocks, visibleMessageCount: 7 }),
    }))

    assert.equal(frame.visibleMessageCount, 7)
    assert.equal(frame.blocks, blocks)
    const next = buildViewState(session({
      sessionId: "selected",
      transcript: transcript({ appliedOutputPosition: 10, blocks, visibleMessageCount: 8 }),
    }))
    assert.equal(next.visibleMessageCount, 8)
    assert.equal(next.blocks, frame.blocks)
    assert.equal(buildViewState(session({ sessionId: "selected" })).visibleMessageCount, 0)
  })
})

describe("view state children", () => {
  const listed: SessionCatalogRow = {
    id: "parent", kind: "chat", title: "Parent", lifecycleState: "active", notices: [], inputMode: { kind: "chat" },
    lastUpdated: "2026-09-18T12:00:00.000Z", executionCwd: "/tmp/project", childSessionIds: ["child"], totalsLoading: true,
  }
  const child: ChildSessionRow = {
    id: "child", kind: "subagent", title: "Child", lifecycleState: "active", notices: [], inputMode: { kind: "message" },
    admittedActions: ["session.send", "subagent.interrupt", "background.terminate", "session.delete"], parentSessionId: "parent", parentToolUseId: "tu-child",
    lastUpdated: "2026-09-18T12:00:00.000Z", executionCwd: "/tmp/project", totalsLoading: true,
  }

  test("a child is read by id after the catalog and never joins the session list", () => {
    const state = buildViewState(session({ sessions: [listed], children: [child], sessionId: "child" }))
    assert.deepEqual(state.sessions.map((summary) => summary.id), ["parent"])
    assert.equal(summaryOf(state, "child")?.kind, "subagent")
    assert.deepEqual(summaryOf(state, "child")?.admittedActions, ["session.send", "subagent.interrupt", "background.terminate", "session.delete"])
    assert.equal(summaryOf(state, "child")?.parentToolUseId, "tu-child")
    assert.equal(summaryOf(state, "parent")?.id, "parent")
    assert.equal(summaryOf(state, "missing"), undefined)
    assert.equal(summaryOf(state, undefined), undefined)
    let previous = summaryOf(state, "child")
    for (const runOutcome of ["completed", "partial", "stopped", "failed", "cancelled", undefined] as const) {
      const next = buildViewState(session({
        sessions: [listed], children: [{ ...child, ...(runOutcome === undefined ? {} : { runOutcome }) }], sessionId: "child",
      }))
      const summary = summaryOf(next, "child")
      assert.equal(summary?.runOutcome, runOutcome)
      assert.notEqual(summary, previous)
      previous = summary
    }
  })

  test("a child parked on a reply names the reply, other background work reads Waiting, and running work has no wait label", () => {
    const parked = statusView({ waitingOnBackgroundWork: true, replyWaits: [{ sessionId: "parent", name: "Parent" }] })
    const waiting = (status: StatusView) => buildViewState(session({ sessions: [listed], children: [child], sessionId: "child", statuses: new Map([["child", status]]) })).waitingOn
    assert.equal(waiting(parked), "Waiting on parent")
    assert.equal(waiting({ ...parked, replyWaits: [{ sessionId: "sibling", name: "Spec review" }] }), "Waiting for message response")
    assert.equal(waiting({ ...parked, replyWaits: [] }), "Waiting")
    assert.equal(waiting({ ...parked, waitingOnBackgroundWork: false, activity: "generating" }), undefined)
  })

  test("a settled child's summary carries the duration its row recorded, which a header shows once no runner reports active time", () => {
    const stopped: ChildSessionRow = {
      id: "workflow", kind: "workflow-agent", workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "attempt" }, title: "Agent", lifecycleState: "inactive", notices: [], inputMode: { kind: "message" },
      admittedActions: [], stoppedBy: "person", parentSessionId: "parent", parentToolUseId: "tu-workflow",
      lastUpdated: "2026-09-18T12:00:00.000Z", executionCwd: "/tmp/project",
      totalsLoading: false, totalCost: 0.01, totalBilledCost: 0, priceUnavailable: false, totalTokens: 1400, contextPercent: 0, contextPromptTokens: 0, durationMs: 103_600,
    }
    const first = buildViewState(session({ sessions: [listed], children: [stopped], sessionId: "workflow" }))
    assert.equal(summaryOf(first, "workflow")?.durationMs, 103_600)
    const later = buildViewState(session({ sessions: [listed], children: [{ ...stopped, totalsLoading: false, durationMs: 104_000 }], sessionId: "workflow" }))
    assert.equal(summaryOf(later, "workflow")?.durationMs, 104_000)
  })

  test("a child summary keeps its identity across frames that changed neither list", () => {
    const first = buildViewState(session({ sessions: [listed], children: [child] }))
    const second = buildViewState(session({ sessions: [listed], children: [child] }))
    assert.equal(second.children, first.children)
    assert.equal(summaryOf(second, "child"), summaryOf(first, "child"))
  })
})

describe("view state opening", () => {
  test("a message sent into a destination that cannot show yet shows in its place, not the loading screen", () => {
    const entry = { id: "local-1", input: { text: "focus on tests" }, timestamp: 0, delivery: { kind: "sending" } } as const
    // The child's detail is still being read, or its transcript has not answered yet.
    for (const opening of [{ awaitsDetail: true } as const, undefined]) {
      assert.equal(buildViewState(session({ sessionId: "child", opening, localSubmissions: [entry] })).opening, undefined)
      assert.deepEqual(buildViewState(session({ sessionId: "child", opening })).opening, {})
    }
  })

  test("a destination that failed says why even while a message sent to it waits", () => {
    const opening = { awaitsDetail: true, failure: "Flywheel could not open this session: the read timed out" } as const
    const waiting = { id: "local-1", input: { text: "focus on tests" }, timestamp: 0, delivery: { kind: "accepted", position: 0 } } as const
    const failed = { ...waiting, delivery: { kind: "failed", error: "Flywheel could not open this session" } } as const
    assert.deepEqual(buildViewState(session({ sessionId: "child", opening, localSubmissions: [waiting] })).opening, { failure: opening.failure })
    // Entries that failed say why themselves, so they stay in view instead.
    assert.equal(buildViewState(session({ sessionId: "child", opening, localSubmissions: [failed] })).opening, undefined)
  })
})
