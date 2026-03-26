/** @jsxImportSource @opentui/solid */
/**
 * FlywheelShell — Top-level persistent shell component
 *
 * Single always-on SharedLayout with content varying by AppState:
 *   IDLE:      EmptyState (logo, help, slogan) + UnifiedPrompt in command mode
 *   WORKING:   OutputWindow + UnifiedPrompt in passive/active mode
 *   COMPLETED: OutputWindow (or EmptyState if no output) + UnifiedPrompt in command mode
 *   IMPORTING: Plan import UI + UnifiedPrompt disabled
 *
 * AppState describes *what the app is doing* — the layout is always SharedLayout.
 *
 * Command dispatch is handled by ActionDispatcher (action-dispatcher.ts),
 * a pure function with dependency injection.
 *
 * Workflow lifecycle:
 *   handleCommand(workflow, args) — routes through ActionDispatcher
 *   stopWorkflow() — shuts down controller/runner, destroys session,
 *     transitions to completed
 */

import fs from "node:fs"
import { createSignal, createMemo, onCleanup, Show } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Toast } from "@tui/shared/ui/toast"
import { SharedLayout } from "../routes/work/components/shared-layout"
import { OutputWindow, type CurrentPhaseInfo } from "../routes/work/components/output-window"
import { SessionSidebar } from "./session-sidebar"
import { WorkflowPanel } from "./workflow-panel"
import { SessionHeader } from "./session-header"
import { BrandingHeader } from "@tui/shared/components/layout/branding-header"
import { EmptyState } from "./empty-state"
import { useUnifiedPrompt } from "./unified-prompt"
import { exitTUI } from "../app"
import { createEscapeHandler } from "../utils/escape-handler"
import { Selection } from "../utils/selection"
import { Clipboard } from "../utils/clipboard"
import { QuitConfirmModal } from "../routes/work/components/modals/quit-confirm-modal"
import { createActionDispatcher } from "./action-dispatcher"
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "./workflow-session"
import {
  createSessionRuntimeManager,
  type SessionRuntimeManager,
  type RunningRuntime,
} from "./session-runtime"
import { ExecutionLoop } from "../../controller/execution-loop"
import { prepareWorkflowDeps } from "../../controller/workflow-deps"
import type { WorkflowDeps } from "../../controller/workflow-deps"
import { EventBus } from "../../events/event-bus"
import { WorkflowPipeline } from "../../controller/workflow-pipeline"
import type { QuestionRequest } from "../../controller/question-service"
import { QuestionPrompt } from "./question-prompt"
import { StatusFooter } from "../routes/work/components/status-footer"
import { TelemetryBar } from "../routes/work/components/telemetry-bar"
import { buildPipelineStages, createShellStageRunner, createEndOfSessionGate } from "./shell-pipeline"
import { buildCustomPipeline, modeHasReview, PIPELINE_MODE_OPTIONS, type PipelineMode } from "./start-command"
import { buildQueue, buildQueueForSlashCommand, type QueueProgressInfo, formatQueueProgress, createEndOfSessionGate as createQueueEndOfSessionGate } from "./shell-queue"
import { buildQueueFromTemplate, type WorkflowName } from "../../queue/templates"
import { createStepExecutor, type StepExecutor, type StepExecutorResult } from "../../queue/executor"
import { createFlywheelEmitter } from "../../events/event-bus"
import { createQueuePersistence } from "../../queue/persistence"
import type { Queue } from "../../queue/types"
import { parseCommand } from "../utils/command-parser"
import { createQuestionWiring, type QuestionWiring } from "../utils/question-wiring"
import { SIDEBAR_WIDTH } from "./shell-modes"
import { createOutputPersistence, type OutputFlusher } from "../../session/output-persistence"
import { readSession, updateSession, deleteSessionWithCompanions } from "../../session/persistence"
import { createBudgetTracker, type BudgetTracker } from "../../session/budget-tracker"
import type { BudgetLimits } from "../../schemas/shared"
import { fromSnapshot, snapshotToBlocks } from "../../schemas/output"
import { createSessionOrchestrator, type SessionOrchestrator } from "./session-orchestrator"
import { handlePipelineCompletion } from "./pipeline-completion"
import { safeUpdateState } from "../../session/safe-transition"
import { ContextIndexer } from "../../memory/indexer"
import { injectOutputBlocks } from "./resume-utils"
import type { PipelineStageInfo, SprintIterationInfo } from "../utils/format"
import type { WorkflowSession } from "./workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState } from "../routes/work/state/types"
import type { AnyBlock } from "../routes/work/state/types"
import type { Unsubscribe } from "../../events/event-bus"
import { sidebarKeyHandler, getOpenAction, groupToFlatList, type SelectionAction } from "./sidebar-logic"
import { createSessionViewport, type SessionViewport } from "./session-viewport"
import { isResumable } from "../../session/state-machine"
import { deriveHeaderInfo } from "./session-header-logic"
import { autoDetectTransport } from "../../dispatcher/auto-detect"
import { createEvaluatorTransport } from "../../evaluator/create-transport"
import { killAllActiveProcesses } from "../../worker/process-lifecycle"
import { createStageLoop } from "../../controller/stage-loop-factory"
import { Log } from "../../utils/log"
import { SubprocessLogger } from "../../utils/subprocess-logger.js"

const log = Log.create({ service: "shell" })

// ── App state ──

