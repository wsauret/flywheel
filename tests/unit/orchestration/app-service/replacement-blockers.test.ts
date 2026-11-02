import { describe, expect, test } from "bun:test"
import { createMutationAdmission } from "../../../../src/orchestration/app-service/mutation-admission.js"
import { collectReplacementBlockers, delaysReplacement, watchReplacementBlockerChanges, type ExecutorBlockerDeps } from "../../../../src/orchestration/app-service/replacement-blockers.js"
import type { FrontendActivity } from "../../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"

const PROJECT = { projectRoot: "/work/app", projectLabel: "app" }

function durable(id: string, kind: "chat" | "subagent", label: string, lifecycleState: DurableSessionCatalogRow["lifecycleState"] = "active"): DurableSessionCatalogRow {
  return { id, kind, label, lifecycleState, command: "", lastUpdated: "0", executionCwd: "/work/app" }
}

function catalog(...sessions: DurableSessionCatalogRow[]): ExecutorBlockerDeps["listMetadata"] {
  return async () => ({ sessions, errors: [] })
}

interface ActivityBySession {
  readonly [sessionId: string]: FrontendActivity
}

interface ShellsBySession {
  readonly [sessionId: string]: readonly string[]
}

interface BackgroundBySession {
  readonly [sessionId: string]: StatusView["activeBackgroundCommands"]
}

function deps(overrides: Partial<ExecutorBlockerDeps> & { readonly activity?: ActivityBySession; readonly shells?: ShellsBySession; readonly background?: BackgroundBySession } = {}): ExecutorBlockerDeps {
  const { activity = {}, shells = {}, background = {}, ...rest } = overrides
  return {
    ...PROJECT,
    listMetadata: async () => ({ sessions: [], errors: [] }),
    residents: () => new Map(),
    runningChildren: () => [],
    runningWorkflows: () => [],
    keptSessions: () => [],
    statuses: async (sessionIds) => new Map(sessionIds.map((id) => {
      const activityOf = activity[id]
      return [id, activityOf === undefined ? undefined : { activity: activityOf, activeForegroundBashToolCallIds: shells[id] ?? [], activeBackgroundCommands: background[id] ?? [] }]
    })),
    inFlightCalls: () => 0,
    storeHealth: { failed() {}, recovered() {} },
    ...rest,
  }
}

