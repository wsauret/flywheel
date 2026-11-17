import { describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createMutationAdmission } from "../../../../src/orchestration/app-service/mutation-admission.js"
import { collectReplacementBlockers, delaysReplacement, watchReplacementBlockerChanges, type ExecutorBlockerDeps } from "../../../../src/orchestration/app-service/replacement-blockers.js"
import type { FrontendActivity } from "../../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../../src/protocol/status-protocol-types.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { makeDepsWithStore } from "../session/_session-manager-fixtures.js"
import { addSubagentChild } from "../session/_child-session-reconciliation-fixtures.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { countStateRequests } from "../../../helpers/state-requests.js"

const temporary = temporaryDirectories()

const PROJECT = { projectRoot: "/work/app", projectLabel: "app" }

function durable(id: string, kind: "chat" | "subagent", label: string, lifecycleState: DurableSessionCatalogRow["lifecycleState"] = "active"): DurableSessionCatalogRow {
  return { id, kind, label, lifecycleState, command: "", lastUpdated: "0", executionCwd: "/work/app" }
}

/** The two durable reads the question makes, over one fixed catalog. */
function catalog(...sessions: DurableSessionCatalogRow[]): Pick<ExecutorBlockerDeps, "listActive" | "listForIds"> {
  return {
    listActive: async () => ({ sessions: sessions.filter((session) => session.lifecycleState === "active"), errors: [] }),
    listForIds: async (ids) => ({ sessions: sessions.filter((session) => ids.includes(session.id)), errors: [] }),
  }
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
    ...catalog(),
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
      // "child-settling" is running, but its row no longer states it active,
      // so its label is read by id.
      runningChildren: () => [{ sessionId: "child-live" }, { sessionId: "child-settling" }],
      ...catalog(durable("child-live", "subagent", "Inspect the runtime"), durable("child-orphan", "subagent", "Left open"), durable("child-settling", "subagent", "Settle the run", "inactive")),
    }))
    expect(blockers).toEqual([
      { ...PROJECT, sessionId: "child-live", sessionTitle: "Inspect the runtime", reason: "subagent" },
      { ...PROJECT, sessionId: "child-settling", sessionTitle: "Settle the run", reason: "subagent" },
    ])
  })

  test("reads the active rows once, and by id only the resident chats and running children they do not name", async () => {
    let activeReads = 0
    const idReads: (readonly string[])[] = []
    const rows = catalog(durable("child", "subagent", "Inspect"), durable("chat-turn", "chat", "Streaming"), durable("chat-attached", "chat", "Attached", "inactive"), durable("chat-cold", "chat", "Cold", "inactive"))
    const resident = { activity: "generating" as const, activeForegroundBashToolCallIds: [], activeBackgroundCommands: [] }
    const blockers = await collectReplacementBlockers(deps({
      runningChildren: () => [{ sessionId: "child" }],
      // A runner can be attached and start a turn with no lifecycle write.
      residents: () => new Map([["chat-turn", resident], ["chat-attached", resident]]),
      listActive: async () => { activeReads += 1; return rows.listActive() },
      listForIds: async (ids) => { idReads.push(ids); return rows.listForIds(ids) },
      activity: { "chat-turn": "generating", "chat-attached": "generating", "chat-cold": "generating" },
    }))
    expect(blockers).toEqual([
      { ...PROJECT, sessionId: "child", sessionTitle: "Inspect", reason: "subagent" },
      { ...PROJECT, sessionId: "chat-turn", sessionTitle: "Streaming", reason: "turn" },
      { ...PROJECT, sessionId: "chat-attached", sessionTitle: "Attached", reason: "turn" },
    ])
    expect(activeReads).toBe(1)
    expect(idReads).toEqual([["chat-attached"]])
  })

  // The idle reaper asks every 30 seconds while a project shows nothing, and
  // a held replacement every 5, so one question costs what live work costs,
  // never what the project's history costs.
  test("a question over M sessions with 2 running children costs requests and rows that do not grow with M", async () => {
    const cost = async (history: number) => {
      const { deps: managerDeps, store } = makeDepsWithStore(temporary("replacement-blockers-"))
      try {
        const writer = asAsyncEventWriter(store)
        const seed = createSessionManager(managerDeps)
        for (let index = 0; index < history; index += 1) await seed.createChat({ id: `closed-${index}`, name: `Closed ${index}`, initialState: "inactive" })
        const parent = await seed.createChat({ id: "parent", name: "Parent", conversationId: "parent-conversation" })
        for (const index of [1, 2]) await addSubagentChild(store, writer, managerDeps.projectRoot, parent, "parent-conversation", index, "created")
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        const manager = createSessionManager({ ...managerDeps, projectionReader: counter.reader })
        let rows = 0
        const counted = <Args extends unknown[]>(read: (...args: Args) => ReturnType<typeof manager.listActive>) => async (...args: Args) => {
          const catalogRead = await read(...args)
          rows += catalogRead.sessions.length
          return catalogRead
        }
        const question = () => collectReplacementBlockers(deps({
          listActive: counted(manager.listActive), listForIds: counted(manager.listForIds),
          runningChildren: () => [{ sessionId: "child-1" }, { sessionId: "child-2" }],
          residents: () => new Map([[parent, { activity: "generating", activeForegroundBashToolCallIds: [], activeBackgroundCommands: [] }]]),
          activity: { [parent]: "generating" },
        }))
        // The first question folds the held projections from their start.
        await question()
        counter.take()
        rows = 0
        const blockers = await question()
        expect(blockers.map((blocker) => [blocker.sessionId, blocker.sessionTitle, blocker.reason])).toEqual([
          ["child-1", "Review", "subagent"],
          ["child-2", "Review", "subagent"],
          [parent, "Parent", "turn"],
        ])
        return { requests: counter.take().length, rows }
      } finally {
        store.close()
      }
    }
    const few = await cost(3)
    const many = await cost(30)
    expect(many).toEqual(few)
    expect(few.rows).toBe(3)
  })

  test("each active chat reports by what it owns: a question outranks its turn, inactive and idle rows do not block", async () => {
    const blockers = await collectReplacementBlockers(deps({
      ...catalog(
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
      ...catalog(
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
    for (const failing of [{ listActive: unreadable }, { statuses: unreadable }]) {
      expect(await collectReplacementBlockers(deps({ ...failing, storeHealth, inFlightCalls: () => 1 }))).toEqual([{ ...PROJECT, reason: "call" }])
      expect(await collectReplacementBlockers(deps({ ...failing, storeHealth }))).toEqual([])
    }
    expect(failures).toEqual(["Error: disk I/O error", "Error: disk I/O error", "Error: disk I/O error", "Error: disk I/O error"])

    const resident = (activity: FrontendActivity) => ({ activity, activeForegroundBashToolCallIds: [], activeBackgroundCommands: [] })
    expect(await collectReplacementBlockers(deps({
      listActive: unreadable,
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
