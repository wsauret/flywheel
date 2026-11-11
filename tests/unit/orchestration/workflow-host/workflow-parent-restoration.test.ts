import { afterEach, describe, expect, it, mock } from "bun:test"
import { FIXTURE_WORKFLOW_ID } from "../../../helpers/project-definitions.js"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js"
import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control.js"
import { readRecipientState } from "../../../../src/orchestration/session/session-input-delivery.js"
import { restoreReplyWaits, suspendReplyWaits } from "../../../../src/orchestration/session/reply-waits.js"
import { holdReplyWait } from "../../../../src/orchestration/session/conversation/reply-wait-cells.js"
import { recordChildWorkflowStartFailure } from "../../../../src/orchestration/session/child-workflow-result.js"
import { readToolExecution } from "../../../../src/orchestration/session/tool-execution-projection.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import { chatRunner } from "../app-service/_frontend-projection-fixtures.js"
import { cleanupProjectRoots, createDeps, createMockManager, makeResumeQueue, seedWorkflowRequest } from "./_workflow-controller-fixtures"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures"
import { seedModelWorkflowCall } from "./_workflow-progress-fixtures.js"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../src/infra/retained-operation-hosts.js"
import { workflowLaunchHost } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { createChildSessionControl } from "../../../../src/orchestration/session/child-session-control.js"
import { createProcessTool } from "../../../../src/orchestration/agent-runtime/tools/process.js"
import { createWaitToolPolicy } from "../../../../src/orchestration/agent-runtime/agent-loop-wait.js"

afterEach(cleanupProjectRoots)

