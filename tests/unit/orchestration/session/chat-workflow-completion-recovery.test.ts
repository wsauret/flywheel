import { afterEach, describe, expect, test } from "bun:test"
import { ManagedRuntime } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { EventReaderService, EventStoreLive, LocalEventStoreService } from "../../../../src/infra/event-store-effect.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { recoverProject } from "../../../helpers/project-recovery.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import { createChatRunner } from "../../../../src/orchestration/chat/runner.js"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer.js"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation.js"
import { readChildCall } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createContinuationLanes } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { loadToolExecutionTimelineFromEvents } from "../../../../src/orchestration/session/tool-execution-projection.js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { createWorkflowHosts } from "../../../../src/orchestration/modules/workflows/host-collection.js"
import { childSessionProjectionAttachment } from "../../../../src/orchestration/session-store/child-session-projection.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { initializedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { mockRunner, supervisorBaseDeps } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { testDirectories } from "../../../helpers/directories.js"
import { createBackgroundNotificationDelivery } from "../../../../src/orchestration/runner/background-notification-delivery.js"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { registerLiveWorkflowControl } from "../../../../src/orchestration/session/live-session-control.js"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue.js"
import {
  QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
  type HeldBackgroundNotification,
} from "../../../../src/orchestration/session/conversation/queued-background-notifications.js"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workflowFacts(description: string, status: "completed" | "paused") {
  return initializedWorkflowFacts(description).map((fact) => {
    if (fact.type === "workflow.control.initialized") {
      return parseWorkflowSessionFact({ ...fact, payload: { control: { ...fact.payload.control, status, frontier: [] } } })
    }
    if (fact.type !== "queue.created" || !("rows" in fact.payload)) return fact
    return parseWorkflowSessionFact({
      ...fact,
      payload: {
        rows: {
          ...fact.payload.rows,
          status,
          attempts: fact.payload.rows.attempts.map((attempt) => ({ ...attempt, status: status === "completed" ? "completed" : "pending" })),
        },
      },
    })
  })
}

async function recordLaunch(
  store: ReturnType<typeof openStore>["store"],
  manager: ReturnType<typeof createSessionManager>,
  parentSessionId: string,
  childSessionId: string,
  status: "completed" | "paused" = "completed",
  source?: string,
) {
  const parent = await manager.read(parentSessionId)
  if (parent?.kind !== "chat") throw new Error("missing parent chat")
  const description = "Recover completion"
  const toolUseId = `workflow-${childSessionId}`
  const input = { ...(source === undefined ? { workflow_definition_id: "workflow" } : { source }), description, summary: "Recovery" }
  const evidence = contentEvidence(JSON.stringify(input))
  const writer = createSessionFactWriter({ sessionId: parentSessionId, writer: store })
  await writer.record({
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId,
      toolName: "workflow",
      input,
      inputBytes: evidence.bytes,
      inputSha256: evidence.sha256,
      inputPreview: evidence.preview,
      executionMode: "background",
      traceKind: "subagent",
      childHasOwnViewport: true,
      modelRequestId: "request",
    },
  })
  writer.dispose()
  const tree = await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(store), writer: store })
  if (!tree) throw new Error("missing launch conversation")
  if ((await tree.getBranch()).length === 0) await tree.appendMessage({ kind: "user", content: "start the workflow" })
  await tree.appendMessage({
    kind: "assistant",
    content: [{ type: "tool_use", id: toolUseId, name: "workflow", input }],
  })
  tree.getStorage().dispose()
  await manager.publishWorkflow({
    id: childSessionId,
    description,
    workflowDefinitionId: "workflow",
    initialRoles: {},
    launchedFrom: { parentSessionId, conversationId: parent.conversationId, workflowDefinitionId: "workflow", toolUseId, description },
    facts: workflowFacts(description, status),
  })
  return { conversationId: parent.conversationId, toolUseId }
}

function openStore(baseDir: string) {
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
  const store = runtime.runSync(LocalEventStoreService)
  const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
  return { runtime, store, manager }
}

/** Commits a delivered notification into the parent conversation the way the
 *  production runner's tree writer does, so the entry carries the notification
 *  key as its id and the held row is consumed. */
