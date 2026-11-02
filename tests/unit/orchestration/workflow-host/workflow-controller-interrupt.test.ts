import { afterEach, describe, expect, it, mock } from "bun:test"
import { workflowRunner } from "../app-service/_frontend-projection-fixtures.js"
import { FIXTURE_WORKFLOW_ID } from "../../../helpers/project-definitions.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { fixtureSource } from "./_workflow-controller-fixtures.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { createMockWorkflowHosts, publishWorkerAttempt } from "./_workflow-host-fixtures"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership"
import { workflowRunReader } from "../../../../src/orchestration/module-catalog"
import type { WorkflowControllerDeps } from "../../../../src/orchestration/workflow-host/controller"
import { cleanupProjectRoots, createCapabilities, createDeps, createMockManager, modelLaunch, until } from "./_workflow-controller-fixtures"
import { moduleDisabledReason } from "../../../../src/protocol/module-ids"
import type { WorkflowHandBack } from "../../../../src/orchestration/workflow-host/runner-types"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { readChildCall, readChildStop, workflowSessionActions, workflowToolCall } from "../../../../src/orchestration/session/chat-session-run-evidence"
import { WHOLE_WORKFLOW, type WorkflowDeliveryAddress } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages.js"

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
  tree.getStorage().dispose()
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

describe("a stopped workflow child", () => {
  it("never resumes and takes no message, before and after a restart, because its parent's tool call records the Stop", async () => {
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
      atTeardown = { stoppedBy: call?.stoppedBy, actions: workflowSessionActions("inactive", "paused", toolCall ? { toolCall } : {}) }
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
    expect(atTeardown).toEqual({ stoppedBy: "person", actions: ["session.delete"] })

    const child = await workflowRunReader(deps.projectionReader).read(launch.workflowId)
    expect(await readChildStop(deps.eventReader, child?.launchedFrom)).toBe("person")
    await expect(launch.done).resolves.toMatchObject({ status: "stopped" })
    expect(await controller.resumeWorkflow(launch.workflowId)).toEqual({ kind: "stopped", message: "This workflow was stopped, so it cannot resume" })
    expect(await controller.sendWorkflow(launch.workflowId, "keep going")).toMatchObject({ kind: "resume_failed" })

    // A new controller holds no memory of the Stop; the durable result alone refuses.
    const restarted = createWorkflowController({ ...deps, workflowHosts: createMockWorkflowHosts() })
    expect(await restarted.resumeWorkflow(launch.workflowId)).toMatchObject({ kind: "stopped" })
  })
})
