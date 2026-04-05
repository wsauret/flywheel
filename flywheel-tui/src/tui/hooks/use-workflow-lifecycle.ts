import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { SessionManager } from "../../orchestration/session/manager.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { Accessor } from "solid-js"
import type { AnyBlock } from "../types.js"
import type { StepType } from "../../workflows/queue/types.js"
import { safeUpdateState } from "../../orchestration/session/safe-transition.js"
import { buildQueueForSlashCommand } from "../../orchestration/queue-builder.js"
import { prepareWorkflowDeps } from "../../orchestration/engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "../../orchestration/session-actions.js"
import { errorMessage as extractErrorMessage } from "../../workflows/shared/error-message.js"

export type AppState = "idle" | "working" | "paused" | "completed" | "error" | "chatting"

export interface WorkflowLifecycleDeps {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  setAppState: (state: AppState) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSteps: (steps: import("../../orchestration/workflow-runner.js").StepState[]) => void
  setErrorMessage: (msg: string) => void
  setStatusLine: (line: string) => void
  setSessionTitle: (title: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  startTimer: () => void
  pauseTimer: () => void
  stopTimer: () => void
  showToast: (opts: { message: string; variant: "info" | "warning" | "error" }) => void
}

export interface WorkflowLifecycleHook {
  startWorkflow(command: string, description: string): Promise<void>
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
    deps.startTimer()
    deps.setAppState("working")
    deps.setTerminalTitle(`flywheel · ${description || command}`)

    let queue
    try {
      const wfDeps = prepareWorkflowDeps()
      queue = buildQueueForSlashCommand(command, wfDeps.config)
    } catch (err) {
      deps.setErrorMessage(`Config error: ${extractErrorMessage(err)}`)
      deps.setAppState("error")
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
    deps.startTimer()
    deps.setAppState("working")
    deps.setTerminalTitle(`flywheel · ${description || "resume"}`)

    safeUpdateState((id, s) => deps.manager.updateState(id, s), sessionId, "work:active")

    deps.registry.start({ sessionId, queue: data.queue, description, priorBlocks: data.outputBlocks })
    deps.setForegroundId(sessionId)
  }

  function pauseForeground(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.pause(fgId)
    deps.pauseTimer()
    deps.resetMetrics()
    deps.setAppState("paused")
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

  return { startWorkflow, resumeWorkflow, pauseForeground, abortForeground, handleResume, actionDeps }
}