async function commitDeliveredNotification(
  cycle: ReturnType<typeof openStore>,
  baseDir: string,
  sessionId: string,
  notification: HeldBackgroundNotification,
): Promise<boolean> {
  const session = await cycle.manager.read(sessionId)
  if (session?.kind !== "chat") throw new Error(`missing chat ${sessionId}`)
  const treeWriter = createConversationTreeWriterController({
    conversationId: session.conversationId,
    sessionId,
    projectRoot: baseDir,
    store: asAsyncEventReadSurface(cycle.store),
    projectionReader: asAsyncEventReadSurface(cycle.store),
    writer: cycle.store,
  })
  try {
    return await treeWriter.commitBackgroundNotification(notification) !== null
  } finally {
    await treeWriter.dispose()
  }
}

interface RunnerHarness {
  /** Runners the supervisor started: activation starts one idle runner for an
   *  open session (ARCH-SESSIONS-038), so an open parent counts one. */
  readonly starts: { value: number }
  /** Turns the supervisor pushed into a runner through resume or injection.
   *  Neither activation nor child completion may add one. */
  readonly turns: { value: number }
}

/** The runner an open tab holds: idle, committing every delivered notification
 *  durably like the production runner, and counting any turn pushed into it. */
function idleRunner(cycle: ReturnType<typeof openStore>, baseDir: string, harness: RunnerHarness, sessionId: string): ChatRunner {
  return mockRunner(sessionId, {
    deliverBackgroundNotification: (notification) => commitDeliveredNotification(cycle, baseDir, sessionId, notification),
    resumeCommitted: () => { harness.turns.value += 1; return true },
    send: async () => { harness.turns.value += 1; return "accepted" },
  })
}

function createSupervisor(
  cycle: ReturnType<typeof openStore>,
  baseDir: string,
  runnerStarts: { value: number },
  runnerFor?: (sessionId: string) => ChatRunner,
  realRunner = false,
  liveRegistry = false,
) {
  let reconciliationPasses = 0
  const harness: RunnerHarness = { starts: runnerStarts, turns: { value: 0 } }
  const projectionReader = cycle.runtime.runSync(EventReaderService)
  const sessionStore = createSessionStore(cycle.runtime, projectionReader)
  const workflowHosts = createWorkflowHosts({ runtime: cycle.runtime, projectionReader, attachChildProjection: childSessionProjectionAttachment(sessionStore) })
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps({ ...cycle, sessionStore, workflowHosts, baseDir, continuationLanes: createContinuationLanes() }, sessionStore, {
      createRunner: async (deps) => {
        runnerStarts.value += 1
        if (realRunner) return createChatRunner(deps)
        return runnerFor ? runnerFor(deps.sessionId) : idleRunner(cycle, baseDir, harness, deps.sessionId)
      },
      reconcileChildSessionCompletions: (parentSessionId, options) => {
        reconciliationPasses += 1
        // Production sweeps through the reader the supervisor registers live
        // controls on, which reaches the parent runner's registry. A separate
        // reader leaves that registry out and delivers through `options`.
        return reconcileChildSessionCompletions({
          parentSessionId,
          reader: liveRegistry ? projectionReader : asAsyncEventReadSurface(cycle.store),
          writer: {
            append: async (event) => cycle.store.append(event),
            appendBatch: async (events) => cycle.store.appendBatch(events),
            appendGuarded: async (event) => cycle.store.appendGuarded(event),
            appendBatchGuarded: async (events) => cycle.store.appendBatchGuarded(events),
            pruneSupersededEvents: async (aggregateId, eventType) => cycle.store.pruneSupersededEvents(aggregateId, eventType),
          },
          ...options,
        })
      },
    }),
    sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(cycle.store), asAsyncEventReadSurface(cycle.store)) },
  })
  return { sessionStore, supervisor, turns: harness.turns, reconciliationPasses: () => reconciliationPasses }
}

/** Runs the project's recovery pass over the store, as the state Worker
 *  runs it after an executor generation closes. It claims every session
 *  left active, and none of them degrades. */
