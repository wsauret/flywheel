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
import { useDialog } from "@tui/shared/context/dialog"
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
import { openStarterChooser } from "./starter-chooser"
import { createActionDispatcher } from "./action-dispatcher"
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "./workflow-session"
import { useTimer } from "@tui/shared/services"
import { WorkController } from "../../controller/work"
import { ExecutionLoop, type PromptBuilder } from "../../controller/execution-loop"
import { WorkflowDefinitionProvider } from "../../controller/workflow-def-provider"
import { PhaseExecutor } from "../../controller/phase-executor"
import { prepareWorkflowDeps } from "../../controller/workflow-deps"
import type { WorkflowDeps } from "../../controller/workflow-deps"
import { EventBus, createFlywheelEmitter } from "../../events/event-bus"
import {
  workflowRegistry,
  buildWorkflowPrompt,
} from "../../workflows/index"
import { createPlanOnStepComplete } from "../../workflows/plan-output-extractor"
import { WorkflowPipeline } from "../../controller/workflow-pipeline"
import { QuestionService, type QuestionRequest } from "../../controller/question-service"
import { QuestionPrompt } from "./question-prompt"
import { StatusFooter } from "../routes/work/components/status-footer"
import { TelemetryBar } from "../routes/work/components/telemetry-bar"
import { buildPipelineStages, createShellStageRunner } from "./shell-pipeline"
import { parseHomeCommand } from "../routes/home/hooks/use-home-commands"
import { SIDEBAR_WIDTH } from "./shell-modes"
import { createOutputPersistence, type OutputFlusher } from "../../session/output-persistence"
import { readSession, updateSession, deleteSessionWithCompanions } from "../../session/persistence"
import { fromSnapshot, snapshotToBlocks } from "../../schemas/output"
import { createSessionOrchestrator, type SessionOrchestrator } from "./session-orchestrator"
import { handlePipelineCompletion } from "./pipeline-completion"
import { injectOutputBlocks } from "./resume-utils"
import type { PipelineStageInfo } from "../utils/format"
import type { WorkflowSession } from "./workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState } from "../routes/work/state/types"
import type { AnyBlock } from "../routes/work/state/types"
import type { Unsubscribe } from "../../events/event-bus"
import { sidebarKeyHandler, getOpenAction, groupToFlatList, type SelectionAction } from "./sidebar-logic"
import { createSessionViewport, type SessionViewport } from "./session-viewport"
import { isResumable } from "../../session/state-machine"
import { deriveHeaderInfo } from "./session-header-logic"

// ── App state ──

import {
  escapeForState,
  ctrlCForState,
  type AppState,
} from "./shell-modes"