describe("executor replacement blockers", () => {
  test("a child blocks only while an owner in this process holds its run; an open record with no owner does not", async () => {
    const blockers = await collectReplacementBlockers(deps({
      // "child-orphan" stands for a run a process that is gone left open: it
      // is in the catalog but no owner here holds it.
      runningChildren: () => [{ sessionId: "child-live" }],
      listMetadata: catalog(durable("child-live", "subagent", "Inspect the runtime"), durable("child-orphan", "subagent", "Left open")),
    }))
    expect(blockers).toEqual([{ ...PROJECT, sessionId: "child-live", sessionTitle: "Inspect the runtime", reason: "subagent" }])
  })

  test("reads the durable catalog once for children and chats alike", async () => {
    let reads = 0
    const blockers = await collectReplacementBlockers(deps({
      runningChildren: () => [{ sessionId: "child" }],
      listMetadata: async () => { reads += 1; return { sessions: [durable("child", "subagent", "Inspect"), durable("chat-turn", "chat", "Streaming")], errors: [] } },
      activity: { "chat-turn": "generating" },
    }))
    expect(blockers.map((blocker) => blocker.reason)).toEqual(["subagent", "turn"])
    expect(reads).toBe(1)
  })

  test("each active chat reports by what it owns: a question outranks its turn, inactive and idle rows do not block", async () => {
    const blockers = await collectReplacementBlockers(deps({
      listMetadata: catalog(
        durable("chat-turn", "chat", "Streaming"),
        durable("chat-ask", "chat", "Asking"),
        durable("chat-idle", "chat", "Idle"),
        durable("chat-cold", "chat", "Cold", "inactive"),
        // A paused chat keeps its tab and runner, idle.
        durable("chat-paused", "chat", "Paused"),
      ),
      activity: { "chat-turn": "waiting", "chat-ask": "awaiting_user", "chat-idle": "idle", "chat-cold": "generating", "chat-paused": "absent" },
    }))
    expect(blockers).toEqual([
      { ...PROJECT, sessionId: "chat-turn", sessionTitle: "Streaming", reason: "turn" },
      { ...PROJECT, sessionId: "chat-ask", sessionTitle: "Asking", reason: "question" },
    ])
  })

  test("foreground, background, and kept shell commands outrank other session work and keep the project open, and only a call, an opening project, and a recovering project delay a replacement", async () => {
    const blockers = await collectReplacementBlockers(deps({
      listMetadata: catalog(
        durable("child", "subagent", "Inspect"),
        durable("chat-shell", "chat", "Building"),
        durable("chat-background", "chat", "Parked"),
        durable("chat-turn", "chat", "Streaming"),
        durable("chat-ask", "chat", "Asking"),
      ),
      activity: { "chat-shell": "executing_tools", "chat-background": "idle", "chat-turn": "generating", "chat-ask": "awaiting_user" },
      shells: { "chat-shell": ["bash-1"] },
      background: { "chat-background": [{ id: "bg", description: "sleep", toolUseId: "bash-3", startedAtMs: 0 }] },
      runningChildren: () => [{ sessionId: "child" }],
      // The keeper holds a command of a workflow a person paused, which no
      // active row accounts for, and one of a session a row names already.
      keptSessions: () => ["wf-paused", "chat-shell"],
      inFlightCalls: () => 1,
    }))
    expect(blockers).toEqual([
      { ...PROJECT, sessionId: "child", sessionTitle: "Inspect", reason: "subagent" },
      { ...PROJECT, sessionId: "chat-shell", sessionTitle: "Building", reason: "shell" },
      { ...PROJECT, sessionId: "chat-background", sessionTitle: "Parked", reason: "shell" },
      { ...PROJECT, sessionId: "chat-turn", sessionTitle: "Streaming", reason: "turn" },
      { ...PROJECT, sessionId: "chat-ask", sessionTitle: "Asking", reason: "question" },
      { ...PROJECT, sessionId: "wf-paused", reason: "shell" },
      { ...PROJECT, reason: "call" },
    ])
    // Every command crosses a replacement to the next build, which adopts
    // it, so none of them delays one.
    expect(blockers.filter(delaysReplacement).map((blocker) => blocker.reason)).toEqual(["call"])
    expect(delaysReplacement({ ...PROJECT, reason: "opening" })).toBe(true)
    expect(delaysReplacement({ ...PROJECT, reason: "recovery" })).toBe(true)
  })

  test("an admitted call that has not returned is a project-level blocker", async () => {
    expect(await collectReplacementBlockers(deps({ inFlightCalls: () => 2 }))).toEqual([{ ...PROJECT, reason: "call" }])
    expect(await collectReplacementBlockers(deps())).toEqual([])
  })

  // A project folder deleted while the service holds it open fails every
  // read of its store. Its executor's memory still knows its live work, so
  // only a call that is really in flight delays a replacement, and a project
  // whose memory holds no work reads as idle and closes.
  test("a project store that cannot be read reports the work the executor holds in memory, and nothing when it holds none", async () => {
    const unreadable = async (): Promise<never> => { throw new Error("disk I/O error") }
    const failures: string[] = []
    const storeHealth = { failed: (error: unknown) => { failures.push(String(error)) }, recovered() {} }
    for (const failing of [{ listMetadata: unreadable }, { statuses: unreadable }]) {
      expect(await collectReplacementBlockers(deps({ ...failing, storeHealth, inFlightCalls: () => 1 }))).toEqual([{ ...PROJECT, reason: "call" }])
      expect(await collectReplacementBlockers(deps({ ...failing, storeHealth }))).toEqual([])
    }
    expect(failures).toEqual(["Error: disk I/O error", "Error: disk I/O error", "Error: disk I/O error", "Error: disk I/O error"])

    const resident = (activity: FrontendActivity) => ({ activity, activeForegroundBashToolCallIds: [], activeBackgroundCommands: [] })
    expect(await collectReplacementBlockers(deps({
      listMetadata: unreadable,
      runningChildren: () => [{ sessionId: "child" }],
      residents: () => new Map([["chat-turn", resident("generating")], ["chat-ask", resident("awaiting_user")], ["chat-idle", resident("idle")]]),
      keptSessions: () => ["wf-paused"],
    }))).toEqual([
      { ...PROJECT, sessionId: "child", reason: "subagent" },
      { ...PROJECT, sessionId: "chat-turn", reason: "turn" },
      { ...PROJECT, sessionId: "chat-ask", reason: "question" },
      { ...PROJECT, sessionId: "wf-paused", reason: "shell" },
    ])
  })
})

describe("executor blocker change watch", () => {
  // No session's work delays a replacement, so only an admitted call going
  // in or out moves the list the account waits on.
  test("reports admission occupancy, coalesced, and nothing after stop", async () => {
    const admission = createMutationAdmission()
    let reports = 0
    const stop = watchReplacementBlockerChanges({ admission, notify: () => { reports += 1 }, settleMs: 2 })

    const released = Promise.withResolvers<void>()
    const first = admission.admit(() => released.promise)
    const second = admission.admit(() => released.promise)
    await Bun.sleep(6)
    expect(reports).toBe(1)
    released.resolve()
    await Promise.all([first, second])
    await Bun.sleep(6)
    expect(reports).toBe(2)

    stop()
    const late = Promise.withResolvers<void>()
    const call = admission.admit(() => late.promise)
    late.resolve()
    await call
    await Bun.sleep(6)
    expect(reports).toBe(2)
  })
})
