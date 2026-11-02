import { afterEach, beforeEach, expect, mock, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createChatTurnDurability } from "../../../../src/orchestration/chat/runner-completion.js"
import { createAskUserController } from "../../../../src/orchestration/runner/ask-user-controller.js"
import { loadAgentInputProjection } from "../../../../src/orchestration/session/agent-input-projection.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { removeOwnerPid } from "../../../../src/orchestration/session/pid-lock.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { SessionStore, SessionEntry } from "../../../../src/orchestration/session-store/types.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { chatRunner } from "./_frontend-projection-fixtures.js"
import { createDeferred, createSupervisorTestContext, disposeSupervisorTestContext, mockRunner, supervisorBaseDeps, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"

let ctx: SupervisorTestContext
beforeEach(() => { ctx = createSupervisorTestContext() })
afterEach(async () => { await disposeSupervisorTestContext(ctx) })

test.each(["answer", "cancel"] as const)("child completion leaves the mailbox available to %s a pending question", async (action) => {
  const durability = createChatTurnDurability(async () => {}, () => {})
  const waitingForDurability = createDeferred<void>()
  const order: string[] = []
  const ask = createAskUserController({
    sessionId: "waiting-parent",
    host: { pushQuestion() {}, answerQuestion() {}, cancelQuestion() {}, flush() {} },
    emit: () => {},
  })
  const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, {
    createRunner: async (deps) => mockRunner(deps.sessionId, {
      awaitLogicalTurnDurability: () => { waitingForDurability.resolve(); return durability.awaitDurable() },
      answerQuestion: ask.answerQuestion,
      cancelQuestion: ask.cancelQuestion,
    }),
    reconcileChildSessionCompletions: async () => {
      order.push("reconciled")
      return { reconciledCount: 0, workflowAggregateReads: 0 }
    },
  }))
  try {
    const sessionId = await supervisor.openSessionRuntime()
    await supervisor.sendChat(sessionId, "Ask me")
    await supervisor.ensureChatRunner(sessionId)
    const session = await ctx.manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("missing chat session")
    const question = { question: "Continue?", choices: [{ kind: "option" as const, choiceId: "yes", label: "Yes" }], multiSelect: false }
    await ctx.store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
      payload: { interactionId: "ask-1", conversationId: session.conversationId, toolUseId: "ask-1", request: [question] },
    })
    durability.begin()
    const asking = ask.ask("ask-1", [question])
    const turnEnded = asking.then(async () => { order.push("answered"); await durability.end() })
    ctx.sessionStore.updateChatEntry(sessionId, { runnerState: "awaiting_user" })
    order.length = 0
    const reconciliation = supervisor.reconcileChildSessionCompletions(sessionId)
    await waitingForDurability.promise
    expect(order).toEqual([])
    const settling = action === "answer"
      ? supervisor.answerQuestion(sessionId, "ask-1", { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } })
      : supervisor.cancelQuestion(sessionId, "ask-1")
    try {
      expect(await Promise.race([settling, Bun.sleep(20).then(() => "mailbox blocked")])).toEqual({ ok: true })
      await turnEnded
      await reconciliation
      expect(order).toEqual(["answered", "reconciled"])
      expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), sessionId)).get("ask-1")?.kind).toBe(action === "answer" ? "answered" : "cancelled")
    } finally {
      durability.settle()
      await Promise.all([settling, turnEnded, reconciliation])
    }
  } finally {
    await supervisor.disposeAll()
  }
})

const workflowQuestionCases = (["awaiting", "idle", "no-runner", "absent"] as const)
  .flatMap(state => (["answer", "cancel"] as const).map(action => [state, action] as const))