export function FlywheelShell() {
  const themeCtx = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const sessionCtx = useSession()
  const timer = useTimer()
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
  let activeQuestionService: QuestionService | null = null
  let questionUnsubs: Unsubscribe[] = []

  // Pipeline stage indicator tracking
  const [activePipelineInfo, setActivePipelineInfo] = createSignal<PipelineStageInfo | null>(null)
  let pipelineUnsubs: Unsubscribe[] = []

  // Non-reactive refs for lifecycle management
  let activeSession: WorkflowSession | null = null
  let activeController: WorkController | null = null
  let activeLoop: ExecutionLoop | null = null
  let activePipeline: WorkflowPipeline | null = null
  let activeFlusher: OutputFlusher | null = null
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

  // ── Workflow Lifecycle ──

  const startWorkWorkflow = (planPath: string) => {
    // Clean up any previous session
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeController = null
      setActiveStore(null)
      setWorkState(null)
    }

    // Create fresh session: store -> adapter -> eventBus
    const session = createWorkflowSession(planPath)
    activeSession = session
    setActiveStore(session.store)
    subscribeToStore(session.store)
    setAppState("working")

    // Load config, resolve engine, create spawner
    const deps = getDepsOrReturnIdle()
    if (!deps) return
    const { config, engine, spawner } = deps

    // Create WorkController
    const controller = new WorkController({
      config,
      spawner,
      engine,
      ui: session.adapter,
    })
    activeController = controller

    queueMicrotask(() => {
      controller.run(planPath).catch(() => {})
    })
  }

  const startGenericWorkflow = (
    workflowName: string,
    args: Record<string, string>,
  ) => {
    const workflow = workflowRegistry[workflowName]
    if (!workflow) return

    // Clean up any previous session
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeController = null
      activeLoop = null
      setActiveStore(null)
      setWorkState(null)
    }

    // Create fresh session
    const session = createWorkflowSession(workflowName)
    activeSession = session
    setActiveStore(session.store)
    subscribeToStore(session.store)
    setAppState("working")

    // Load config
    const deps = getDepsOrReturnIdle()
    if (!deps) return
    const { config, engine, spawner } = deps

    // Wire event bus
    const eventBus = new EventBus()
    const emitter = createFlywheelEmitter(eventBus)
    session.adapter.connect(eventBus)

    const workflowId = `${workflowName}-tui`

    const executor = new PhaseExecutor({
      spawner,
      emitter,
      config,
      engine,
      workflowId,
    })

    const promptBuilder: PromptBuilder = (phase, ctx) =>
      buildWorkflowPrompt(
        phase.index,
        workflow,
        args,
        ctx.previousResult,
        config.project_cwd,
        ctx.extra,
      )

    const phaseProvider = new WorkflowDefinitionProvider(workflow)

    const isPlan = workflowName === "plan"
    const onStepComplete = isPlan && config.project_cwd
      ? createPlanOnStepComplete(config.project_cwd)
      : undefined

    const loop = new ExecutionLoop({
      phaseProvider,
      promptBuilder,
      executor,
      emitter,
      config,
      ui: session.adapter,
      workflowId,
      workflowLabel: workflow.name,
      onStepComplete,
      skipTruncation: isPlan,
    })
    activeLoop = loop

    queueMicrotask(() => {
      loop.run().catch(() => {})
    })
  }

  const startPipeline = (
    stages: import("../../controller/workflow-pipeline").PipelineStage[],
    args: Record<string, string>,
    preloadedDeps?: WorkflowDeps,
  ) => {
    // Clean up any previous session
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeController = null
      activeLoop = null
      activePipeline = null
      if (activeFlusher) {
        activeFlusher.dispose()
        activeFlusher = null
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

    // Create persistent CliSession for pause/resume support
    const planPathForSession = args.planPath ?? stages.map((s) => s.workflow).join(" -> ")
    try {
      const persistedSessionId = sessionCtx.manager.create(planPathForSession)
      sessionCtx.setActiveSessionId(persistedSessionId)

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

    // Create QuestionService for pipeline gates
    const questionService = new QuestionService(session.eventBus)
    activeQuestionService = questionService

    cleanupQuestionSubscriptions()
    questionUnsubs.push(
      session.eventBus.subscribeToType("question:asked", (e) => {
        const pending = questionService.list()
        if (pending.length > 0) {
          setPendingQuestion(pending[0])
        }
      }),
      session.eventBus.subscribeToType("question:replied", () => {
        setPendingQuestion(null)
      }),
      session.eventBus.subscribeToType("question:rejected", () => {
        setPendingQuestion(null)
      }),
    )

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
        // Final flush on pipeline completion
        if (activeFlusher) {
          activeFlusher.schedule()
          activeFlusher.flush().catch(() => {})
        }
      }),
      session.eventBus.subscribeToType("pipeline:failed", () => {
        setActivePipelineInfo(null)
      }),
      // Event-driven flush: persist output after each phase completes
      session.eventBus.subscribeToType("phase:completed", () => {
        if (activeFlusher) {
          activeFlusher.schedule()
        }
      }),
    )

    // Create stage runner
    const stageRunner = createShellStageRunner(session, deps)

    // Create and start the pipeline
    const pipeline = new WorkflowPipeline({
      stages,
      args,
      config: deps.config,
      stageRunner,
      questionService,
      eventBus: session.eventBus,
    })
    activePipeline = pipeline
    _isPipelineRunning = true
    _userInitiatedPause = false

    // Register pipeline in sessionControllers (uniform shutdown interface)
    const pipelineSessionId = sessionCtx.activeSessionId()
    if (pipelineSessionId) {
      sessionControllers.set(pipelineSessionId, {
        shutdown: async () => {
          pipeline.requestShutdown()
        },
      })
      setViewedSessionId(pipelineSessionId)
    }

    queueMicrotask(async () => {
      let pipelineResult: import("../../controller/workflow-pipeline").PipelineResult | undefined
      try {
        pipelineResult = await pipeline.run()
        if (!pipelineResult.completed && !_userInitiatedPause) {
          activeStore()?.setError(pipelineResult.reason ?? "Pipeline failed")
          // Persist lifecycle state as work:paused (failure ≠ completed)
          if (pipelineSessionId) {
            try { sessionCtx.manager.updateState(pipelineSessionId, "work:paused") } catch {}
            sessionCtx.refreshList()
          }
          setAppState("completed")
        }
      } catch (err) {
        if (!_userInitiatedPause) {
          activeStore()?.setError(String(err))
          // Persist lifecycle state as work:paused (crash ≠ completed)
          if (pipelineSessionId) {
            try { sessionCtx.manager.updateState(pipelineSessionId, "work:paused") } catch {}
            sessionCtx.refreshList()
          }
          setAppState("completed")
        }
      } finally {
        _isPipelineRunning = false

        // Remove from sessionControllers on completion (keep in sessionStores for cached viewing)
        if (pipelineSessionId) {
          sessionControllers.delete(pipelineSessionId)
        }

        // Handle auto-archive or completion
        if (pipelineResult && !_userInitiatedPause) {
          await handlePipelineCompletion(pipelineResult, {
            orchestrator,
            sessionId: sessionCtx.activeSessionId(),
            flusher: activeFlusher,
            toast,
            updateState: (id, s) => sessionCtx.manager.updateState(id, s),
            refreshList: () => sessionCtx.refreshList(),
          })
          activeFlusher = null
        }
      }
    })
  }

  const cleanupQuestionSubscriptions = () => {
    for (const unsub of questionUnsubs) unsub()
    questionUnsubs = []
    setPendingQuestion(null)
    activeQuestionService = null
  }

  const cleanupPipelineSubscriptions = () => {
    for (const unsub of pipelineUnsubs) unsub()
    pipelineUnsubs = []
    setActivePipelineInfo(null)
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
    if (activeLoop) {
      activeLoop.requestShutdown()
      activeLoop = null
    }
    let shutdownPromise: Promise<void> | undefined
    if (activeController) {
      shutdownPromise = activeController.shutdown().catch(() => {})
      activeController = null
    }
    return shutdownPromise
  }

  const teardownActiveWorkflow = (): Promise<void> | undefined => {
    cleanupQuestionSubscriptions()
    cleanupPipelineSubscriptions()
    if (storeUnsub) {
      storeUnsub()
      storeUnsub = null
    }
    // Dispose output flusher (does NOT flush — just cancels timers)
    if (activeFlusher) {
      activeFlusher.dispose()
      activeFlusher = null
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
    const sessionId = sessionCtx.activeSessionId()

    await teardownActiveWorkflow()

    // Persist lifecycle state as work:paused (manual stop ≠ completed)
    if (sessionId) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch {
        // Best effort — session may already be in a terminal state
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

    // Shut down pipeline, loop, and controller (but NOT session/adapter/store)
    _clearPipelineRuntime()

    // Persist session state as work:paused
    // Use sessionControllers keyset to find all running sessions — NOT activeSessionId(),
    // which may point to the most recently started session, not necessarily the one
    // the user intends to pause. With viewport switching, the user may be viewing
    // a different session than the one that's running.
    const runningSessionIds = [...sessionControllers.keys()]
    for (const sessionId of runningSessionIds) {
      try {
        sessionCtx.manager.updateState(sessionId, "work:paused")
      } catch (err) {
        toast.show({
          message: `Failed to persist pause state: ${err instanceof Error ? err.message : String(err)}`,
          variant: "warning",
        })
      }
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
   * Unlike startPipeline(), this does NOT create a new CliSession on disk
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

    // 5. Inject output blocks in chunks (prevents UI freeze on large histories)
    injectOutputBlocks(session.store, snapshotToBlocks(result.outputBlocks) as AnyBlock[])

    // 6. Wire session context (reuse existing session ID — no new CliSession)
    sessionCtx.setActiveSessionId(sessionId)

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

    // 10. Start WorkController directly (reads .state.md, skips completed phases).
    //     We do NOT call startPipeline() because that creates a new CliSession
    //     and tears down the session we just set up.
    const controller = new WorkController({
      config: deps.config,
      spawner: deps.spawner,
      engine: deps.engine,
      ui: session.adapter,
    })
    activeController = controller

    // Register controller in sessionControllers
    sessionControllers.set(sessionId, {
      shutdown: () => controller.shutdown(),
    })
    setViewedSessionId(sessionId)

    // 11. Transition to working
    setAppState("working")

    queueMicrotask(() => {
      controller.run(result.planPath).then(() => {
        // On completion: remove from sessionControllers, keep in sessionStores
        sessionControllers.delete(sessionId)
      }).catch(() => {
        sessionControllers.delete(sessionId)
      })
    })
  }

  /**
   * Handle session selection from the sidebar.
   * Routes to open (viewport switch) or delete.
   */
  /** Look up a session's display name by ID (O(1) via memoized Map). */
  const sessionName = (id: string): string => {
    const s = sessionsMap().get(id)
    return s?.name || s?.planPath || id.slice(0, 8)
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

  // Clean up on component unmount
  onCleanup(() => {
    escapeHandler.dispose()
    teardownActiveWorkflow()
  })

  // ── Command Handler (via ActionDispatcher) ──

  const launchWorkWithPipeline = (planPath: string) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    const stages = buildPipelineStages("work", deps.config)
    if (stages) {
      startPipeline(stages, { planPath }, deps)
    } else {
      startWorkWorkflow(planPath)
    }
  }

  const launchGenericWithPipeline = (name: string, args: Record<string, string>) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    const stages = buildPipelineStages(name, deps.config)
    if (stages) {
      startPipeline(stages, args, deps)
    } else {
      startGenericWorkflow(name, args)
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
    exit: exitTUI,
    returnToLauncher: returnToIdle,
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
        exitTUI()
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

      const result = parseHomeCommand(trimmed)

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
      // Active mode: approval handling
      const state = workState()
      if (state?.approvalState?.pending) {
        // Approve (with optional steering prompt)
        if (activeSession) {
          activeSession.adapter.onApprovalDecision?.(true)
        }
        activeStore()?.clearApproval()
      }
      return
    }
  }

  // ── Shell-Level Keyboard Shortcuts ──

  useKeyboard((evt) => {
    // === Sidebar-focused key routing ===
    // When sidebar has focus, intercept navigation keys before anything else.
    // Modal guards: sidebar focus is disabled when stop/error/approval modals are open.
    if (sidebarFocused() && !showStopModal() && !approvalPending() && !pendingQuestion()) {
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
    if (evt.name === "escape") {
      const currentState = appState()
      if (currentState === "working" || currentState === "importing" || currentState === "completed") {
        evt.preventDefault()
        handleEscape()
        return
      }
    }

    // Ctrl+T: toggle theme (always available)
    if (evt.ctrl && evt.name === "t") {
      evt.preventDefault()
      themeCtx.setMode(themeCtx.mode === "dark" ? "light" : "dark")
      return
    }
    // Ctrl+N: open starter chooser dialog
    if (evt.ctrl && evt.name === "n") {
      evt.preventDefault()
      openStarterChooser(dialog, (selection) => {
        if (selection === "import-plan") {
          toast.show({ message: "Type /work <plan-path> to start", variant: "info" })
        } else if (selection === "new-idea") {
          toast.show({ message: "Type /plan <description> to create a plan", variant: "info" })
        }
      })
      return
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
          exitTUI()
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
  const runtime = () => timer.workflowRuntime()

  // Default work state for SharedLayout when no workflow is active
  const defaultWorkState: WorkState = {
    planName: "",
    version: "0.0.1",
    startTime: 0,
    workflowStatus: "idle",
    phases: [],
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
        {/* Center content: EmptyState when idle, OutputWindow when working/completed */}
        <Show
          when={hasActiveWorkflow() || appState() === "completed"}
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
            <box flexDirection="column" width="100%">
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

      {/* Prompt input — always present below the layout */}
      <box flexShrink={0} alignItems="center" justifyContent="center" onMouseDown={() => {
        if (sidebarFocused()) {
          setSidebarFocused(false)
        }
      }}>
        <prompt.Input />
      </box>

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
          pipelineInfo={activePipelineInfo()}
        />
      </box>

      {/* Status footer — always at the very bottom */}
      <StatusFooter
        approvalPending={approvalPending()}
        isPromptFocused={isPromptFocused()}
        sidebarFocused={sidebarFocused()}
        sidebarVisible={sessionCtx.sessions().length > 0 && (dimensions()?.width ?? 120) >= 90}
        isSessionResumable={isSessionResumable()}
      />

      {/* QuestionPrompt overlay — shown when pipeline gate asks a question */}
      <Show when={pendingQuestion() && activeQuestionService}>
        <QuestionPrompt
          request={pendingQuestion()!}
          questionService={activeQuestionService!}
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