import {
  escapeForState,
  ctrlCForState,
  type AppState,
} from "./shell-modes"

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const sessionCtx = useSession()
  const [appState, setAppState] = createSignal<AppState>("idle")
  const [escHint, setEscHint] = createSignal("")

  // Active workflow metadata
  const [activeStepLabel, setActiveStepLabel] = createSignal("Phase")
  const [activeWorkflowName, setActiveWorkflowName] = createSignal("work")

  // Active workflow store as signal — drives the idle/work view switch
  const [activeStore, setActiveStore] = createSignal<UIActions | null>(null)

  // Work state derived from store (for SharedLayout + OutputWindow)
  const [workState, setWorkState] = createSignal<WorkState | null>(null)

  // Prompt focus management (P1: re-wired through FlywheelShell)
  const [isPromptFocused, setIsPromptFocused] = createSignal(false)
  const [showStopModal, setShowStopModal] = createSignal(false)
  const [showQuitModal, setShowQuitModal] = createSignal(false)

  // Sidebar focus management — mutually exclusive with prompt focus
  const [sidebarFocused, setSidebarFocused] = createSignal(false)
  const [sidebarSelectedIndex, setSidebarSelectedIndex] = createSignal(0)

  // ── Viewport: which session is currently shown (may differ from executing session) ──
  const [viewedSessionId, setViewedSessionId] = createSignal<string | null>(null)

  // Per-session store cache (LRU-5): sessionId → UIActions store
  const sessionStores = new Map<string, UIActions>()

  // Per-session controller registry: sessionId → { shutdown() }
  // CRITICAL: activeSessionId tracks EXECUTING sessions; viewedSessionId tracks the VISIBLE session
  const sessionControllers = new Map<string, { shutdown(): Promise<void> }>()

  // ── SessionRuntime Map (replaces single-instance let refs) ──
  const runtimes: SessionRuntimeManager = createSessionRuntimeManager({
    destroyWorkflowSession,
  })

  // ── Focused session: which running session the viewport is connected to ──
  const [focusedSessionId, setFocusedSessionId] = createSignal<string | null>(null)

  // Memoized Map for O(1) session name lookup (used by sessionName(), viewedSessionInfo())
  const sessionsMap = createMemo(() =>
    new Map(sessionCtx.sessions().map((s) => [s.id, s]))
  )

  // Memoized flat list for sidebar — recomputes only on session list changes, not every keypress
  const _sidebarFlatList = createMemo(() => groupToFlatList(sessionCtx.sessions()))

  // Loading state for async disk reads (Step 5.3)
  const [sessionLoading, setSessionLoading] = createSignal(false)

  // Pending question tracking for QuestionPrompt
  const [pendingQuestion, setPendingQuestion] = createSignal<QuestionRequest | null>(null)
  let activeQuestionWiring: QuestionWiring | null = null

  // Pipeline stage indicator tracking
  const [activePipelineInfo, setActivePipelineInfo] = createSignal<PipelineStageInfo | null>(null)
  // Queue progress indicator tracking (replaces pipeline info for queue-based execution)
  const [activeQueueInfo, setActiveQueueInfo] = createSignal<QueueProgressInfo | null>(null)
  // Sprint iteration tracking for telemetry bar
  const [activeSprintInfo, setActiveSprintInfo] = createSignal<SprintIterationInfo | null>(null)
  let pipelineUnsubs: Unsubscribe[] = []

  // Track the active session's timer for the status bar runtime display.
  // The timer is a per-session instance (not the global singleton).
  // We subscribe/unsubscribe as sessions switch.
  const [runtimeText, setRuntimeText] = createSignal("00:00")
  let _activeTimerUnsub: (() => void) | null = null

  /** Subscribe to a session's timer for runtime display updates. */
  const subscribeToTimer = (sessionTimer: import("../shared/services/timer").TimerService) => {
    if (_activeTimerUnsub) _activeTimerUnsub()
    // Immediately read current value
    setRuntimeText(sessionTimer.getWorkflowRuntime())
    // Subscribe for ongoing ticks
    _activeTimerUnsub = sessionTimer.subscribe(() => {
      setRuntimeText(sessionTimer.getWorkflowRuntime())
    })
  }

  const unsubscribeTimer = () => {
    if (_activeTimerUnsub) {
      _activeTimerUnsub()
      _activeTimerUnsub = null
    }
    setRuntimeText("00:00")
  }

  // Non-reactive refs for lifecycle management
  let activeSession: WorkflowSession | null = null
  // activeController was removed — shutdown is now via activeLoop.requestShutdown()
  let activeLoop: ExecutionLoop | null = null
  let activePipeline: WorkflowPipeline | null = null
  let activeStepExecutor: StepExecutor | null = null
  let activeQueue: Queue | null = null
  let activeFlusher: OutputFlusher | null = null
  let activeBudgetTracker: BudgetTracker | null = null
  let storeUnsub: (() => void) | null = null

  // Pipeline running guard: prevents handleCommand from overwriting activeWorkflowName
  // during pipeline execution (stage-transition events handle it instead)
  let _isPipelineRunning = false

  // User-initiated pause flag: set when double-Esc pauses a pipeline.
  // Distinguishes pause from failure so ErrorModal is suppressed.
  let _userInitiatedPause = false

  // ── Lazy-cached workflow deps ──
  // Avoids calling prepareWorkflowDeps() at every call site.
  // Caches on first successful call; returns null on config errors.
  let _cachedDeps: WorkflowDeps | null = null
  let _depsAttempted = false

  /**
   * Get workflow deps with lazy-init cache.
   * Returns null if config is invalid or engine is unknown.
   * Logs a toast warning on first failure.
   */
  const getDepsOrWarn = (): WorkflowDeps | null => {
    if (_cachedDeps) return _cachedDeps
    if (_depsAttempted) return null  // Already failed once
    _depsAttempted = true
    try {
      _cachedDeps = prepareWorkflowDeps()
      return _cachedDeps
    } catch (err) {
      toast.show({
        message: `Config error: ${err instanceof Error ? err.message : String(err)}`,
        variant: "error",
      })
      return null
    }
  }

  // ── Shared ContextIndexer (one per project_cwd) ──
  // Lazy-init: created on first pipeline start, disposed on shell unmount.
  let _sharedContextIndexer: ContextIndexer | null = null
  let _indexerStarted = false

  const getOrCreateContextIndexer = (): ContextIndexer => {
    if (!_sharedContextIndexer) {
      _sharedContextIndexer = new ContextIndexer(getProjectCwd())
    }
    return _sharedContextIndexer
  }

  /** Convenience: get project_cwd from cached deps (or "." on failure). */
  const getProjectCwd = (): string => getDepsOrWarn()?.config.project_cwd ?? "."

  /**
   * Get deps or return to idle on failure.
   * Used in workflow launch functions where failure means we can't proceed.
   */
  const getDepsOrReturnIdle = (): WorkflowDeps | null => {
    const deps = getDepsOrWarn()
    if (!deps) {
      returnToIdle()
      return null
    }
    return deps
  }

  // ── Session Orchestrator ──
  // Handles resume, session switching, auto-archive, and delete.
  // Uses dependency injection — no direct imports of persistence internals.
  const orchestrator: SessionOrchestrator = createSessionOrchestrator({
    readSession: (id: string) => {
      return readSession(id, getProjectCwd())
    },
    createOutputPersistence: (sessionId: string) => {
      return createOutputPersistence({ sessionId, baseDir: getProjectCwd() })
    },
    fromSnapshot,
    manager: sessionCtx.manager,
    refreshList: () => sessionCtx.refreshList(),
    deleteSessionFiles: (id: string) => {
      // Guard: refuse to delete any session that has a running controller.
      // Check the entire sessionControllers keyset, not just a single activeSessionId.
      if (sessionControllers.has(id)) {
        return { deleted: [], errors: ["Cannot delete a running session"] }
      }
      return deleteSessionWithCompanions(id, getProjectCwd())
    },
  })

  // Double-Esc handler for stopping workflows
  const escapeHandler = createEscapeHandler({ timeoutMs: 5000 })

  // Wire console copy-to-clipboard via OpenTUI's onCopySelection callback
  renderer.console.onCopySelection = async (text: string) => {
    if (!text || text.length === 0) return
    await Clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch((err) => toast.show({ message: String(err), variant: "error" }))
    renderer.clearSelection()
  }

  // ── Store subscription helper ──

  const subscribeToStore = (store: UIActions) => {
    // Unsubscribe previous
    if (storeUnsub) storeUnsub()

    // Initial state
    setWorkState(store.getState())

    // Subscribe to updates
    storeUnsub = store.subscribe(() => {
      setWorkState(store.getState())
    })
  }

  // ── Session Viewport ──
  // Handles switching the visible session in the viewport without
  // mutating lifecycle state or creating new WorkflowSession instances.
  const viewport: SessionViewport = createSessionViewport({
    viewedSessionId,
    setViewedSessionId,
    activeStore: () => activeStore(),
    setActiveStore,
    subscribeToStore,
    unsubscribeStore: () => {
      if (storeUnsub) {
        storeUnsub();
        storeUnsub = null;
      }
    },
    setWorkState,
    setAppState,
    sessionControllers,
    sessionStores,
    orchestrator,
    toast,
    setSessionLoading,
  })

  // ── Derived state ──

  const currentPhase = createMemo((): CurrentPhaseInfo | null => {
    const state = workState()
    if (!state) return null
    const phases = state.phases
    const running = phases.find((p) => p.status === "running")
    if (running) {
      return { index: running.index, name: running.name, status: running.status }
    }
    for (let i = phases.length - 1; i >= 0; i--) {
      const p = phases[i]
      if (p.status === "completed" || p.status === "failed") {
        return { index: p.index, name: p.name, status: p.status }
      }
    }
    return null
  })

  const approvalPending = () => workState()?.approvalState?.pending ?? false

  // Derived: is the currently viewed session resumable (work:paused)?
  const isSessionResumable = createMemo(() => {
    const vid = viewedSessionId()
    if (!vid) return false
    const session = sessionsMap().get(vid)
    if (!session) return false
    return isResumable(session.lifecycleState)
  })

  // Derived: header info for the currently viewed session (historical/non-running)
  // Returns null when there's no viewed session or it's running (live store has its own header data)
  const viewedSessionInfo = createMemo(() => {
    const vid = viewedSessionId()
    if (!vid) return null
    // Running sessions use header data from the live store, not derived from SessionSummary
    if (sessionControllers.has(vid)) return null
    const session = sessionsMap().get(vid)
    if (!session) return null
    return deriveHeaderInfo(session)
  })

  // Auto-focus prompt when approval is pending (P1: approval focus path)
  // Using createEffect-like pattern via derived memo.
  // Guard: skip auto-focus for read-only sessions (no running controller).
  const _autoFocusApproval = createMemo(() => {
    if (approvalPending()) {
      const vid = viewedSessionId()
      if (!vid || sessionControllers.has(vid)) {
        setIsPromptFocused(true)
        setSidebarFocused(false)
      }
    }
    return approvalPending()
  })
  // Force tracking
  void _autoFocusApproval

  // Auto-focus prompt during working state so user can inject messages
  // into the running worker. Without this, the output scrollbox steals
  // focus (it gets focused={!isPromptFocused}) and keystrokes don't
  // reach the prompt input.
  const _autoFocusWorking = createMemo(() => {
    if (appState() === "working" && !sidebarFocused()) {
      setIsPromptFocused(true)
    }
    return appState()
  })
  void _autoFocusWorking

  // ── Workflow Lifecycle ──

  const startPipeline = (
    stages: import("../../controller/workflow-pipeline").PipelineStage[],
    args: Record<string, string>,
    preloadedDeps?: WorkflowDeps,
    interactiveOverrides?: { plan?: boolean; review?: boolean },
  ) => {
    // Background previous session (don't destroy — allow concurrent pipelines)
    const prevFocused = focusedSessionId()
    if (prevFocused && runtimes.has(prevFocused)) {
      runtimes.background(prevFocused)
      // Detach local refs WITHOUT destroying — the pipeline continues running
      // in the background, tracked by runtimes. The pipeline's async closure
      // captured its own local references and will clean up on completion.
      activeSession = null
      activeLoop = null
      activePipeline = null
      activeFlusher = null
      activeBudgetTracker = null
      if (storeUnsub) {
        storeUnsub()
        storeUnsub = null
      }
      cleanupQuestionSubscriptions()
      cleanupPipelineSubscriptions()
      setActiveStore(null)
      setWorkState(null)
    } else if (activeSession) {
      // No previous session in runtimes — full destroy (legacy path)
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeLoop = null
      activePipeline = null
      if (activeFlusher) {
        activeFlusher.dispose()
        activeFlusher = null
      }
      if (activeBudgetTracker) {
        activeBudgetTracker.dispose()
        activeBudgetTracker = null
      }
      setActiveStore(null)
      setWorkState(null)
    }

    // Create fresh session
    const sessionLabel = stages.map((s) => s.workflow).join(" -> ")
    const session = createWorkflowSession(sessionLabel)
    activeSession = session
    setActiveStore(session.store)
    subscribeToStore(session.store)
    subscribeToTimer(session.timer)
    setAppState("working")

    // Config loaded once at pipeline start
    let deps: WorkflowDeps
    if (preloadedDeps) {
      deps = preloadedDeps
    } else {
      const resolved = getDepsOrReturnIdle()
      if (!resolved) return
      deps = resolved
    }

    // Create persistent Session for pause/resume support
    const planPathForSession = args.planPath ?? stages.map((s) => s.workflow).join(" -> ")
    // Use the raw description as a placeholder name. The dispatcher LLM will
    // generate a short 2-5 word session name on its first call and update it.
    const placeholderName = args.description || args.topic || undefined
    let persistedSessionId: string | null = null
    try {
      persistedSessionId = sessionCtx.manager.create(planPathForSession, placeholderName)

      // Set outputPath on the session
      const projectCwd = deps.config.project_cwd ?? "."
      updateSession(persistedSessionId, { outputPath: `${persistedSessionId}.output.json` }, projectCwd)

      // Transition to work:active (new -> plan:imported -> plan:approved -> work:active)
      sessionCtx.manager.updateState(persistedSessionId, "plan:imported")
      sessionCtx.manager.updateState(persistedSessionId, "plan:approved")
      sessionCtx.manager.updateState(persistedSessionId, "work:active")

      // Start output flusher — captures session's own store directly (NOT activeStore() signal)
      const persistence = createOutputPersistence({
        sessionId: persistedSessionId,
        baseDir: projectCwd,
      })
      const sessionStore = session.store
      const getOutputBlocks = () => (sessionStore.getState().outputBlocks ?? []) as unknown as { kind: string; [key: string]: unknown }[]
      activeFlusher = persistence.createFlusher(getOutputBlocks, { intervalMs: 5000 })

      // Register in session maps
      sessionStores.set(persistedSessionId, session.store)

      sessionCtx.refreshList()
    } catch (err) {
      // Best effort — don't block pipeline start on persistence failure
      toast.show({
        message: `Session persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    // Create BudgetTracker for the pipeline.
    // Read budgetLimits from the persisted session (set by SessionManager.create()
    // from config.budget). If no session was persisted, budgetLimits stays null
    // and the tracker is not created — budget enforcement is silently skipped.
    let pipelineBudgetTracker: BudgetTracker | null = null
    let pipelineBudgetLimits: BudgetLimits | null = null
    const pipelineSessionId_ = persistedSessionId
    if (pipelineSessionId_) {
      const projectCwd = deps.config.project_cwd ?? "."
      const persistedSession = readSession(pipelineSessionId_, projectCwd)
      if (persistedSession) {
        pipelineBudgetLimits = persistedSession.budgetLimits
        pipelineBudgetTracker = createBudgetTracker({
          sessionId: pipelineSessionId_,
          baseDir: projectCwd,
        })
        activeBudgetTracker = pipelineBudgetTracker
      }
    }

    // Create question wiring for pipeline gates (DRY: extracted to createQuestionWiring)
    cleanupQuestionSubscriptions()
    const questionWiring = createQuestionWiring({
      eventBus: session.eventBus,
      onQuestion: (q) => setPendingQuestion(q),
      onClear: () => setPendingQuestion(null),
    })
    activeQuestionWiring = questionWiring
    const questionService = questionWiring.service

    // Pipeline stage indicator subscriptions
    cleanupPipelineSubscriptions()
    pipelineUnsubs.push(
      session.eventBus.subscribeToType("pipeline:started", (e) => {
        setActivePipelineInfo({
          stage: 1,
          total: e.stages.length,
          stageName: e.stages[0],
        })
        setActiveWorkflowName(e.stages[0])
      }),
      session.eventBus.subscribeToType("pipeline:stage-transition", (e) => {
        setActivePipelineInfo((prev) => prev ? {
          stage: prev.stage + 1,
          total: prev.total,
          stageName: e.to,
        } : null)
        setActiveWorkflowName(e.to)
      }),
      session.eventBus.subscribeToType("pipeline:completed", () => {
        setActivePipelineInfo(null)
        setActiveSprintInfo(null)
        // Final flush on pipeline completion
        if (activeFlusher) {
          activeFlusher.schedule()
          activeFlusher.flush().catch(() => {})
        }
      }),
      session.eventBus.subscribeToType("pipeline:failed", () => {
        setActivePipelineInfo(null)
        setActiveSprintInfo(null)
      }),
      // Event-driven flush: persist output after each phase completes
      session.eventBus.subscribeToType("phase:completed", () => {
        if (activeFlusher) {
          activeFlusher.schedule()
        }
      }),
      // Sprint iteration tracking for telemetry bar
      session.eventBus.subscribeToType("sprint:started", (e) => {
        setActiveSprintInfo({ iteration: 0, maxIterations: e.maxIterations })
      }),
      session.eventBus.subscribeToType("sprint:iteration-started", (e) => {
        setActiveSprintInfo({ iteration: e.iteration, maxIterations: e.maxIterations })
      }),
      session.eventBus.subscribeToType("sprint:completed", () => {
        setActiveSprintInfo(null)
      }),
      session.eventBus.subscribeToType("sprint:escalated", () => {
        setActiveSprintInfo(null)
      }),
    )

    // Shared context indexer (one per project_cwd, lazy-init)
    const pipelineContextIndexer = getOrCreateContextIndexer()

    const capturedSessionId = persistedSessionId
    const capturedProjectCwd = deps.config.project_cwd ?? "."
    const pipelineSessionId = persistedSessionId
    _isPipelineRunning = true
    _userInitiatedPause = false

    // Capture local references for the async closure — these survive backgrounding
    // (backgrounding nulls the shell-level `let` refs but the closure keeps its own)
    const capturedFlusher = activeFlusher

    queueMicrotask(async () => {
      // Check if this session is still the one the user is viewing.
      // If backgrounded, we should persist state but NOT force UI transitions.
      const isStillViewed = () => viewedSessionId() === pipelineSessionId

      // Start context indexing (shared — only runs once, subsequent calls are no-ops)
      if (!_indexerStarted) {
        try {
          await pipelineContextIndexer.startIndexing()
          _indexerStarted = true
        } catch { /* silently fall back to empty context */ }
      }

      // Prune old subprocess log directories (best-effort, fire-and-forget)
      const pipelineLogBaseDir = deps.config.project_cwd ?? process.cwd()
      try { SubprocessLogger.cleanup(pipelineLogBaseDir) } catch { /* best-effort */ }

      // Track current workflowId for dispatcher/evaluator output events.
      // Updated by workflow:started events; closures below capture this mutable reference.
      let currentWorkflowId = "unknown"
      const workflowIdUnsub = session.eventBus.subscribeToType("workflow:started", (ev) => {
        currentWorkflowId = ev.workflowId
      })
      pipelineUnsubs.push(workflowIdUnsub)

      const pipelineEngineName = deps.config.engine

      // Auto-detect dispatcher transport (engine-aware: claude → CLI, opencode → SDK then CLI).
      let dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined
      try {
        const { resolveModels } = await import("../../config/loader")
        const { dispatcherModel } = resolveModels(deps.config)
        const resolved = await autoDetectTransport({
          spawner: deps.spawner,
          engineName: deps.config.engine,
          dispatcherModel,
          onStdout: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: currentWorkflowId, stream: "stdout", data: chunk, engineName: pipelineEngineName, timestamp: Date.now() }),
          onStderr: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: currentWorkflowId, stream: "stderr", data: chunk, engineName: pipelineEngineName, timestamp: Date.now() }),
          logBaseDir: pipelineLogBaseDir,
        })
        dispatcherTransport = resolved.transport
        log.info("dispatcher transport resolved", { label: resolved.label, engine: deps.config.engine })
      } catch (err) {
        log.warn("dispatcher transport auto-detect failed, phases will use static prompt builder", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Create engine-aware evaluator transport (same engine/model config as dispatcher).
      // Uses SdkSpawner when available for OpenCode (shared singleton with dispatcher).
      let evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined
      if (!deps.config.skip_evaluation) {
        try {
          const { resolveModels: resolveModelsForEval } = await import("../../config/loader")
          const { dispatcherModel: evalModel } = resolveModelsForEval(deps.config)
          evaluatorTransport = await createEvaluatorTransport({
            spawner: deps.spawner,
            engineName: deps.config.engine,
            evaluatorModel: evalModel,
            onStdout: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: currentWorkflowId, stream: "stdout", data: chunk, engineName: pipelineEngineName, timestamp: Date.now() }),
            onStderr: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: currentWorkflowId, stream: "stderr", data: chunk, engineName: pipelineEngineName, timestamp: Date.now() }),
            logBaseDir: pipelineLogBaseDir,
          })
          log.info("evaluator transport created", { engine: deps.config.engine })
        } catch (err) {
          log.warn("evaluator transport creation failed, evaluation will be skipped", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Create stage runner — unified path for all workflow types, dispatcher always wired.
      const stageRunner = createShellStageRunner({
        session,
        deps,
        questionService,
        interactiveOverrides,
        budgetTracker: pipelineBudgetTracker ?? undefined,
        budgetLimits: pipelineBudgetLimits ?? undefined,
        onLoopCreated: (loop: ExecutionLoop) => { activeLoop = loop },
        contextIndexer: pipelineContextIndexer,
        dispatcherTransport,
        evaluatorTransport,
        // onSessionName: update persisted session + refresh sidebar when dispatcher returns a name
        onSessionName: capturedSessionId ? (name: string) => {
          try {
            updateSession(capturedSessionId, { name, label: name }, capturedProjectCwd)
            sessionCtx.refreshList()
          } catch { /* best-effort */ }
        } : undefined,
        logBaseDir: pipelineLogBaseDir,
      })

      // Create pipeline now that stageRunner is ready
      const projectCwd = deps.config.project_cwd || process.cwd()
      const endOfSessionGate = createEndOfSessionGate(deps.config, projectCwd)
      const pipeline = new WorkflowPipeline({
        stages,
        args,
        config: deps.config,
        stageRunner,
        questionService,
        eventBus: session.eventBus,
        endOfSessionGate,
      })
      activePipeline = pipeline

      // Register pipeline in sessionControllers (uniform shutdown interface)
      if (pipelineSessionId) {
        sessionControllers.set(pipelineSessionId, {
          shutdown: async () => { pipeline.requestShutdown() },
        })
        setViewedSessionId(pipelineSessionId)

        // Register in runtimes manager
        runtimes.register(pipelineSessionId, {
          kind: "running" as const,
          sessionId: pipelineSessionId,
          session,
          controller: null,
          loop: null as any, // Set via onLoopCreated callback
          pipeline,
          flusher: activeFlusher!,
          budgetTracker: pipelineBudgetTracker!,
          storeUnsub: storeUnsub!,
          questionCleanup: () => cleanupQuestionSubscriptions(),
          pipelineCleanup: () => cleanupPipelineSubscriptions(),
          contextIndexer: pipelineContextIndexer,
          workerPid: null,
        })
        setFocusedSessionId(pipelineSessionId)
      }

      let pipelineResult: import("../../controller/workflow-pipeline").PipelineResult | undefined
      try {
        pipelineResult = await pipeline.run()
        if (!pipelineResult.completed && !_userInitiatedPause) {
          const isRateLimitPause = /rate limit/i.test(pipelineResult.reason ?? "")

          if (isRateLimitPause) {
            // Rate limit exhaustion: show toast warning, skip ErrorModal
            toast.show({
              message: "Workflow paused — rate limit reached. Resume when limits lift.",
              variant: "warning",
              duration: 5000,
            })
          } else {
            activeStore()?.setError(pipelineResult.reason ?? "Pipeline failed")
          }

          // Persist lifecycle state as work:paused (failure ≠ completed)
          // Uses safeUpdateState to handle sessions stuck in intermediate states
          // (e.g., "new" when startup transitions failed)
          if (pipelineSessionId) {
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              pipelineSessionId,
              "work:paused",
            )
            sessionCtx.refreshList()
          }
          if (isStillViewed()) setAppState("completed")
        }
      } catch (err) {
        if (!_userInitiatedPause) {
          activeStore()?.setError(String(err))
          // Persist lifecycle state as work:paused (crash ≠ completed)
          // Uses safeUpdateState to handle sessions stuck in intermediate states
          // (e.g., "new" when startup transitions failed)
          if (pipelineSessionId) {
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              pipelineSessionId,
              "work:paused",
            )
            sessionCtx.refreshList()
          }
          if (isStillViewed()) setAppState("completed")
        }
      } finally {
        _isPipelineRunning = false

        // Note: shared context indexer is NOT disposed per-pipeline.
        // It stays alive for the shell's lifetime and is disposed in onCleanup.

        // Dispose budget tracker (flushes pending cost/usage data to session file)
        if (pipelineBudgetTracker) {
          pipelineBudgetTracker.dispose()
          if (activeBudgetTracker === pipelineBudgetTracker) {
            activeBudgetTracker = null
          }
        }

        // Remove from sessionControllers and runtimes on completion
        // (keep in sessionStores for cached viewing).
        // Use remove() (not teardown()) — pipeline resources are already cleaned up.
        if (pipelineSessionId) {
          sessionControllers.delete(pipelineSessionId)
          runtimes.remove(pipelineSessionId)
        }

        // Handle auto-archive or completion — errors must stay in the output
        // pane, never leak to stderr where they overlay the TUI chrome.
        if (pipelineResult && !_userInitiatedPause) {
          try {
            await handlePipelineCompletion(pipelineResult, {
              orchestrator,
              sessionId: pipelineSessionId ?? null,
              flusher: capturedFlusher,
              toast,
              updateState: (id, s) => sessionCtx.manager.updateState(id, s),
              refreshList: () => sessionCtx.refreshList(),
            })
          } catch (completionErr) {
            log.error("pipeline completion failed", { error: completionErr instanceof Error ? completionErr : String(completionErr) })
          }
        }
      }
    })
  }

  /**
   * Start queue-based execution. Creates a new session, builds the queue,
   * wires events, and runs the step executor.
   *
   * This is the queue-based replacement for startPipeline().
   * VAL-SHELL-013: Shell transitions idle→working on queue start
   * VAL-SHELL-014: Shell transitions working→completed on queue success
   * VAL-SHELL-015: Shell transitions working→completed on queue failure
   * VAL-SHELL-019: Session created when queue starts
   * VAL-SHELL-020: Session lifecycle follows queue progression
   * VAL-SHELL-035: Output blocks render during step execution
   */
  const startQueueExecution = (
    queue: Queue,
    args: Record<string, string>,
    preloadedDeps?: WorkflowDeps,
    interactiveOverrides?: { plan?: boolean; review?: boolean },
  ) => {
    // Background previous session (don't destroy — allow concurrent pipelines)
    const prevFocused = focusedSessionId()
    if (prevFocused && runtimes.has(prevFocused)) {
      runtimes.background(prevFocused)
      activeSession = null
      activeLoop = null
      activePipeline = null
      activeStepExecutor = null
      activeQueue = null
      activeFlusher = null
      activeBudgetTracker = null
      if (storeUnsub) {
        storeUnsub()
        storeUnsub = null
      }
      cleanupQuestionSubscriptions()
      cleanupPipelineSubscriptions()
      setActiveStore(null)
      setWorkState(null)
    } else if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeLoop = null
      activePipeline = null
      activeStepExecutor = null
      activeQueue = null
      if (activeFlusher) {
        activeFlusher.dispose()
        activeFlusher = null
      }
      if (activeBudgetTracker) {
        activeBudgetTracker.dispose()
        activeBudgetTracker = null
      }
      setActiveStore(null)
      setWorkState(null)
    }

    // Create fresh session
    const sessionLabel = queue.steps.map((s) => s.type).join(" → ")
    const session = createWorkflowSession(sessionLabel)
    activeSession = session
    activeQueue = queue
    setActiveStore(session.store)
    subscribeToStore(session.store)
    subscribeToTimer(session.timer)
    setAppState("working")

    // Config loaded once at queue start
    let deps: WorkflowDeps
    if (preloadedDeps) {
      deps = preloadedDeps
    } else {
      const resolved = getDepsOrReturnIdle()
      if (!resolved) return
      deps = resolved
    }

    // Create persistent Session for pause/resume support
    const planPathForSession = args.planPath ?? sessionLabel
    const placeholderName = args.description || args.topic || undefined
    let persistedSessionId: string | null = null
    try {
      persistedSessionId = sessionCtx.manager.create(planPathForSession, placeholderName)

      const projectCwd = deps.config.project_cwd ?? "."
      updateSession(persistedSessionId, { outputPath: `${persistedSessionId}.output.json` }, projectCwd)

      // Transition to work:active
      sessionCtx.manager.updateState(persistedSessionId, "plan:imported")
      sessionCtx.manager.updateState(persistedSessionId, "plan:approved")
      sessionCtx.manager.updateState(persistedSessionId, "work:active")

      // Start output flusher
      const persistence = createOutputPersistence({
        sessionId: persistedSessionId,
        baseDir: projectCwd,
      })
      const sessionStore = session.store
      const getOutputBlocks = () => (sessionStore.getState().outputBlocks ?? []) as unknown as { kind: string; [key: string]: unknown }[]
      activeFlusher = persistence.createFlusher(getOutputBlocks, { intervalMs: 5000 })

      sessionStores.set(persistedSessionId, session.store)
      sessionCtx.refreshList()
    } catch (err) {
      toast.show({
        message: `Session persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    // Create BudgetTracker
    let queueBudgetTracker: BudgetTracker | null = null
    let queueBudgetLimits: import("../../schemas/shared").BudgetLimits | null = null
    if (persistedSessionId) {
      const projectCwd = deps.config.project_cwd ?? "."
      const persistedSession = readSession(persistedSessionId, projectCwd)
      if (persistedSession) {
        queueBudgetLimits = persistedSession.budgetLimits
        queueBudgetTracker = createBudgetTracker({
          sessionId: persistedSessionId,
          baseDir: projectCwd,
        })
        activeBudgetTracker = queueBudgetTracker
      }
    }

    // Question wiring
    cleanupQuestionSubscriptions()
    const questionWiring = createQuestionWiring({
      eventBus: session.eventBus,
      onQuestion: (q) => setPendingQuestion(q),
      onClear: () => setPendingQuestion(null),
    })
    activeQuestionWiring = questionWiring

    // Queue event subscriptions (replaces pipeline event subscriptions)
    cleanupPipelineSubscriptions()
    let stepCounter = 0
    pipelineUnsubs.push(
      session.eventBus.subscribeToType("queue:initialized", (e) => {
        stepCounter = 0
        setActiveQueueInfo({
          currentStep: 1,
          totalSteps: e.stepIds.length,
          stepName: queue.steps[0]?.type ?? "step",
        })
        setActiveWorkflowName(queue.steps[0]?.type ?? "work")
      }),
      session.eventBus.subscribeToType("queue:step-started", (e) => {
        stepCounter++
        setActiveQueueInfo({
          currentStep: stepCounter,
          totalSteps: queue.steps.length,
          stepName: e.stepType,
        })
        setActiveWorkflowName(e.stepType)
      }),
      session.eventBus.subscribeToType("queue:completed", () => {
        setActiveQueueInfo(null)
        setActiveSprintInfo(null)
        // Final flush on queue completion
        if (activeFlusher) {
          activeFlusher.schedule()
          activeFlusher.flush().catch(() => {})
        }
      }),
      session.eventBus.subscribeToType("queue:failed", () => {
        setActiveQueueInfo(null)
        setActiveSprintInfo(null)
      }),
      // Event-driven flush: persist output after each step completes
      session.eventBus.subscribeToType("queue:step-completed", () => {
        if (activeFlusher) {
          activeFlusher.schedule()
        }
      }),
      // Sprint iteration tracking for telemetry bar
      session.eventBus.subscribeToType("sprint:started", (e) => {
        setActiveSprintInfo({ iteration: 0, maxIterations: e.maxIterations })
      }),
      session.eventBus.subscribeToType("sprint:iteration-started", (e) => {
        setActiveSprintInfo({ iteration: e.iteration, maxIterations: e.maxIterations })
      }),
      session.eventBus.subscribeToType("sprint:completed", () => {
        setActiveSprintInfo(null)
      }),
      session.eventBus.subscribeToType("sprint:escalated", () => {
        setActiveSprintInfo(null)
      }),
    )

    // Shared context indexer
    const queueContextIndexer = getOrCreateContextIndexer()

    const capturedSessionId = persistedSessionId
    const capturedProjectCwd = deps.config.project_cwd ?? "."
    const queueSessionId = persistedSessionId
    _isPipelineRunning = true
    _userInitiatedPause = false

    const capturedFlusher = activeFlusher

    // Register in runtimes and sessionControllers BEFORE the async execution starts
    if (queueSessionId) {
      setViewedSessionId(queueSessionId)
      setFocusedSessionId(queueSessionId)
    }

    queueMicrotask(async () => {
      const isStillViewed = () => viewedSessionId() === queueSessionId

      // Start context indexing
      if (!_indexerStarted) {
        try {
          await queueContextIndexer.startIndexing()
          _indexerStarted = true
        } catch { /* silently fall back to empty context */ }
      }

      // Prune old subprocess log dirs
      const queueLogBaseDir = deps.config.project_cwd ?? process.cwd()
      try { SubprocessLogger.cleanup(queueLogBaseDir) } catch { /* best-effort */ }

      // Track current workflowId
      let currentWorkflowId = `queue-${queueSessionId ?? "unknown"}`
      const workflowIdUnsub = session.eventBus.subscribeToType("workflow:started", (ev) => {
        currentWorkflowId = ev.workflowId
      })
      pipelineUnsubs.push(workflowIdUnsub)

      const queueEngineName = deps.config.engine

      // Auto-detect dispatcher transport
      let dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined
      try {
        const { resolveModels } = await import("../../config/loader")
        const { dispatcherModel } = resolveModels(deps.config)
        const resolved = await autoDetectTransport({
          spawner: deps.spawner,
          engineName: deps.config.engine,
          dispatcherModel,
          onStdout: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: currentWorkflowId, stream: "stdout", data: chunk, engineName: queueEngineName, timestamp: Date.now() }),
          onStderr: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: currentWorkflowId, stream: "stderr", data: chunk, engineName: queueEngineName, timestamp: Date.now() }),
          logBaseDir: queueLogBaseDir,
        })
        dispatcherTransport = resolved.transport
        log.info("queue dispatcher transport resolved", { label: resolved.label, engine: deps.config.engine })
      } catch (err) {
        log.warn("queue dispatcher transport auto-detect failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }

      // Create evaluator transport
      let evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined
      if (!deps.config.skip_evaluation) {
        try {
          const { resolveModels: resolveModelsForEval } = await import("../../config/loader")
          const { dispatcherModel: evalModel } = resolveModelsForEval(deps.config)
          evaluatorTransport = await createEvaluatorTransport({
            spawner: deps.spawner,
            engineName: deps.config.engine,
            evaluatorModel: evalModel,
            onStdout: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: currentWorkflowId, stream: "stdout", data: chunk, engineName: queueEngineName, timestamp: Date.now() }),
            onStderr: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: currentWorkflowId, stream: "stderr", data: chunk, engineName: queueEngineName, timestamp: Date.now() }),
            logBaseDir: queueLogBaseDir,
          })
          log.info("queue evaluator transport created", { engine: deps.config.engine })
        } catch (err) {
          log.warn("queue evaluator transport creation failed", {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Create stage runner for backward compatibility — step executor delegates to
      // createStageLoop for each step, which is what the shell stage runner does.
      const emitter = createFlywheelEmitter(session.eventBus)

      // Create step executor with real dependencies
      // Note: For this feature, we wire the step executor with stub functions
      // that delegate to the existing stage loop infrastructure. The full
      // integration (dispatcher → worker → evaluator per step) is already
      // implemented in the step executor. Here we create the executor with
      // the queue and wire it into the session.
      const stepExec = createStepExecutor({
        queue,
        workflowId: currentWorkflowId,
        emitter,
        dispatcher: async (step, context) => {
          // Stub dispatcher — real integration uses dispatcher transport
          return { prompt: `Execute ${step.type}: ${step.title}`, validationCriteria: null }
        },
        worker: async (step, prompt) => {
          // Delegate to createStageLoop for the actual execution
          const handle = createStageLoop({
            workflow: step.type as any,
            args: { ...args },
            config: deps.config,
            spawner: deps.spawner,
            engine: deps.engine,
            ui: session.adapter,
            eventBus: session.eventBus,
            budgetTracker: queueBudgetTracker ?? undefined,
            budgetLimits: queueBudgetLimits ?? undefined,
            contextIndexer: queueContextIndexer,
            dispatcherTransport,
            evaluatorTransport,
            onSessionName: capturedSessionId ? (name: string) => {
              try {
                updateSession(capturedSessionId, { name, label: name }, capturedProjectCwd)
                sessionCtx.refreshList()
              } catch { /* best-effort */ }
            } : undefined,
            logBaseDir: queueLogBaseDir,
          })

          activeLoop = handle.loop

          const result = await handle.loop.run()
          return {
            output: result.completed ? "completed" : (result.reason ?? "failed"),
            handoffPath: "",
            durationMs: 0,
          }
        },
        evaluator: null, // Evaluator is handled within createStageLoop
        handoffReader: async () => null,
        budgetChecker: queueBudgetTracker && queueBudgetLimits
          ? { isExhausted: () => queueBudgetTracker!.isExhausted(queueBudgetLimits!) }
          : { isExhausted: () => false },
        persist: async (q) => {
          // Queue persistence
          if (queueSessionId && deps.config.queue?.persist_queue !== false) {
            try {
              const queuePersistence = createQueuePersistence({
                sessionId: queueSessionId,
                baseDir: capturedProjectCwd,
              })
              await queuePersistence.save(q)
            } catch { /* best-effort */ }
          }
        },
        accumulator: {
          accumulate: () => {},
          getContext: () => ({}),
        },
        maxRevisions: 0, // Revisions handled within createStageLoop
      })

      activeStepExecutor = stepExec

      // Register in sessionControllers
      if (queueSessionId) {
        sessionControllers.set(queueSessionId, {
          shutdown: async () => { stepExec.requestShutdown() },
        })

        runtimes.register(queueSessionId, {
          kind: "running" as const,
          sessionId: queueSessionId,
          session,
          controller: null,
          loop: null as any,
          pipeline: null as any,
          flusher: activeFlusher!,
          budgetTracker: queueBudgetTracker!,
          storeUnsub: storeUnsub!,
          questionCleanup: () => cleanupQuestionSubscriptions(),
          pipelineCleanup: () => cleanupPipelineSubscriptions(),
          contextIndexer: queueContextIndexer,
          workerPid: null,
          stepExecutor: stepExec,
          queue,
        })
      }

      let queueResult: StepExecutorResult | undefined
      try {
        queueResult = await stepExec.run()

        if (!queueResult.completed && !_userInitiatedPause) {
          const isRateLimitPause = /rate limit/i.test(queueResult.reason ?? "")
          if (isRateLimitPause) {
            toast.show({
              message: "Queue paused — rate limit reached. Resume when limits lift.",
              variant: "warning",
              duration: 5000,
            })
          } else {
            activeStore()?.setError(queueResult.reason ?? "Queue execution failed")
          }

          if (queueSessionId) {
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              queueSessionId,
              "work:paused",
            )
            sessionCtx.refreshList()
          }
          if (isStillViewed()) setAppState("completed")
        }
      } catch (err) {
        if (!_userInitiatedPause) {
          activeStore()?.setError(String(err))
          if (queueSessionId) {
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              queueSessionId,
              "work:paused",
            )
            sessionCtx.refreshList()
          }
          if (isStillViewed()) setAppState("completed")
        }
      } finally {
        _isPipelineRunning = false

        if (queueBudgetTracker) {
          queueBudgetTracker.dispose()
          if (activeBudgetTracker === queueBudgetTracker) {
            activeBudgetTracker = null
          }
        }

        if (queueSessionId) {
          sessionControllers.delete(queueSessionId)
          runtimes.remove(queueSessionId)
        }

        // Handle completion
        if (queueResult && !_userInitiatedPause) {
          try {
            // Convert queue result to pipeline result format for handlePipelineCompletion
            const pipelineResultCompat: import("../../controller/workflow-pipeline").PipelineResult = {
              completed: queueResult.completed,
              stagesCompleted: queueResult.stepsCompleted,
              stagesTotal: queueResult.stepsTotal,
              reason: queueResult.reason,
              stageResults: queue.steps
                .filter((s) => s.status === "completed")
                .map((s) => ({
                  workflow: s.type as any,
                  completed: true,
                })),
            }
            await handlePipelineCompletion(pipelineResultCompat, {
              orchestrator,
              sessionId: queueSessionId ?? null,
              flusher: capturedFlusher,
              toast,
              updateState: (id, s) => sessionCtx.manager.updateState(id, s),
              refreshList: () => sessionCtx.refreshList(),
            })
          } catch (completionErr) {
            log.error("queue completion failed", { error: completionErr instanceof Error ? completionErr : String(completionErr) })
          }
        }
      }
    })
  }

  const cleanupQuestionSubscriptions = () => {
    if (activeQuestionWiring) {
      activeQuestionWiring.cleanup()
      activeQuestionWiring = null
    }
    setPendingQuestion(null)
  }

  const cleanupPipelineSubscriptions = () => {
    for (const unsub of pipelineUnsubs) unsub()
    pipelineUnsubs = []
    setActivePipelineInfo(null)
    setActiveQueueInfo(null)
    _isPipelineRunning = false
  }

  /**
   * Shut down pipeline/loop/controller runtime without touching
   * session, store, adapter, or subscriptions.
   *
   * Used by both teardownActiveWorkflow() (full cleanup) and
   * pausePipeline() (partial cleanup — keeps store/adapter alive).
   */
  const _clearPipelineRuntime = (): Promise<void> | undefined => {
    if (activePipeline) {
      activePipeline.requestShutdown()
      activePipeline = null
    }
    if (activeStepExecutor) {
      activeStepExecutor.requestShutdown()
      activeStepExecutor = null
    }
    activeQueue = null
    if (activeLoop) {
      activeLoop.requestShutdown()
      activeLoop = null
    }
    // Kill all active worker processes (fire-and-forget)
    const shutdownPromise = killAllActiveProcesses().catch(() => {})
    return shutdownPromise
  }

  const teardownActiveWorkflow = (): Promise<void> | undefined => {
    cleanupQuestionSubscriptions()
    cleanupPipelineSubscriptions()
    unsubscribeTimer()
    if (storeUnsub) {
      storeUnsub()
      storeUnsub = null
    }
    // Dispose output flusher (does NOT flush — just cancels timers)
    if (activeFlusher) {
      activeFlusher.dispose()
      activeFlusher = null
    }
    // Dispose budget tracker (flushes pending data, cancels timers)
    if (activeBudgetTracker) {
      activeBudgetTracker.dispose()
      activeBudgetTracker = null
    }
    const shutdownPromise = _clearPipelineRuntime()
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)
    // Note: we do NOT clear workState here so completed view can still show output
    return shutdownPromise
  }

  const stopWorkflow = async () => {
    escapeHandler.reset()
    setEscHint("")

    // Capture session ID before teardown clears it
    const sessionId = focusedSessionId()

    await teardownActiveWorkflow()

    // Remove from sessionControllers so sidebar shows "Paused" not "Active"
    if (sessionId) {
      runtimes.teardown(sessionId)
      sessionControllers.delete(sessionId)
    }

    // Persist lifecycle state as work:paused (manual stop ≠ completed)
    if (sessionId) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch (stateErr) {
        // Session may already be in a terminal state
        log.warn("state transition failed (stop)", { session: sessionId, error: stateErr instanceof Error ? stateErr : String(stateErr) })
      }
      sessionCtx.refreshList()
    }

    setAppState("completed")
  }

  /**
   * Pause the pipeline (user-initiated via double-Esc).
   *
   * Unlike stopWorkflow(), this does NOT fully tear down the session:
   * - Sets suppressPipelineError on the adapter so pipeline:failed doesn't trigger ErrorModal
   * - Requests pipeline shutdown (which internally fires pipeline:failed)
   * - Persists session state as work:paused (if a persistent session exists)
   * - Pushes a pause system message to output
   * - Transitions app state to "completed" (keeps output visible)
   */
  const pausePipeline = async () => {
    _userInitiatedPause = true
    escapeHandler.reset()
    setEscHint("")

    // Suppress ErrorModal from the pipeline:failed event that shutdown triggers
    if (activeSession?.adapter) {
      activeSession.adapter.suppressPipelineError = true
    }

    // Flush output BEFORE shutting down runtime (data must be persisted first)
    if (activeFlusher) {
      try {
        activeFlusher.schedule()
        await activeFlusher.flush()
      } catch {
        // Best effort — don't block pause on flush failure
      }
      activeFlusher.dispose()
      activeFlusher = null
    }

    // Flush and dispose budget tracker (persists final cost/usage data)
    if (activeBudgetTracker) {
      activeBudgetTracker.dispose()
      activeBudgetTracker = null
    }

    // Shut down pipeline, loop, and controller (but NOT session/adapter/store)
    _clearPipelineRuntime()

    // Persist session state as work:paused and remove from sessionControllers
    // so the sidebar groups them as "Paused" instead of "Active".
    const runningSessionIds = [...sessionControllers.keys()]
    for (const sessionId of runningSessionIds) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch (err) {
        log.warn("state transition failed (pause)", { session: sessionId, error: err instanceof Error ? err : String(err) })
      }
      sessionControllers.delete(sessionId)
    }
    if (runningSessionIds.length > 0) {
      sessionCtx.refreshList()
    }

    // Push pause message through the event bus
    if (activeSession) {
      activeSession.eventBus.emit({
        type: "worker:output",
        workflowId: "pipeline-pause",
        stream: "stderr",
        data: "⏸ Pipeline paused. Resume with /work or select from session sidebar.\n",
        timestamp: new Date().toISOString(),
      })
    }

    // Transition to completed (keeps output visible, enables /work to restart)
    setAppState("completed")
  }

  /**
   * Resume a previously paused session.
   *
   * Unlike startPipeline(), this does NOT create a new Session on disk
   * or a new WorkflowSession from scratch. Instead, it:
   *
   * 1. Tears down any active workflow
   * 2. Loads session data + output blocks via orchestrator
   * 3. Creates fresh WorkflowSession (store/adapter/eventBus)
   * 4. Injects restored output blocks in chunks
   * 5. Transitions session from work:paused → work:active
   * 6. Starts WorkController (which reads .state.md and skips completed phases)
   * 7. Transitions shell to "working"
   */
  const resumeSession = async (sessionId: string) => {
    // 1. Clean up any current workflow
    if (activeSession) {
      teardownActiveWorkflow()
    }

    // 2. Get session data + output from orchestrator
    const result = await orchestrator.handleResumeSession(sessionId)
    if (!result) {
      toast.show({ message: "Session not found or corrupt", variant: "error" })
      return
    }

    // 3. Load workflow deps (config, engine, spawner)
    const deps = getDepsOrWarn()
    if (!deps) {
      toast.show({ message: "Failed to load config for resume", variant: "error" })
      return
    }

    // 4. Create fresh workflow session (store → adapter → eventBus)
    const session = createWorkflowSession(result.planPath)
    activeSession = session
    setActiveStore(session.store)
    subscribeToStore(session.store)
    subscribeToTimer(session.timer)

    // 5. Inject output blocks in chunks (prevents UI freeze on large histories)
    injectOutputBlocks(session.store, snapshotToBlocks(result.outputBlocks) as AnyBlock[])

    // 6. Wire focused session (reuse existing session ID — no new Session)
    setFocusedSessionId(sessionId)

    // 7. Transition session state: work:paused → work:active
    try {
      sessionCtx.manager.updateState(sessionId, "work:active")
      sessionCtx.refreshList()
    } catch (err) {
      toast.show({
        message: `Failed to update session state: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    // 8. Start output flusher — captures session's own store directly (NOT activeStore() signal)
    const projectCwd = deps.config.project_cwd ?? "."
    const persistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
    const resumedStore = session.store
    activeFlusher = persistence.createFlusher(
      () => (resumedStore.getState().outputBlocks ?? []) as unknown as { kind: string; [key: string]: unknown }[],
      { intervalMs: 5000 },
    )

    // 9. Register in session maps
    sessionStores.set(sessionId, session.store)

    // 10. Create a stage loop for the "work" workflow (reads .state.md, skips completed phases).
    //     We do NOT call startPipeline() because that creates a new Session
    //     and tears down the session we just set up.
    setViewedSessionId(sessionId)
    setAppState("working")

    queueMicrotask(async () => {
      // Track current workflowId for dispatcher/evaluator output events.
      let resumeCurrentWorkflowId = "unknown"
      const resumeWorkflowIdUnsub = session.eventBus.subscribeToType("workflow:started", (ev) => {
        resumeCurrentWorkflowId = ev.workflowId
      })
      const resumeEngineName = deps.config.engine

      // Auto-detect dispatcher transport for the resumed session (engine-aware)
      let dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined
      try {
        const { resolveModels } = await import("../../config/loader")
        const { dispatcherModel } = resolveModels(deps.config)
        const resolved = await autoDetectTransport({
          spawner: deps.spawner,
          engineName: deps.config.engine,
          dispatcherModel,
          onStdout: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: resumeCurrentWorkflowId, stream: "stdout", data: chunk, engineName: resumeEngineName, timestamp: Date.now() }),
          onStderr: (chunk) => session.eventBus.emit({ type: "dispatcher:output", workflowId: resumeCurrentWorkflowId, stream: "stderr", data: chunk, engineName: resumeEngineName, timestamp: Date.now() }),
          logBaseDir: deps.config.project_cwd ?? process.cwd(),
        })
        dispatcherTransport = resolved.transport
      } catch { /* fallback to static prompts */ }

      // Create engine-aware evaluator transport for the resumed session.
      // Uses SdkSpawner when available for OpenCode (shared singleton with dispatcher).
      let resumeEvaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined
      if (!deps.config.skip_evaluation) {
        try {
          const { resolveModels: resolveModelsForEval } = await import("../../config/loader")
          const { dispatcherModel: evalModel } = resolveModelsForEval(deps.config)
          resumeEvaluatorTransport = await createEvaluatorTransport({
            spawner: deps.spawner,
            engineName: deps.config.engine,
            evaluatorModel: evalModel,
            onStdout: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: resumeCurrentWorkflowId, stream: "stdout", data: chunk, engineName: resumeEngineName, timestamp: Date.now() }),
            onStderr: (chunk) => session.eventBus.emit({ type: "evaluator:output", workflowId: resumeCurrentWorkflowId, stream: "stderr", data: chunk, engineName: resumeEngineName, timestamp: Date.now() }),
            logBaseDir: deps.config.project_cwd ?? process.cwd(),
          })
        } catch { /* evaluation will be skipped */ }
      }

      try {
        const handle = createStageLoop({
          workflow: "work",
          args: { planPath: result.planPath },
          config: deps.config,
          spawner: deps.spawner,
          engine: deps.engine,
          ui: session.adapter,
          eventBus: session.eventBus,
          dispatcherTransport,
          evaluatorTransport: resumeEvaluatorTransport,
          logBaseDir: deps.config.project_cwd ?? process.cwd(),
        })
        activeLoop = handle.loop

        // Register in sessionControllers for shutdown
        sessionControllers.set(sessionId, {
          shutdown: () => { handle.shutdown(); return killAllActiveProcesses() },
        })

        const execResult = await handle.loop.run()
        sessionControllers.delete(sessionId)
      } catch {
        sessionControllers.delete(sessionId)
      } finally {
        resumeWorkflowIdUnsub()
      }
    })
  }

  /**
   * Handle session selection from the sidebar.
   * Routes to open (viewport switch) or delete.
   */
  /** Look up a session's display name by ID (O(1) via memoized Map). */
  const sessionName = (id: string): string => {
    const s = sessionsMap().get(id)
    return s?.name || s?.label || id.slice(0, 8)
  }

  const handleSessionSelect = (sessionId: string, action: SelectionAction) => {
    switch (action) {
      case "open":
        viewport.openSession(sessionId)
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
        })
        return
    }
  }

  const returnToIdle = () => {
    teardownActiveWorkflow()
    viewport.cancelInjection()
    setSessionLoading(false)
    setViewedSessionId(null)
    setWorkState(null)
    setAppState("idle")
  }

  /**
   * Background the current session: deselect it from the viewport and return
   * to idle, but keep the pipeline/controller running. The session stays in
   * `sessionControllers` and can be re-opened from the sidebar.
   *
   * Unlike returnToIdle(), this does NOT tear down the workflow — the worker
   * process continues executing in the background.
   */
  const backgroundSession = () => {
    // Background in runtimes manager (pauses adapter flush)
    const currentFocused = focusedSessionId()
    if (currentFocused) {
      runtimes.background(currentFocused)
    }

    // Unsubscribe from the active store so we stop driving workState
    if (storeUnsub) {
      storeUnsub()
      storeUnsub = null
    }

    // Detach the live session references from the shell's "active" slots
    // without destroying them. The session, controller, pipeline, and flusher
    // continue to run — they're still tracked in sessionControllers/sessionStores.
    //
    // IMPORTANT: We null these refs so the shell doesn't try to interact with
    // them, but the pipeline's async closure captured its own local references.
    // The pipeline will clean up sessionControllers when it finishes.
    activeSession = null
    activeLoop = null
    activePipeline = null
    activeFlusher = null
    activeBudgetTracker = null

    // Clear question/pipeline UI subscriptions (the pipeline itself doesn't need
    // these signals to function — they only drive UI state like pendingQuestion).
    cleanupQuestionSubscriptions()
    cleanupPipelineSubscriptions()
    unsubscribeTimer()

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
    // Toggle sidebarFocused to trigger a focused prop change on the Prompt,
    // which forces the underlying input to regain focus after mode switch.
    setSidebarFocused(true)
    queueMicrotask(() => setSidebarFocused(false))
  }

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    teardownActiveWorkflow()
    runtimes.teardownAll()
    if (_sharedContextIndexer) {
      _sharedContextIndexer.dispose()
      _sharedContextIndexer = null
    }
  })

  // ── Command Handler (via ActionDispatcher) ──

  const launchWorkWithPipeline = (planPath: string) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    const queue = buildQueueForSlashCommand("work", deps.config)
    startQueueExecution(queue, { planPath }, deps)
  }

  const launchGenericWithPipeline = (name: string, args: Record<string, string>) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    const queue = buildQueueForSlashCommand(name, deps.config)
    startQueueExecution(queue, args, deps)
  }

  /**
   * /start flow: guided question wizard that collects a description and
   * pipeline mode, then starts the appropriate pipeline.
   *
   * Questions happen BEFORE the pipeline starts. Uses a temporary EventBus
   * + QuestionService to drive the existing QuestionPrompt component.
   */
  const launchStartFlow = async (args: Record<string, string>) => {
    // Create a temporary event bus + question wiring for pre-pipeline questions
    const startBus = new EventBus()
    cleanupQuestionSubscriptions()
    const startWiring = createQuestionWiring({
      eventBus: startBus,
      onQuestion: (q) => setPendingQuestion(q),
      onClear: () => setPendingQuestion(null),
    })
    activeQuestionWiring = startWiring
    const startQS = startWiring.service

    try {
      // Step 1: Get description (skip if already provided via /start <description>)
      let description = args.description ?? ""
      if (!description) {
        const descAnswers = await startQS.ask([{
          question: "What do you want to build?",
          header: "Description",
          options: [],
          textOnly: true,
        }])
        description = descAnswers[0]?.[0] ?? ""
        if (!description) {
          // User dismissed the question
          cleanupQuestionSubscriptions()
          return
        }
      }

      // Step 2: Pick pipeline mode
      const modeAnswers = await startQS.ask([{
        question: "How far should the pipeline go?",
        header: "Pipeline Mode",
        options: PIPELINE_MODE_OPTIONS.map((o) => ({
          label: o.label,
          description: o.description,
        })),
        custom: false,
        default: "Plan + Work + Review",
      }])
      const selectedLabel = modeAnswers[0]?.[0]
      if (!selectedLabel) {
        // User dismissed
        cleanupQuestionSubscriptions()
        return
      }

      // Map label back to PipelineMode value
      const selectedOption = PIPELINE_MODE_OPTIONS.find((o) => o.label === selectedLabel)
      const mode: PipelineMode = selectedOption?.value ?? "plan-work-review"

      // Step 2.5a: Consolidation preference (all modes include plan)
      const consolidationAnswers = await startQS.ask([{
        question: "Do you want to participate in plan consolidation?",
        header: "Consolidation",
        options: [
          { label: "Yes, let me review", description: "Review and consolidate the plan interactively (Recommended)" },
          { label: "No, handle automatically", description: "Auto-consolidate without prompts" },
        ],
        custom: false,
        default: "Yes, let me review",
      }])
      const consolidationLabel = consolidationAnswers[0]?.[0]
      if (!consolidationLabel) {
        cleanupQuestionSubscriptions()
        return
      }
      const planInteractive = consolidationLabel === "Yes, let me review"

      // Step 2.5b: Review triage preference (only if mode includes review)
      let reviewInteractive = false
      if (modeHasReview(mode)) {
        const triageAnswers = await startQS.ask([{
          question: "Do you want to triage review findings?",
          header: "Review Triage",
          options: [
            { label: "Yes, let me triage", description: "Review P3 findings interactively (Recommended)" },
            { label: "No, handle automatically", description: "Auto-resolve P3 findings" },
          ],
          custom: false,
          default: "Yes, let me triage",
        }])
        const triageLabel = triageAnswers[0]?.[0]
        if (!triageLabel) {
          cleanupQuestionSubscriptions()
          return
        }
        reviewInteractive = triageLabel === "Yes, let me triage"
      }

      // Clean up question subscriptions before starting pipeline
      // (pipeline will create its own QuestionService)
      cleanupQuestionSubscriptions()

      // Step 3: Build queue from workflow template and start execution
      const workflowNameMap: Record<PipelineMode, WorkflowName> = {
        "plan-only": "plan-only",
        "plan-work": "plan-work",
        "plan-work-review": "plan-work-review",
        "full": "full",
        "sprint": "sprint",
      }
      const startDeps = getDepsOrWarn()
      if (!startDeps) {
        cleanupQuestionSubscriptions()
        return
      }
      const workflowName = workflowNameMap[mode]
      const startFlowQueue = buildQueue(workflowName, startDeps.config)
      startQueueExecution(startFlowQueue, { description }, startDeps, {
        plan: planInteractive,
        review: reviewInteractive,
      })
    } catch {
      // QuestionRejectedError or other: user dismissed, clean up
      cleanupQuestionSubscriptions()
    }
  }

  const dispatch = createActionDispatcher({
    fileExists: (path) => fs.existsSync(path),
    notify: (message, variant) => {
      toast.show({
        message,
        variant: variant as "info" | "error" | "warning",
        ...(variant === "info" ? { duration: 8000 } : {}),
      })
    },
    launchWorkWorkflow: launchWorkWithPipeline,
    launchGenericWorkflow: launchGenericWithPipeline,
    launchStartFlow,
    exit: exitTUI,
    returnToIdle,
  })

  const handleCommand = (workflow: string, args: Record<string, string>) => {
    const meta = dispatch(workflow, args)
    if (meta) {
      setActiveStepLabel(meta.stepLabel)
      if (!_isPipelineRunning) {
        setActiveWorkflowName(meta.workflowName)
      }
    }
  }

  // ── Escape Handling ──

  const handleEscape = () => {
    const behavior = escapeForState(appState())
    switch (behavior) {
      case "exit-tui":
        if (runtimes.size > 0) {
          setShowQuitModal(true)
        } else {
          exitTUI()
        }
        return
      case "double-esc-stop": {
        const result = escapeHandler.handleEscape()
        if (result === "show-hint") {
          setEscHint("Press Esc again to stop")
          setTimeout(() => setEscHint(""), 5000)
        } else {
          setEscHint("")
          // During pipeline: pause instead of full stop
          if (_isPipelineRunning) {
            pausePipeline()
          } else {
            stopWorkflow()
          }
        }
        return
      }
      case "return-idle":
        returnToIdle()
        return
      case "cancel-import":
        setAppState("idle")
        return
    }
  }

  // ── Prompt input handling ──

  const handlePromptInput = (input: string) => {
    const currentAppState = appState()

    if (currentAppState === "idle" || currentAppState === "completed") {
      // Command mode: parse like the old LauncherView
      const trimmed = input.trim()
      if (!trimmed) return

      const result = parseCommand(trimmed)

      if (result === null) {
        // If it doesn't start with / and looks like a file path, treat as /work <path>
        if (!trimmed.startsWith("/") && (trimmed.includes(".") || trimmed.includes("/"))) {
          handleCommand("work", { planPath: trimmed })
          return
        }
        const message = trimmed.startsWith("/")
          ? `Unknown command: ${trimmed}. Try /work, /plan, /review, /ship`
          : `Commands start with /. Try /work ${trimmed}`
        toast.show({ message, variant: "error" })
        return
      }

      handleCommand(result.workflow, result.args)
      return
    }

    if (currentAppState === "working") {
      const state = workState()
      if (state?.approvalState?.pending) {
        // Active mode: approval handling (approve with optional steering prompt)
        if (activeSession) {
          activeSession.adapter.onApprovalDecision?.(true)
        }
        activeStore()?.clearApproval()
      } else if (input.trim()) {
        // Working mode without approval: inject text into the running worker's stdin
        const injected = activeLoop?.injectToWorker(input.trim()) ?? false
        if (injected) {
          log.info("injected message to worker", { length: input.trim().length })
          toast.show({ message: "Message sent to worker", variant: "info", duration: 2000 })
        } else {
          log.warn("worker injection failed (no active loop or stdin handle)")
          toast.show({ message: "No active worker to send to", variant: "warning", duration: 3000 })
        }
      }
      return
    }
  }

  // ── Shell-Level Keyboard Shortcuts ──

  useKeyboard((evt) => {
    // === Sidebar-focused key routing ===
    // When sidebar has focus, intercept navigation keys before anything else.
    // Modal guards: sidebar focus is disabled when stop/error/approval modals are open.
    if (sidebarFocused() && !showStopModal() && !showQuitModal() && !approvalPending() && !pendingQuestion()) {
      if (evt.name === "up") {
        evt.preventDefault()
        const result = sidebarKeyHandler("move-up", sessionCtx.sessions(), sidebarSelectedIndex())
        setSidebarSelectedIndex(result.selectedIndex)
        return
      }
      if (evt.name === "down") {
        evt.preventDefault()
        const result = sidebarKeyHandler("move-down", sessionCtx.sessions(), sidebarSelectedIndex())
        setSidebarSelectedIndex(result.selectedIndex)
        return
      }
      if (evt.name === "return") {
        evt.preventDefault()
        const result = sidebarKeyHandler("select", sessionCtx.sessions(), sidebarSelectedIndex())
        if (result.selectedSessionId && result.action) {
          handleSessionSelect(result.selectedSessionId, result.action)
        }
        return
      }
      if (evt.name === "delete" || evt.name === "backspace") {
        evt.preventDefault()
        const result = sidebarKeyHandler("delete", sessionCtx.sessions(), sidebarSelectedIndex())
        if (result.selectedSessionId && result.action) {
          handleSessionSelect(result.selectedSessionId, result.action)
        }
        return
      }
      if (evt.name === "escape" || evt.name === "tab") {
        evt.preventDefault()
        setSidebarFocused(false)
        return
      }
    }

    // === Work-mode shortcuts (only active when working) ===
    if (appState() === "working" && activeStore()) {
      // Ctrl+B: background session (minimize to sidebar, keep running)
      if (evt.ctrl && evt.name === "b") {
        evt.preventDefault()
        backgroundSession()
        return
      }

      // Ctrl+S: skip current phase
      if (evt.ctrl && evt.name === "s") {
        evt.preventDefault()
        return
      }

      // Ctrl+D: toggle raw output mode
      if (evt.ctrl && evt.name === "d") {
        evt.preventDefault()
        if (activeSession) {
          const nowRaw = activeSession.adapter.toggleRawMode()
          toast.show({
            message: nowRaw ? "Raw output: ON" : "Raw output: OFF",
            variant: "info",
            duration: 2000,
          })
        }
        return
      }

      // Up/Down: phase navigation (only when not prompt or sidebar focused)
      if (!isPromptFocused() && !sidebarFocused()) {
        if (evt.name === "up") {
          evt.preventDefault()
          activeStore()!.selectPrevious()
          return
        }
        if (evt.name === "down") {
          evt.preventDefault()
          activeStore()!.selectNext()
          return
        }

        // Right arrow: focus prompt (when approval pending)
        if (evt.name === "right" && workState()?.approvalState?.pending) {
          evt.preventDefault()
          setIsPromptFocused(true)
          setSidebarFocused(false)
          return
        }
      }
    }
    // === End work-mode shortcuts ===

    // === Resume key: press 'r' to resume a paused session ===
    if (
      evt.name === "r" &&
      !evt.ctrl &&
      !evt.meta &&
      appState() === "completed" &&
      !isPromptFocused() &&
      !sidebarFocused() &&
      !showStopModal() &&
      isSessionResumable()
    ) {
      evt.preventDefault()
      const vid = viewedSessionId()
      if (vid) {
        resumeSession(vid)
      }
      return
    }

    // Tab: toggle sidebar focus (when not prompt focused, sessions exist, sidebar visible)
    if (evt.name === "tab" && !isPromptFocused() && !showStopModal() && !approvalPending() && !pendingQuestion()) {
      const hasSessions = sessionCtx.sessions().length > 0
      const sidebarVisible = (dimensions()?.width ?? 120) >= 90
      if (hasSessions && sidebarVisible) {
        evt.preventDefault()
        const next = !sidebarFocused()
        setSidebarFocused(next)
        if (next) setIsPromptFocused(false)
        return
      }
    }

    // Escape: handle at shell level for non-idle states.
    // "completed" is included because the prompt may not always capture Escape
    // (e.g., when viewing a read-only session and prompt focus is ambiguous).
    // When a question is pending, let the QuestionPrompt handle Escape (to dismiss the question).
    if (evt.name === "escape" && !pendingQuestion()) {
      const currentState = appState()
      if (currentState === "working" || currentState === "importing" || currentState === "completed") {
        evt.preventDefault()
        handleEscape()
        return
      }
    }



    // Ctrl+C: copy selection if active, otherwise state-based behavior
    if (evt.ctrl && evt.name === "c") {
      if (renderer.getSelection()) {
        evt.preventDefault()
        if (!Selection.copy(renderer, toast)) {
          renderer.clearSelection()
        }
        return
      }
      evt.preventDefault()
      const behavior = ctrlCForState(appState())
      switch (behavior) {
         case "exit-tui":
          if (runtimes.size > 0) {
            setShowQuitModal(true)
          } else {
            exitTUI()
          }
          return
        case "stop-workflow":
          stopWorkflow()
          return
        case "return-idle":
          returnToIdle()
          return
      }
      return
    }
  })

  // ── Approval decision handler ──

  const handleApprovalDecision = (approved: boolean, skip?: boolean) => {
    if (activeSession) {
      activeSession.adapter.onApprovalDecision?.(approved, skip)
    }
  }

  // ── Computed layout props ──

  const hasActiveWorkflow = () => activeStore() !== null && workState() !== null
  const runtime = () => runtimeText()

  // Default work state for SharedLayout when no workflow is active
  const defaultWorkState: WorkState = {
    planName: "",
    version: "0.0.1",
    startTime: 0,
    workflowStatus: "idle",
    phases: [],
    stages: [],
    outputLines: [],
    outputBlocks: [],
    error: undefined,
    selectedPhaseIndex: 0,
    scrollOffset: 0,
    visibleItemCount: 0,
    approvalState: { pending: false },
  }

  const layoutState = () => workState() ?? defaultWorkState

  const runningPhaseIndex = () => {
    const state = layoutState()
    const running = state.phases.findIndex((p) => p.status === "running")
    if (running >= 0) return running + 1
    for (let i = state.phases.length - 1; i >= 0; i--) {
      if (state.phases[i].status !== "pending") return i + 1
    }
    return 0
  }

  // ── Unified prompt (Input + Overlay split for z-ordering) ──

  const prompt = useUnifiedPrompt({
    get appState() { return appState() },
    get approvalPending() { return approvalPending() },
    get sidebarFocused() { return sidebarFocused() },
    onCommand: handleCommand,
    onPromptSubmit: handlePromptInput,
    onEscape: handleEscape,
    get availableWidth() { return dimensions()?.width },
    get runningCount() { return runtimes.getRunningIds().length },
  })

  // ── Render ──

  return (
    <box flexDirection="column" height="100%" position="relative" onMouseUp={() => Selection.copy(renderer, toast)}>
      <Toast />
      <SharedLayout
        state={layoutState()}
        showStopModal={showStopModal()}
        showApprovalGate={approvalPending()}
        showErrorModal={!!layoutState().error && layoutState().workflowStatus === "failed"}
        errorMessage={layoutState().error}
        approvalPending={approvalPending()}
        isPromptFocused={isPromptFocused()}
        header={
          hasActiveWorkflow() ? (
            <SessionHeader
              info={{
                sessionName: layoutState().planName,
                planName: layoutState().planName,
                workflowStatus: layoutState().workflowStatus,
                currentPhase: currentPhase()?.name,
              }}
              version={layoutState().version}
            />
          ) : viewedSessionInfo() ? (
            <SessionHeader
              info={viewedSessionInfo()!}
              version="0.0.1"
            />
          ) : (
            <BrandingHeader
              version="0.0.1"
              currentDir=""
            />
          )
        }
        sidebar={
          sessionCtx.sessions().length > 0 ? (
            <SessionSidebar
              sessions={sessionCtx.sessions()}
              terminalWidth={dimensions()?.width}
              width={SIDEBAR_WIDTH}
              focused={sidebarFocused()}
              selectedIndex={sidebarSelectedIndex()}
              onSelect={handleSessionSelect}
              focusedSessionId={focusedSessionId()}
              onSessionClick={(sessionId, flatIndex) => {
                setSidebarFocused(true)
                setIsPromptFocused(false)
                setSidebarSelectedIndex(flatIndex)
                const session = sessionsMap().get(sessionId)
                if (session) {
                  const action = getOpenAction(session)
                  if (action) handleSessionSelect(sessionId, action)
                }
              }}
            />
          ) : undefined
        }
        panel={
          hasActiveWorkflow() ? (
            <WorkflowPanel
              state={layoutState()}
              stepLabel={activeStepLabel()}
              selectedPhaseIndex={layoutState().selectedPhaseIndex}
            />
          ) : undefined
        }
        onStopConfirm={() => {
          setShowStopModal(false)
          stopWorkflow()
        }}
        onStopCancel={() => setShowStopModal(false)}
        onApprovalContinue={() => {
          handleApprovalDecision(true)
          activeStore()?.clearApproval()
        }}
        onApprovalReject={() => {
          handleApprovalDecision(false)
          activeStore()?.clearApproval()
        }}
        onApprovalSkip={() => {
          handleApprovalDecision(true, true)
          activeStore()?.clearApproval()
        }}
        onErrorClose={() => activeStore()?.clearError()}
      >
        {/* Center content: EmptyState when idle, OutputWindow when working/completed with content */}
        <Show
          when={hasActiveWorkflow() || (appState() === "completed" && (layoutState().outputBlocks.length > 0 || viewedSessionInfo()))}
          fallback={<EmptyState />}
        >
          <Show
            when={!sessionLoading()}
            fallback={
              <box flexDirection="column" width="100%" justifyContent="center" alignItems="center" flexGrow={1}>
                <text fg={themeCtx.theme.textMuted}>Loading session...</text>
              </box>
            }
          >
            <box flexDirection="column" width="100%" flexGrow={1}>
              <OutputWindow
                outputBlocks={layoutState().outputBlocks}
                workflowStatus={viewedSessionInfo()?.workflowStatus ?? layoutState().workflowStatus}
                approvalPending={approvalPending()}
                isPromptFocused={isPromptFocused() || sidebarFocused()}
                availableWidth={dimensions()?.width}
                currentPhase={currentPhase()}
              />
            </box>
          </Show>
        </Show>
      </SharedLayout>

      {/* Bottom slot: QuestionPrompt (when pending) OR normal Prompt input */}
      <Show
        when={pendingQuestion() && activeQuestionWiring}
        fallback={
          <box flexShrink={0} alignItems="center" justifyContent="center" onMouseDown={() => {
            if (sidebarFocused()) {
              setSidebarFocused(false)
            }
          }}>
            <prompt.Input />
          </box>
        }
      >
        <box flexShrink={0}>
          <QuestionPrompt
            request={pendingQuestion()!}
            questionService={activeQuestionWiring!.service}
          />
        </box>
      </Show>

      {/* Telemetry bar — below the prompt */}
      <box flexShrink={0}>
        <TelemetryBar
          planName={viewedSessionInfo()?.sessionName ?? layoutState().planName}
          runtime={runtime()}
          status={viewedSessionInfo()?.workflowStatus ?? layoutState().workflowStatus}
          currentPhase={runningPhaseIndex()}
          totalPhases={layoutState().phases.length}
          workflowLabel={hasActiveWorkflow() ? activeWorkflowName() : undefined}
          stepLabel={hasActiveWorkflow() ? activeStepLabel() : undefined}
          pipelineInfo={activePipelineInfo() ?? (activeQueueInfo() ? {
            stage: activeQueueInfo()!.currentStep,
            total: activeQueueInfo()!.totalSteps,
            stageName: activeQueueInfo()!.stepName,
          } : null)}
          sprintInfo={activeSprintInfo()}
        />
      </box>

      {/* Status footer — always at the very bottom */}
      <StatusFooter
        approvalPending={approvalPending()}
        isPromptFocused={isPromptFocused()}
        sidebarFocused={sidebarFocused()}
        sidebarVisible={sessionCtx.sessions().length > 0 && (dimensions()?.width ?? 120) >= 90}
        isSessionResumable={isSessionResumable()}
        isWorking={appState() === "working"}
      />

      {/* Quit confirmation modal (Esc in idle with running sessions) */}
      <Show when={showQuitModal()}>
        <QuitConfirmModal
          activeSessionCount={runtimes.size}
          onConfirm={() => {
            setShowQuitModal(false)
            // Pause all running sessions before exiting
            for (const id of runtimes.getRunningIds()) {
              try {
                const rt = runtimes.get(id)
                if (rt?.kind === "running") {
                  // Only pause work:active sessions
                  const persisted = sessionsMap().get(id)
                  if (persisted?.lifecycleState === "work:active") {
                    sessionCtx.manager.updateState(id, "work:paused")
                  }
                }
              } catch (err) {
                log.warn("quit pause failed", { session: id, error: err instanceof Error ? err : String(err) })
              }
            }
            runtimes.teardownAll()
            sessionCtx.refreshList()
            exitTUI()
          }}
          onCancel={() => setShowQuitModal(false)}
        />
      </Show>

      {/* Escape hint overlay (during double-Esc) */}
      <Show when={escHint()}>
        <box flexShrink={0} paddingLeft={2}>
          <text fg={themeCtx.theme.warning ?? themeCtx.theme.textMuted}>
            {escHint()}
          </text>
        </box>
      </Show>

      {/* Autocomplete overlay — rendered LAST so it paints on top of everything */}
      <prompt.Overlay />
    </box>
  )
}