// Only a chat asks the person (PI-AGENT-024). A workflow step of an earlier
// build can still hold an open question: the person's settlement is durable
// first, and the workflow resume folds it into the step. No workflow runner
// takes the answer live.
test.each(workflowQuestionCases)(
  "a retired workflow question with %s runtime persists the %s before the resume",
  async (state, action) => {
    const workflowId = await publishTestWorkflow(ctx.manager, { id: `workflow-question-${state}-${action}` })
    const sessionId = await startTestWorkflowMember(ctx.manager, ctx.store, workflowId)
    const member = await ctx.manager.read(sessionId)
    if (member?.kind !== "workflow-agent") throw new Error("Missing member")
    await ctx.store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
      payload: {
        interactionId: "ask-1", conversationId: member.conversationId, toolUseId: "ask-1",
        request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
      },
    })
    const answers = { "Continue?": { kind: "choice" as const, selections: [{ choiceId: "yes" }], text: "Yes" } }
    // The check reads the local store synchronously. An awaited projection fold
    // would also see a fact that the supervisor appends after the callback
    // returns, so it could not prove that the fact was durable before routing.
    const assertPersisted = (): void => {
      const terminal = ctx.store.read({ aggregateId: `session:${sessionId}`, types: ["agent_input.answered", "agent_input.cancelled"] })
      expect(terminal.map(fact => fact.type)).toEqual([action === "answer" ? "agent_input.answered" : "agent_input.cancelled"])
      expect(terminal[0]?.payload).toMatchObject(action === "answer" ? { interactionId: "ask-1", answers } : { interactionId: "ask-1" })
    }
    const answerQuestion = mock<SessionStore["answerQuestion"]>(() => true)
    const cancelQuestion = mock<SessionStore["cancelQuestion"]>(() => true)
    const resumeWorkflow = mock(async (id: string) => {
      assertPersisted()
      expect(id).toBe(workflowId)
      return { kind: "resumed" as const, sessionId: id }
    })
    const entry: SessionEntry = {
      ...entryRuntimeDefaults(() => [], 0),
      kind: "workflow-agent", workflowId, operations: null, description: sessionId, conversationId: member.conversationId,
      runner: state === "no-runner" ? null : chatRunner(sessionId),
      runnerState: state === "idle" ? "idle" : "awaiting_user",
    }
    const supervisor = createRuntimeSupervisor(supervisorBaseDeps(ctx, {
      ...ctx.sessionStore,
      get: () => state === "absent" ? undefined : entry,
      answerQuestion,
      cancelQuestion,
    }, { resumeWorkflow }))
    try {
      expect(await (action === "answer"
        ? supervisor.answerQuestion(sessionId, "ask-1", answers)
        : supervisor.cancelQuestion(sessionId, "ask-1"))).toEqual({ ok: true })
      expect(answerQuestion).not.toHaveBeenCalled()
      expect(cancelQuestion).not.toHaveBeenCalled()
      expect(resumeWorkflow).toHaveBeenCalledTimes(1)
      assertPersisted()
    } finally {
      await supervisor.disposeAll()
    }
  },
)

test.each(["answer", "dismiss"] as const)("close during recovered question %s admission preserves settlement without resuming", async (action) => {
  const sessionId = `question-close-${action}`
  await ctx.manager.createChat({ name: "Waiting Chat", initialState: "inactive", id: sessionId })
  const session = await ctx.manager.read(sessionId)
  if (session?.kind !== "chat") throw new Error("missing chat session")
  const tree = await tryOpenConversationTree({ conversationId: session.conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
  if (!tree) throw new Error("missing conversation tree")
  const appended = await tree.appendMessages([
    { kind: "user", content: "Ask me" },
    { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
  ])
  await tree.getStorage().dispose()
  if (appended.kind !== "committed") throw new Error(`tree append failed: ${appended.kind}`)
  await ctx.store.append({
    aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: 1,
    payload: {
      interactionId: "ask-1", conversationId: session.conversationId, toolUseId: "ask-1",
      request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
    },
  })
  removeOwnerPid(sessionId, ctx.baseDir)
  const admitting = createDeferred<void>()
  const finishAdmission = createDeferred<void>()
  const deps = supervisorBaseDeps(ctx)
  const capabilities = await deps.runnerCapabilities()
  const runner = async () => mockRunner(sessionId, {
    resumeCommitted: () => { resumes += 1; return true },
  })
  let resumes = 0
  let creations = 0
  const supervisor = createRuntimeSupervisor({
    ...deps,
    runnerCapabilities: async () => ({
      ...capabilities,
      runnerLoader: {
        ...capabilities.runnerLoader,
        createRunner: async () => { creations += 1; return runner() },
      },
      authAdmission: {
        ...capabilities.authAdmission,
        admit: async (id) => {
          admitting.resolve()
          await finishAdmission.promise
          return capabilities.authAdmission.admit(id)
        },
      },
    }),
    sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(ctx.store), asAsyncEventReadSurface(ctx.store)) },
  })
  const activation = supervisor.activateSession(sessionId)
  void activation.catch(() => {})
  await admitting.promise
  const settling = action === "answer"
    ? supervisor.answerQuestion(sessionId, "ask-1", { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } })
    : supervisor.cancelQuestion(sessionId, "ask-1")
  // The open tab waits for runner admission outside the mailbox. A question
  // can settle durably while it waits; closing must prevent the wake.
  for (let turn = 0; turn < 500 && !["answered", "cancelled"].includes((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), sessionId)).get("ask-1")?.kind ?? ""); turn += 1) await Bun.sleep(1)
  const closing = supervisor.closeChat(sessionId)
  try {
    finishAdmission.resolve()
    expect(await settling).toEqual({ ok: true })
    expect(resumes).toBe(0)
    expect(creations).toBe(0)
    expect((await loadAgentInputProjection(asAsyncEventReadSurface(ctx.store), sessionId)).get("ask-1")?.kind).toBe(action === "answer" ? "answered" : "cancelled")
    const recovered = await tryOpenConversationTree({ conversationId: session.conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store) })
    if (!recovered) throw new Error("missing recovered conversation tree")
    const leaf = (await recovered.getBranch()).at(-1)
    await recovered.getStorage().dispose()
    expect(leaf?.kind === "message" && leaf.message.kind === "toolResult" ? leaf.message.toolUseId : null).toBe("ask-1")
    await expect(closing).resolves.toBe(true)
  } finally {
    finishAdmission.resolve()
    await Promise.allSettled([activation, settling, closing])
    await supervisor.disposeAll()
  }
})