async function recoverClosedGeneration(cycle: ReturnType<typeof openStore>, baseDir: string): Promise<void> {
  const recovered = await recoverProject({ directories: testDirectories(baseDir), reader: asAsyncEventReadSurface(cycle.store), writer: cycle.store }, "closed-generation")
  expect(recovered.degraded).toEqual([])
}

async function assertSingleCompletion(cycle: ReturnType<typeof openStore>, parentSessionId: string, conversationId: string, toolUseId: string, childSessionId: string) {
  const tools = loadToolExecutionTimelineFromEvents(cycle.store.read({ aggregateId: `session:${parentSessionId}` }))
  expect(tools.filter((tool) => tool.toolUseId === toolUseId && tool.status === "completed")).toHaveLength(1)
  const tree = await createConversationTreeProjection(asAsyncEventReadSurface(cycle.store), conversationId).replay()
  expect(Object.keys(tree.entriesById).filter((id) => id === `workflow-completion:${childSessionId}`)).toHaveLength(1)
  expect(cycle.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(1)
}

describe("fresh-store chat workflow completion recovery", () => {
  test("an open idle parent refreshes after a child completes without resuming a turn", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-parent-first-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "parent-first", name: "Parent", initialState: "inactive" })
    const parent = await cycle.manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("missing parent")
    const tree = await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store), writer: cycle.store })
    if (!tree) throw new Error("missing parent tree")
    await tree.appendMessage({ kind: "user", content: "wait for the workflow" })
    tree.getStorage().dispose()
    const runnerStarts = { value: 0 }
    const live = createSupervisor(cycle, baseDir, runnerStarts)
    expect(await live.supervisor.activateSession(parentSessionId)).toBe(true)
    // An open session holds its runner (ARCH-SESSIONS-038): activation started it idle
    // in the background, and joining that start pins the state the child
    // completes into.
    const runner = await live.supervisor.ensureChatRunner(parentSessionId)
    expect(runnerStarts.value).toBe(1)
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "child-after-parent")
    expect(await live.supervisor.reconcileChildSessionCompletions(parentSessionId)).toEqual({
      reconciledCount: 1,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: ["child-after-parent"],
    })
    await assertSingleCompletion(cycle, parentSessionId, launch.conversationId, launch.toolUseId, "child-after-parent")
    expect(live.sessionStore.get(parentSessionId)?.outputBlocks().length).toBeGreaterThan(1)
    expect(live.sessionStore.get(parentSessionId)?.runner).toBe(runner)
    expect(runnerStarts.value).toBe(1)
    expect(live.turns.value).toBe(0)
    await live.supervisor.disposeAll()
    await cycle.runtime.dispose()
  })

  test.each([
    ["legacy source", undefined],
    ["JSON-string content source", JSON.stringify({ kind: "content", content: "id: workflow\n" })],
  ] as const)("an attached parked parent publishes child completion once for a %s", async (_label, source) => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-parked-parent-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "parked-parent", name: "Parent", initialState: "inactive" })
    const parent = await cycle.manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("missing parent")
    const tree = await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store), writer: cycle.store })
    if (!tree) throw new Error("missing parent tree")
    await tree.appendMessage({ kind: "user", content: "wait for the workflow" })
    tree.getStorage().dispose()
    const runnerStarts = { value: 0 }
    const neverSettles = Promise.withResolvers<void>()
    const treeWriter = createConversationTreeWriterController({
      conversationId: parent.conversationId, sessionId: parentSessionId, projectRoot: baseDir,
      store: asAsyncEventReadSurface(cycle.store), projectionReader: asAsyncEventReadSurface(cycle.store), writer: cycle.store,
    })
    await treeWriter.getState()
    treeWriter.beginTurn()
    const queue = new WorkflowInjectionQueue()
    const delivery = createBackgroundNotificationDelivery({ conversation: treeWriter, queue, abort: () => { throw new Error("notification hold failed") } })
    // A runner mid-turn: its registry holds a delivered notification durably
    // for its next save point instead of committing it now.
    const registry = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text, key) => delivery.enqueue(text, key) })
    const runner = mockRunner(parentSessionId, {
      backgroundTasks: registry,
      awaitTurnSettlement: () => neverSettles.promise,
      awaitLogicalTurnDurability: async () => {},
    })
    // Activation starts the open session's runner (ARCH-SESSIONS-038), so the parked
    // runner is the one that start attaches rather than a second attach that
    // would race it.
    const live = createSupervisor(cycle, baseDir, runnerStarts, () => runner, false, true)
    expect(await live.supervisor.activateSession(parentSessionId)).toBe(true)
    expect(await live.supervisor.ensureChatRunner(parentSessionId)).toBe(runner)
    expect(runnerStarts.value).toBe(1)
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "child-of-parked", "completed", source)
    await treeWriter.recordCanonicalMessage({ kind: "toolResult", toolUseId: launch.toolUseId, content: [{ type: "text", text: "Workflow launched" }] })
    // The finished workflow's runner, as the launch lifecycle tracks it: its
    // run ends only after the parent's reconciliation acknowledges the
    // completion as durable, and its report of that end comes later still.
    const acknowledged = Promise.withResolvers<number>()
    const runEnded = Promise.withResolvers<BackgroundWorkResult>()
    const unregisterWorkflow = registerLiveWorkflowControl(cycle.runtime.runSync(EventReaderService), {
      kind: "workflow",
      workflowId: "child-of-parked",
      handBackMember: async () => undefined,
      memberHost: async () => undefined,
      state: async () => "between_steps",
      deliver: async () => ({ status: "refused", reason: "settled" }),
      notify: async () => false,
      acknowledgeCompletion: (sequence) => { acknowledged.resolve(sequence) },
    })
    registry.track({
      done: runEnded.promise,
      hostClose: "detach",
      meta: { id: "child-of-parked", type: "workflow", description: "Recover completion", toolUseId: launch.toolUseId, settlementOwner: "child_session" },
    })
    expect(registry.awaitedTaskCount()).toBe(1)

    expect(await live.supervisor.reconcileChildSessionCompletions(parentSessionId)).toMatchObject({
      reconciledCount: 1,
      durableTerminalChildSessionIds: [],
    })
    const completedTools = loadToolExecutionTimelineFromEvents(
      cycle.store.read({ aggregateId: `session:${parentSessionId}` }),
    ).filter((tool) => tool.toolUseId === launch.toolUseId && tool.status === "completed")
    expect(completedTools).toHaveLength(1)
    expect(live.sessionStore.get(parentSessionId)?.runner).toBe(runner)
    expect(cycle.store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(1)
    expect(await live.supervisor.reconcileChildSessionCompletions(parentSessionId)).toMatchObject({
      reconciledCount: 0,
      durableTerminalChildSessionIds: [],
    })
    // The registry admits the completion to the runner's queue only after its
    // durable hold lands, so the runner's own wait is the signal it arrived.
    const notice = await queue.prepareWaitForInput().commit()
    if (notice?.kind !== "message") throw new Error("missing child completion")
    expect(notice.text).toContain("Workflow completed:")
    expect(queue.drainPending()).toBeNull()
    await treeWriter.recordCanonicalMessage({ kind: "user", origin: "system", content: notice.text, backgroundNotificationIds: notice.backgroundNotificationIds })
    await treeWriter.flushSavePoint()
    // The registry's keyed commit alone drives the parent's next sweep, which
    // acknowledges the workflow's terminal revision and so ends its run.
    expect(await acknowledged.promise).toBe(cycle.store.aggregateSeq("workflow:child-of-parked") + 1)
    // The parent's turn on the committed notice ends with nothing awaited,
    // though the workflow's run has not reported its end yet.
    expect(registry.awaitedTaskCount()).toBe(0)
    expect(registry.liveWorkReferences()).toEqual([])
    runEnded.resolve({ status: "completed", content: "done" })
    await runEnded.promise
    expect(registry.awaitedTaskCount()).toBe(0)
    await assertSingleCompletion(cycle, parentSessionId, launch.conversationId, launch.toolUseId, "child-of-parked")
    expect(queue.drainPending()).toBeNull()
    unregisterWorkflow()
    await treeWriter.dispose()
    await live.supervisor.disposeAll()
    neverSettles.resolve()
    await cycle.runtime.dispose()
  })

  test("reconciles a child that finishes after runner construction before the next parent turn", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-turn-start-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "turn-start-parent", name: "Parent", initialState: "inactive" })
    const parent = await cycle.manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("missing parent")
    const tree = await tryOpenConversationTree({ conversationId: parent.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store), writer: cycle.store })
    if (!tree) throw new Error("missing parent tree")
    await tree.appendMessage({ kind: "user", content: "wait for the child" })
    tree.getStorage().dispose()
    const runnerStarts = { value: 0 }
    const live = createSupervisor(cycle, baseDir, runnerStarts)
    expect(await live.supervisor.activateSession(parentSessionId)).toBe(true)
    await live.supervisor.ensureChatRunner(parentSessionId)
    expect(runnerStarts.value).toBe(1)

    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "turn-start-child")
    expect(cycle.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(0)

    expect(await live.supervisor.sendChat(parentSessionId, "continue after the child")).toEqual({ ok: true })
    // The idle runner committed the delivered completion before taking the
    // turn, so the parent holds it once in the conversation and nothing stays
    // held in flight.
    await assertSingleCompletion(cycle, parentSessionId, launch.conversationId, launch.toolUseId, "turn-start-child")
    expect(cycle.store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toHaveLength(0)
    expect(runnerStarts.value).toBe(1)

    await live.supervisor.disposeAll()
    await cycle.runtime.dispose()
  })

  test("a provider-style paused child leaves the parent tool and notification pending", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-paused-child-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "paused-parent", name: "Parent", initialState: "inactive" })
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "paused-child", "paused")
    const live = createSupervisor(cycle, baseDir, { value: 0 }, undefined, true)

    expect(await live.supervisor.reconcileChildSessionCompletions(parentSessionId)).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 1,
      durableTerminalChildSessionIds: [],
      linkedNonterminalWorkflowToolUseIds: [launch.toolUseId],
    })
    expect(await live.supervisor.activateSession(parentSessionId)).toBe(true)
    expect(live.reconciliationPasses()).toBe(2)
    expect(cycle.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toHaveLength(0)
    const parentTree = await createConversationTreeProjection(asAsyncEventReadSurface(cycle.store), launch.conversationId).replay()
    expect(Object.keys(parentTree.entriesById).some((id) => id.startsWith("workflow-completion:paused-child"))).toBe(false)

    await live.supervisor.disposeAll()
    await cycle.runtime.dispose()
  })

  test("a fresh store reconstructs a terminal child into a reopened parent exactly once without resuming a turn", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-child-first-recovery-"))
    directories.push(baseDir)
    let cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "closed-parent", name: "Parent", initialState: "inactive" })
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "terminal-child")
    await cycle.runtime.dispose()

    cycle = openStore(baseDir)
    const runnerStarts = { value: 0 }
    const recovered = createSupervisor(cycle, baseDir, runnerStarts, undefined, true)
    expect(await recovered.supervisor.activateSession(parentSessionId)).toBe(true)
    expect(recovered.reconciliationPasses()).toBe(1)
    await assertSingleCompletion(cycle, parentSessionId, launch.conversationId, launch.toolUseId, "terminal-child")
    // Reopening the parent starts its runner idle (ARCH-SESSIONS-038); the completion
    // above was already durable before that start, and the start owes no turn.
    await recovered.supervisor.ensureChatRunner(parentSessionId)
    expect(runnerStarts.value).toBe(1)
    expect(await recovered.supervisor.reconcileChildSessionCompletions(parentSessionId)).toEqual({
      reconciledCount: 0,
      workflowAggregateReads: 0,
      durableTerminalChildSessionIds: ["terminal-child"],
    })
    await assertSingleCompletion(cycle, parentSessionId, launch.conversationId, launch.toolUseId, "terminal-child")
    expect(runnerStarts.value).toBe(1)
    expect(recovered.turns.value).toBe(0)
    await recovered.supervisor.disposeAll()
    await cycle.runtime.dispose()
  })

  test("startup recovery leaves workflows and their parked parents to the parents' own loads, at every start", async () => {
    // A workflow has no owner process once it stops, so "owner gone" holds
    // for every workflow the project ever ran. Recovery that claimed them
    // re-read each one, and its parent, at every start, and the wait grew
    // with the project's history. A parked parent reconciles its children
    // when its runner starts.
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-stale-owner-child-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "stale-owner-parent", name: "Parent", initialState: "inactive" })
    const finished = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "finished-child")
    const paused = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "paused-child", "paused")
    const reader = asAsyncEventReadSurface(cycle.store)

    for (const scope of ["closed-generation", "ownerless", "ownerless"] as const) {
      const recovered = await recoverProject({ directories: testDirectories(baseDir), reader, writer: cycle.store }, scope)
      expect(recovered).toEqual({ sessionIds: [], degraded: [] })
    }
    const launchCalls = loadToolExecutionTimelineFromEvents(cycle.store.read({ aggregateId: `session:${parentSessionId}` }))
      .filter((tool) => tool.toolUseId === finished.toolUseId || tool.toolUseId === paused.toolUseId)
    expect(launchCalls.map((tool) => tool.status)).not.toContain("completed")
    expect(cycle.store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])
    expect(await cycle.manager.read(parentSessionId)).toMatchObject({ lifecycleState: "inactive" })

    await cycle.runtime.dispose()
  })

  test("recovery of a parent its owner left active keeps the launch call of a child that has not ended waiting, with no interrupted guess", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-waiting-launch-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "waiting-parent", name: "Parent", initialState: "active" })
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "waiting-child", "paused")
    // The deferred call's acknowledgement answers its tool_use in the
    // conversation, and its result waits for the child.
    const tree = await tryOpenConversationTree({ conversationId: launch.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store), writer: cycle.store })
    if (!tree) throw new Error("missing launch conversation")
    await tree.appendMessage({ kind: "toolResult", toolUseId: launch.toolUseId, content: [{ type: "text", text: "Workflow launched" }] })
    tree.getStorage().dispose()

    await recoverClosedGeneration(cycle, baseDir)

    expect(cycle.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] })).toEqual([])
    expect(await readChildCall(asAsyncEventReadSurface(cycle.store), { parentSessionId, toolUseId: launch.toolUseId })).toEqual({})
    expect(await cycle.manager.read(parentSessionId)).toMatchObject({ lifecycleState: "inactive" })

    await cycle.runtime.dispose()
  })

  test("recovery of a parent its owner left active records the crash without the launch call its acknowledgement answered, and restores its notification after the crash record", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-ended-launch-recovery-"))
    directories.push(baseDir)
    const cycle = openStore(baseDir)
    const parentSessionId = await cycle.manager.createChat({ id: "ended-parent", name: "Parent", initialState: "active" })
    const launch = await recordLaunch(cycle.store, cycle.manager, parentSessionId, "ended-child")
    const tree = await tryOpenConversationTree({ conversationId: launch.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store), writer: cycle.store })
    if (!tree) throw new Error("missing launch conversation")
    await tree.appendMessage({ kind: "toolResult", toolUseId: launch.toolUseId, content: [{ type: "text", text: "Workflow launched" }] })
    tree.getStorage().dispose()

    await recoverClosedGeneration(cycle, baseDir)

    expect(cycle.store.read({ aggregateId: `session:${parentSessionId}`, types: ["tool.result.recorded"] }).map(({ payload }) => payload.outcome)).toEqual(["ok"])
    const recovered = await tryOpenConversationTree({ conversationId: launch.conversationId, sessionId: parentSessionId, store: asAsyncEventReadSurface(cycle.store) })
    if (!recovered) throw new Error("missing launch conversation")
    const [record, notification] = (await recovered.getBranch()).slice(-2)
    recovered.getStorage().dispose()
    expect(record).toMatchObject({ message: { kind: "user", origin: "system", content: expect.stringContaining("exited before the turn finished") } })
    // The acknowledgement the turn committed answers the launch call, so the
    // record does not name it as left-behind work.
    expect(record?.kind === "message" ? String(record.message.content) : "").not.toContain("workflow")
    expect(notification).toMatchObject({ id: "workflow-completion:ended-child", parentId: record?.id, message: { replyRequired: true } })
    expect(cycle.store.readInFlight(parentSessionId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)).toEqual([])

    await cycle.runtime.dispose()
  })
})
