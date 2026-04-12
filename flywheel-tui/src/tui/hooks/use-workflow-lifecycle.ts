/**
 * Workflow Lifecycle Hook — thin adapter over WorkflowController.
 *
 * The hook holds only display-reset logic and writes signals from
 * controller return values. All business logic lives in the controller.
 */

import { batch } from "solid-js"
import {
  createWorkflowController,
} from "../../orchestration/workflow-controller.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { ShellSignals, ShellServices } from "./shell-state.js"
import { wireLifecycleCallbacks } from "./lifecycle-callbacks.js"

export interface WorkflowLifecycleDeps {
  signals: ShellSignals
  services: ShellServices
}

export interface WorkflowLifecycleHook {
  startWorkflow(command: string, description: string): void
  startTestStep(stepId?: string): void
  resumeWorkflow(sessionId: string): Promise<void>
  pauseForeground(): void
  abortForeground(): void
  handleResume(sessionIdArg?: string): Promise<void>
  /** Steer a running workflow by injecting a user message. Returns true if delivered. */
  steerWorkflow(text: string): boolean
  /** Check if a session is a workflow (for keyboard handler). */
  isWorkflowSession(id: string): boolean
  actionDeps: SessionActionDeps
}

export function useWorkflowLifecycle(deps: WorkflowLifecycleDeps): WorkflowLifecycleHook {
  const { signals, services } = deps
  const metrics = services.metrics

  const callbacks = wireLifecycleCallbacks(signals, services)

  // Create the controller — all business logic lives there
  const controller = createWorkflowController({
    sessionStore: services.sessionStore,
    manager: services.manager,
    refreshList: services.refreshList,
    workStartTime: metrics.workStartTime,
    foregroundId: signals.foregroundId,
    onRunnerDone: callbacks.onRunnerDone,
    onRunnerError: callbacks.onRunnerError,
  })

  /** Reset writable UI signals to a clean "starting" state. */
  function resetUIState(terminalTitle: string): void {
    batch(() => {
      signals.setErrorMessage("")
      signals.setStatusLine("")
      metrics.resetMetrics()
    })
    services.setTerminalTitle(terminalTitle)
  }

  function startWorkflow(command: string, description: string, chatContext?: string): void {
    const result = controller.startWorkflow(command, description, chatContext)

    if ("error" in result) {
      signals.setErrorMessage(result.error)
      return
    }

    resetUIState(result.terminalTitle)
    signals.setForegroundId(result.sessionId)
  }

  function startTestStep(stepId?: string): void {
    const result = controller.startTestStep(stepId)

    if (result === null) return

    if ("info" in result) {
      services.showToast({ message: result.info, variant: "info" })
      return
    }

    if ("error" in result) {
      if (result.error.startsWith("Unknown test step")) {
        services.showToast({ message: result.error, variant: "error" })
      } else {
        signals.setErrorMessage(result.error)
      }
      return
    }

    resetUIState(result.terminalTitle)
    signals.setForegroundId(result.sessionId)
  }

  async function resumeWorkflow(sessionId: string): Promise<void> {
    const result = await controller.resumeWorkflow(sessionId)

    if (!result) {
      services.showToast({ message: "Failed to resume \u2014 missing data", variant: "error" })
      return
    }

    resetUIState(result.terminalTitle)
    signals.setForegroundId(result.sessionId)
  }

  function pauseForeground(): void {
    const fgId = signals.foregroundId()
    const paused = controller.pause(fgId)
    if (paused) {
      services.showToast({ message: "Pausing after current step... (Esc to force stop)", variant: "info" })
    }
  }

  function abortForeground(): void {
    const fgId = signals.foregroundId()
    controller.abort(fgId)
    services.showToast({ message: "Force-stopping workflow", variant: "warning" })
  }

  async function handleResume(sessionIdArg?: string): Promise<void> {
    const result = await controller.handleResume(sessionIdArg)

    if (!result) {
      if (!sessionIdArg) {
        services.showToast({ message: "No resumable sessions found", variant: "warning" })
      } else {
        services.showToast({ message: "Failed to resume \u2014 missing data", variant: "error" })
      }
      return
    }

    resetUIState(result.terminalTitle)
    signals.setForegroundId(result.sessionId)
  }

  return {
    startWorkflow,
    startTestStep,
    resumeWorkflow,
    pauseForeground,
    abortForeground,
    handleResume,
    steerWorkflow: (text: string) => controller.steerWorkflow(signals.foregroundId(), text),
    isWorkflowSession: controller.isWorkflowSession,
    actionDeps: controller.getActionDeps(),
  }
}
