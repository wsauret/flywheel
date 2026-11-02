import { describe, expect, test } from "bun:test"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { interruptLiveChild, registerTestChildRun } from "../../../helpers/live-child-run"
import { liveChildRun } from "../../../../src/orchestration/session/live-session-control.js"

import { EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { asAsyncEventReadSurface, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { ConversationMessage, StreamOptions } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { SessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps.js"
import { createChatRunner } from "../../../../src/orchestration/chat/runner.js"
import { composeModuleProtocolRuntimes } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { continueAfterReplacement } from "../../../../src/orchestration/app-service/replacement-continuation.js"
import type { ChatHostAttach } from "../../../../src/orchestration/app-service/executor-command-handover.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { subagentsModule } from "../../../../src/orchestration/modules/subagents.js"
import { buildDurableSubagentCreated, buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { readChatTurnEnd } from "../../../../src/orchestration/session/chat-session-run-evidence.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId, type TurnInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { authorizePlannedSessionContinuation, awaitsPlannedContinuation, createContinuationLanes, interruptChildForReplacement, readPlannedSessionContinuationAsync, recordOwedPersonInterrupt } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { ChatSessionEntry, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { createSupervisorTestContext, mockRunner, mockWorkflowRunner, supervisorBaseDeps, testSessionAuthAdmission, resumeDispatch, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { workflowControlInitializedEvent } from "../../workflows/vm/_workflow-control-fixtures.js"
import { roleCapture } from "../../../helpers/role-capture.js"

const HANDOFF = "handoff-1"
const tmp = temporaryDirectories()

/** One project store with the successor's continuation over it. */
async function withProject(run: (ctx: SupervisorTestContext, writer: AsyncEventWriter) => Promise<void>): Promise<void> {
  const ctx = createSupervisorTestContext(tmp("flywheel-person-interrupt-"))
  try {
    await run(ctx, ctx.runtime.runSync(EventStoreWriterService))
  } finally {
    await ctx.runtime.dispose()
  }
}

/** Appends one message to the conversation, under `id` when given. */
async function append(ctx: SupervisorTestContext, writer: AsyncEventWriter, sessionId: string, conversationId: string, message: ConversationMessage, id?: string): Promise<void> {
  const handle = { conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer }
  const tree = await tryOpenConversationTree(handle) ?? await createConversationTree(handle)
  await tree.appendMessage(message, id)
  tree.getStorage().dispose()
}

const userTurn: ConversationMessage = { kind: "user", content: "Do the fixture work.", origin: "human" }

/** Records the turn end of an interrupt by `by`, as its interrupt records it. */
async function recordTurnEnd(ctx: SupervisorTestContext, writer: AsyncEventWriter, sessionId: string, conversationId: string, by: TurnInterruption): Promise<void> {
  const end = interruptedTurnEnd(by)
  await append(ctx, writer, sessionId, conversationId, { kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, crypto.randomUUID()))
}

/** A chat the cut interrupted, holding the handoff's continuation row. */
async function cutChat(ctx: SupervisorTestContext, writer: AsyncEventWriter): Promise<{ readonly sessionId: string; readonly conversationId: string }> {
  const conversationId = `conversation-${crypto.randomUUID()}`
  const sessionId = await ctx.manager.createChat({ conversationId })
  await append(ctx, writer, sessionId, conversationId, userTurn)
  await recordTurnEnd(ctx, writer, sessionId, conversationId, "replacement")
  await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { sessionId, kind: "chat" }, handoffId: HANDOFF } })
  return { sessionId, conversationId }
}

const WORKFLOW = "flow"
const STEP_CONVERSATION = "step-conversation"

/** A workflow whose current step the cut interrupted, holding the handoff's continuation row. */
async function cutWorkflow(ctx: SupervisorTestContext, writer: AsyncEventWriter): Promise<void> {
  const queue: WorkflowView = {
    tree: { nodes: [{ id: "step-1:phase", kind: "phase", form: "single", phaseId: "implement", label: "Implement", parentId: null, disposition: "running" }, { id: "step-1", kind: "agent", definitionId: "implement", label: "Implement", parentId: "step-1:phase", disposition: "running", attempts: 1, currentAttemptId: "step-1" }] },
    attempts: [{ id: "step-1", definitionId: "implement", briefId: "implement", workflowDefinitionId: "implement", name: "Implement", status: "running", writes: [], resumeRevertCount: 0, lastConversationId: STEP_CONVERSATION }],
    cursor: 0,
    status: "running",
    mutationLog: [],
  }
  await writer.append(workflowControlInitializedEvent(WORKFLOW, 0))
  await writer.appendBatch(queueFactsForState(null, queue).map((fact) => ({ aggregateId: `workflow:${WORKFLOW}`, timestamp: 0, sessionId: WORKFLOW, ...fact })))
  await append(ctx, writer, WORKFLOW, STEP_CONVERSATION, userTurn)
  await recordTurnEnd(ctx, writer, WORKFLOW, STEP_CONVERSATION, "replacement")
  await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { workflowId: WORKFLOW, kind: "workflow" }, handoffId: HANDOFF } })
}

