import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { SessionManager } from "../../orchestration/session/manager.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { Accessor } from "solid-js"
import type { AnyBlock } from "../types.js"
import type { StepType } from "../../infra/step-types.js"
import { safeUpdateState } from "../../orchestration/session/safe-transition.js"
import { buildQueueForSlashCommand } from "../../orchestration/queue-builder.js"
import { prepareWorkflowDeps } from "../../orchestration/engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "../../orchestration/session-actions.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "../../orchestration/test-step.js"

export type AgentState = "idle" | "active"
export type SessionStatus = null | "running" | "paused" | "completed" | "error"

export interface WorkflowLifecycleDeps {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  setAgentState: (state: AgentState) => void
  setSessionStatus: (status: SessionStatus) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSteps: (steps: import("../../orchestration/workflow-runner.js").StepState[]) => void
  setErrorMessage: (msg: string) => void
  setStatusLine: (line: string) => void
  setSessionTitle: (title: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export interface WorkflowLifecycleHook {
  startWorkflow(command: string, description: string): Promise<void>
  startTestStep(stepId?: string): Promise<void>
  resumeWorkflow(sessionId: string): Promise<void>
  pauseForeground(): void
  abortForeground(): void
  handleResume(sessionIdArg?: string): Promise<void>
  actionDeps: SessionActionDeps
}

export function useWorkflowLifecycle(deps: WorkflowLifecycleDeps): WorkflowLifecycleHook {
  const actionDeps: SessionActionDeps = {
    manager: deps.manager,
    refreshList: deps.refreshList,
    activeSessionId: deps.foregroundId,
  }

  async function startWorkflow(command: string, description: string): Promise<void> {
    deps.setOutputBlocks([])
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle(description || command)
    deps.resetMetrics()
    deps.setAgentState("active")
    deps.setSessionStatus("running")
    deps.setTerminalTitle(`flywheel · ${description || command}`)

    let queue
    try {
      const wfDeps = prepareWorkflowDeps()
      queue = buildQueueForSlashCommand(command, wfDeps.config)
    } catch (err) {
      deps.setErrorMessage(`Config error: ${extractErrorMessage(err)}`)
      deps.setAgentState("idle")
      deps.setSessionStatus("error")
      return
    }

    const sessionId = deps.manager.create(description, description, command as StepType)
    safeUpdateState((id, s) => deps.manager.updateState(id, s), sessionId, "work:active")

    deps.registry.start({ sessionId, queue, description })
    deps.setForegroundId(sessionId)
  }

  async function resumeWorkflow(sessionId: string): Promise<void> {
    const data = await loadResumeData(sessionId, actionDeps)
    if (!data) {
      deps.showToast({ message: "Failed to resume — missing data", variant: "error" })
      return
    }

    const description = data.session.name || data.session.label || ""
    deps.setOutputBlocks(data.outputBlocks)
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle(description || "Resumed session")
    deps.resetMetrics()
    deps.setAgentState("active")
    deps.setSessionStatus("running")
    deps.setTerminalTitle(`flywheel · ${description || "resume"}`)

    safeUpdateState((id, s) => deps.manager.updateState(id, s), sessionId, "work:active")

    deps.registry.start({ sessionId, queue: data.queue, description, priorBlocks: data.outputBlocks })
    deps.setForegroundId(sessionId)
  }

  function pauseForeground(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.pause(fgId)
    deps.resetMetrics()
    deps.setAgentState("idle")
    deps.setSessionStatus("paused")
    deps.showToast({ message: "Pausing after current step... (Esc to force stop)", variant: "info" })
  }

  function abortForeground(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.abort(fgId)
    deps.showToast({ message: "Force-stopping workflow", variant: "warning" })
  }

  async function handleResume(sessionIdArg?: string): Promise<void> {
    let targetId = sessionIdArg
    if (!targetId) {
      const session = findResumableSession(actionDeps)
      if (!session) {
        deps.showToast({ message: "No resumable sessions found", variant: "warning" })
        return
      }
      targetId = session.id
    }
    await resumeWorkflow(targetId)
  }

  async function startTestStep(stepId?: string): Promise<void> {
    if (!stepId) {
      const ids = TEST_STEPS.map(s => s.id).join(", ")
      deps.showToast({ message: `Available test steps: ${ids}. Usage: /test <step-id>`, variant: "info" })
      return
    }

    const stepDef = TEST_STEPS.find(s => s.id === stepId)
    if (!stepDef) {
      deps.showToast({ message: `Unknown test step "${stepId}". Available: ${TEST_STEPS.map(s => s.id).join(", ")}`, variant: "error" })
      return
    }

    deps.setOutputBlocks([])
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle(`[test] ${stepDef.label}`)
    deps.resetMetrics()
    deps.setAgentState("active")
    deps.setSessionStatus("running")
    deps.setTerminalTitle(`flywheel · [test] ${stepDef.label}`)

    let queue
    let workdir: ReturnType<typeof createTestWorkdir> | null = null
    try {
      const wfDeps = prepareWorkflowDeps()
      const projectCwd = wfDeps.config.project_cwd ?? process.cwd()
      workdir = createTestWorkdir(projectCwd)
      const fixture = setupTestFixture(stepDef, projectCwd)
      queue = buildTestQueue(stepDef, fixture)
    } catch (err) {
      workdir?.cleanup()
      deps.setErrorMessage(`Test step error: ${extractErrorMessage(err)}`)
      deps.setAgentState("idle")
      deps.setSessionStatus("error")
      return
    }

    const testWorkdir = workdir
    const sessionId = deps.manager.create(`[test] ${stepDef.label}`, `[test] ${stepDef.label}`, stepDef.type)
    safeUpdateState((id, s) => deps.manager.updateState(id, s), sessionId, "work:active")

    deps.registry.start({
      sessionId,
      queue,
      description: `[test] ${stepDef.label}`,
      subprocessCwd: testWorkdir.path,
      onComplete: () => testWorkdir.cleanup(),
    })
    deps.setForegroundId(sessionId)
  }

  return { startWorkflow, startTestStep, resumeWorkflow, pauseForeground, abortForeground, handleResume, actionDeps }
}
