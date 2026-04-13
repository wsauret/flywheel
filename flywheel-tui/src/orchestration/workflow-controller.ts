import { buildQueueFromTemplate, type WorkflowName } from "../workflows/queue/templates.js"
import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "./session-actions.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { TERMINAL_TITLE_PREFIX } from "../infra/format.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "./test-step.js"
import type { WorkflowResult } from "./workflow-runner.js"
import type { SessionStore } from "./session-store-types.js"
import type { SessionManager, SessionSummary } from "./session/manager.js"
import type { SessionActionDeps } from "./session-actions.js"
import type { SessionState } from "./session/state-machine.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type {
  RunnerDoneResult as BaseRunnerDoneResult,
  RunnerErrorResult,
} from "./session/types.js"

interface WorkflowControllerDeps {
  sessionStore: SessionStore
  manager: SessionManager
  refreshList: () => void
  foregroundId: () => string | undefined
  onRunnerDone?: (id: string, result: RunnerDoneResult) => void
  onRunnerError?: (id: string, result: RunnerErrorResult) => void
}

interface StartWorkflowResult {
  sessionId: string
  terminalTitle: string
}

interface StartTestStepResult {
  sessionId: string
  workdir: string
  terminalTitle: string
}

interface ResumeWorkflowResult {
  sessionId: string
  priorBlocks: AnyBlock[]
  terminalTitle: string
}

export interface RunnerDoneResult extends BaseRunnerDoneResult {
  state: SessionState
}

export interface WorkflowController {
  startWorkflow(command: string, description: string, chatContext?: string): StartWorkflowResult | { error: string }
  startTestStep(stepId?: string): StartTestStepResult | { error: string } | { info: string } | null
  resumeWorkflow(sessionId: string): Promise<ResumeWorkflowResult | null>
  pause(foregroundId: string | undefined): boolean
  abort(foregroundId: string | undefined): void
  handleResume(sessionIdArg?: string): Promise<ResumeWorkflowResult | null>
  getActionDeps(): SessionActionDeps
  isWorkflowSession(sessionId: string): boolean
  steerWorkflow(foregroundId: string | undefined, text: string): boolean
}