const CHILD = "child"
const CHILD_CONVERSATION = "child-conversation"
const CHILD_RUN = "run"

/** A running child, as its dispatch records it. */
async function runningChild(ctx: SupervisorTestContext, writer: AsyncEventWriter): Promise<void> {
  await writer.append(prepareSessionFactAppend(CHILD, buildDurableSubagentCreated({
    childSessionId: CHILD,
    childRunId: CHILD_RUN,
    conversationId: CHILD_CONVERSATION,
    parentSessionId: "parent",
    parentConversationId: "parent-conversation",
    parentToolCallId: "dispatch-1",
    persona: { name: "explorer", kind: "persona" },
    capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "test" },
    admittedModuleIds: [],
    skillsRevision: 1,
    model: "test/model",
    tools: ["read"],
    executionCwd: ctx.baseDir,
    budget: { maxTurns: 10, maxTokens: 0 },
    parentDepth: 0,
    description: "child",
  })))
  await append(ctx, writer, CHILD, CHILD_CONVERSATION, userTurn)
}

/** The person's controls of the child, through the subagents module. */
function childControls(ctx: SupervisorTestContext, writer: AsyncEventWriter) {
  const bus = createRuntimeUiBus()
  return composeModuleProtocolRuntimes([subagentsModule], {
    eventStore: asAsyncEventReadSurface(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
    eventWriter: writer,
    manager: ctx.manager,
    sessionStore: ctx.sessionStore,
    interruptSession: interruptLiveChild({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer, manager: ctx.manager, lanes: ctx.continuationLanes }),
    definitions: repoDefinitions(),
    onStored: () => () => {},
    publish: bus.publish,
    snapshotPosition: bus.snapshotPosition,
    hasLiveSession: () => false,
    background: async () => { throw new Error("The interrupt reads no background history") },
    modules: NO_MODULE_SERVICES,
  }, () => [subagentsModule.id])
}

/** No chat of these cases holds a handed-over command, so the successor attaches none. */
const NO_CHAT_ATTACH: ChatHostAttach["supervisor"] = {
  activateSession: async () => { throw new Error("no chat here holds a handed-over command") },
  ensureChatRunner: async () => { throw new Error("no chat here holds a handed-over command") },
}

/** The successor's continuation of the handoff: what it resumed and dispatched. */
async function successorContinues(ctx: SupervisorTestContext, writer: AsyncEventWriter): Promise<{ readonly resumed: readonly string[]; readonly dispatched: readonly FrontendMutation[] }> {
  const dispatched: FrontendMutation[] = []
  const resumed = await continueAfterReplacement({
    reader: asAsyncEventReadSurface(ctx.store),
    projectionReader: asAsyncEventReadSurface(ctx.store),
    writer,
    manager: ctx.manager,
    lanes: ctx.continuationLanes,
    supervisor: NO_CHAT_ATTACH,
    keep: async () => {},
    dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
    handoffId: HANDOFF,
    resumePlannedWorkflow: async (workflowId) => ({ kind: "resumed", sessionId: workflowId }),
    settled: () => {},
  })
  return { resumed, dispatched }
}

/** A model whose chat turn streams until it is cut. Its stream then waits
 *  for `unwind` before it ends, as a provider stream takes time to end
 *  after its request is aborted, so the cut's step is still running while
 *  it waits. */
function slowToEndModel() {
  const requested = Promise.withResolvers<void>()
  const aborted = Promise.withResolvers<void>()
  const unwind = Promise.withResolvers<void>()
  const client = asModelClient({
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test",
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    promptNotes: { progress: "", modelNotes: "" },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
    async *streamWithTools(options: StreamOptions) {
      // The session's title request carries no tools.
      if (options.tools.length === 0) {
        yield { kind: "text_delta", text: "Counting", blockKey: "t0" } as const
        yield { kind: "done", stopReason: "end_turn" } as const
        return
      }
      requested.resolve()
      yield { kind: "text_delta", text: "1\n2\n3\n", blockKey: "b0" } as const
      await new Promise<void>((resolve) => {
        if (options.signal?.aborted) resolve()
        options.signal?.addEventListener("abort", () => resolve(), { once: true })
      })
      aborted.resolve()
      await unwind.promise
    },
  })
  return { client, requested: requested.promise, aborted: aborted.promise, unwind: () => unwind.resolve() }
}

/** The test's auth admission, whose runners stream from `client`. */
function admissionStreamingFrom(client: ReturnType<typeof slowToEndModel>["client"]): SessionAuthAdmission<WorkflowDeps> {
  const base = testSessionAuthAdmission()
  const current = base.current("any")
  const createLLMClient = async () => client
  const capture = async () => ({
    ...roleCapture([client.model]),
    admit: () => ({ createLLMClient, createAgent: () => { throw new Error("This capture constructs clients only") } }),
  })
  const admitted = Object.freeze({ ...current, workflowDeps: { ...current.workflowDeps, captureProviderConnection: capture, createAgent: (options: Parameters<WorkflowDeps["createAgent"]>[0]) => newTestRunner(options, createLLMClient, undefined, capture) } })
  return { ...base, admitDefaults: async () => admitted, admit: async () => admitted, current: () => admitted }
}

/** A chat with one answered exchange, in a predecessor whose real chat
 *  runner streams from a model that is slow to end, under the handoff the
 *  account published for its stop. */
async function predecessorChat(ctx: SupervisorTestContext, writer: AsyncEventWriter) {
  const conversationId = `conversation-${crypto.randomUUID()}`
  const sessionId = await ctx.manager.createChat({ conversationId })
  await append(ctx, writer, sessionId, conversationId, userTurn)
  await append(ctx, writer, sessionId, conversationId, { kind: "assistant", content: [{ type: "text", text: "Done." }] })
  const model = slowToEndModel()
  const admission = admissionStreamingFrom(model.client)
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner: (deps) => createChatRunner({ ...deps, authAdmission: admission }) }),
    sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
    replacementHandoff: () => HANDOFF,
  })
  return { sessionId, conversationId, model, supervisor }
}

