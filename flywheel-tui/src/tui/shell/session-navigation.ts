/**
 * Session Navigation — extracted from flywheel-shell.tsx
 *
 * Contains the functions that handle user interactions with sessions:
 *   - handleSessionSelect — routes sidebar selections to open/resume/delete
 *   - returnToIdle — tears down and resets to idle
 *   - returnToChat — tears down and returns to chat
 *   - backgroundSession — detaches without destroying
 *   - stopWorkflow — shuts down and transitions to completed
 *   - pauseQueue — flush-first pause with state transitions
 *   - resumeWorkerWithMessage — resumes worker after interrupt
 *   - resumeSession — resumes a paused session
 *
 * All dependencies are injected via the factory — no SolidJS signals
 * or component-level state captured in closures.
 */

import {
  resumeWorkerWithMessage as resumeWorkerWithMessageImpl,
  resetInterruptState,
  type InterruptControllerDeps,
} from "./interrupt-controller"
import { destroyWorkflowSession } from "../session/workflow-session"
import { updateSession } from "../../session/persistence"
import { killAllActiveProcesses } from "../../worker/process-lifecycle"
import { groupToFlatList, getOpenAction, type SelectionAction } from "../session/sidebar-logic"
import { Log } from "../../utils/log"

import type { SessionLifecycleManager } from "./session-lifecycle-runner"
import type { SessionOrchestrator } from "../session/session-orchestrator"
import type { SessionViewport } from "../session/session-viewport"
import type { EscapeHandler } from "../utils/escape-handler"
import type { ChatController } from "./chat-controller"
import type { StepExecutor } from "../../queue/executor"
import type { Queue } from "../../queue/types"
import type { StdinHandle } from "../../worker/spawner"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState, QueueStepState } from "../types"
import type { AppState } from "./shell-modes"
import type { SessionRuntimeManager } from "../session/session-runtime"
import type { SessionSummary } from "../../session/manager"

const log = Log.create({ service: "shell" })

// ---------------------------------------------------------------------------
// Toast duck type (avoids importing the context provider)
// ---------------------------------------------------------------------------

export interface ToastLike {
  show(options: { message: string; variant: string; duration?: number }): void
}

// ---------------------------------------------------------------------------
// SessionContext duck type (avoids importing the context provider)
// ---------------------------------------------------------------------------

interface SessionContextLike {
  manager: {
    updateState(id: string, state: string): void
    create(planPath: string, name?: string): string
  }
  refreshList: () => void
  sessions: () => SessionSummary[]
}

// ---------------------------------------------------------------------------
// Dependency interface
// ---------------------------------------------------------------------------

export interface SessionNavigationDeps {
  // Lifecycle manager
  lifecycle: SessionLifecycleManager

  // Shell state refs
  activeStepExecutor: { current: StepExecutor | null }
  activeQueue: { current: Queue | null }
  activeStdinHandleRef: { current: StdinHandle | null }

  // Signal setters
  setAppState: (state: AppState) => void
  setIsInterrupted: (v: boolean) => void
  setEscHint: (v: string) => void
  setViewedSessionId: (id: string | null) => void
  setFocusedSessionId: (id: string | null) => void
  setSessionLoading: (v: boolean) => void
  setWorkState: (v: WorkState | null) => void
  setActiveStore: (v: UIActions | null) => void
  setShellQueueSteps: (v: QueueStepState[]) => void
  setIsPromptFocused: (v: boolean) => void
  setSidebarFocused: (v: boolean) => void
  setSidebarSelectedIndex: (v: number) => void

  // Registries
  sessionControllers: Map<string, { shutdown(): Promise<void> }>
  runtimes: SessionRuntimeManager
  sessionStores: Map<string, UIActions>

  // Dependencies
  orchestrator: SessionOrchestrator
  viewport: SessionViewport
  escapeHandler: EscapeHandler
  toast: ToastLike
  sessionCtx: SessionContextLike
  chatController: ChatController