function formatWorkflowDoneResult(
  result: WorkflowResult,
): RunnerDoneResult {
  if (result.completed) {
    return {
      terminalTitle: `${TERMINAL_TITLE_PREFIX}done`,
      state: "completed",
    }
  }
  return {
    terminalTitle: `${TERMINAL_TITLE_PREFIX}paused`,
    state: "paused",
  }
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const { sessionStore, manager, refreshList } = deps

  function handleRunnerDone(id: string, result: WorkflowResult): void {
    const doneResult = formatWorkflowDoneResult(result)
    manager.updateState(id, doneResult.state)
    refreshList()
    deps.onRunnerDone?.(id, doneResult)
  }

  function handleRunnerError(id: string, err: unknown): void {
    manager.updateState(id, "paused")
    const errorResult = {
      errorMessage: extractErrorMessage(err),
      terminalTitle: `${TERMINAL_TITLE_PREFIX}error`,
    }
    refreshList()
    deps.onRunnerError?.(id, errorResult)
  }

  function startWorkflow(
    command: string,
    description: string,
    chatContext?: string,
  ): StartWorkflowResult | { error: string } {
    let queue
    let wfDeps
    try {
      wfDeps = prepareWorkflowDeps()
      const workflowName: WorkflowName = command === "sprint" ? "sprint" : command === "plan" ? "plan" : "work"
      queue = buildQueueFromTemplate(workflowName, wfDeps.config.queue?.max_steps)
    } catch (err) {
      return { error: `Config error: ${extractErrorMessage(err)}` }
    }

    const sessionId = manager.create(description, description, "workflow", "active")
    const terminalTitle = `${TERMINAL_TITLE_PREFIX}${description || command}`

    sessionStore.start({
      sessionId,
      queue,
      description,
      workflowDeps: wfDeps,
      chatContext,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })

    return { sessionId, terminalTitle }
  }

  function startTestStep(
    stepId?: string,
  ): StartTestStepResult | { error: string } | { info: string } | null {
    if (!stepId) {
      const ids = TEST_STEPS.map((s) => s.id).join(", ")
      return { info: `Available test steps: ${ids}. Usage: /test <step-id>` }
    }

    const stepDef = TEST_STEPS.find((s) => s.id === stepId)
    if (!stepDef) {
      return { error: `Unknown test step "${stepId}". Available: ${TEST_STEPS.map((s) => s.id).join(", ")}` }
    }

    let queue
    let wfDeps
    let workdir: ReturnType<typeof createTestWorkdir> | null = null
    try {
      wfDeps = prepareWorkflowDeps()
      const projectCwd = wfDeps.config.project_cwd ?? process.cwd()
      workdir = createTestWorkdir(projectCwd)
      const fixture = setupTestFixture(stepDef, projectCwd)
      queue = buildTestQueue(stepDef, fixture)
    } catch (err) {
      workdir?.cleanup()
      return { error: `Test step error: ${extractErrorMessage(err)}` }
    }

    const testWorkdir = workdir
    const label = `[test] ${stepDef.label}`
    const sessionId = manager.create(label, label, "workflow", "active")
    const terminalTitle = `${TERMINAL_TITLE_PREFIX}${label}`

    sessionStore.start({
      sessionId,
      queue,
      description: label,
      subprocessCwd: testWorkdir.path,
      workflowDeps: wfDeps,
      onComplete: () => testWorkdir.cleanup(),
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })

    return { sessionId, workdir: testWorkdir.path, terminalTitle }
  }

  async function resumeWorkflow(
    sessionId: string,
  ): Promise<ResumeWorkflowResult | null> {
    const actionDeps = getActionDeps()
    const data = await loadResumeData(sessionId, actionDeps)
    if (!data) return null

    const description = data.session.name || data.session.label || ""
    const terminalTitle = `${TERMINAL_TITLE_PREFIX}${description || "resume"}`

    manager.updateState(sessionId, "active")

    sessionStore.start({
      sessionId,
      queue: data.queue,
      description,
      priorBlocks: data.outputBlocks,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })

    return {
      sessionId,
      priorBlocks: data.outputBlocks,
      terminalTitle,
    }
  }

  function pause(foregroundId: string | undefined): boolean {
    if (!foregroundId) return false
    const paused = sessionStore.pause(foregroundId)
    if (paused) {
      manager.updateState(foregroundId, "paused")
    }
    return paused
  }

  function abort(foregroundId: string | undefined): void {
    if (!foregroundId) return
    sessionStore.abort(foregroundId)
  }

  async function handleResume(
    sessionIdArg?: string,
  ): Promise<ResumeWorkflowResult | null> {
    let targetId = sessionIdArg
    if (!targetId) {
      const actionDeps = getActionDeps()
      const session = findResumableSession(actionDeps)
      if (!session) return null
      targetId = session.id
    }
    return resumeWorkflow(targetId)
  }

  function getActionDeps(): SessionActionDeps {
    return {
      manager,
      activeSessionId: deps.foregroundId,
    }
  }

  function isWorkflowSession(sessionId: string): boolean {
    const entry = sessionStore.get(sessionId)
    return entry?.kind === "workflow"
  }

  function steerWorkflow(foregroundId: string | undefined, text: string): boolean {
    if (!foregroundId) return false
    if (!sessionStore.isRunning(foregroundId)) return false
    // Cancel pending shutdown so the session continues
    sessionStore.cancelShutdown(foregroundId)
    return sessionStore.injectMessage(foregroundId, text)
  }

  return {
    startWorkflow,
    startTestStep,
    resumeWorkflow,
    pause,
    abort,
    handleResume,
    getActionDeps,
    isWorkflowSession,
    steerWorkflow,
  }
}