describe("a person's interrupt of a session a successor owes its continuation", () => {
  test("in the predecessor, an interrupt that arrives while the cut is cutting the running turn wins: the person's turn end stands over the cut, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const { sessionId, conversationId, model, supervisor } = await predecessorChat(ctx, writer)
      expect(await supervisor.sendChat(sessionId, "Count to one hundred.")).toEqual({ ok: true })
      await model.requested

      const cut = supervisor.interruptForReplacement(HANDOFF)
      // The cut has written the row and aborted the turn, whose stream is
      // still ending: the person's Escape lands now.
      await model.aborted
      const interrupt = supervisor.interruptSession(sessionId, "person")
      model.unwind()

      expect(await cut).toEqual([sessionId])
      expect(await interrupt).toBe(true)
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toBeNull()
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      await supervisor.disposeAll()
    })
  })

  test("in the predecessor, an interrupt that arrives while the stop cuts a turn admitted after the cut wins: the person's turn end stands over the cut, the stop closes the session, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const { sessionId, conversationId, model, supervisor } = await predecessorChat(ctx, writer)
      expect(await supervisor.sendChat(sessionId, "Count to one hundred.")).toEqual({ ok: true })
      await model.requested

      // The executor heard the handoff after the cut, so its stop cuts the
      // turn; the person's Escape lands while that turn's stream is ending.
      const stop = supervisor.disposeAll()
      await model.aborted
      const interrupt = supervisor.interruptSession(sessionId, "person")
      model.unwind()

      await stop
      expect(await interrupt).toBe(true)
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toBeNull()
      expect((await ctx.manager.read(sessionId))?.lifecycleState).toBe("inactive")
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
    })
  })

  test("in the predecessor, an interrupt that lands while the stop ends an owed chat's runner, its store entry still resident, is recorded through the conversation's writer, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      // The stop has ended the chat's runner, which answers so; the store
      // entry that holds it is not removed yet.
      const entry: ChatSessionEntry = {
        ...entryRuntimeDefaults(() => [], 0),
        kind: "chat",
        description: chat.sessionId,
        conversationId: chat.conversationId,
        runnerState: "idle",
        runner: mockRunner(chat.sessionId, { interruptPlannedCut: async () => "ended" }),
      }
      const store: SessionStore = { ...ctx.sessionStore, get: (sessionId) => sessionId === chat.sessionId ? entry : undefined, interrupt: () => false }
      const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, store))

      expect(await supervisor.interruptSession(chat.sessionId, "person")).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      await supervisor.disposeAll()
    })
  })

  test("an interrupt whose turn in the session's lane does not come within the cut limit records the person's turn end through the conversation's writer, and its later turn does nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const lanes = createContinuationLanes({ interruptWaitLimitMs: 5 })
      // A step ahead of the interrupt never settles, as a cut whose turn
      // never unwinds.
      const stuck = Promise.withResolvers<void>()
      const ahead = lanes.run(chat.sessionId, () => stuck.promise)

      const interrupted = await lanes.interrupt({ by: "person",
        reader: asAsyncEventReadSurface(ctx.store),
        projectionReader: asAsyncEventReadSurface(ctx.store),
        writer,
        manager: ctx.manager,
        sessionId: chat.sessionId,
        runs: () => false,
        interrupt: () => false,
      })

      expect(interrupted).toBe(true)
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      const personRecords = () => ctx.store.read({ aggregateId: `conversation:${chat.conversationId}`, types: ["chat.entries.appended"] })
        .flatMap((batch) => Array.isArray(batch.payload.entries) ? batch.payload.entries : [])
        .filter((stored: { readonly id?: unknown }) => typeof stored.id === "string" && stored.id.startsWith("itb-paused-person-"))
      expect(personRecords()).toHaveLength(1)
      stuck.resolve()
      await ahead
      // The interrupt's own turn comes now and records nothing more.
      await lanes.run(chat.sessionId, async () => {})
      expect(personRecords()).toHaveLength(1)
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
    })
  })

  test("in the predecessor, an interrupt past the cut limit while the cut's turn still unwinds is recorded by the chat's runner behind the cut's record, so the person's turn end is the last one", async () => {
    await withProject(async (ctx, writer) => {
      const bounded = { ...ctx, continuationLanes: createContinuationLanes({ interruptWaitLimitMs: 5 }) }
      const { sessionId, conversationId, model, supervisor } = await predecessorChat(bounded, writer)
      expect(await supervisor.sendChat(sessionId, "Count to one hundred.")).toEqual({ ok: true })
      await model.requested

      // The cut aborted the turn, whose stream does not end within the limit.
      const cut = supervisor.interruptForReplacement(HANDOFF)
      await model.aborted
      expect(await supervisor.interruptSession(sessionId, "person")).toBe(true)
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toBeNull()
      model.unwind()
      expect(await cut).toEqual([sessionId])

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(ctx.sessionStore.get(sessionId)?.outputBlocks()).toContainEqual(expect.objectContaining({ kind: "system", message: "Interrupted" }))
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      await supervisor.disposeAll()
    })
  })

  test("an interrupt past the cut limit while a turn that no cut ended runs, such as the one a slow resume opened, takes the ordinary interrupt, whose runner records the person's turn end", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const lanes = createContinuationLanes({ interruptWaitLimitMs: 5 })
      const interrupts: string[] = []
      const entry: ChatSessionEntry = {
        ...entryRuntimeDefaults(() => [], 0),
        kind: "chat",
        description: chat.sessionId,
        conversationId: chat.conversationId,
        runnerState: "streaming",
        runner: mockRunner(chat.sessionId, { interruptPlannedCut: async () => "running" }),
      }
      const store: SessionStore = { ...ctx.sessionStore, get: (sessionId) => sessionId === chat.sessionId ? entry : undefined, interrupt: (sessionId) => { interrupts.push(sessionId); return true } }
      const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, store), continuationLanes: lanes })
      // The successor has dispatched its resume, which holds the session's
      // lane past the limit.
      const dispatched = Promise.withResolvers<boolean>()
      const settle = Promise.withResolvers<void>()
      const resuming = lanes.resume(chat.sessionId, async (mayDispatch) => { dispatched.resolve(mayDispatch()); await settle.promise })
      expect(await dispatched.promise).toBe(true)

      expect(await supervisor.interruptSession(chat.sessionId, "person")).toBe(true)

      expect(interrupts).toEqual([chat.sessionId])
      // The runner that took the interrupt records it; no second writer does.
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      settle.resolve()
      await resuming
      await supervisor.disposeAll()
    })
  })

  test("in the successor before its duty resumes it, a chat no runner holds is left interrupted by the person, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx))
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, chat.sessionId)).toBe(true)

      expect(await supervisor.interruptSession(chat.sessionId, "person")).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, chat.sessionId)).toBe(false)
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      await supervisor.disposeAll()
    })
  })

  test("in the successor while its executor recovers with no restart scheduled, the account's interrupt is recorded through the state Worker's writer over the cut, and the next executor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      // The state Worker's own reader and writer, as the account asks it.
      const owed = { reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer, manager: ctx.manager, sessionId: chat.sessionId }

      expect(await recordOwedPersonInterrupt(owed)).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      // The session is owed nothing now, so a second interrupt records nothing.
      expect(await recordOwedPersonInterrupt(owed)).toBe(false)
    })
  })

  test("while no executor holds the project, the account's interrupt of a chat that waits for model capacity records the person's turn end and ends the wait, so no wake continues it", async () => {
    await withProject(async (ctx, writer) => {
      const conversationId = `conversation-${crypto.randomUUID()}`
      const sessionId = await ctx.manager.createChat({ conversationId })
      await append(ctx, writer, sessionId, conversationId, userTurn)
      await recordTurnEnd(ctx, writer, sessionId, conversationId, "runtime")
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { sessionId, kind: "chat" }, continuesAt: Date.now() + 60_000 } })
      const owed = { reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), writer, manager: ctx.manager, sessionId }

      expect(await recordOwedPersonInterrupt(owed)).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), sessionId)).toBeNull()
    })
  })

  test("in the predecessor, a chat whose runner the cut left idle records the person's interrupt through that runner and shows it, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx), sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) } })
      expect(await supervisor.activateSession(chat.sessionId)).toBe(true)
      await supervisor.ensureChatRunner(chat.sessionId)

      expect(await supervisor.interruptSession(chat.sessionId, "person")).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(ctx.sessionStore.get(chat.sessionId)?.outputBlocks()).toContainEqual(expect.objectContaining({ kind: "system", message: "Interrupted" }))
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      await supervisor.disposeAll()
    })
  })

  test("an interrupt that arrives while the successor continues the session, before it dispatches the resume, wins: the successor resumes nothing and the person's turn end stands over the cut", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx))
      // The successor reads the session's metadata before it decides to
      // resume it; the person's interrupt lands during that read.
      const reading = Promise.withResolvers<void>()
      const read = Promise.withResolvers<void>()
      const dispatched: FrontendMutation[] = []
      const continuation = continueAfterReplacement({
        reader: asAsyncEventReadSurface(ctx.store),
        projectionReader: asAsyncEventReadSurface(ctx.store),
        writer,
        manager: { read: async (sessionId) => { reading.resolve(); await read.promise; return await ctx.manager.read(sessionId) } },
        lanes: ctx.continuationLanes,
        supervisor: NO_CHAT_ATTACH,
        keep: async () => {},
        dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
        handoffId: HANDOFF,
        resumePlannedWorkflow: async (sessionId) => ({ kind: "resumed", sessionId }),
        settled: () => {},
      })
      await reading.promise
      const interrupt = supervisor.interruptSession(chat.sessionId, "person")
      read.resolve()

      expect(await continuation).toEqual([])
      expect(dispatched).toEqual([])
      expect(await interrupt).toBe(true)
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, chat.sessionId)).toBe(false)
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
      await supervisor.disposeAll()
    })
  })

  test("an interrupt of a chat at rest takes the session's lane in the tick it arrives, so a resume that enters the lane during the interrupt's reads dispatches nothing", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const lanes = ctx.continuationLanes
      const base = asAsyncEventReadSurface(ctx.store)
      // The interrupt's first state read waits until the successor's resume
      // has entered the session's lane.
      const reading = Promise.withResolvers<void>()
      const read = Promise.withResolvers<void>()
      let held = false
      const projectionReader = {
        ...base,
        readInFlight: async (sessionId: string, kind: string | readonly string[]) => {
          if (!held) {
            held = true
            reading.resolve()
            await read.promise
          }
          return await base.readInFlight(sessionId, kind)
        },
      }
      const interrupt = lanes.interrupt({ reader: base, projectionReader, writer, manager: ctx.manager, sessionId: chat.sessionId, by: "person", runs: () => false, interrupt: () => false })
      await reading.promise
      const resumeEntered = Promise.withResolvers<void>()
      const dispatched: FrontendMutation[] = []
      const continuation = continueAfterReplacement({
        reader: base,
        projectionReader: base,
        writer,
        manager: ctx.manager,
        lanes: { ...lanes, resume: (sessionId, step) => { const resuming = lanes.resume(sessionId, step); resumeEntered.resolve(); return resuming } },
        supervisor: NO_CHAT_ATTACH,
        keep: async () => {},
        dispatch: resumeDispatch(async (mutation) => { dispatched.push(mutation); return { ok: true } }),
        handoffId: HANDOFF,
        resumePlannedWorkflow: async (sessionId) => ({ kind: "resumed", sessionId }),
        settled: () => {},
      })
      await resumeEntered.promise
      read.resolve()

      expect(await interrupt).toBe(true)
      expect(await continuation).toEqual([])
      expect(dispatched).toEqual([])
      expect((await readChatTurnEnd(base, chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), chat.sessionId)).toBeNull()
    })
  })

  test("an interrupt that arrives while the successor resumes the session waits for that resume and records nothing over the cut", async () => {
    await withProject(async (ctx, writer) => {
      const chat = await cutChat(ctx, writer)
      const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx))
      const resuming = Promise.withResolvers<void>()
      const resumed = Promise.withResolvers<void>()
      const continuation = continueAfterReplacement({
        reader: asAsyncEventReadSurface(ctx.store),
        projectionReader: asAsyncEventReadSurface(ctx.store),
        writer,
        manager: ctx.manager,
        lanes: ctx.continuationLanes,
        supervisor: NO_CHAT_ATTACH,
        keep: async () => {},
        dispatch: resumeDispatch(async () => {
          resuming.resolve()
          await resumed.promise
          return { ok: true }
        }),
        handoffId: HANDOFF,
        resumePlannedWorkflow: async (sessionId) => ({ kind: "resumed", sessionId }),
        settled: () => {},
      })
      await resuming.promise
      // The interrupt arrives while the resume holds the session's lane. The
      // session stays owed until the resume ends, so an interrupt that did
      // not wait would record the person's turn end over the cut.
      const interrupt = supervisor.interruptSession(chat.sessionId, "person")

      resumed.resolve()
      expect(await continuation).toEqual([chat.sessionId])
      // The resume started a turn, which the ordinary interrupt cuts; this
      // runtime runs none, so there is nothing to cut.
      expect(await interrupt).toBe(false)
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), chat.conversationId))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
      await supervisor.disposeAll()
    })
  })

  test("in the successor before its duty resumes it, a workflow whose step the cut interrupted is left interrupted by the person, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      await cutWorkflow(ctx, writer)
      const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx))
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, WORKFLOW)).toBe(true)

      expect(await supervisor.interruptSession(WORKFLOW, "person")).toBe(true)

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), STEP_CONVERSATION))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, WORKFLOW)).toBe(false)
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), WORKFLOW)).toBeNull()
      await supervisor.disposeAll()
    })
  })

  test("in the predecessor, a workflow whose step the cut left parked gives the person's interrupt to its runner, whose step holds the step's conversation, and writes no record of its own", async () => {
    await withProject(async (ctx, writer) => {
      await cutWorkflow(ctx, writer)
      const asked: string[] = []
      // The runner answers that its parked step recorded the person's turn
      // end; this stand-in records nothing, so any record is the supervisor's.
      const runner = mockWorkflowRunner(WORKFLOW, { interruptPlannedCut: async () => { asked.push(WORKFLOW); return "recorded" } })
      const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore),
        workflowHosts: { ...ctx.workflowHosts, get: (id) => id === WORKFLOW ? runner : undefined } })

      expect(await supervisor.interruptSession(WORKFLOW, "person")).toBe(true)

      expect(asked).toEqual([WORKFLOW])
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), STEP_CONVERSATION))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), WORKFLOW)).toBeNull()
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      await supervisor.disposeAll()
    })
  })

  for (const pastLane of [false, true]) test(`a targeted workflow interrupt reaches its planned-cut owner ${pastLane ? "past" : "in"} the lane and keeps successor authority`, async () => {
    await withProject(async (ctx, writer) => {
      await cutWorkflow(ctx, writer)
      const address = { addressedTo: [{ _tag: "agent", nodeId: "step-1", definitionId: "implement" }], label: "implement" } as const
      const asked: unknown[] = []
      const runner = mockWorkflowRunner(WORKFLOW, { interruptPlannedCut: async (by, reached) => { asked.push({ by, address: reached }); return "recorded" } })
      const lanes = createContinuationLanes({ interruptWaitLimitMs: 1 })
      const gate = Promise.withResolvers<void>()
      const blocker = pastLane ? lanes.run(WORKFLOW, () => gate.promise) : undefined
      const supervisor = createRuntimeSupervisor({ ...supervisorBaseDeps(ctx, ctx.sessionStore), continuationLanes: lanes,
        workflowHosts: { ...ctx.workflowHosts, get: (id) => id === WORKFLOW ? runner : undefined } })
      expect(await supervisor.interruptSession(WORKFLOW, "person", address)).toBe(true)
      expect(asked).toEqual([{ by: "person", address }])
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), WORKFLOW)).not.toBeNull()
      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), STEP_CONVERSATION))?.end).toEqual({ reason: "paused", pausedBy: "runtime", planned: true })
      gate.resolve()
      await blocker
      await supervisor.disposeAll()
    })
  })

  test("in the predecessor, a child the cut paused is left interrupted by the person, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      await runningChild(ctx, writer)
      // The child runs until the cut's step authorizes it and pauses it, as its dispatch does.
      const release = registerTestChildRun(asAsyncEventReadSurface(ctx.store), {
        sessionId: CHILD, runId: CHILD_RUN, parentSessionId: "parent", parentConversationId: "parent-conversation", parentToolCallId: "dispatch-1", stop: () => {},
        async interrupt(by) {
          await recordTurnEnd(ctx, writer, CHILD, CHILD_CONVERSATION, by)
          await writer.append(prepareSessionFactAppend(CHILD, buildSubagentPaused({ childRunId: CHILD_RUN, pausedBy: interruptedTurnEnd(by).pausedBy === "runtime" ? "runtime" : "person" })))
          release()
        },
      })
      const control = liveChildRun(asAsyncEventReadSurface(ctx.store), CHILD)
      if (!control) throw new Error("the child does not run")
      await interruptChildForReplacement({ projectionReader: asAsyncEventReadSurface(ctx.store), writer, control, handoffId: HANDOFF })
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, CHILD)).toBe(true)

      expect(await childControls(ctx, writer).mutate({ type: "subagent.interrupt", sessionId: CHILD })).toEqual({ ok: true })

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), CHILD_CONVERSATION))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await awaitsPlannedContinuation({ reader: asAsyncEventReadSurface(ctx.store), projectionReader: asAsyncEventReadSurface(ctx.store), manager: ctx.manager }, CHILD)).toBe(false)
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), CHILD)).toBeNull()
    })
  })

  test("in the successor before its duty resumes it, a child the cut paused is left interrupted by the person, and the successor resumes nothing", async () => {
    await withProject(async (ctx, writer) => {
      await runningChild(ctx, writer)
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(ctx.store), writer, continuation: { target: { sessionId: CHILD, kind: "subagent" }, handoffId: HANDOFF, runId: CHILD_RUN } })
      await recordTurnEnd(ctx, writer, CHILD, CHILD_CONVERSATION, "replacement")
      await writer.append(prepareSessionFactAppend(CHILD, buildSubagentPaused({ childRunId: CHILD_RUN, pausedBy: "runtime" })))

      expect(await childControls(ctx, writer).mutate({ type: "subagent.interrupt", sessionId: CHILD })).toEqual({ ok: true })

      expect((await readChatTurnEnd(asAsyncEventReadSurface(ctx.store), CHILD_CONVERSATION))?.end).toEqual({ reason: "paused", pausedBy: "person" })
      expect(await successorContinues(ctx, writer)).toEqual({ resumed: [], dispatched: [] })
      expect(await readPlannedSessionContinuationAsync(asAsyncEventReadSurface(ctx.store), CHILD)).toBeNull()
    })
  })
})
