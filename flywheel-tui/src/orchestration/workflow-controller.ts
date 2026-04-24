import { buildQueueFromTemplate, type WorkflowName } from "../workflows/queue/templates.js"
import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "./session-actions.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { TERMINAL_TITLE_PREFIX } from "../infra/format.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "./test-step.js"
import type { WorkflowResult } from "./workflow-runner-types.js"
import type { SessionStore } from "./session-store-types.js"
import type { SessionManager, SessionSummary } from "./session/manager.js"
import type { SessionState } from "./session/types.js"

interface WorkflowControllerDeps {
  sessionStore: SessionStore
  manager: SessionManager
  foregroundId: () => string | undefined
  onRunnerDone?: (id: string, state: SessionState) => void
  onRunnerError?: (id: string, errorMessage: string) => void
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

interface WorkflowController {
  startWorkflow(command: string, description: string, chatContext?: string): StartWorkflowResult | { error: string }
  startTestStep(stepId?: string): StartTestStepResult | { error: string } | { info: string }
  pause(foregroundId: string | undefined): boolean
  abort(foregroundId: string | undefined): void
  handleResume(sessionIdArg?: string): Promise<string | null>
  isWorkflowSession(sessionId: string): boolean
  steerWorkflow(foregroundId: string | undefined, text: string): boolean
}

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const { sessionStore, manager } = deps

  function handleRunnerDone(id: string, result: WorkflowResult): void {
    const state: SessionState = result.completed ? "completed" : "paused"
    manager.updateState(id, state)
    deps.onRunnerDone?.(id, state)
  }

  function handleRunnerError(id: string, err: unknown): void {
    manager.updateState(id, "paused")
    deps.onRunnerError?.(id, extractErrorMessage(err))
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
      const workflowName: WorkflowName = command === "sprint" ? "sprint" : "work"
      queue = buildQueueFromTemplate(workflowName, description, wfDeps.config.queue?.max_steps)
    } catch (err) {
      return { error: `Config error: ${extractErrorMessage(err)}` }
    }

    const sessionId = manager.create(description, description, "workflow", "active")
    const terminalTitle = `${TERMINAL_TITLE_PREFIX}${command}`

    sessionStore.start({
      sessionId,
      queue,
      description,
      seedInitialUserMessage: true,
      workflowDeps: wfDeps,
      chatContext,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })

    return { sessionId, terminalTitle }
  }

  function startTestStep(
    stepId?: string,
  ): StartTestStepResult | { error: string } | { info: string } {
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
    const terminalTitle = `${TERMINAL_TITLE_PREFIX}test`

    sessionStore.start({
      sessionId,
      queue,
      description: label,
      workerCwd: testWorkdir.path,
      workflowDeps: wfDeps,
      onRunnerDone: (id, result) => { handleRunnerDone(id, result); testWorkdir.cleanup() },
      onRunnerError: (id, err) => { handleRunnerError(id, err); testWorkdir.cleanup() },
    })

    return { sessionId, workdir: testWorkdir.path, terminalTitle }
  }

  async function resumeWorkflow(sessionId: string): Promise<string | null> {
    const data = await loadResumeData(sessionId)
    if (!data) return null

    const description = data.session.name || data.session.label || ""
    manager.updateState(sessionId, "active")

    sessionStore.start({
      sessionId,
      queue: data.queue,
      description,
      priorBlocks: data.outputBlocks,
      onRunnerDone: handleRunnerDone,
      onRunnerError: handleRunnerError,
    })

    return sessionId
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

  async function handleResume(sessionIdArg?: string): Promise<string | null> {
    let targetId = sessionIdArg
    if (!targetId) {
      const session = findResumableSession(manager)
      if (!session) return null
      targetId = session.id
    }
    return resumeWorkflow(targetId)
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
    pause,
    abort,
    handleResume,
    isWorkflowSession,
    steerWorkflow,
  }
}