describe("workflow parent restoration", () => {
  it.each(["tracking", "parent attachment", "idle attachment", "reply wait", "stop", "repeated resume", "earlier run notice", "failed resume"] as const)("restores a launched workflow after its parent restarts: %s", async (assertion) => {
    const manager = createMockManager()
    const workflowHosts = createMockWorkflowHosts()
    // A notice of the earlier run commits only after a Resume started the next run.
    const earlierRunNotice = Promise.withResolvers<void>()
    const parentTasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (_text, key) => key === "workflow-completion:child:1" ? earlierRunNotice.promise : undefined })
    const notices: string[] = []
    const stepTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: (text) => { notices.push(text) } })
    await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
    let unregister: (() => void) | undefined
    const hold = mock(async () => NO_MODULE_RUNTIMES)
    const send = mock(async () => "accepted" as const)
    const resume = mock(() => true)
    const openChatRunner = mock(async () => {
      unregister ??= registerLiveSessionControl(deps.projectionReader, {
        sessionId: "parent", state: async () => "waiting_on_work",
        deliver: async () => ({ status: "delivered", startsTurn: false }), notify: async () => true,
      })
      return { ...chatRunner("parent"), backgroundTasks: parentTasks, hold, send, resume }
    })
    const deps = createDeps({ manager, workflowHosts, openChatRunner,
      reconcileChildSessionCompletions: async () => ({ reconciledCount: 1, workflowAggregateReads: 1, durableTerminalChildSessionIds: ["child"] }),
    })
    await seedWorkflowRequest(deps, "child", "Saved request", { parentSessionId: "parent", toolUseId: "original-launch" })
    await seedModelWorkflowCall(deps, "parent", "original-launch", "Saved request")
    await holdReplyWait(deps.eventWriter, "child", { addresseeSessionId: "parent", toolUseId: "saved-question", openedAtMs: Date.now() })
    let started: Parameters<typeof workflowHosts.start>[0] | undefined
    workflowHosts.start = mock(async (options) => {
      started = options
      await options.onPrepared?.(makeResumeQueue())
      await restoreReplyWaits({
        projectionReader: deps.projectionReader, eventWriter: deps.eventWriter,
        addresseeState: async (id) => readRecipientState(deps, id, await manager.read(id)),
        lineage: async (id) => id === "child" ? ["child", "parent"] : [id],
      }, { sessionId: "child", tasks: stepTasks }, async () => "Parent")
      return options.sessionId
    })
    const controller = createWorkflowController(deps)
    try {
      expect(await controller.resumeWorkflow("child")).toEqual({ kind: "resumed", sessionId: "child" })
      if (assertion === "parent attachment") {
        parentTasks.stopAdmission()
        await parentTasks.terminateAll()
        const replacement = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} })
        const children = createChildSessionControl({
          manager, reader: deps.eventReader, projectionReader: deps.projectionReader, writer: deps.eventWriter,
          projectRoot: deps.projectRoot, modules: NO_MODULE_SERVICES, deliverNotification: async () => true,
          hosts: () => composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, controller)]),
          interrupt: async () => false,
        })
        try {
          await children.restoreTracking("parent", replacement)
          const tool = createProcessTool(replacement)
          const context = { executionCwd: deps.projectRoot, userDataRoot: `${deps.projectRoot}/.test-account`, projectRoot: deps.projectRoot, artifactScopeId: "parent", retrievalSessionId: "parent" }
          const result = await tool.execute({ action: "wait", soft_timeout: 60 }, context)
          expect(result.outcome).toBe("ok")
          let parked = false
          const notifications: string[] = []
          createWaitToolPolicy(
            () => replacement.awaitedTaskCount() > 0,
            () => { parked = true },
            (notice) => { notifications.push(notice) },
          ).settleWaitCalls([{ id: "wait", name: "process", input: { action: "wait", soft_timeout: 60 } }])
          expect(parked).toBe(true)
          expect(notifications).toEqual([])
          expect(replacement.processRecord("child")?.status).toBe("running")
          expect((await tool.execute({ action: "list" }, context)).content).toContain("child")
          expect((await tool.execute({ action: "status", process_id: "child" }, context)).content).toContain("running")
          const waiting = replacement.waitProcess("child")
          await started?.onCoreCompleted?.("child", { completed: true, attemptsCompleted: 1, attemptsTotal: 1, tokens: 0, cost: 0 })
          expect(await waiting).toBe(true)
          expect(replacement.awaitedTaskCount()).toBe(0)
          expect(replacement.activeBackgroundCommands()).toEqual([])
        } finally {
          await replacement.terminateAll()
        }
      } else if (assertion === "tracking") {
        expect(parentTasks.awaitedTaskCount()).toBe(1)
        expect(parentTasks.activeBackgroundCommands()).toMatchObject([{ id: "child", description: "Saved request", toolUseId: "original-launch" }])
        const waiting = parentTasks.waitProcess("child")
        await started?.onCoreCompleted?.("child", { completed: true, attemptsCompleted: 1, attemptsTotal: 1, tokens: 0, cost: 0 })
        expect(await waiting).toBe(true)
        expect(parentTasks.awaitedTaskCount()).toBe(0)
      } else if (assertion === "idle attachment") {
        expect(openChatRunner).toHaveBeenCalledWith("parent")
        expect(hold).not.toHaveBeenCalled()
        expect(send).not.toHaveBeenCalled()
        expect(resume).not.toHaveBeenCalled()
      } else if (assertion === "reply wait") {
        expect(stepTasks.awaitedTaskCount()).toBe(1)
        expect(notices).toEqual([])
      } else {
        if (assertion === "failed resume") {
          await recordChildWorkflowStartFailure({ reader: deps.eventReader, projectionReader: deps.projectionReader, writer: deps.eventWriter, parentSessionId: "parent", toolUseId: "original-launch", childSessionId: "child", workflowDefinitionId: FIXTURE_WORKFLOW_ID })
          await started?.onCoreCompleted?.("child", { completed: false, attemptsCompleted: 0, attemptsTotal: 1, tokens: 0, cost: 0, reason: "Step failed" })
          expect(parentTasks.awaitedTaskCount()).toBe(0)
        }
        const notice = assertion === "earlier run notice" ? parentTasks.deliverDurableSubagentNotification({ key: "workflow-completion:child:1", text: "Workflow failed" }) : undefined
        if (assertion !== "stop") expect(await controller.resumeWorkflow("child")).toEqual({ kind: "resumed", sessionId: "child" })
        earlierRunNotice.resolve()
        await notice
        expect(parentTasks.awaitedTaskCount()).toBe(1)
        const waiting = parentTasks.waitProcess("child")
        expect(parentTasks.terminate("original-launch")).toBe(true)
        expect(await waiting).toBe(true)
        expect(workflowHosts._abortCalls).toContain("child")
        if (assertion === "failed resume") {
          expect((await readToolExecution(deps.projectionReader, "parent", "original-launch"))?.resultOutcome).toBe("stopped")
          expect((await deps.projectionReader.readLatestByAggregateAndTypes("session:parent", ["tool.result.recorded", "workflow.tool_result.corrected"])).map((fact) => [fact.type, fact.payload.outcome])).toEqual([["tool.result.recorded", "error"], ["workflow.tool_result.corrected", "stopped"]])
        }
      }
    } finally {
      suspendReplyWaits(deps.projectionReader)
      await stepTasks.terminateAll()
      await parentTasks.terminateAll()
      unregister?.()
    }
  })
})
