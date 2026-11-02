import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import type { SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, mockWorkflowRunner, supervisorBaseDeps } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { registerTestChildRun } from "../../../helpers/live-child-run"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control.js"
import { authorizePlannedSessionContinuation, continuationTargetId, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, plannedContinuationsFor, readPlannedSessionContinuationAsync } from "../../../../src/orchestration/session/planned-session-continuation.js"
import type { RuntimeInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND, writeCommandHandover } from "../../../../src/orchestration/session/command-handover.js"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { ChatSessionEntry, SessionEntry, SessionEntryBase, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import type { WorkflowRunner } from "../../../../src/orchestration/workflow-host/runner-types.js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { turnInFlight } from "../../../../src/orchestration/session-store/view.js"
import type { ChatRunnerDeps } from "../../../../src/orchestration/chat/runner.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"

type RunnerState = SessionEntryBase["runnerState"]

function chat(sessionId: string, runnerState: RunnerState, interrupts: boolean, calls: string[]): ChatSessionEntry {
  return {
    ...entryRuntimeDefaults(() => [], 0),
    kind: "chat",
    description: sessionId,
    conversationId: `${sessionId}-conversation`,
    runnerState,
    runner: mockRunner(sessionId, { interruptForReplacement: async () => { calls.push(sessionId); return interrupts } }),
  }
}

interface HostedWorkflow {
  readonly kind: "workflow"
  readonly description: string
  readonly runner: WorkflowRunner
  readonly runnerState: RunnerState
  readonly waitingOnBackgroundWork: boolean
}

function workflow(sessionId: string, runnerState: RunnerState, waitingOnBackgroundWork: boolean, calls: string[], interrupts = true, overrides: Partial<WorkflowRunner> = {}): HostedWorkflow {
  const runner = mockWorkflowRunner(sessionId, { interruptForReplacement: async () => { calls.push(sessionId); return interrupts }, ...overrides })
  return { kind: "workflow", description: sessionId, runner, runnerState, waitingOnBackgroundWork }
}

/** The one session store the supervisor asks, holding fixture entries of
 *  every kind in place of live runners. A chat's runner holds a running turn
 *  while its entry's published activity says one runs, as a live runner does
 *  apart from the request a turn's reply nudge runs after its logical end,
 *  unless `running` gives the runner's own answer. */
function storeWith(ctx: SupervisorTestContext, entries: readonly (SessionEntry | HostedWorkflow)[], running: { readonly [sessionId: string]: () => boolean } = {}): SessionStore {
  const hosted = entries.filter((entry): entry is HostedWorkflow => entry.kind === "workflow")
  const byId = new Map(entries.filter((entry): entry is SessionEntry => entry.kind !== "workflow").map((entry) => [entry.description, entry]))
  const active = () => hosted.filter((host) => host.runnerState === "streaming" || host.waitingOnBackgroundWork)
  Object.assign(ctx.workflowHosts, {
    allIds: () => active().map((host) => host.description),
    get: (id: string) => active().find((host) => host.description === id)?.runner,
    disposeAll: async () => {},
  })
  for (const entry of entries) {
    if (entry.kind === "chat" && entry.runner) Object.assign(entry.runner, { holdsRunningTurn: running[entry.description] ?? (() => turnInFlight(entry)) })
  }
  return {
    ...ctx.sessionStore,
    allIds: () => [...byId.keys()],
    get: (sessionId) => byId.get(sessionId),
    interruptForReplacement: async (sessionId) => await byId.get(sessionId)?.runner?.interruptForReplacement() ?? false,
    disposeAll: async () => {},
  }
}

describe("RuntimeSupervisor planned replacement", () => {
  let ctx: SupervisorTestContext

  beforeEach(() => {
    ctx = createSupervisorTestContext()
  })

  afterEach(async () => {
    await disposeSupervisorTestContext(ctx)
  })

  test("authorizes deterministic retained work without a running parent turn", async () => {
    const sessionId = "retained-chat"
    const conversationId = `${sessionId}-conversation`
    const childSessionId = "reserved-workflow"
    await ctx.manager.createChat({ id: sessionId, conversationId })
    await ctx.runtime.runSync(EventStoreWriterService).putInFlight?.(
      sessionId,
      WORKFLOW_LAUNCH_OPERATION_KIND,
      "operation-1",
      {
        kind: WORKFLOW_LAUNCH_OPERATION_KIND,
        version: 1,
        operationId: "operation-1",
        parentSessionId: sessionId,
        parentConversationId: conversationId,
        childSessionId,
        toolUseId: "tool-1",
        parentEntryId: "entry-1",
        acceptedAt: "2026-01-02T03:04:05.000Z",
        initiator: "person",
        launch: {
          workflowDefinitionId: "implement",
          description: "retained work",
        },
      },
    )
    const calls: string[] = []
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, storeWith(ctx, [
      chat(sessionId, "idle", true, calls),
    ])))

    expect(await supervisor.interruptForReplacement("handoff-retained")).toEqual([sessionId])
    expect(calls).toEqual([])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toEqual({
      version: 3,
      target: { kind: "chat", sessionId },
      handoffId: "handoff-retained",
      operations: [{
        kind: WORKFLOW_LAUNCH_OPERATION_KIND,
        key: "operation-1",
        ownerSessionId: sessionId,
        target: { kind: "workflow", workflowId: childSessionId },
        bindingId: "tool-1",
      }],
    })
    await supervisor.disposeAll()
  })

  test("continues every running child, chat turn, parked chat, and workflow, and leaves a question open", async () => {
    const calls: string[] = []
    const store = storeWith(ctx, [
      chat("streaming-chat", "streaming", true, calls),
      // It waits on a question: the person's turn, which the cut leaves open.
      chat("asking-chat", "awaiting_user", true, calls),
      // A person interrupted it, so its runner is idle and it gets no row,
      // whatever its runner answers.
      chat("interrupted-chat", "idle", true, calls),
      // A chat parked on its children continues by itself when they report.
      { ...chat("waiting-chat", "idle", true, calls), waitingOnBackgroundWork: true, activeBackgroundCommands: [{ id: "child", description: "child", toolUseId: "dispatch-2", startedAtMs: 0, model: "gpt-5" }] },
      // A chat parked on a completed command still has unfinished agent work.
      { ...chat("command-chat", "idle", true, calls), waitingOnBackgroundWork: true, activeBackgroundCommands: [{ id: "bg", description: "sleep 600", toolUseId: "bash-1", startedAtMs: 0 }] },
      // It launched a command without a word, so its turn's logical end,
      // which its published activity reads as idle, is followed by the
      // request of the reply nudge. Its runner holds that running turn, which
      // the stop would interrupt, so the cut cuts it and gives it its row.
      { ...chat("nudging-chat", "idle", true, calls), activeBackgroundCommands: [{ id: "bg-2", description: "bun run dev", toolUseId: "bash-2", startedAtMs: 0 }] },
      // A turn that ended between the read and the cut loses the row it was given.
      chat("finished-chat", "streaming", false, calls),
      workflow("running-workflow", "streaming", false, calls),
      workflow("waiting-workflow", "idle", true, calls),
      // A workflow a person interrupted is idle: its turn is left alone.
      workflow("interrupted-workflow", "idle", false, calls),
    ], { "nudging-chat": () => true, "asking-chat": () => false })
    const paused: string[] = []
    const release = registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: "running-child",
      runId: "run-1",
      parentSessionId: "waiting-chat",
      parentConversationId: "waiting-chat-conversation",
      parentToolCallId: "dispatch-1",
      stop: () => {},
      async interrupt(by) { paused.push(by); release() },
    })
    // Chat and workflow controls are live too, but they are not runs: the cut
    // and its blockers read only the controls of children.
    const notRuns = (["interrupted-chat", "interrupted-workflow"] as const).map((sessionId) => registerLiveSessionControl(ctx.runtime.runSync(EventReaderService), {
      sessionId,
      state: async () => "interrupted" as const,
      deliver: async () => { throw new Error("the cut delivers no message") },
      notify: async () => false,
    }))
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, store))

    const interrupted = await supervisor.interruptForReplacement("handoff-1")
    for (const unregister of notRuns) unregister()

    expect([...interrupted].sort()).toEqual(["command-chat", "nudging-chat", "running-child", "running-workflow", "streaming-chat", "waiting-chat", "waiting-workflow"].sort())
    expect(paused).toEqual(["replacement"])
    expect(calls.sort()).toEqual([
      "command-chat", "finished-chat", "nudging-chat",
      "running-workflow", "streaming-chat", "waiting-chat", "waiting-workflow",
    ].sort())
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "streaming-chat")).toEqual({ version: 3, target: { sessionId: "streaming-chat", kind: "chat" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "command-chat")).toEqual({ version: 3, target: { sessionId: "command-chat", kind: "chat" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "nudging-chat")).toEqual({ version: 3, target: { sessionId: "nudging-chat", kind: "chat" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "waiting-chat")).toEqual({ version: 3, target: { sessionId: "waiting-chat", kind: "chat" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "running-workflow")).toEqual({ version: 3, target: { workflowId: "running-workflow", kind: "workflow" }, handoffId: "handoff-1" })
    // A step parked on its children is running too: the shutdown pauses the workflow and only a resume continues it.
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "waiting-workflow")).toEqual({ version: 3, target: { workflowId: "waiting-workflow", kind: "workflow" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "running-child")).toEqual({ version: 3, target: { sessionId: "running-child", kind: "subagent" }, handoffId: "handoff-1", runId: "run-1" })
    for (const untouched of ["asking-chat", "interrupted-chat", "finished-chat", "interrupted-workflow"]) {
      expect(ctx.store.readInFlight(untouched, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)).toEqual([])
    }
    await supervisor.disposeAll()
  })

  test("a running workflow that prepares its next attempt keeps its row, and one whose step a person paused loses it", async () => {
    const calls: string[] = []
    // Between attempts a running workflow holds no worker: the cut finds no
    // agent to interrupt while the next attempt's preparation runs.
    const between = workflow("between-attempts", "streaming", false, calls, false)
    // A person paused the step's only agent, so its worker is parked and the
    // cut finds no running turn either.
    const paused = workflow("paused-step", "streaming", false, calls, false, { interruption: () => "person" })
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, storeWith(ctx, [between, paused])))

    expect(await supervisor.interruptForReplacement("handoff-1")).toEqual([])
    expect(calls.sort()).toEqual(["between-attempts", "paused-step"])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "between-attempts")).toEqual({ version: 3, target: { workflowId: "between-attempts", kind: "workflow" }, handoffId: "handoff-1" })
    expect(ctx.store.readInFlight("paused-step", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)).toEqual([])
    await supervisor.disposeAll()
  })

  test("an empty chat a tab holds survives the replacement's stop, and the successor takes its first message and titles it", async () => {
    // The tab's client holds the project as the replacement stops it.
    const withRunner = (sessionStore: SessionStore, onRunner: (deps: ChatRunnerDeps) => void = () => {}) => createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, sessionStore, { createRunner: async (deps) => { onRunner(deps); return mockRunner(deps.sessionId) } }),
      replacementHandoff: () => "handoff-blank",
      clientsHold: () => true,
    })
    const predecessor = withRunner(ctx.sessionStore)
    const blankId = await predecessor.openSessionRuntime()
    // The tab's keeper attached the runner; the person has typed nothing yet.
    await predecessor.ensureChatRunner(blankId)
    expect(await predecessor.interruptForReplacement("handoff-blank")).toEqual([])

    await predecessor.disposeAll()

    const kept = await ctx.manager.read(blankId)
    if (kept?.kind !== "chat") throw new Error("the replacement's stop removed the empty chat")
    expect(kept.lifecycleState).toBe("inactive")
    // The successor serves the same durable state from a fresh store. The
    // tab's keeper activates the chat again, and the executor adopts a
    // durable chat that holds no message, as it does for any such activation.
    let successorRunner: ChatRunnerDeps | undefined
    const successor = withRunner(createSessionStore(ctx.runtime, ctx.runtime.runSync(EventReaderService)), (deps) => { successorRunner = deps })
    successor.adoptBlankChat({ sessionId: blankId, conversationId: kept.conversationId, description: kept.label })
    await expect(successor.sendChat(blankId, "draft typed before the update")).resolves.toEqual({ ok: true })
    expect(successorRunner?.generateTitleForNextMessage).toBe(true)
    await successor.disposeAll()
  })

  test("an ordinary shutdown writes no continuation authority and is no replacement's stop", async () => {
    const calls: string[] = []
    const store = storeWith(ctx, [chat("streaming-chat", "streaming", true, calls)])
    let replacementStops = 0
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), onReplacementStop: () => { replacementStops += 1 } })
    await supervisor.disposeAll()
    expect(calls).toEqual([])
    expect(replacementStops).toBe(0)
    expect(ctx.store.sessionsWithInFlight(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND)).toEqual([])
  })

  test("the stop runs the cut's steps for work admitted after the cut, under the handoff the account published", async () => {
    const calls: string[] = []
    let lateState: RunnerState = "idle"
    let askingState: RunnerState = "idle"
    let stepState: RunnerState = "idle"
    let cutState: RunnerState = "streaming"
    const late = { ...chat("late-chat", "idle", true, calls), get runnerState() { return lateState } }
    // A turn a message from another surface started after the cut, which
    // then asked a question: the person's, not work the cut carries.
    const asking = { ...chat("asking-chat", "idle", true, calls), get runnerState() { return askingState } }
    // A workflow that advanced to its next step after the cut.
    const step = { ...workflow("late-workflow", "idle", false, calls), get runnerState() { return stepState } }
    // Cut by the cut, then idle: its row stands and the stop leaves it.
    const cut = { ...chat("cut-chat", "streaming", true, calls), get runnerState() { return cutState } }
    // Cut by the cut, then a message after the cut started a new turn in it.
    const restarted = chat("restarted-chat", "streaming", true, calls)
    // Cut by the cut and still parked on its children, so the stop finds
    // nothing more to interrupt in it.
    let parkedCalls = 0
    const parked: ChatSessionEntry = {
      ...chat("parked-chat", "idle", true, calls),
      waitingOnBackgroundWork: true,
      runner: mockRunner("parked-chat", { interruptForReplacement: async () => { calls.push("parked-chat"); parkedCalls += 1; return parkedCalls === 1 } }),
    }
    const store = storeWith(ctx, [late, asking, step, cut, restarted, parked, chat("idle-chat", "idle", true, calls)], { "asking-chat": () => false })
    // The account published this handoff before its cut, and the stop reads it.
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), replacementHandoff: () => "handoff-1" })

    expect([...await supervisor.interruptForReplacement("handoff-1")].sort()).toEqual(["cut-chat", "parked-chat", "restarted-chat"])
    lateState = "streaming"
    askingState = "awaiting_user"
    stepState = "streaming"
    cutState = "idle"
    calls.splice(0)
    const paused: string[] = []
    const release = registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: "late-child",
      runId: "run-9",
      parentSessionId: "late-chat",
      parentConversationId: "late-chat-conversation",
      parentToolCallId: "dispatch-9",
      stop: () => {},
      async interrupt(by) { paused.push(by); release() },
    })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "late-chat")).toBeNull()

    await supervisor.disposeAll()

    // Each piece of work is cut the way the cut cuts it, with the planned
    // interrupt no surface shows, and the step parks so that its resume
    // enters it again. The turn that waits on a question is left open.
    expect(calls.sort()).toEqual(["late-chat", "late-workflow", "parked-chat", "restarted-chat"])
    expect(paused).toEqual(["replacement"])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "late-chat")).toEqual({ version: 3, target: { sessionId: "late-chat", kind: "chat" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "asking-chat")).toBeNull()
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "late-workflow")).toEqual({ version: 3, target: { workflowId: "late-workflow", kind: "workflow" }, handoffId: "handoff-1" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "late-child")).toEqual({ version: 3, target: { sessionId: "late-child", kind: "subagent" }, handoffId: "handoff-1", runId: "run-9" })
    for (const held of ["cut-chat", "restarted-chat", "parked-chat"]) {
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), held)).toEqual({ version: 3, target: { sessionId: held, kind: "chat" }, handoffId: "handoff-1" })
    }
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "idle-chat")).toBeNull()
    // The successor that consumes the handoff resumes exactly these rows, and
    // the stop reports how many there are.
    expect((await plannedContinuationsFor(asAsyncEventReadSurface(ctx.store), "handoff-1")).map((row) => continuationTargetId(row.target)).sort()).toEqual(["cut-chat", "late-chat", "late-child", "late-workflow", "parked-chat", "restarted-chat"])
    expect(supervisor.replacementSuccessorRows()).toEqual({ continuations: 6, handovers: 0 })
  })

  test("a stop that leaves no continuation row and one handover row counts that handover row, so the project stays in the handoff", async () => {
    // An idle chat whose background command the stop handed over: nothing
    // is resumed, and the successor must still open the project to adopt it.
    const store = storeWith(ctx, [chat("idle-chat", "idle", true, [])])
    const written = ctx.runtime.runSync(EventStoreWriterService)
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), replacementHandoff: () => "handoff-5" })
    await writeCommandHandover({ reader: asAsyncEventReadSurface(ctx.store), writer: written, row: {
      handoffId: "handoff-5", sessionId: "idle-chat", conversationId: "idle-chat-conversation", processId: "bash-bg-00000001",
      description: "bun run dev", logPath: "/p/cmd.log", recordPath: "/p/cmd.outcome.json", channel: "/serve/h-1.sock",
      token: "owned:1", pid: 4242, startedAtMs: 1,
    } })
    // A row of an older handoff is not this stop's.
    await writeCommandHandover({ reader: asAsyncEventReadSurface(ctx.store), writer: written, row: {
      handoffId: "handoff-old", sessionId: "idle-chat", conversationId: "idle-chat-conversation", processId: "bash-bg-00000002",
      description: "bun run dev", logPath: "/p/old.log", recordPath: "/p/old.outcome.json", channel: "/serve/h-2.sock",
      token: "owned:2", pid: 4243, startedAtMs: 1,
    } })

    await supervisor.disposeAll()

    expect(await plannedContinuationsFor(asAsyncEventReadSurface(ctx.store), "handoff-5")).toEqual([])
    expect(supervisor.replacementSuccessorRows()).toEqual({ continuations: 0, handovers: 1 })
  })

  // An interrupt ends a foreground command that is still in its hold, so
  // every held command of every session, a child's included, must be in the
  // background before the first row or interrupt of the cut and of the stop.
  test("the cut and the stop move every held foreground command to the background before any row, pause, or interrupt", async () => {
    const order: string[] = []
    let cutState: RunnerState = "streaming"
    let lateState: RunnerState = "idle"
    let transfer = Promise.withResolvers<void>()
    const store: SessionStore = {
      ...storeWith(ctx, [
        { ...chat("streaming-chat", "idle", true, order), get runnerState() { return cutState } },
        { ...workflow("running-workflow", "idle", false, order), get runnerState() { return cutState } },
        { ...chat("late-chat", "idle", true, order), get runnerState() { return lateState } },
      ]),
      transferForegroundForReplacement: async (sessionId) => {
        order.push(`transfer:${sessionId}`)
        await transfer.promise
      },
    }
    const workflowHost = ctx.workflowHosts.get("running-workflow")
    if (!workflowHost) throw new Error("Missing workflow host")
    workflowHost.transferForegroundForReplacement = async () => {
      order.push("transfer:running-workflow")
      await transfer.promise
    }
    const written = ctx.runtime.runSync(EventStoreWriterService)
    const writer: AsyncEventWriter = {
      ...written,
      putInFlight: async (sessionId, kind, key, payload) => {
        order.push(`row:${sessionId}`)
        await written.putInFlight?.(sessionId, kind, key, payload)
      },
    }
    const release = registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: "running-child",
      runId: "run-4",
      parentSessionId: "streaming-chat",
      parentConversationId: "streaming-chat-conversation",
      parentToolCallId: "dispatch-4",
      stop: () => {},
      async interrupt() { order.push("pause:running-child"); release() },
    })
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), writer, replacementHandoff: () => "handoff-4", onReplacementStop: () => { order.push("replacement stop") } })
    const transfers = ["transfer:late-chat", "transfer:running-workflow", "transfer:streaming-chat"]

    const cut = supervisor.interruptForReplacement("handoff-4")
    await Bun.sleep(5)
    // A move that has not settled holds every row, pause, and interrupt.
    expect([...order].sort()).toEqual(transfers)
    transfer.resolve()
    expect([...await cut].sort()).toEqual(["running-child", "running-workflow", "streaming-chat"])
    expect(order.slice(3).sort()).toEqual(["pause:running-child", "row:running-child", "row:running-workflow", "row:streaming-chat", "running-workflow", "streaming-chat"])

    // A turn a message started after the cut: the stop moves first too.
    order.splice(0)
    cutState = "idle"
    lateState = "streaming"
    transfer = Promise.withResolvers<void>()
    const stopped = supervisor.disposeAll()
    await Bun.sleep(5)
    // The cut workflow has released its host. The remaining sessions still
    // hand their commands over before the stop cuts their turns.
    expect(order[0]).toBe("replacement stop")
    expect(order.slice(1).sort()).toEqual(["transfer:late-chat", "transfer:streaming-chat"])
    transfer.resolve()
    await stopped
    expect(order.slice(3)).toEqual(["row:late-chat", "late-chat"])
  })

  test.each([
    { outcome: "cuts the turn", cutsTurn: true, interrupted: ["slow-chat"] },
    // The stop may have ended the turn while the step waited, so a turn the
    // step then finds ended is no reason to retire the row.
    { outcome: "finds the turn already ended", cutsTurn: false, interrupted: [] },
  ])("a session whose cut step is still writing its row when the stop begins is left to that step, which keeps the row when it $outcome", async ({ cutsTurn, interrupted }) => {
    let cuts = 0
    const slow: ChatSessionEntry = {
      ...chat("slow-chat", "streaming", true, []),
      runner: mockRunner("slow-chat", { interruptForReplacement: async () => {
        cuts += 1
        // A second interrupt finds the turn already cut.
        return cutsTurn && cuts === 1
      } }),
    }
    // The stop settles the store only after it has passed every session it cuts.
    const stopPassed = Promise.withResolvers<void>()
    const store: SessionStore = { ...storeWith(ctx, [slow]), disposeAll: async () => { stopPassed.resolve() } }
    // The store is slow to take the cut's row, as under another writer's lock.
    const written = ctx.runtime.runSync(EventStoreWriterService)
    const writing = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const writer: AsyncEventWriter = {
      ...written,
      putInFlight: async (sessionId, kind, key, payload) => {
        writing.resolve()
        await gate.promise
        await written.putInFlight?.(sessionId, kind, key, payload)
      },
    }
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), writer, replacementHandoff: () => "handoff-3" })

    const cut = supervisor.interruptForReplacement("handoff-3")
    await writing.promise
    const stopped = supervisor.disposeAll()
    await stopPassed.promise
    gate.resolve()
    await stopped
    expect(await cut).toEqual(interrupted)

    expect(cuts).toBe(1)
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "slow-chat")).toEqual({ version: 3, target: { sessionId: "slow-chat", kind: "chat" }, handoffId: "handoff-3" })
  })

  test("the stop ends each turn the handoff owns as the cut ends it, one whose cut step has not settled at the cut limit included, and every other turn with the ordinary runtime interrupt", async () => {
    const stops = new Map<string, RuntimeInterruption>()
    const stopPassed = Promise.withResolvers<void>()
    const store: SessionStore = { ...ctx.sessionStore, disposeAll: async () => { stopPassed.resolve(); await ctx.sessionStore.disposeAll() } }
    // The store is slow to take the cut's row, as under another writer's lock.
    const written = ctx.runtime.runSync(EventStoreWriterService)
    const writing = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const writer: AsyncEventWriter = {
      ...written,
      putInFlight: async (sessionId, kind, key, payload) => {
        writing.resolve()
        await gate.promise
        await written.putInFlight?.(sessionId, kind, key, payload)
      },
    }
    // The chats whose runner holds a running turn.
    const running = new Set<string>()
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps(ctx, store, { createRunner: async (deps) => mockRunner(deps.sessionId, {
        holdsRunningTurn: () => running.has(deps.sessionId),
        prepareForShutdown: (by) => { stops.set(deps.sessionId, by) },
      }) }),
      writer,
      replacementHandoff: () => "handoff-7",
    })
    const open = async (): Promise<string> => {
      const sessionId = await supervisor.openSessionRuntime()
      await supervisor.ensureChatRunner(sessionId)
      return sessionId
    }
    // Its turn runs, and the cut's step for it cannot write its row.
    const cutting = await open()
    running.add(cutting)
    // The cut interrupted it already, and it holds the handoff's row.
    const held = await open()
    await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer: written, continuation: { target: { sessionId: held, kind: "chat" }, handoffId: "handoff-7" } })
    // The handoff owes it nothing.
    const unowned = await open()

    const cut = supervisor.interruptForReplacement("handoff-7")
    await writing.promise
    // The cut limit passes, and the stop begins while the step still waits.
    const stopped = supervisor.disposeAll()
    await stopPassed.promise
    gate.resolve()
    await stopped
    await cut

    expect(Object.fromEntries(stops)).toEqual({ [cutting]: "replacement", [held]: "replacement", [unowned]: "runtime" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), cutting)).toEqual({ version: 3, target: { sessionId: cutting, kind: "chat" }, handoffId: "handoff-7" })
  })

  test.each([
    ["continuation", PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND],
    ["handover", COMMAND_HANDOVER_IN_FLIGHT_KIND],
  ])("a stop whose %s rows cannot be read still runs its ordered teardown, ends each turn with the runtime interrupt, reports only its other failures, and records once that it counts no successor rows", async (_rows, refusedKind) => {
    const stops = new Map<string, RuntimeInterruption>()
    const base = supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId, {
      prepareForShutdown: (by) => { stops.set(deps.sessionId, by) },
    }) })
    const authFailure = new Error("auth admission did not settle")
    const supervisor = createRuntimeSupervisor({
      ...base,
      projectionReader: { ...base.projectionReader, sessionsWithInFlight: async (kind) => {
        if (kind === refusedKind) throw new Error("state read refused")
        return base.projectionReader.sessionsWithInFlight(kind)
      } },
      lifecycle: { ...base.lifecycle, settleAuthAdmission: async () => {
        await base.lifecycle.settleAuthAdmission()
        throw authFailure
      } },
      replacementHandoff: () => "handoff-9",
    })
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.ensureChatRunner(sessionId)

    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      const reported = await supervisor.disposeAll().then(() => [], (error: unknown) => error instanceof AggregateError ? error.errors : [error])

      expect(Object.fromEntries(stops)).toEqual({ [sessionId]: "runtime" })
      expect(reported).toEqual([authFailure])
      // No count is not a count of zero: the successor keeps the project named
      // and reads its rows itself.
      expect(supervisor.replacementSuccessorRows()).toBeUndefined()
      const countFailure = { type: "log.warn", payload: { message: "the replacement's successor rows could not be counted; the successor keeps the project named and reads its rows itself", handoffId: "handoff-9", error: "state read refused" } }
      expect(record.mock.calls.filter(([input]) => Bun.deepMatch(countFailure, input))).toHaveLength(1)
    } finally {
      mock.restore()
    }
  })

  test("a parent the stop interrupts keeps its row when the cut's pause of its child settles only after that", async () => {
    let parentCuts = 0
    const pausing = Promise.withResolvers<void>()
    const childPaused = Promise.withResolvers<void>()
    const parent: ChatSessionEntry = {
      ...chat("parent-chat", "streaming", true, []),
      runner: mockRunner("parent-chat", { interruptForReplacement: async () => {
        parentCuts += 1
        // The child's pause settles once its parent is interrupted; a later
        // call finds nothing left to interrupt.
        childPaused.resolve()
        return parentCuts === 1
      } }),
    }
    const store = storeWith(ctx, [parent])
    const release = registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: "slow-child",
      runId: "run-3",
      parentSessionId: "parent-chat",
      parentConversationId: "parent-chat-conversation",
      parentToolCallId: "dispatch-3",
      stop: () => {},
      async interrupt() { pausing.resolve(); await childPaused.promise; release() },
    })
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), replacementHandoff: () => "handoff-2" })

    const cut = supervisor.interruptForReplacement("handoff-2")
    await pausing.promise
    await supervisor.disposeAll()
    // The cut's pause of the child settles now, after the stop interrupted
    // the parent; the cut takes no further step.
    expect(await cut).toEqual(["slow-child"])

    expect(parentCuts).toBe(1)
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "parent-chat")).toEqual({ version: 3, target: { sessionId: "parent-chat", kind: "chat" }, handoffId: "handoff-2" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "slow-child")).toEqual({ version: 3, target: { sessionId: "slow-child", kind: "subagent" }, handoffId: "handoff-2", runId: "run-3" })
  })

  test.each(["cut", "stop"] as const)("a child whose pause fails does not keep the %s from cutting the chats and workflows: each gets the planned cut, and the failure is reported once both phases have settled", async (path) => {
    const calls: string[] = []
    let chatState: RunnerState = path === "cut" ? "streaming" : "idle"
    let workflowState: RunnerState = path === "cut" ? "streaming" : "idle"
    const running = { ...chat("running-chat", "idle", true, calls), get runnerState() { return chatState } }
    const stepping = { ...workflow("running-workflow", "idle", false, calls), get runnerState() { return workflowState } }
    const store = storeWith(ctx, [running, stepping])
    const failingChild = () => registerTestChildRun(ctx.runtime.runSync(EventReaderService), {
      sessionId: "failing-child",
      runId: "run-5",
      parentSessionId: "running-chat",
      parentConversationId: "running-chat-conversation",
      parentToolCallId: "dispatch-5",
      stop: () => {},
      async interrupt() { throw new Error("the child's runner did not answer the pause") },
    })
    let reported: unknown
    const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), replacementHandoff: () => "handoff-5" })

    if (path === "cut") {
      failingChild()
      reported = await supervisor.interruptForReplacement("handoff-5").catch((error: unknown) => error)
    } else {
      // The child and the turns start after the cut, so the stop cuts them.
      expect(await supervisor.interruptForReplacement("handoff-5")).toEqual([])
      failingChild()
      chatState = "streaming"
      workflowState = "streaming"
      await supervisor.disposeAll()
    }

    expect(calls.sort()).toEqual(["running-chat", "running-workflow"])
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "running-chat")).toEqual({ version: 3, target: { sessionId: "running-chat", kind: "chat" }, handoffId: "handoff-5" })
    expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), "running-workflow")).toEqual({ version: 3, target: { workflowId: "running-workflow", kind: "workflow" }, handoffId: "handoff-5" })
    if (path === "cut") {
      expect(reported).toBeInstanceOf(AggregateError)
      await supervisor.disposeAll()
    }
  })
})
