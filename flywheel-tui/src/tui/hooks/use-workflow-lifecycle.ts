import type { SessionRegistry } from "../../orchestration/session-registry.js"
import type { SessionManager } from "../../orchestration/session/manager.js"
import type { SessionActionDeps } from "../../orchestration/session-actions.js"
import type { Accessor } from "solid-js"
import type { AnyBlock } from "../types.js"
import type { WorkflowResult } from "../../orchestration/workflow-runner.js"
import { buildQueueForSlashCommand } from "../../orchestration/queue-builder.js"
import { prepareWorkflowDeps } from "../../orchestration/engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "../../orchestration/session-actions.js"
import { errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import { formatElapsed, formatCost, formatTokens } from "../format.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "../../orchestration/test-step.js"

export type AgentState = "idle" | "active"

/** Shared terminal title prefix used across TUI hooks. */
export const TERMINAL_TITLE_PREFIX = "flywheel · "

export interface WorkflowLifecycleDeps {
  registry: SessionRegistry
  manager: SessionManager
  refreshList: () => void
  foregroundId: Accessor<string | undefined>
  setForegroundId: (id: string | undefined) => void
  setAgentState: (state: AgentState) => void
  setOutputBlocks: (blocks: AnyBlock[]) => void
  setSteps: (steps: import("../../orchestration/workflow-runner.js").StepState[]) => void
  setErrorMessage: (msg: string) => void
  setStatusLine: (line: string) => void
  setSessionTitle: (title: string) => void
  setTerminalTitle: (title: string) => void
  resetMetrics: () => void
  /** workStartTime accessor from metrics hook, for elapsed calculation. */
  workStartTime: () => number
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

  /** Reset all UI signals to a clean "starting" state. */
  function resetUIState(title: string, terminalSuffix: string): void {
    deps.setOutputBlocks([])
    deps.setSteps([])
    deps.setErrorMessage("")
    deps.setStatusLine("")
    deps.setSessionTitle(title)
    deps.resetMetrics()
    deps.setAgentState("active")
    deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}${terminalSuffix}`)
  }

  /** Handle workflow runner completion — update session manager and UI. */
  function handleRunnerDone(id: string, result: WorkflowResult): void {
    const totalElapsed = formatElapsed(Date.now() - deps.workStartTime())
    if (result.completed) {
      deps.manager.updateState(id, "completed")
      deps.setStatusLine(`\u2713 ${result.stepsCompleted}/${result.stepsTotal} steps \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)} \u00b7 ${formatTokens(result.tokens)} tokens`)
      deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}done`)
    } else {
      deps.manager.updateState(id, "paused")
      deps.setStatusLine(`\u2717 ${result.reason ?? "stopped"} (${result.stepsCompleted}/${result.stepsTotal}) \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)}`)
      deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}paused`)
    }
    deps.setAgentState("idle")
    deps.refreshList()
    deps.setForegroundId(undefined)
  }

  /** Handle workflow runner error — update session manager and UI. */
  function handleRunnerError(id: string, err: unknown): void {
    deps.manager.updateState(id, "paused")
    deps.setErrorMessage(extractErrorMessage(err))
    deps.setAgentState("idle")
    deps.setTerminalTitle(`${TERMINAL_TITLE_PREFIX}error`)
    deps.refreshList()
    deps.setForegroundId(undefined)
  }

  async function startWorkflow(command: string, description: string): Promise<void> {
    resetUIState(description || command, description || command)

    let queue
    try {
      const wfDeps = prepareWorkflowDeps()
      queue = buildQueueForSlashCommand(command, wfDeps.config)
    } catch (err) {
      deps.setErrorMessage(`Config error: ${extractErrorMessage(err)}`)
      deps.setAgentState("idle")
      return
    }

    const sessionId = deps.manager.create(description, description, "workflow", "active")

    deps.registry.start({
      sessionId, queue, description,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    deps.setForegroundId(sessionId)
  }

  async function resumeWorkflow(sessionId: string): Promise<void> {
    const data = await loadResumeData(sessionId, actionDeps)
    if (!data) {
      deps.showToast({ message: "Failed to resume — missing data", variant: "error" })
      return
    }

    const description = data.session.name || data.session.label || ""
    resetUIState(description || "Resumed session", description || "resume")
    deps.setOutputBlocks(data.outputBlocks)

    deps.manager.updateState(sessionId, "active")

    deps.registry.start({
      sessionId, queue: data.queue, description, priorBlocks: data.outputBlocks,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    deps.setForegroundId(sessionId)
  }

  function pauseForeground(): void {
    const fgId = deps.foregroundId()
    if (!fgId) return
    deps.registry.pause(fgId)
    deps.manager.updateState(fgId, "paused")
    // Don't reset metrics — preserve token/cost display while paused
    deps.setAgentState("idle")
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
      deps.setErrorMessage(`Test step error: ${extractErrorMessage(err)}`)
      deps.setAgentState("idle")
      return
    }

    const testWorkdir = workdir
    const sessionId = deps.manager.create(`[test] ${stepDef.label}`, `[test] ${stepDef.label}`, "workflow", "active")

    deps.registry.start({
      sessionId,
      queue,
      description: `[test] ${stepDef.label}`,
      subprocessCwd: testWorkdir.path,
      onComplete: () => testWorkdir.cleanup(),
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })
    deps.setForegroundId(sessionId)
  }

  return { startWorkflow, startTestStep, resumeWorkflow, pauseForeground, abortForeground, handleResume, actionDeps }
}