  // Queue execution
  runQueueOnSession: (init: {
    session: import("../session/workflow-session").WorkflowSession
    queue: Queue
    sessionId: string | null
    deps: WorkflowDeps
    budgetTracker: import("../../session/budget-tracker").BudgetTracker | null
    budgetLimits: import("../../schemas").BudgetLimits | null
    sessionObjective?: string
    chatContext?: string
    interactiveOverrides?: { plan?: boolean; review?: boolean }
    seedHandoff?: Record<string, unknown> | null
    alreadyCompletedSteps?: number
  }) => void

  // Other
  getDepsOrWarn: () => WorkflowDeps | null
  teardownActiveWorkflow: () => Promise<void> | undefined
  cleanupQuestionSubscriptions: () => void
  cleanupQueueSubscriptions: () => void
  unsubscribeTimer: () => void
  pendingInjection: { current: string | null }
  capturedWorkerSessionId: { current: string | undefined }

  // Session lookup
  sessionsMap: () => Map<string, SessionSummary>
  focusedSessionId: () => string | null
  sidebarSelectedIndex: () => number
  isInterrupted: () => boolean

  // Pause flag (owned by shell, shared with queue runner)
  setUserInitiatedPause: (v: boolean) => void

  // Interrupt controller additional deps (for resumeWorkerWithMessage)
  getActiveSession: () => import("../session/workflow-session").WorkflowSession | null
  getActiveQueue: () => Queue | null
  getActiveStepExecutor: () => StepExecutor | null
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface SessionNavigation {
  handleSessionSelect: (sessionId: string, action: SelectionAction) => void
  returnToIdle: () => void
  returnToChat: () => void
  backgroundSession: () => void
  stopWorkflow: () => Promise<void>
  pauseQueue: () => Promise<void>
  resumeWorkerWithMessage: (message: string) => void
  resumeSession: (sessionId: string) => Promise<void>
}

export function createSessionNavigation(deps: SessionNavigationDeps): SessionNavigation {
  const {
    lifecycle,
    activeStepExecutor,
    activeQueue,
    activeStdinHandleRef,
    setAppState,
    setIsInterrupted,
    setEscHint,
    setViewedSessionId,
    setFocusedSessionId,
    setSessionLoading,
    setWorkState,
    setActiveStore,
    setShellQueueSteps,
    setIsPromptFocused,
    setSidebarFocused,
    setSidebarSelectedIndex,
    sessionControllers,
    runtimes,
    sessionStores,
    orchestrator,
    viewport,
    escapeHandler,
    toast,
    sessionCtx,
    chatController,
    runQueueOnSession,
    getDepsOrWarn,
    teardownActiveWorkflow,
    pendingInjection,
    capturedWorkerSessionId,
    sessionsMap,
    focusedSessionId,
    sidebarSelectedIndex,
    setUserInitiatedPause,
  } = deps

  // ── returnToIdle ──
  const returnToIdle = () => {
    teardownActiveWorkflow()
    viewport.cancelInjection()
    setSessionLoading(false)
    setViewedSessionId(null)
    setWorkState(null)
    resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })
    setAppState("idle")
  }

  // ── returnToChat ──
  const returnToChat = () => {
    teardownActiveWorkflow()
    viewport.cancelInjection()
    setSessionLoading(false)
    setViewedSessionId(null)
    setWorkState(null)
    resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })
    // Try to restart chat; fall back to idle if it fails
    const started = chatController.restartChat()
    if (!started) {
      setAppState("idle")
    }
  }

  // ── backgroundSession ──
  const backgroundSession = () => {
    // Background in runtimes manager (pauses adapter flush)
    const currentFocused = focusedSessionId()
    if (currentFocused) {
      runtimes.background(currentFocused)
    }

    // Delegate session lifecycle cleanup to lifecycle manager
    lifecycle.backgroundCurrent()

    // Null queue-execution refs (kept in shell)
    activeStepExecutor.current = null
    activeStdinHandleRef.current = null

    // Reset viewport and shell state
    viewport.cancelInjection()
    setSessionLoading(false)
    setActiveStore(null)
    setWorkState(null)
    setViewedSessionId(null)
    setFocusedSessionId(null)
    setAppState("idle")
    setEscHint("")
    escapeHandler.reset()
    // Force the Prompt component to re-acquire keyboard focus.
    setSidebarFocused(true)
    queueMicrotask(() => setSidebarFocused(false))
  }

  // ── stopWorkflow ──
  const stopWorkflow = async () => {
    escapeHandler.reset()
    setEscHint("")
    resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })

    // Capture session ID before teardown clears it
    const sessionId = focusedSessionId()

    await teardownActiveWorkflow()

    // Remove from sessionControllers so sidebar shows "Paused" not "Active"
    if (sessionId) {
      runtimes.teardown(sessionId)
      sessionControllers.delete(sessionId)
    }

    // Persist lifecycle state as work:paused (manual stop != completed)
    if (sessionId) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch (stateErr) {
        log.warn("state transition failed (stop)", { session: sessionId, error: stateErr instanceof Error ? stateErr : String(stateErr) })
      }
      sessionCtx.refreshList()
    }

    setAppState("completed")
  }

  // ── pauseQueue ──
  const pauseQueue = async () => {
    setUserInitiatedPause(true)
    escapeHandler.reset()
    setEscHint("")
    resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })

    // Suppress ErrorModal from the queue:failed event that shutdown triggers
    const currentSession = lifecycle.getActiveSession()
    if (currentSession?.adapter) {
      currentSession.adapter.suppressQueueError = true
    }

    // Flush persistence, clean up subscriptions, unsubscribe timer/store
    await lifecycle.teardownForPause()

    // Shut down queue runtime (executor, processes, stdin handles)
    if (activeStepExecutor.current) {
      activeStepExecutor.current.requestShutdown()
      activeStepExecutor.current = null
    }
    activeQueue.current = null
    activeStdinHandleRef.current = null
    resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })
    killAllActiveProcesses().catch(() => {})

    // Push pause message through the event bus BEFORE destroying the session
    if (currentSession) {
      currentSession.eventBus.emit({
        type: "worker:output",
        workflowId: "queue-pause",
        stream: "stderr",
        data: "\u23f8 Execution paused. Resume with /work or select from session sidebar.\n",
        timestamp: new Date().toISOString(),
      })
    }

    // Destroy the workflow session (stops timer interval, stops and disconnects adapter)
    if (currentSession) {
      destroyWorkflowSession(currentSession)
    }
    setActiveStore(null)

    // Persist session state as work:paused and remove from sessionControllers
    const runningSessionIds = [...sessionControllers.keys()]
    for (const sessionId of runningSessionIds) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch (err) {
        log.warn("state transition failed (pause)", { session: sessionId, error: err instanceof Error ? err : String(err) })
      }
      runtimes.teardown(sessionId)
      sessionControllers.delete(sessionId)
    }
    if (runningSessionIds.length > 0) {
      sessionCtx.refreshList()
    }

    // Transition to completed (keeps output visible, enables /work to restart)
    setAppState("completed")
  }

  // ── resumeWorkerWithMessage ──
  const resumeWorkerWithMessage = (message: string) => {
    const interruptDeps: InterruptControllerDeps = {
      activeStdinHandleRef,
      getDepsOrWarn,
      getActiveSession: deps.getActiveSession,
      getActiveQueue: deps.getActiveQueue,
      getActiveStepExecutor: deps.getActiveStepExecutor,
      stopWorkflow,
      toast,
      escapeHandler,
      capturedWorkerSessionId,
      pendingInjection,
      setShellQueueSteps: (fn: (prev: QueueStepState[]) => QueueStepState[]) => setShellQueueSteps(fn as any),
      setEscHint,
      setIsInterrupted,
    }
    resumeWorkerWithMessageImpl(message, interruptDeps)
  }

  // ── resumeSession ──
  const resumeSession = async (sessionId: string) => {
    // 1. Clean up any current workflow
    if (lifecycle.getActiveSession()) {
      teardownActiveWorkflow()
    }

    // 2. Get session data + output + queue from orchestrator
    const result = await orchestrator.handleResumeSession(sessionId)
    if (!result) {
      toast.show({ message: "Session not found or corrupt", variant: "error" })
      return
    }

    // 3. Load workflow deps (config, engine, spawner)
    const wfDeps = getDepsOrWarn()
    if (!wfDeps) {
      toast.show({ message: "Failed to load config for resume", variant: "error" })
      return
    }

    // 4. Transition session state before starting execution
    try {
      sessionCtx.manager.updateState(sessionId, "work:active")
      sessionCtx.refreshList()
    } catch (err) {
      toast.show({
        message: `Failed to update session state: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    // 5. Delegate session creation + persistence wiring to lifecycle manager
    const projectCwd = wfDeps.config.project_cwd ?? "."
    const initResult = lifecycle.initResumeSession({
      result,
      projectCwd,
      sessionId,
    })
    activeQueue.current = result.queue

    const alreadyCompletedSteps = result.queue.steps.filter((s) => s.status === "completed").length

    // 6. Hand off to shared queue wiring (steps 6-13)
    runQueueOnSession({
      session: initResult.session,
      queue: result.queue,
      sessionId,
      deps: wfDeps,
      budgetTracker: initResult.budgetTracker,
      budgetLimits: initResult.budgetLimits,
      sessionObjective: result.session.name ?? undefined,
      alreadyCompletedSteps,
    })
  }

  // ── Session name lookup ──
  const sessionName = (id: string): string => {
    const s = sessionsMap().get(id)
    return s?.name || s?.label || id.slice(0, 8)
  }

  /** Session IDs currently being resumed — prevents duplicate concurrent resumes. */
  const resumingSessionIds = new Set<string>()

  // ── handleSessionSelect ──
  const handleSessionSelect = (sessionId: string, action: SelectionAction) => {
    switch (action) {
      case "open":
        viewport.openSession(sessionId)
        return
      case "resume":
        if (resumingSessionIds.has(sessionId)) return
        resumingSessionIds.add(sessionId)
        resumeSession(sessionId)
          .catch(() => {
            toast.show({ message: `Failed to resume ${sessionName(sessionId)}`, variant: "error" })
          })
          .finally(() => {
            resumingSessionIds.delete(sessionId)
          })
        return
      case "delete":
        orchestrator.handleDeleteSession(sessionId).then(() => {
          toast.show({ message: `Deleted ${sessionName(sessionId)}`, variant: "info" })
          sessionCtx.refreshList()

          // Evict any cached store for the deleted session
          sessionStores.delete(sessionId)

          // After deletion, open the next openable session at the selected
          // index so the viewport stays in sync with the sidebar highlight.
          const flatList = groupToFlatList(sessionCtx.sessions())
          const idx = sidebarSelectedIndex()
          const clampedIdx = Math.min(idx, flatList.length - 1)
          if (clampedIdx >= 0) {
            const nextSession = flatList[clampedIdx]
            if (nextSession && getOpenAction(nextSession) !== null) {
              setSidebarSelectedIndex(clampedIdx)
              viewport.openSession(nextSession.id)
              return
            }
          }
          // No openable sessions left — return to idle
          returnToIdle()
        }).catch(() => {
          toast.show({ message: `Failed to delete ${sessionName(sessionId)}`, variant: "error" })
          sessionCtx.refreshList()
        })
        return
      default: {
        const _exhaustive: never = action
        throw new Error(`Unhandled action: ${_exhaustive}`)
      }
    }
  }

  return {
    handleSessionSelect,
    returnToIdle,
    returnToChat,
    backgroundSession,
    stopWorkflow,
    pauseQueue,
    resumeWorkerWithMessage,
    resumeSession,
  }
}
