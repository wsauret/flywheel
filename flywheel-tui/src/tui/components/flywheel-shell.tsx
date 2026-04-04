/** @jsxImportSource @opentui/solid */
/**
 * FlywheelShell — Top-level persistent shell component
 *
 * Single always-on SharedLayout with content varying by AppState:
 *   IDLE:      EmptyState (API key missing fallback) + UnifiedPrompt in command mode
 *   CHATTING:  ChatHeader + OutputWindow (chat messages) + UnifiedPrompt in chat mode
 *   WORKING:   SessionHeader + OutputWindow + UnifiedPrompt in passive/active mode
 *   COMPLETED: OutputWindow (or EmptyState if no output) + UnifiedPrompt in command mode
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

import { createSignal, createMemo, onCleanup, Show } from "solid-js"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "@tui/shared/context/theme"
import { useToast } from "@tui/shared/context/toast"
import { useSession } from "@tui/shared/context/session"
import { Toast } from "@tui/shared/ui/toast"
import { SharedLayout } from "../routes/work/components/shared-layout"
import { OutputWindow, type CurrentStepInfo } from "../routes/work/components/output-window"
import { SessionSidebar } from "./session-sidebar"
import { WorkflowPanel } from "./workflow-panel"
import { SessionHeader } from "./session-header"
import { ChatHeader } from "./chat-header"
import { BrandingHeader } from "@tui/shared/components/branding-header"
import { EmptyState } from "./empty-state"
import { useUnifiedPrompt } from "./unified-prompt"
import { shouldShowThinkingIndicator } from "./thinking-indicator-state"
import type { ModelActivity } from "../adapters/structured-output-builder"
import { exitTUI } from "../app"
import { createEscapeHandler } from "../utils/escape-handler"
import { createRef } from "../utils/create-ref"
import { Selection } from "../utils/selection"
import { Clipboard } from "../utils/clipboard"
import { QuitConfirmModal } from "../routes/work/components/modals/quit-confirm-modal"
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "../session/workflow-session"
import {
  createSessionRuntimeManager,
  type SessionRuntimeManager,
} from "../session/session-runtime"
import type { WorkflowDeps } from "../../engines/workflow-deps"
import type { QuestionRequest } from "../../queue/question-service"
import { QuestionPrompt } from "./question-prompt"
import { StatusFooter } from "../routes/work/components/status-footer"
import { TelemetryBar } from "../routes/work/components/telemetry-bar"
import { Spinner } from "@tui/shared/components/spinner"
import { ShimmerText } from "@tui/shared/components/shimmer-text"
import type { QueueProgressInfo } from "../shell/shell-queue"
import type { StepExecutor } from "../../queue/executor"

import { createQueuePersistence } from "../../queue/persistence"
import type { Queue } from "../../queue/types"
import { createQuestionWiring, type QuestionWiring } from "../utils/question-wiring"
import { SIDEBAR_WIDTH } from "../shell/shell-modes"
import { createOutputPersistence } from "../../session/output-persistence"
import { createTranscriptLogger } from "../../session/transcript"
import { readSession, updateSession, deleteSessionWithCompanions } from "../../session/persistence"
import { createBudgetTracker } from "../../session/budget-tracker"
import { fromSnapshot, snapshotToBlocks } from "../../session/output-schemas"
import { createSessionOrchestrator, type SessionOrchestrator } from "../session/session-orchestrator"
import { injectOutputBlocks } from "../session/resume-utils"
import { createSessionLifecycleManager, type SessionLifecycleManager } from "../shell/session-lifecycle-runner"
import type { SprintIterationInfo } from "../utils/format"
import type { WorkflowSession } from "../session/workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState } from "../types"
import type { AnyBlock } from "../types"
import type { Unsubscribe } from "../../events/event-bus"
import { getOpenAction, groupToFlatList, type SelectionAction } from "../session/sidebar-logic"
import { createCommandHandlers, createShellDispatcher } from "../shell/command-handlers"
import { createSessionViewport, type SessionViewport } from "../session/session-viewport"
import { isResumable } from "../../session/state-machine"
import { deriveHeaderInfo } from "./session-header-logic"
import { interruptAllActiveProcesses } from "../../worker/process-lifecycle"
import { Log } from "../../utils/log"

import type { StdinHandle } from "../../worker/spawner"
import { PlanConfirmation } from "./plan-confirmation"
import type { PlanImportResult } from "../../queue/shared/plan-import"
import type { ConfirmBeforeInsert } from "../../queue/steps/plan-consolidate/hooks"
import {
  runQueueOnSession,
} from "../shell/queue-execution-runner"
import {
  resetInterruptState,
} from "../shell/interrupt-controller"
import { handleShellKeyEvent, type KeyboardContext } from "../shell/keyboard-controller"
import { createPromptHandler } from "../shell/prompt-handler"
import {
  createDepsCache,
  createContextIndexerCache,
  getProjectCwd as getProjectCwdUtil,
  cleanupQuestionSubscriptions as cleanupQuestionSubscriptionsImpl,
  cleanupQueueSubscriptions as cleanupQueueSubscriptionsImpl,
  clearQueueRuntime,
  type QuestionCleanupRefs,
  type QueueCleanupRefs,
  type ClearQueueRuntimeRefs,
} from "../shell/shell-lifecycle"
import { createChatController, type ChatController } from "../shell/chat-controller"
import { createSessionNavigation } from "../shell/session-navigation"

const log = Log.create({ service: "shell" })

// ── App state ──

import {
  escapeForState,
  type AppState,
} from "../shell/shell-modes"

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const sessionCtx = useSession()
  const [appState, setAppState] = createSignal<AppState>("idle")
  const [escHint, setEscHint] = createSignal("")
  const [modelActivity, setModelActivity] = createSignal<ModelActivity>("idle")

  // Active workflow metadata
  const [activeStepLabel, setActiveStepLabel] = createSignal("Step")
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

  // Plan confirmation HITL state: holds the parsed plan and a resolver
  // that the plan integration hook awaits for user approval/rejection.
  const [pendingPlanConfirm, setPendingPlanConfirm] = createSignal<{
    plan: PlanImportResult
    resolve: (approved: boolean) => void
  } | null>(null)
  let activeQuestionWiring: QuestionWiring | null = null
  /** Getter-based ref for passing activeQuestionWiring to extracted lifecycle functions. */
  const activeQuestionWiringRef = createRef<QuestionWiring | null>(() => activeQuestionWiring, (v) => { activeQuestionWiring = v })

  // Queue progress indicator tracking
  const [activeQueueInfo, setActiveQueueInfo] = createSignal<QueueProgressInfo | null>(null)
  // Sprint iteration tracking for telemetry bar
  const [activeSprintInfo, setActiveSprintInfo] = createSignal<SprintIterationInfo | null>(null)

  // Direct reactive queue steps signal for WorkflowPanel.
  // Bypasses the store → workState signal chain which breaks SolidJS fine-grained
  // reactivity for nested array properties at runtime. Updated directly from
  // event bus subscriptions, matching the proven pattern of activeQueueInfo.
  const [shellQueueSteps, setShellQueueSteps] = createSignal<import("../types").QueueStepState[]>([])
  let queueUnsubs: Unsubscribe[] = []
  /** Getter-based ref for passing queueUnsubs to extracted lifecycle functions. */
  const queueUnsubsRef = createRef<Unsubscribe[]>(() => queueUnsubs, (v) => { queueUnsubs = v })

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

  // ── Session Lifecycle Manager ──
  // Owns: activeSession, activeFlusher, activeTranscript, activeBudgetTracker,
  //       storeUnsub, activeQuestionWiring
  // Shell accesses them through lifecycle.getXxx() / lifecycle.setXxx()

  // Forward-declared subscribeToStore — defined in terms of lifecycle manager below
  let _subscribeToStore: (store: UIActions) => void
  let _unsubscribeStore: () => void

  const lifecycle: SessionLifecycleManager = createSessionLifecycleManager({
    createWorkflowSession,
    destroyWorkflowSession,
    createOutputPersistence: (lOpts) => createOutputPersistence(lOpts),
    createTranscriptLogger: (lOpts) => createTranscriptLogger(lOpts),
    createBudgetTracker: (lOpts) => createBudgetTracker(lOpts),
    readSession: (id, baseDir) => readSession(id, baseDir),
    createQuestionWiring: (lOpts) => createQuestionWiring(lOpts),
    injectOutputBlocks: (store, blocks) => injectOutputBlocks(store, blocks),
    snapshotToBlocks: (snapshots) => snapshotToBlocks(snapshots) as AnyBlock[],
    onModelActivityChange: (activity) => setModelActivity(activity),
    setActiveStore,
    setWorkState: () => setWorkState(null),
    subscribeToStore: (store) => _subscribeToStore(store),
    unsubscribeStore: () => _unsubscribeStore(),
    subscribeToTimer,
    unsubscribeTimer,
    onQuestionChange: (q) => setPendingQuestion(q),
    onQuestionWiringChange: (wiring) => { activeQuestionWiring = wiring },
    cleanupQueueSubscriptions: () => cleanupQueueSubscriptionsImpl(_queueCleanupRefs),
  })

  /** Getter-based ref for passing activeSession to extracted queue-orchestrator functions. */
  const activeSessionRef = createRef<WorkflowSession | null>(() => lifecycle.getActiveSession(), (v) => lifecycle.setActiveSession(v))

  // Non-reactive refs for queue execution (kept in shell — shared across sessions)
  let activeStepExecutor: StepExecutor | null = null
  /** Getter-based ref for passing activeStepExecutor to extracted lifecycle functions. */
  const activeStepExecutorRef = createRef<StepExecutor | null>(() => activeStepExecutor, (v) => { activeStepExecutor = v })
  let activeQueue: Queue | null = null
  /** Getter-based ref for passing activeQueue to extracted lifecycle functions. */
  const activeQueueRef = createRef<Queue | null>(() => activeQueue, (v) => { activeQueue = v })
  /** Mutable ref for the currently running worker's stdin handle (mid-execution injection). */
  const activeStdinHandleRef: { current: StdinHandle | null } = { current: null }

  // ── 2-Tier Interrupt System ──
  // Tracks whether the worker has been interrupted (first Esc / SIGINT)
  // and stores a pending message for injection at turn boundaries or resume.
  const [isInterrupted, setIsInterrupted] = createSignal(false)
  /** Pending message to inject at next turn boundary (soft injection). */
  const pendingInjection: { current: string | null } = { current: null }
  /** Captured session ID from the NDJSON output, for --resume/--session after interrupt. */
  const capturedWorkerSessionId: { current: string | undefined } = { current: undefined }

  // Queue running guard: prevents handleCommand from overwriting activeWorkflowName
  // during queue execution (step-transition events handle it instead)
  let _isQueueRunning = false
  /** Getter-based ref for passing _isQueueRunning to extracted lifecycle functions. */
  const isQueueRunningRef = createRef<boolean>(() => _isQueueRunning, (v) => { _isQueueRunning = v })

  // ── Lazy-cached workflow deps (via shell-lifecycle) ──
  const _depsCache = createDepsCache(toast)
  const getDepsOrWarn = _depsCache.getDepsOrWarn

  // ── Shared ContextIndexer (via shell-lifecycle) ──
  const _indexerCache = createContextIndexerCache(() => getProjectCwd())
  const getOrCreateContextIndexer = _indexerCache.getOrCreateContextIndexer
  let _indexerStarted = false

  /** Convenience: get project_cwd from cached deps (or "." on failure). */
  const getProjectCwd = (): string => getProjectCwdUtil(getDepsOrWarn)

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
    createQueuePersistence: (sessionId: string) => {
      return createQueuePersistence({ sessionId, baseDir: getProjectCwd() })
    },
    fromSnapshot,
    manager: sessionCtx.manager,
    worktreeManager: sessionCtx.worktreeManager ?? undefined,
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
  // Uses lifecycle manager to track storeUnsub ref (owned by lifecycle manager)

  const subscribeToStore = (store: UIActions) => {
    // Unsubscribe previous
    const prevUnsub = lifecycle.getStoreUnsub()
    if (prevUnsub) prevUnsub()

    // Initial state
    setWorkState(store.getState())

    // Subscribe to updates
    const unsub = store.subscribe(() => {
      setWorkState(store.getState())
    })
    lifecycle.setStoreUnsub(unsub)
  }

  const unsubscribeStore = () => {
    const unsub = lifecycle.getStoreUnsub()
    if (unsub) {
      unsub()
      lifecycle.setStoreUnsub(null)
    }
  }

  // Wire the forward-declared subscribeToStore/unsubscribeStore
  _subscribeToStore = subscribeToStore
  _unsubscribeStore = unsubscribeStore


  // ── Chat Controller ──
  // Manages interactive chat session lifecycle (chatting state).
  const chatController: ChatController = createChatController({
    setAppState,
    setActiveStore,
    setWorkState,
    subscribeToStore,
    unsubscribeStore,
    setModelActivity,
    toast,
    getProjectCwd,
  })

  // Boot into chatting state if API key is available
  // Use queueMicrotask to ensure SolidJS reactivity is ready
  queueMicrotask(() => {
    if (appState() === "idle") {
      const started = chatController.startChat()
      if (started) {
        setIsPromptFocused(true)
      }
    }
  })
  // ── Session Viewport ──
  // Handles switching the visible session in the viewport without
  // mutating lifecycle state or creating new WorkflowSession instances.
  const viewport: SessionViewport = createSessionViewport({
    viewedSessionId,
    setViewedSessionId,
    activeStore: () => activeStore(),
    setActiveStore,
    subscribeToStore,
    unsubscribeStore,
    setWorkState,
    setAppState,
    sessionControllers,
    sessionStores,
    orchestrator,
    toast,
    setSessionLoading,
    setShellQueueSteps,
    setActiveQueueInfo,
  })

  // ── Derived state ──

  const currentStep = createMemo((): CurrentStepInfo | null => {
    const state = workState()
    if (!state) return null
    const steps = state.queueSteps
    const running = steps.find((s) => s.status === "running")
    if (running) {
      return { index: steps.indexOf(running), name: running.title, status: running.status }
    }
    for (let i = steps.length - 1; i >= 0; i--) {
      const s = steps[i]
      if (s.status === "completed" || s.status === "failed") {
        return { index: i, name: s.title, status: s.status }
      }
    }
    return null
  })

  const approvalPending = () => workState()?.approvalState?.pending ?? false
  const showThinkingIndicator = createMemo(() =>
    shouldShowThinkingIndicator({
      appState: appState(),
      approvalPending: approvalPending(),
      hasPendingQuestion: pendingQuestion() !== null,
      isInterrupted: isInterrupted(),
      modelActivity: modelActivity(),
    })
  )

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

  // Derived: lifecycle state of the currently viewed session (for prompt placeholders)
  const viewedLifecycleState = createMemo(() => {
    const vid = viewedSessionId()
    if (!vid) return null
    const session = sessionsMap().get(vid)
    return session?.lifecycleState ?? null
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

  /**
   * Plan confirmation callback (HITL). When planInteractive is true, the
   * plan integration hook calls this before inserting work steps. The shell
   * sets a signal to render <PlanConfirmation>, and the returned Promise
   * resolves when the user approves or rejects.
   */
  const confirmPlanBeforeInsert: ConfirmBeforeInsert = (planResult) => {
    return new Promise<boolean>((resolve) => {
      setPendingPlanConfirm({ plan: planResult, resolve })
    })
  }

  // ── Lifecycle cleanup refs (wired to extracted shell-lifecycle functions) ──
  const _questionCleanupRefs: QuestionCleanupRefs = {
    activeQuestionWiring: activeQuestionWiringRef,
    setPendingQuestion,
  }
  const _queueCleanupRefs: QueueCleanupRefs = {
    queueUnsubs: queueUnsubsRef,
    setActiveQueueInfo,
    setShellQueueSteps: (v) => setShellQueueSteps(v),
    isQueueRunning: isQueueRunningRef,
  }
  const _clearQueueRuntimeRefs: ClearQueueRuntimeRefs = {
    activeStepExecutor: activeStepExecutorRef,
    activeQueue: activeQueueRef,
    activeStdinHandleRef,
    setIsInterrupted,
    pendingInjection,
    capturedWorkerSessionId,
  }

  const cleanupQuestionSubscriptions = () => cleanupQuestionSubscriptionsImpl(_questionCleanupRefs)
  const cleanupQueueSubscriptions = () => cleanupQueueSubscriptionsImpl(_queueCleanupRefs)
  const _clearQueueRuntime = (): Promise<void> | undefined => clearQueueRuntime(_clearQueueRuntimeRefs)

  const teardownActiveWorkflow = (): Promise<void> | undefined => {
    lifecycle.teardown()
    const shutdownPromise = _clearQueueRuntime()
    // Note: we do NOT clear workState here so completed view can still show output
    return shutdownPromise
  }

  // User-initiated pause flag: set when double-Esc pauses a queue.
  // Distinguishes pause from failure so ErrorModal is suppressed.
  let _userInitiatedPause = false

  // Interrupt-abort flag: set when first Esc aborts the executor mid-step.
  let _interruptAbort = false

  // ── Queue execution deps (shared across runQueueOnSession calls) ──
  const _runQueueDeps = () => ({
    lifecycle,
    setShellQueueSteps,
    setFocusedSessionId,
    setViewedSessionId,
    setAppState,
    setActiveQueueInfo,
    setActiveSprintInfo,
    setActiveWorkflowName,
    sessionControllers,
    runtimes,
    sessionStores,
    activeStdinHandleRef,
    capturedWorkerSessionId,
    pendingInjection,
    activeSessionRef,
    isQueueRunningRef,
    queueUnsubs: queueUnsubsRef,
    getUserInitiatedPause: () => _userInitiatedPause,
    setUserInitiatedPause: (v: boolean) => { _userInitiatedPause = v },
    getInterruptAbort: () => _interruptAbort,
    setInterruptAbort: (v: boolean) => { _interruptAbort = v },
    getIndexerStarted: () => _indexerStarted,
    setIndexerStarted: (v: boolean) => { _indexerStarted = v },
    getOrCreateContextIndexer,
    sessionCtx: {
      manager: sessionCtx.manager,
      refreshList: () => sessionCtx.refreshList(),
    },
    orchestrator,
    toast,
    viewedSessionId,
    activeStore,
    setActiveStepExecutor: (v: StepExecutor | null) => { activeStepExecutor = v },
    confirmPlanBeforeInsert,
    cleanupQuestionSubscriptions,
    cleanupQueueSubscriptions,
  })

  /**
   * Shared wiring for steps 6-13 of queue execution (both new + resumed sessions).
   * Delegates to the extracted runQueueOnSession in queue-execution-runner.ts.
   */
  const _runQueueOnSession = (init: {
    session: WorkflowSession
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
  }) => {
    runQueueOnSession(init, _runQueueDeps())
  }

  // ── Session Navigation (extracted to session-navigation.ts) ──
  const sessionNav = createSessionNavigation({
    lifecycle,
    activeStepExecutor: activeStepExecutorRef,
    activeQueue: activeQueueRef,
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
    runQueueOnSession: _runQueueOnSession,
    getDepsOrWarn,
    teardownActiveWorkflow,
    cleanupQuestionSubscriptions,
    cleanupQueueSubscriptions,
    unsubscribeTimer,
    pendingInjection,
    capturedWorkerSessionId,
    sessionsMap,
    focusedSessionId,
    sidebarSelectedIndex,
    isInterrupted,
    setUserInitiatedPause: (v: boolean) => { _userInitiatedPause = v },
    getActiveSession: () => lifecycle.getActiveSession(),
    getActiveQueue: () => activeQueue,
    getActiveStepExecutor: () => activeStepExecutor,
  })

  // Expose navigation functions as local names for the rest of the shell
  const { handleSessionSelect, returnToIdle, returnToChat, backgroundSession,
          stopWorkflow, pauseQueue, resumeWorkerWithMessage, resumeSession } = sessionNav

  /**
   * Start queue-based execution. Creates a new session, builds the queue,
   * wires events, and runs the step executor.
   *
   * VAL-SHELL-019: Session created when queue starts
   * VAL-SHELL-020: Session lifecycle follows queue progression
   */
  const startQueueExecution = (
    queue: Queue,
    args: Record<string, string>,
    preloadedDeps?: WorkflowDeps,
    interactiveOverrides?: { plan?: boolean; review?: boolean },
    /** Pre-seed the context accumulator with fixture handoff data (for /test). */
    seedHandoff?: Record<string, unknown> | null,
  ) => {
    // 1. Background/destroy previous session
    const prevFocused = focusedSessionId()
    if (prevFocused && runtimes.has(prevFocused)) {
      runtimes.background(prevFocused)
      lifecycle.backgroundCurrent()
      activeStepExecutor = null
      activeQueue = null
      activeStdinHandleRef.current = null
    } else if (lifecycle.getActiveSession()) {
      lifecycle.destroyCurrent()
      activeStepExecutor = null
      activeQueue = null
      activeStdinHandleRef.current = null
    }

    // 2. Load deps (config, engine, spawner)
    let deps: WorkflowDeps
    if (preloadedDeps) {
      deps = preloadedDeps
    } else {
      const resolved = getDepsOrReturnIdle()
      if (!resolved) return
      deps = resolved
    }

    // 3. Create persistent Session for pause/resume support
    let persistedSessionId: string | null = null
    try {
      const sessionLabel = queue.steps.map((s) => s.type).join(" -> ")
      const planPathForSession = args.planPath ?? sessionLabel
      const placeholderName = args.description || args.topic || undefined
      persistedSessionId = sessionCtx.manager.create(planPathForSession, placeholderName)

      const projectCwd = deps.config.project_cwd ?? "."
      updateSession(persistedSessionId, { outputPath: "output.json" }, projectCwd)

      // Transition to work:active
      sessionCtx.manager.updateState(persistedSessionId, "plan:imported")
      sessionCtx.manager.updateState(persistedSessionId, "plan:approved")
      sessionCtx.manager.updateState(persistedSessionId, "work:active")
    } catch (err) {
      toast.show({
        message: `Session persistence failed: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    // 4. Delegate session creation + persistence wiring to lifecycle manager
    const projectCwd = deps.config.project_cwd ?? "."
    const initResult = lifecycle.initSession({
      queue,
      args,
      projectCwd,
      persistedSessionId,
      sessionStore: null as any, // session store created internally by lifecycle manager
    })
    activeQueue = queue

    // 5. Hand off to shared queue wiring (steps 6-13)
    _runQueueOnSession({
      session: initResult.session,
      queue,
      sessionId: persistedSessionId,
      deps,
      budgetTracker: initResult.budgetTracker,
      budgetLimits: initResult.budgetLimits,
      sessionObjective: args.description,
      chatContext: args.chatContext,
      interactiveOverrides,
      seedHandoff,
    })
  }

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    chatController.dispose()
    teardownActiveWorkflow()
    runtimes.teardownAll()
    _indexerCache.dispose()
  })

  // ── Command Handlers (extracted to command-handlers.ts) ──

  const commandHandlers = createCommandHandlers({
    getDepsOrWarn,
    getDepsOrReturnIdle,
    toast,
    getProjectCwd,
    chatController,
    startQueueExecution,
    cleanupQuestionSubscriptions,
    setActiveQuestionWiring: (wiring) => { activeQuestionWiring = wiring },
    setPendingQuestion,
    returnToIdle,
    returnToChat,
  })

  const dispatch = createShellDispatcher(commandHandlers, {
    toast,
    returnToIdle,
    returnToChat,
  })

  // ── Prompt Handler (extracted to prompt-handler.ts) ──

  const { handlePromptInput, handleCommand, handleApprovalDecision } = createPromptHandler({
    appState,
    workState,
    isSessionResumable,
    viewedSessionId,
    isInterrupted,
    activeStore,
    isQueueRunning: () => _isQueueRunning,
    activeStdinHandleRef,
    pendingInjection,
    getActiveSession: () => lifecycle.getActiveSession(),
    getDepsOrWarn,
    toast,
    resumeSession,
    resumeWorkerWithMessage,
    dispatch,
    setActiveStepLabel,
    setActiveWorkflowName,
    sendChatMessage: (text: string) => chatController.sendMessage(text),
  })
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
        // If already interrupted (first Esc was pressed), second Esc is full kill
        if (isInterrupted()) {
          escapeHandler.reset()
          setEscHint("")
          resetInterruptState({ setIsInterrupted, pendingInjection, capturedWorkerSessionId })
          pauseQueue()
          return
        }

        const result = escapeHandler.handleEscape()
        if (result === "interrupt") {
          const handle = activeStdinHandleRef.current
          if (handle?.interrupt) {
            // SDK path: interrupt without killing — session stays alive for resume
            handle.interrupt()
            setIsInterrupted(true)
            setEscHint("Press Esc again to kill worker")
            log.info("worker interrupted via SDK session.abort (session stays alive)", {
              sessionId: capturedWorkerSessionId.current,
            })
          } else {
            // CLI path: Send SIGINT to all active worker processes and abort
            // the step executor so the evaluator is skipped and the step is
            // NOT marked as completed (queue does not advance).
            // Suppress ErrorModal from the queue:failed event that abort triggers
            if (lifecycle.getActiveSession()?.adapter) {
              lifecycle.getActiveSession()!.adapter.suppressQueueError = true
            }
            interruptAllActiveProcesses()
            if (activeStepExecutor) {
              _interruptAbort = true
              activeStepExecutor.abort()
            }
            setIsInterrupted(true)
            setEscHint("Press Esc again to kill worker")
            log.info("worker interrupted via SIGINT + executor abort", {
              sessionId: capturedWorkerSessionId.current,
            })
          }
        } else {
          // Tier 2: Full kill — pause the queue entirely
          setEscHint("")
          setIsInterrupted(false)
          pendingInjection.current = null
          // During queue: pause instead of full stop
          if (_isQueueRunning) {
            pauseQueue()
          } else {
            stopWorkflow()
          }
        }
        return
      }
      case "return-idle":
        returnToIdle()
        return
      case "return-chat":
        returnToChat()
        return

    }
  }

  // ── Shell-Level Keyboard Shortcuts ──

  const keyboardCtx: KeyboardContext = {
    // State accessors
    appState,
    sidebarFocused,
    isPromptFocused,
    showStopModal,
    showQuitModal,
    approvalPending,
    pendingQuestion,
    isSessionResumable,
    viewedSessionId,
    sessions: () => sessionCtx.sessions(),
    sidebarSelectedIndex,
    activeStore,
    workState,
    isInterrupted,
    get runtimesSize() { return runtimes.size },
    get sidebarVisible() {
      const hasSessions = sessionCtx.sessions().length > 0
      return hasSessions && (dimensions()?.width ?? 120) >= 90
    },

    // State setters
    setSidebarSelectedIndex,
    setIsPromptFocused,
    setSidebarFocused,
    setShowQuitModal,

    // Actions
    handleSessionSelect,
    backgroundSession,
    handleEscape,
    resumeSession,
    exitTUI,
    stopWorkflow,
    returnToIdle,
    returnToChat,
    // TUI helpers
    get activeSession() { return lifecycle.getActiveSession() },
    renderer,
    toast,
    dimensions,
  }

  useKeyboard((evt) => handleShellKeyEvent(evt, keyboardCtx))

  // ── Computed layout props ──

  const hasActiveWorkflow = () => activeStore() !== null && workState() !== null
  const runtime = () => runtimeText()
  const promptWidth = () => Math.min(100, Math.max(50, Math.floor((dimensions()?.width ?? 80) * 0.8)))

  // Default work state for SharedLayout when no workflow is active
  const defaultWorkState: WorkState = {
    planName: "",
    version: "0.0.1",
    startTime: 0,
    workflowStatus: "idle",
    queueSteps: [],
    outputLines: [],
    outputBlocks: [],
    error: undefined,
    selectedStepIndex: 0,
    scrollOffset: 0,
    visibleItemCount: 0,
    approvalState: { pending: false },
  }

  const layoutState = () => workState() ?? defaultWorkState


  // ── Unified prompt (Input + Overlay split for z-ordering) ──

  const prompt = useUnifiedPrompt({
    get appState() { return appState() },
    get approvalPending() { return approvalPending() },
    get sidebarFocused() { return sidebarFocused() },
    get isInterrupted() { return isInterrupted() },
    onCommand: handleCommand,
    onPromptSubmit: handlePromptInput,
    onEscape: handleEscape,
    get availableWidth() { return dimensions()?.width },
    get runningCount() { return runtimes.getRunningIds().length },
    get lifecycleState() { return viewedLifecycleState() },
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
          appState() === "chatting" ? (
            <ChatHeader version="0.0.1" />
          ) : hasActiveWorkflow() ? (
            <SessionHeader
              info={{
                sessionName: layoutState().planName,
                planName: layoutState().planName,
                workflowStatus: layoutState().workflowStatus,
                currentStep: currentStep()?.name,
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
          hasActiveWorkflow() && appState() !== "chatting" ? (
            <WorkflowPanel
              state={layoutState()}
              stepLabel={activeStepLabel()}
              selectedStepIndex={layoutState().selectedStepIndex}
              queueSteps={shellQueueSteps()}
              isInterrupted={isInterrupted()}
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
                currentStep={currentStep()}
                isInterrupted={isInterrupted()}
              />
            </box>
          </Show>
        </Show>
      </SharedLayout>

      {/* Bottom slot: QuestionPrompt (when pending) OR normal Prompt input */}
      <Show when={showThinkingIndicator()}>
        <box flexShrink={0} alignItems="center" justifyContent="center" paddingBottom={1}>
          <box width={promptWidth()} paddingLeft={1} paddingRight={1} flexDirection="row">
            <Spinner color={themeCtx.theme.primary} />
            <text fg={themeCtx.theme.textMuted}>{" "}</text>
            <ShimmerText text="Thinking..." color={themeCtx.theme.primary} />
          </box>
        </box>
      </Show>

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
          queueProgress={activeQueueInfo()}
          sprintInfo={activeSprintInfo()}
        />
      </box>

      {/* Status footer — always at the very bottom */}
      <StatusFooter
        appState={appState()}
        approvalPending={approvalPending()}
        isPromptFocused={isPromptFocused()}
        sidebarFocused={sidebarFocused()}
        sidebarVisible={sessionCtx.sessions().length > 0 && (dimensions()?.width ?? 120) >= 90}
        isSessionResumable={isSessionResumable()}
        isWorking={appState() === "working"}
        isInterrupted={isInterrupted()}
      />

      {/* Plan confirmation modal (HITL: user reviews plan before work steps are inserted) */}
      <Show when={pendingPlanConfirm()}>
        {(confirm) => (
          <PlanConfirmation
            plan={confirm().plan}
            onApprove={() => {
              confirm().resolve(true)
              setPendingPlanConfirm(null)
            }}
            onEdit={() => {
              confirm().resolve(false)
              setPendingPlanConfirm(null)
            }}
            onClose={() => {
              confirm().resolve(false)
              setPendingPlanConfirm(null)
            }}
          />
        )}
      </Show>

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
