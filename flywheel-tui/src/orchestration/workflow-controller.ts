/**
 * Workflow Controller — pure business logic for workflow session lifecycle.
 *
 * Extracted from `src/tui/hooks/use-workflow-lifecycle.ts`. Controllers return
 * DATA, not signal writes. The TUI hook calls controller methods and writes
 * the returned data to SolidJS signals.
 *
 * Must NOT import from `src/tui/`.
 */

import { buildQueueForSlashCommand } from "./queue-builder.js"
import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { loadResumeData, findResumableSession } from "./session-actions.js"
import { errorMessage as extractErrorMessage } from "../infra/error-message.js"
import { TERMINAL_TITLE_PREFIX, formatElapsed, formatCost, formatTokens } from "../infra/format.js"
import { TEST_STEPS, setupTestFixture, buildTestQueue, createTestWorkdir } from "./test-step.js"
import type { WorkflowResult } from "./workflow-runner.js"
import type { SessionStore } from "./session-store-types.js"
import type { SessionManager, SessionSummary } from "./session/manager.js"
import type { SessionActionDeps } from "./session-actions.js"
import type { SessionState } from "./session/state-machine.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type {
  RunnerDoneResult as BaseRunnerDoneResult,
  RunnerErrorResult as BaseRunnerErrorResult,
} from "./session/types.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowControllerDeps {
  sessionStore: SessionStore
  manager: SessionManager
  refreshList: () => void
  /** Returns a monotonic timestamp for elapsed-time computation. */
  workStartTime: () => number
  /** Foreground session ID accessor (needed for pause/abort/actionDeps). */
  foregroundId: () => string | undefined
  /** Called when a runner completes normally. */
  onRunnerDone?: (id: string, result: RunnerDoneResult) => void
  /** Called when a runner encounters an error. */
  onRunnerError?: (id: string, result: RunnerErrorResult) => void
}

export interface StartWorkflowResult {
  sessionId: string
  terminalTitle: string
}

export interface StartTestStepResult {
  sessionId: string
  workdir: string
  terminalTitle: string
}

export interface ResumeWorkflowResult {
  sessionId: string
  priorBlocks: AnyBlock[]
  terminalTitle: string
}

export interface RunnerDoneResult extends BaseRunnerDoneResult {
  state: SessionState
}

export interface RunnerErrorResult extends BaseRunnerErrorResult {
  statusMessage: string
}

export interface WorkflowController {
  /**
   * Start a workflow from a slash command.
   * Returns session data on success, or an error message.
   */
  startWorkflow(command: string, description: string, chatContext?: string): StartWorkflowResult | { error: string }

  /**
   * Start a single test step in isolation.
   * Returns session data, or an info/error message, or null if stepId not provided.
   */
  startTestStep(stepId?: string): StartTestStepResult | { error: string } | { info: string } | null

  /**
   * Resume a persisted workflow session.
   * Returns session data, or null if resume data is missing.
   */
  resumeWorkflow(sessionId: string): Promise<ResumeWorkflowResult | null>

  /**
   * Pause the foreground workflow.
   * Returns true if paused, false if no foreground or not a workflow.
   */
  pause(foregroundId: string | undefined): boolean

  /**
   * Abort the foreground workflow.
   */
  abort(foregroundId: string | undefined): void

  /**
   * Find and resume the most recent resumable session.
   * Returns the result of resumeWorkflow, or null.
   */
  handleResume(sessionIdArg?: string): Promise<ResumeWorkflowResult | null>

  /**
   * Build actionDeps for useSessionModal.
   */
  getActionDeps(): SessionActionDeps

  /**
   * Check whether a session ID belongs to a workflow (for keyboard handler).
   */
  isWorkflowSession(sessionId: string): boolean

  /**
   * Steer a running workflow by injecting a user message.
   * Cancels shutdown if the session is paused. Returns true if delivered.
   */
  steerWorkflow(foregroundId: string | undefined, text: string): boolean
}

// ---------------------------------------------------------------------------
// Shared lifecycle helper
// ---------------------------------------------------------------------------

/**
 * Format runner-done result. Shared between chat and workflow controllers
 * to consolidate the handleRunnerDone pattern.
 */
export function formatWorkflowDoneResult(
  result: WorkflowResult,
  elapsedMs: number,
): RunnerDoneResult {
  const totalElapsed = formatElapsed(elapsedMs)
  if (result.completed) {
    return {
      statusMessage: `\u2713 ${result.stepsCompleted}/${result.stepsTotal} steps \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)} \u00b7 ${formatTokens(result.tokens)} tokens`,
      terminalTitle: `${TERMINAL_TITLE_PREFIX}done`,
      state: "completed",
    }
  }
  return {
    statusMessage: `\u2717 ${result.reason ?? "stopped"} (${result.stepsCompleted}/${result.stepsTotal}) \u00b7 ${totalElapsed} \u00b7 ${formatCost(result.cost)}`,
    terminalTitle: `${TERMINAL_TITLE_PREFIX}paused`,
    state: "paused",
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createWorkflowController(deps: WorkflowControllerDeps): WorkflowController {
  const { sessionStore, manager, refreshList } = deps

  /** Handle workflow runner completion. */
  function handleRunnerDone(id: string, result: WorkflowResult): void {
    const elapsedMs = Date.now() - deps.workStartTime()
    const doneResult = formatWorkflowDoneResult(result, elapsedMs)
    manager.updateState(id, doneResult.state)
    refreshList()
    deps.onRunnerDone?.(id, doneResult)
  }

  /** Handle workflow runner error. */
  function handleRunnerError(id: string, err: unknown): void {
    manager.updateState(id, "paused")
    const errorResult = {
      errorMessage: extractErrorMessage(err),
      statusMessage: "",
      terminalTitle: `${TERMINAL_TITLE_PREFIX}error`,
    } satisfies RunnerErrorResult
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
      queue = buildQueueForSlashCommand(command, wfDeps.config)
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
