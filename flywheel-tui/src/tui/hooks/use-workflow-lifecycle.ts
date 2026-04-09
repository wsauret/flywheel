import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { WorkflowResult } from "../../orchestration/workflow-runner.js"
import { buildQueueForSlashCommand } from "../../orchestration/queue-builder.js"
import { prepareWorkflowDeps } from "../../orchestration/engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "../../orchestration/session-actions.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "../../orchestration/test-step.js"
import { TERMINAL_TITLE_PREFIX, type ShellSignals, type ShellServices } from "./shell-state.js"

// Re-export for backward compatibility — canonical definition is in shell-state.ts
export { TERMINAL_TITLE_PREFIX }

export interface WorkflowLifecycleDeps {
  signals: ShellSignals
  services: ShellServices
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
  const { signals, services } = deps

  const actionDeps: SessionActionDeps = {
    manager: services.manager,
    refreshList: services.refreshList,
    activeSessionId: signals.foregroundId,
  }

  /** Reset all UI signals to a clean "starting" state. */
  function resetUIState(title: string, terminalSuffix: string): void {
    signals.setOutputBlocks([])
    signals.setSteps([])
    signals.setErrorMessage("")
    signals.setStatusLine("")
    signals.setSessionTitle(title)
    services.metrics.resetMetrics()
    signals.setAgentState("active")
    services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${terminalSuffix}`)
  }

  /** Handle workflow runner completion — update session manager and UI. */
  function handleRunnerDone(id: string, result: WorkflowResult): void {
    const totalElapsed = formatElapsed(Date.now() - services.metrics.workStartTime())
    if (result.completed) {
      services.manager.updateState(id, "completed")
      signals.setStatusLine(`\u2713 ${result.stepsCompleted}/${result.stepsTotal} steps \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)} \u00b7 ${formatTokens(result.tokens)} tokens`)
      services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
    } else {
      services.manager.updateState(id, "paused")
      signals.setStatusLine(`\u2717 ${result.reason ?? "stopped"} (${result.stepsCompleted}/${result.stepsTotal}) \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)}`)
      services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}paused`)
    }
    signals.setAgentState("idle")
    services.refreshList()
    signals.setForegroundId(undefined)
  }

  /** Handle workflow runner error — update session manager and UI. */
  function handleRunnerError(id: string, err: unknown): void {
    services.manager.updateState(id, "paused")
    signals.setErrorMessage(extractErrorMessage(err))
    signals.setAgentState("idle")
    services.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}error`)
    services.refreshList()
    signals.setForegroundId(undefined)
  }

  async function startWorkflow(command: string, description: string): Promise<void> {
    resetUIState(description || command, description || command)

    let queue
    try {
      const wfDeps = prepareWorkflowDeps()
      queue = buildQueueForSlashCommand(command, wfDeps.config)
    } catch (err) {
      signals.setErrorMessage(`Config error: ${extractErrorMessage(err)}`)
      signals.setAgentState("idle")
      return
    }

    const sessionId = services.manager.create(description, description, "workflow", "active")

    services.registry.start({
      sessionId, queue, description,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    signals.setForegroundId(sessionId)
  }

  async function resumeWorkflow(sessionId: string): Promise<void> {
    const data = await loadResumeData(sessionId, actionDeps)
    if (!data) {
      services.showToast({ message: "Failed to resume \u2014 missing data", variant: "error" })
      return
    }

    const description = data.session.name || data.session.label || ""
    resetUIState(description || "Resumed session", description || "resume")
    signals.setOutputBlocks(data.outputBlocks)

    services.manager.updateState(sessionId, "active")

    services.registry.start({
      sessionId, queue: data.queue, description, priorBlocks: data.outputBlocks,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    signals.setForegroundId(sessionId)
  }

  function pauseForeground(): void {
    const fgId = signals.foregroundId()
    if (!fgId) return
    services.registry.pause(fgId)
    services.manager.updateState(fgId, "paused")
    // Don't reset metrics — preserve token/cost display while paused
    signals.setAgentState("idle")
    services.showToast({ message: "Pausing after current step... (Esc to force stop)", variant: "info" })
  }

  function abortForeground(): void {
    const fgId = signals.foregroundId()
    if (!fgId) return
    services.registry.abort(fgId)
    services.showToast({ message: "Force-stopping workflow", variant: "warning" })
  }

  async function handleResume(sessionIdArg?: string): Promise<void> {
    let targetId = sessionIdArg
    if (!targetId) {
      const session = findResumableSession(actionDeps)
      if (!session) {
        services.showToast({ message: "No resumable sessions found", variant: "warning" })
        return
      }
      targetId = session.id
    }
    await resumeWorkflow(targetId)
  }

  async function startTestStep(stepId?: string): Promise<void> {
    if (!stepId) {
      const ids = TEST_STEPS.map(s => s.id).join(", ")
      services.showToast({ message: `Available test steps: ${ids}. Usage: /test <step-id>`, variant: "info" })
      return
    }

    const stepDef = TEST_STEPS.find(s => s.id === stepId)
    if (!stepDef) {
      services.showToast({ message: `Unknown test step "${stepId}". Available: ${TEST_STEPS.map(s => s.id).join(", ")}`, variant: "error" })
      return
    }

    resetUIState(`[test] ${stepDef.label}`, `[test] ${stepDef.label}`)

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
      signals.setErrorMessage(`Test step error: ${extractErrorMessage(err)}`)
      signals.setAgentState("idle")
      return
    }

    const testWorkdir = workdir
    const sessionId = services.manager.create(`[test] ${stepDef.label}`, `[test] ${stepDef.label}`, "workflow", "active")

    services.registry.start({
      sessionId,
      queue,
      description: `[test] ${stepDef.label}`,
      subprocessCwd: testWorkdir.path,
      onComplete: () => testWorkdir.cleanup(),
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    signals.setForegroundId(sessionId)
  }

  return { startWorkflow, startTestStep, resumeWorkflow, pauseForeground, abortForeground, handleResume, actionDeps }
}
