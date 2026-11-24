import { afterEach, describe, expect, it, mock } from "bun:test"
import { workflowRunner } from "../app-service/_frontend-projection-fixtures.js"
import { FIXTURE_WORKFLOW_ID } from "../../../helpers/project-definitions.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { fixtureSource } from "./_workflow-controller-fixtures.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/lifecycle/controller"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/tree/conversation-tree-handle"
import { interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { createMockWorkflowHosts, publishWorkerAttempt } from "./_workflow-host-fixtures"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog"
import type { WorkflowControllerDeps } from "../../../../src/orchestration/workflow-host/lifecycle/controller"
import { cleanupProjectRoots, createCapabilities, createDeps, createMockManager, modelLaunch, until } from "./_workflow-controller-fixtures"
import { moduleDisabledReason } from "../../../../src/protocol/module-ids"
import type { WorkflowHandBack } from "../../../../src/orchestration/workflow-host/runner-types"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { readChildCall, readChildStop, workflowSessionActions, workflowToolCall } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"
import { personCutRefusal } from "../../../../src/orchestration/session/child-continuation"
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types.js"
import { Database } from "bun:sqlite"
import { cpSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { replayWorkflowControl } from "../../../../src/workflows/vm/recovery/fact-fold"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client.js"
import { cleanup, compose, context, modelCall, parentChat } from "../app-service/_runtime-supervisor-workflow-launch-fixtures.js"

afterEach(() => {
  cleanupProjectRoots()
})


const SESSION_ID = "wf-live"
const STEP_CONVERSATION = "step-conversation"

/** Seeds a compiled workflow whose current step's attempt runs in
 *  `STEP_CONVERSATION`, the conversation its interrupt record lands in. */
async function seedCurrentStep(deps: WorkflowControllerDeps): Promise<void> {
  await publishWorkerAttempt({ projectRoot: deps.projectRoot, reader: deps.projectionReader, writer: deps.eventWriter, workflowId: SESSION_ID, attemptId: "step-1", conversationId: STEP_CONVERSATION })
}

/** Seeds the step conversation: the task, then either the interrupt record a
 *  person's interrupt writes or an ordinary answer. */
async function seedStepConversation(deps: WorkflowControllerDeps, interrupted: boolean): Promise<void> {
  const member = await workflowMembershipReader(deps.projectionReader).attempt(SESSION_ID, "step-1")
  if (!member) throw new Error("Missing published member")
  const tree = await tryOpenConversationTree({ conversationId: STEP_CONVERSATION, sessionId: member.sessionId, store: deps.eventReader, writer: deps.eventWriter })
  if (!tree) throw new Error("Missing published conversation")
  await tree.appendMessage({ kind: "user", content: "Implement the parser", origin: "system" })
  if (interrupted) await tree.appendMessage({ kind: "user", content: interruptedTurnMessage("person", true), origin: "system" }, turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"))
  else await tree.appendMessage({ kind: "assistant", content: "Working on it." })
  tree.dispose()
}

/** A live workflow whose step is parked: an entry with idle activity and a
 *  runner whose hand-back answers `answer`. The runner owns the module
 *  admission of a live Resume, so this entry stands in for its answer. */
function liveWorkflow(answer: WorkflowHandBack = { kind: "continued" }) {
  const handBack = mock(async (_address?: WorkflowDeliveryAddress) => answer)
  const workflowHosts = createMockWorkflowHosts()
  workflowHosts._runners.set(SESSION_ID, { ...workflowRunner(SESSION_ID), handBack })
  const manager = createMockManager()
  const capabilities = createCapabilities()
  return { workflowHosts, handBack, capabilities, deps: createDeps({ workflowHosts, manager, capabilities }) }
}

describe("workflow interrupt and resume", () => {
  it("Resume continues a live workflow whose step a person interrupted through its runner's hand-back, and starts no runner", async () => {
    const { workflowHosts, handBack, capabilities, deps } = liveWorkflow()
    await seedCurrentStep(deps)
    await seedStepConversation(deps, true)

    const result = await createWorkflowController(deps).resumeWorkflow(SESSION_ID)

    expect(result).toEqual({ kind: "resumed", sessionId: SESSION_ID })
    expect(handBack).toHaveBeenCalledWith(WHOLE_WORKFLOW)
    // The run keeps the content it captured, so the controller admits no
    // current definition for it.
    expect(capabilities._requests).toEqual([])
    expect(workflowHosts._startCalls).toEqual([])
  })

  it("Resume of a live interrupted workflow answers its runner's module refusal and starts nothing", async () => {
    const reason = `resuming the repair workflow is unavailable: ${moduleDisabledReason(["subagents"])}`
    const { workflowHosts, deps } = liveWorkflow({ kind: "refused", reason })
    await seedCurrentStep(deps)
    await seedStepConversation(deps, true)

    expect(await createWorkflowController(deps).resumeWorkflow(SESSION_ID)).toEqual({ kind: "unavailable", message: reason })
    expect(workflowHosts._startCalls).toEqual([])
  })

  it("Resume of a live workflow whose step was not interrupted changes nothing", async () => {
    const { handBack, deps } = liveWorkflow({ kind: "not_parked" })
    await seedCurrentStep(deps)
    await seedStepConversation(deps, false)

    const result = await createWorkflowController(deps).resumeWorkflow(SESSION_ID)

    expect(result).toEqual({ kind: "already_running", sessionId: SESSION_ID })
    expect(handBack).toHaveBeenCalledWith(WHOLE_WORKFLOW)
  })
})

/** The model's workflow call in the parent chat that the child answers, as
 *  the parent's runner records it before the call runs. A Stop records its
 *  result. */
async function recordWorkflowCall(deps: WorkflowControllerDeps): Promise<void> {
  const input = { workflow_definition_id: FIXTURE_WORKFLOW_ID, description: "Build it" }
  const evidence = contentEvidence(JSON.stringify(input))
  const writer = createSessionFactWriter({ sessionId: "parent-chat", writer: deps.eventWriter })
  await writer.record({
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId: "workflow-call", toolName: "workflow", input,
      inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
    },
  })
  writer.dispose()
}

describe("workflow Stop", () => {
  async function launchChild() {
    const manager = createMockManager()
    await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent chat" })
    const workflowHosts = createMockWorkflowHosts()
    const deps = createDeps({ manager, workflowHosts })
    await recordWorkflowCall(deps)
    const controller = createWorkflowController(deps)
    const launch = await controller.startWorkflow({ source: fixtureSource(deps), description: "Build it", origin: await modelLaunch({ manager }, { toolUseId: "workflow-call" }) })
    if ("error" in launch) throw new Error(launch.error)
    return { launch, workflowHosts }
  }

  it("a person's Stop tears the child down and settles its background work as stopped by the user", async () => {
    const { launch, workflowHosts } = await launchChild()

    await launch.terminate("user")

    expect(workflowHosts._abortCalls).toEqual([launch.workflowId])
    await expect(launch.done).resolves.toMatchObject({ status: "stopped", content: expect.stringContaining("The user stopped it before it finished; it will not resume. Do not redo the stopped work. Tell the user it stopped and wait for their direction.") })
  })

  it("the requesting agent's Stop says the agent canceled it", async () => {
    const { launch } = await launchChild()

    await launch.terminate("agent")

    await expect(launch.done).resolves.toMatchObject({ status: "cancelled", content: expect.stringContaining("You canceled it before it finished") })
  })
})

describe("a canceled workflow child", () => {
  it("takes no message and no automatic wake, and an explicit Resume of a person runs it again as its parent's work", async () => {
    const manager = createMockManager()
    await manager.createChat({ id: "parent-chat", conversationId: "parent-conversation", name: "Parent chat" })
    const workflowHosts = createMockWorkflowHosts()
    const deps = createDeps({ manager, workflowHosts })
    // What a detail read of the child reports when its teardown starts.
    let atTeardown: { readonly stoppedBy: string | undefined; readonly actions: readonly string[] } | undefined
    workflowHosts.abort = mock(async (id: string) => {
      const launchedFrom = (await workflowRunReader(deps.projectionReader).read(id))?.launchedFrom
      const call = await readChildCall(deps.eventReader, launchedFrom)
      const toolCall = workflowToolCall(launchedFrom?.toolUseId, call)
      atTeardown = { stoppedBy: call?.stoppedBy, actions: workflowSessionActions("inactive", "paused", toolCall ? { toolCall, message: false } : {}) }
      workflowHosts._runners.delete(id)
      return true
    })
    await recordWorkflowCall(deps)
    const controller = createWorkflowController(deps)
    const launch = await controller.startWorkflow({
      source: fixtureSource(deps),
      description: "Build it",
      origin: { kind: "model", chatSessionId: "parent-chat", conversationId: "parent-conversation", toolUseId: "workflow-call", confirmation: { kind: "absent" }, authority: fullAuthority() },
    })
    if ("error" in launch) throw new Error(launch.error)

    await launch.terminate("user")
    // The Stop starts the child's teardown and does not wait for it. The
    // teardown is what takes the child idle, and every client re-reads the
    // child's detail on that edge: the Stop is already durable then.
    await until(() => atTeardown !== undefined, "the child's teardown")
    expect(atTeardown).toEqual({ stoppedBy: "person", actions: ["workflow.resume", "session.delete"] })

    const id = launch.workflowId
    const child = await workflowRunReader(deps.projectionReader).read(id)
    expect(await readChildStop(deps.eventReader, child?.launchedFrom)).toBe("person")
    await expect(launch.done).resolves.toMatchObject({ status: "stopped" })
    expect(await controller.sendWorkflow(id, "keep going")).toEqual({ kind: "resume_failed", sessionId: id, message: "This workflow was canceled. Resume it to continue." })
    expect(await controller.resumeWorkflow(id, WHOLE_WORKFLOW, { wake: "planned" })).toMatchObject({ kind: "stopped" })
    // A person canceled it, so its parent agent cannot run it again.
    expect(await controller.resumeLaunch(id)).toEqual({ ok: false, error: personCutRefusal({ kind: "stop", by: "person" }) })

    // A resume that a message or a settled question implies is no Resume.
    expect(await controller.resumeWorkflow(id)).toMatchObject({ kind: "stopped" })

    // A new controller holds no memory of the Cancel; a person's explicit
    // Resume starts the run again from the durable state alone.
    const restarted = createWorkflowController(deps)
    expect(await restarted.resumeWorkflow(id, WHOLE_WORKFLOW, { explicit: "person" })).toEqual({ kind: "resumed", sessionId: id })
    expect(workflowHosts._startCalls.at(-1)).toMatchObject({ sessionId: id, startMode: "operator_resume", wake: WHOLE_WORKFLOW })

    // The Resume passed the Cancel before the run started: the call waits
    // again, so the row offers Cancel again and the child is no longer
    // canceled.
    const resumedCall = await readChildCall(deps.eventReader, child?.launchedFrom)
    expect(resumedCall).toEqual({})
    const resumedToolCall = workflowToolCall(child?.launchedFrom.toolUseId, resumedCall)
    expect(workflowSessionActions("active", "running", resumedToolCall ? { toolCall: resumedToolCall } : {})).toContain("background.terminate")
  })
})

describe("a canceled workflow child in a workflow host", () => {
  afterEach(cleanup)

  /** A model launch whose child runs in a real workflow host. Each agent of
   *  a step counts once it starts and works until its run aborts it. While
   *  `holdPreparation` holds, each start of the child's runtime waits in its
   *  preparation, after the host read its durable state. */
  async function hostedLaunch(baseDir?: string) {
    let agents = 0
    let preparation: PromiseWithResolvers<void> | undefined
    const preparing = { count: 0 }
    const runsWorkflows: AgentFactory = (options) => {
      if (options.purpose.kind !== "workflow-agent") return { send() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }) }
      agents += 1
      return newTestRunner({ ...options, agentRegistry: new Map(), agentsMd: "" }, async () => asModelClient({
        accessProvider: "openai_api", modelFamily: "openai", model: "gpt-5.4", contextLimit: 100_000, outputLimit: 8_000, supportsReasoning: false,
        priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
        async *streamWithTools(request) {
          yield { kind: "text_delta", text: "working", blockKey: "text" }
          await new Promise<void>((resolve) => {
            if (request.signal?.aborted) resolve()
            request.signal?.addEventListener("abort", () => resolve(), { once: true })
          })
        },
      }))
    }
    const ctx = context(baseDir)
    const composition = compose(ctx, { runsWorkflows, runtimePreflight: async () => { preparing.count += 1; await preparation?.promise } })
    return {
      ctx, composition,
      agents: () => agents,
      preparing: () => preparing.count,
      holdPreparation: () => { preparation = Promise.withResolvers() },
      releasePreparation: () => { preparation?.resolve() },
    }
  }

  async function launchAndCancel(hosted: Awaited<ReturnType<typeof hostedLaunch>>) {
    const { ctx, composition } = hosted
    const parentId = await parentChat(ctx)
    const launch = await modelCall(ctx, composition, parentId)
    await until(() => hosted.agents() === 1, "the first step's agent")
    await composition.supervisor.terminateBackgroundWork(parentId, "workflow-call")
    await expect(launch.done).resolves.toMatchObject({ status: "stopped" })
    await until(() => !ctx.workflowHosts.isRunning(launch.workflowId), "the canceled run's teardown")
    const launchedFrom = (await workflowRunReader(composition.reader).read(launch.workflowId))?.launchedFrom
    return { parentId, id: launch.workflowId, launchedFrom }
  }

  it("refuses every automatic wake and implicit resume of a paused canceled run, and a person's Resume starts its first attempt again", async () => {
    const hosted = await hostedLaunch()
    const { composition, ctx } = hosted
    const { id, launchedFrom } = await launchAndCancel(hosted)
    expect(replayWorkflowControl(ctx.store.read({ aggregateId: `workflow:${id}` })).status).toBe("paused")

    for (const start of [{ wake: "planned" as const }, { wake: { capacity: new Set(["agent"]) } }, undefined]) {
      expect(await composition.controller.resumeWorkflow(id, WHOLE_WORKFLOW, start)).toEqual({ kind: "stopped", message: "This workflow was canceled. Resume it to continue." })
    }
    expect(ctx.workflowHosts.allIds()).toEqual([])
    expect(await readChildStop(composition.reader, launchedFrom)).toBe("person")

    expect(await composition.controller.resumeWorkflow(id, WHOLE_WORKFLOW, { explicit: "person" })).toEqual({ kind: "resumed", sessionId: id })
    await until(() => hosted.agents() === 2, "the resumed run's first attempt")
    expect(ctx.workflowHosts.isRunning(id)).toBe(true)
    expect(await readChildStop(composition.reader, launchedFrom)).toBeUndefined()
  })

  it("runs a run that a crash left executing when a person resumes it after a Cancel, rather than pausing it again", async () => {
    const first = await hostedLaunch()
    const parentId = await parentChat(first.ctx)
    const launch = await modelCall(first.ctx, first.composition, parentId)
    await until(() => first.agents() === 1, "the first step's agent")
    // The project as a crash leaves it while the run executes: a copy of its
    // files and a consistent snapshot of its store, with no teardown.
    const crashDir = mkdtempSync(join(tmpdir(), "flywheel-crash-left-"))
    cpSync(first.ctx.baseDir, crashDir, { recursive: true })
    const crashedStore = resolveEventStoreDbFile(crashDir)
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${crashedStore}${suffix}`, { force: true })
    const live = new Database(resolveEventStoreDbFile(first.ctx.baseDir), { readonly: true })
    live.run(`VACUUM INTO '${crashedStore}'`)
    live.close()

    const hosted = await hostedLaunch(crashDir)
    const { composition } = hosted
    const launchedFrom = (await workflowRunReader(composition.reader).read(launch.workflowId))?.launchedFrom
    expect(replayWorkflowControl(hosted.ctx.store.read({ aggregateId: `workflow:${launch.workflowId}` })).status).toBe("executing")
    await composition.supervisor.terminateBackgroundWork(parentId, "workflow-call")
    expect(await readChildStop(composition.reader, launchedFrom)).toBe("person")
    expect(await composition.controller.resumeWorkflow(launch.workflowId, WHOLE_WORKFLOW, { explicit: "person" })).toEqual({ kind: "resumed", sessionId: launch.workflowId })
    await until(() => hosted.agents() === 1, "the resumed run's attempt")
    expect(hosted.ctx.workflowHosts.isRunning(launch.workflowId)).toBe(true)
    expect(await readChildStop(composition.reader, launchedFrom)).toBeUndefined()
  })

  it("lets a Cancel that lands while a Resume prepares the run win: the run starts no attempt and stays canceled", async () => {
    const hosted = await hostedLaunch()
    const { composition, ctx } = hosted
    const { parentId, id, launchedFrom } = await launchAndCancel(hosted)

    hosted.holdPreparation()
    const resuming = composition.controller.resumeWorkflow(id, WHOLE_WORKFLOW, { explicit: "person" })
    await until(() => hosted.preparing() === 2, "the Resume's preparation")
    expect(await readChildStop(composition.reader, launchedFrom)).toBeUndefined()
    await composition.supervisor.terminateBackgroundWork(parentId, "workflow-call")
    expect(await readChildStop(composition.reader, launchedFrom)).toBe("person")
    hosted.releasePreparation()

    expect(await resuming).toEqual({ kind: "stopped", message: "This workflow was canceled. Resume it to continue." })
    expect(ctx.workflowHosts.allIds()).toEqual([])
    expect(hosted.agents()).toBe(1)
    expect(await composition.controller.resumeWorkflow(id, WHOLE_WORKFLOW, { wake: "planned" })).toMatchObject({ kind: "stopped" })
  })
})
