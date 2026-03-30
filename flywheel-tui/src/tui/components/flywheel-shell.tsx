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
import { randomUUID } from "node:crypto"
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
import { prepareWorkflowDeps } from "../../controller/workflow-deps"
import type { WorkflowDeps } from "../../controller/workflow-deps"
import { EventBus } from "../../events/event-bus"
import type { QueueResult } from "../../controller/queue-types"
import type { QuestionRequest } from "../../controller/question-service"
import { QuestionPrompt } from "./question-prompt"
import { StatusFooter } from "../routes/work/components/status-footer"
import { TelemetryBar } from "../routes/work/components/telemetry-bar"
import { workflowHasReview, WORKFLOW_OPTIONS, type WorkflowName } from "./start-command"
import { buildQueue, buildQueueForSlashCommand, buildQueueFromPlan, type QueueProgressInfo, createEndOfSessionGate as createQueueEndOfSessionGate } from "./shell-queue"
import { buildQueueFromTemplate } from "../../queue/templates"
import { createStepExecutor, type StepExecutor, type StepExecutorResult } from "../../queue/executor"
import { createSprintQueueHandler, type SprintQueueHandler } from "../../queue/sprint"
import { createDebugQueueHandler } from "../../queue/debug-loop"
import { runVerificationScript } from "../../sprint/verification-runner"
import { createFlywheelEmitter } from "../../events/event-bus"
import { createQueuePersistence } from "../../queue/persistence"
import { createQueue } from "../../queue/queue"
import type { Queue } from "../../queue/types"
import { parseCommand } from "../utils/command-parser"
import { createQuestionWiring, type QuestionWiring } from "../utils/question-wiring"
import { SIDEBAR_WIDTH } from "./shell-modes"
import { createOutputPersistence, type OutputFlusher } from "../../session/output-persistence"
import { createTranscriptLogger, type TranscriptLogger } from "../../session/transcript"
import { readSession, updateSession, deleteSessionWithCompanions } from "../../session/persistence"
import { createBudgetTracker, type BudgetTracker } from "../../session/budget-tracker"
import type { BudgetLimits } from "../../schemas/shared"
import { fromSnapshot, snapshotToBlocks } from "../../schemas/output"
import { createSessionOrchestrator, type SessionOrchestrator } from "./session-orchestrator"
import { handleQueueCompletion } from "./queue-completion"
import { safeUpdateState } from "../../session/safe-transition"
import { ContextIndexer } from "../../memory/indexer"
import { injectOutputBlocks } from "./resume-utils"
import type { SprintIterationInfo } from "../utils/format"
import type { WorkflowSession } from "./workflow-session"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { WorkState } from "../routes/work/state/types"
import type { AnyBlock } from "../routes/work/state/types"
import type { Unsubscribe } from "../../events/event-bus"
import { sidebarKeyHandler, getOpenAction, groupToFlatList, type SelectionAction } from "./sidebar-logic"
import { TEST_STEPS, setupTestFixture, buildTestQueue, type TestStepDef } from "./test-step"
import { createSessionViewport, type SessionViewport } from "./session-viewport"
import { isResumable } from "../../session/state-machine"
import { deriveHeaderInfo } from "./session-header-logic"
import { autoDetectTransport } from "../../dispatcher/auto-detect"
import { createEvaluatorTransport } from "../../evaluator/create-transport"
import { killAllActiveProcesses, interruptAllActiveProcesses } from "../../worker/process-lifecycle"
import { Log } from "../../utils/log"
import { SubprocessLogger } from "../../utils/subprocess-logger.js"
import { createStepDispatcher, type StepDispatchContext } from "../../queue/step-dispatcher"
import { createAgentEvaluatorFn } from "../../evaluator/create-agent-evaluator"
import { readHandoff } from "../../handoff/reader"
import { WorkerHandoffSchema } from "../../schemas/handoff"
import { createContextAccumulator } from "../../queue/context-accumulator"
import { createPlanIntegrationHook, createCompositeHook } from "../../queue/plan-integration"
import { createReviewFixInjectionHook } from "../../queue/review-fix-injection"
import { createReviewP3TriageHook } from "../../queue/review-p3-triage"
import { buildScaffolding, type ScaffoldingPaths } from "../../queue/prompt-scaffolding"
import {
  sessionDir,
  sessionHandoffsDir,
  buildWorkerHandoffPath,
  ensureSessionDir,
  resolveSessionFile,
} from "../../config/paths"
import { resolveModels } from "../../config/loader"
import type { StdinHandle } from "../../worker/spawner"
import { formatClaudeStdinMessage } from "../../worker/stdin-format"

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
  let activeQuestionWiring: QuestionWiring | null = null

  // Queue progress indicator tracking
  const [activeQueueInfo, setActiveQueueInfo] = createSignal<QueueProgressInfo | null>(null)
  // Sprint iteration tracking for telemetry bar
  const [activeSprintInfo, setActiveSprintInfo] = createSignal<SprintIterationInfo | null>(null)

  // Direct reactive queue steps signal for WorkflowPanel.
  // Bypasses the store → workState signal chain which breaks SolidJS fine-grained
  // reactivity for nested array properties at runtime. Updated directly from
  // event bus subscriptions, matching the proven pattern of activeQueueInfo.
  const [shellQueueSteps, setShellQueueSteps] = createSignal<import("../routes/work/state/types").QueueStepState[]>([])
  let queueUnsubs: Unsubscribe[] = []

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
  let activeStepExecutor: StepExecutor | null = null
  let activeQueue: Queue | null = null
  /** Mutable ref for the currently running worker's stdin handle (mid-execution injection). */
  const activeStdinHandleRef: { current: StdinHandle | null } = { current: null }
  let activeFlusher: OutputFlusher | null = null
  let activeTranscript: TranscriptLogger | null = null
  let activeBudgetTracker: BudgetTracker | null = null
  let storeUnsub: (() => void) | null = null

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

  // User-initiated pause flag: set when double-Esc pauses a queue.
  // Distinguishes pause from failure so ErrorModal is suppressed.
  let _userInitiatedPause = false

  // Interrupt-abort flag: set when first Esc aborts the executor mid-step.
  // Unlike _userInitiatedPause (which is set by the full pause/kill flow),
  // this flag tells the queue result handler to transition to work:paused
  // and "completed" app state WITHOUT showing the ErrorModal.
  let _interruptAbort = false

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
  // Lazy-init: created on first queue start, disposed on shell unmount.
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
   * Resolve dispatcher and evaluator transports for queue execution.
   * Shared between startQueueExecution and resumeSession queue paths.
   */
  async function resolveTransports(deps: WorkflowDeps, eventBus: EventBus, workflowIdRef: { current: string }, logBaseDir: string, sessionId?: string, baseDir?: string) {
    const engineName = deps.config.engine

    let dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined
    try {
      const { resolveModels } = await import("../../config/loader")
      const { dispatcherModel } = resolveModels(deps.config)
      const resolved = await autoDetectTransport({
        spawner: deps.spawner,
        engineName,
        dispatcherModel,
        onStdout: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
        onStderr: (chunk) => eventBus.emit({ type: "dispatcher:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
        logBaseDir,
        sessionId,
        baseDir,
      })
      dispatcherTransport = resolved.transport
      log.info("queue dispatcher transport resolved", { label: resolved.label, engine: engineName })
    } catch (err) {
      log.warn("queue dispatcher transport auto-detect failed", {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    let evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined
    if (!deps.config.skip_evaluation) {
      try {
        const { resolveModels: resolveModelsForEval } = await import("../../config/loader")
        const { dispatcherModel: evalModel } = resolveModelsForEval(deps.config)
        evaluatorTransport = await createEvaluatorTransport({
          spawner: deps.spawner,
          engineName,
          evaluatorModel: evalModel,
          onStdout: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stdout", data: chunk, engineName, timestamp: Date.now() }),
          onStderr: (chunk) => eventBus.emit({ type: "evaluator:output", workflowId: workflowIdRef.current, stream: "stderr", data: chunk, engineName, timestamp: Date.now() }),
          logBaseDir,
          sessionId,
          baseDir,
        })
        log.info("queue evaluator transport created", { engine: engineName })
      } catch (err) {
        log.warn("queue evaluator transport creation failed", {
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return { dispatcherTransport, evaluatorTransport }
  }

  /**
   * Build the shared executor dependencies (dispatcher, accumulator, evaluator,
   * hooks, worker callback, handoff reader) used by both startQueueExecution
   * and resumeSession. Eliminates ~150 lines of duplication between the two paths.
   */
  function buildExecutorDeps(opts: {
    deps: WorkflowDeps;
    emitter: ReturnType<typeof createFlywheelEmitter>;
    workflowIdRef: { current: string };
    dispatcherTransport: import("../../dispatcher/transport").DispatcherTransport | undefined;
    evaluatorTransport: import("../../evaluator/transport").EvaluatorTransport | undefined;
    contextIndexer: ContextIndexer;
    projectCwd: string;
    sessionObjective: string | undefined;
    queue: Queue;
    /** Session ID for session-scoped file paths. */
    sessionId: string;
    /** Mutable ref to store the active worker's stdin handle for mid-execution injection. */
    stdinHandleRef?: { current: StdinHandle | null };
    /** Pre-seed context accumulator with fixture handoff (for /test command). */
    seedHandoff?: Record<string, unknown> | null;
  }) {
    const { deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport, contextIndexer, projectCwd, sessionObjective, queue, stdinHandleRef, seedHandoff, sessionId: execSessionId } = opts
    const { dispatcherModel, workerModel } = resolveModels(deps.config)

    // Build real StepDispatcher if transport is available
    const realDispatcher = dispatcherTransport
      ? createStepDispatcher({
          transport: dispatcherTransport,
          emitter,
          workflowId: workflowIdRef.current,
          configContext: {
            maxEvalCycles: deps.config.max_revisions ?? 1,
            worktreePath: projectCwd,
            projectCwd,
            workerModel: workerModel ?? "sonnet",
            dispatcherModel: dispatcherModel ?? "sonnet",
          },
          sessionBudget: { wall_clock_deadline: null, invocations_remaining: null, token_budget_remaining: null },
          availableContext: contextIndexer.getRelevantContext({ stepType: "plan", stepDescription: sessionObjective ?? "" }),
          sessionObjective,
        })
      : null

    // Real context accumulator (windowed detail strategy)
    const contextAccumulator = createContextAccumulator()

    // Seed accumulator with fixture handoff data (for /test command)
    if (seedHandoff) {
      contextAccumulator.accumulate(seedHandoff)
    }

    // Agent-based evaluator (if evaluation not skipped and transport available)
    // Verify steps skip evaluation entirely — they use direct verification scripts.
    const baseEvaluator = !deps.config.skip_evaluation && evaluatorTransport
      ? createAgentEvaluatorFn({ transport: evaluatorTransport })
      : null
    const evaluator = baseEvaluator
      ? async (step: import("../../queue/types").Step, workerOutput: string, evaluationCriteria?: unknown | null, handoffData?: Record<string, unknown> | null) => {
          // Skip evaluation for verify steps (sprint verification is handled by the sprint handler)
          if (step.type === "verify") {
            return { passed: true, skipped: true, transportError: false, reason: null, feedback: null, suggestions: [], cyclesUsed: 0 }
          }
          return baseEvaluator(step, workerOutput, evaluationCriteria, handoffData)
        }
      : null

    // Sprint queue handler: wire when queue contains verify steps but NOT debug steps
    // (debug queues also have verify steps but use the debug-loop handler instead)
    const isDebugQueue = queue.steps.some(s => s.type === "debug")
    const isSprintQueue = !isDebugQueue && queue.steps.some(s => s.type === "verify")
    let sprintHandler: SprintQueueHandler | null = null
    if (isSprintQueue) {
      sprintHandler = createSprintQueueHandler({
        taskDescription: sessionObjective ?? "",
        projectCwd,
        sprintConfig: {
          max_iterations: deps.config.sprint?.max_iterations ?? 5,
          verification_timeout_ms: deps.config.sprint?.verification_timeout_ms ?? 30000,
          escalate_to_full: deps.config.sprint?.escalate_to_full ?? true,
          escalate_on_stuck: deps.config.sprint?.escalate_on_stuck ?? false,
        },
        emitter,
        workflowId: workflowIdRef.current,
        runVerification: runVerificationScript,
        readHandoff: async (handoffPath: string) => {
          if (!handoffPath) return null
          try {
            const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
            return handoff as unknown as Record<string, unknown>
          } catch { return null }
        },
      })
    }

    // Debug queue handler (isDebugQueue already computed above for sprint exclusion)
    const debugHandler = isDebugQueue ? createDebugQueueHandler() : null

    // Plan integration hook + review fix injection + P3 triage + debug hook + sprint hook + TUI step insertion composite hook
    const planIntegrationHook = createPlanIntegrationHook(projectCwd)
    const reviewFixInjectionHook = createReviewFixInjectionHook()
    const reviewP3TriageHook = createReviewP3TriageHook({ questionService: activeQuestionWiring?.service ?? null })
    const compositeHook = createCompositeHook([
      planIntegrationHook,
      reviewFixInjectionHook,
      reviewP3TriageHook,
      debugHandler?.onStepCompleted ?? null,
      sprintHandler?.onStepCompleted ?? null,
      async (step, status, q, _handoffData) => {
        // Refresh TUI step list when plan, review, or verify steps complete
        // (plan integration inserts work steps; review-fix-injection may insert a fix step;
        // sprint handler inserts retry pairs or escalation steps)
        if (status === "completed" && (step.type === "plan" || step.type === "review" || step.type === "verify")) {
          const updatedQueueStepStates = q.steps.map(s => ({
            id: s.id,
            type: s.type,
            title: s.title,
            status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
          }))
          setShellQueueSteps(updatedQueueStepStates)
        }
        // Also refresh on failed verify/work steps in sprint or debug (retry pairs get inserted)
        if ((isSprintQueue || isDebugQueue) && status === "failed" && (step.type === "work" || step.type === "verify" || step.type === "debug")) {
          const updatedQueueStepStates = q.steps.map(s => ({
            id: s.id,
            type: s.type,
            title: s.title,
            status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
          }))
          setShellQueueSteps(updatedQueueStepStates)
        }
        return { continueExecution: false }
      },
    ])

    // Dispatcher callback: real dispatcher with fallback to step metadata
    // Sprint work steps use the sprint handler's prompt builder for iteration-aware prompts
    const dispatcherFn = async (step: import("../../queue/types").Step, context: { previousHandoff?: unknown; previousAssessment?: unknown; hitlResponse?: unknown }) => {
      // Sprint work steps: use sprint handler's prompt builder (iteration-aware)
      if (sprintHandler && step.type === "work" && isSprintQueue) {
        const sprintPrompt = sprintHandler.buildWorkStepPrompt(step)
        return { prompt: sprintPrompt, evaluationCriteria: null }
      }

      // Verify steps: no dispatcher needed (they run verification scripts directly)
      if (step.type === "verify") {
        return { prompt: "", evaluationCriteria: null }
      }

      if (realDispatcher) {
        try {
          const dispatchContext: StepDispatchContext = {
            accumulatedContext: contextAccumulator.getContext() as any,
            previousHandoff: (context.previousHandoff as Record<string, unknown>) ?? null,
            previousAssessment: (context.previousAssessment as any) ?? null,
            hitlResponse: (context.hitlResponse as string) ?? null,
          }
          const decision = await realDispatcher.dispatch(step, queue, dispatchContext)
          return {
            prompt: decision.taskContent,
            evaluationCriteria: decision.evaluationCriteria,
          }
        } catch (err) {
          log.warn("real dispatcher failed, falling back to step metadata", {
            stepId: step.id,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      const parts = [step.title]
      if (step.description) parts.push(step.description)
      if (step.acceptanceCriteria?.length) {
        parts.push("Acceptance criteria:", ...step.acceptanceCriteria.map(c => `- ${c}`))
      }
      if (step.evaluationCriteria) parts.push(`Evaluation: ${step.evaluationCriteria}`)
      return { prompt: parts.join("\n"), evaluationCriteria: null }
    }

    // Worker callback: spawn engine process (or run verification script for verify steps)
    const useStdinPipe = deps.engine.metadata.supportsStreamingInput
    const workerFn = async (step: import("../../queue/types").Step, prompt: string) => {
      // Sprint verify steps: run verification script directly (no dispatcher/worker/evaluator)
      if (step.type === "verify" && sprintHandler) {
        const startTime = Date.now()
        const verifyResult = await sprintHandler.executeVerifyStep(step, null)
        // Write verification result as a pseudo-handoff so the sprint handler
        // can read it back in onStepCompleted
        const invocationId = randomUUID()
        const handoffPath = buildWorkerHandoffPath(execSessionId, step.type, step.id, projectCwd)
        ensureSessionDir(execSessionId, projectCwd)
        try {
          const verifySummary = verifyResult.passed
            ? `Verification passed (exit code ${verifyResult.exitCode ?? 0}).`
            : `Verification failed: ${verifyResult.error ?? `exit code ${verifyResult.exitCode ?? 1}`}.`
          const handoffData = {
            summary: verifySummary.replace(/[\n\r]/g, " ").slice(0, 500),
            verificationResult: verifyResult,
          }
          await Bun.write(handoffPath, JSON.stringify(handoffData, null, 2))
        } catch (err) {
          log.warn("failed to write verify handoff", { error: err instanceof Error ? err.message : String(err) })
        }
        // Emit output for TUI display
        const statusLabel = verifyResult.passed ? "✅ PASSED" : "❌ FAILED"
        emitter.workerOutput(workflowIdRef.current, "stderr",
          `Verification ${statusLabel}${verifyResult.exitCode !== undefined ? ` (exit code ${verifyResult.exitCode})` : ""}\n`,
          "verification-runner")
        if (verifyResult.stdout) {
          emitter.workerOutput(workflowIdRef.current, "stdout", verifyResult.stdout, "verification-runner")
        }
        if (verifyResult.stderr) {
          emitter.workerOutput(workflowIdRef.current, "stderr", verifyResult.stderr, "verification-runner")
        }
        if (verifyResult.error) {
          emitter.workerOutput(workflowIdRef.current, "stderr", `Error: ${verifyResult.error}\n`, "verification-runner")
        }
        return {
          output: verifyResult.passed ? "completed" : "verification failed",
          handoffPath,
          durationMs: Date.now() - startTime,
        }
      }

      const invocationId = randomUUID()

      // Compute handoff path BEFORE spawning — session-scoped with meaningful name
      const handoffPath = buildWorkerHandoffPath(execSessionId, step.type, step.id, projectCwd)
      ensureSessionDir(execSessionId, projectCwd)

      // Build session-scoped paths for scaffolding
      const scaffoldingPaths: ScaffoldingPaths = {
        handoffPath,
        planPath: `${sessionDir(execSessionId)}/plan.json`,
        researchPath: `${sessionDir(execSessionId)}/research.md`,
        reviewPath: `${sessionDir(execSessionId)}/review.md`,
      }

      // Build deterministic scaffolding (preamble before task_content, postamble after)
      const scaffolding = buildScaffolding(step, scaffoldingPaths)
      const parts: string[] = []
      if (scaffolding.preamble) parts.push(scaffolding.preamble)
      parts.push(prompt)
      if (scaffolding.postamble) parts.push(scaffolding.postamble)
      const fullPrompt = parts.join("\n\n")

      const engineCmd = deps.engine.buildCommand({
        prompt: fullPrompt,
        model: deps.config.worker?.model ?? deps.config.model,
        toolScoping: step.toolScoping ?? undefined,
      })
      const startTime = Date.now()
      const rawStdinContent = engineCmd.stdinPrompt
        ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + fullPrompt : fullPrompt)
        : undefined
      // NDJSON-wrap stdin content when using streaming pipe (Claude's --input-format stream-json)
      const stdinContent = useStdinPipe && rawStdinContent
        ? formatClaudeStdinMessage(rawStdinContent)
        : rawStdinContent
      // Turn-complete callback: when the worker finishes a turn (result event)
      // and the stdin pipe is still open, either inject a pending message or
      // close the pipe to let the step advance.
      const onTurnComplete = useStdinPipe ? (sessionId: string | undefined) => {
        // Capture session ID for --resume/--session after interrupt
        capturedWorkerSessionId.current = sessionId
        // Check for pending injection (user typed while worker was running)
        if (pendingInjection.current && stdinHandleRef?.current?.isOpen) {
          const message = pendingInjection.current
          pendingInjection.current = null
          const written = stdinHandleRef.current.write(formatClaudeStdinMessage(message))
          if (written) {
            log.info("turn-boundary injection sent to worker", { length: message.length })
            // Emit event for TUI display
            if (activeSession) {
              activeSession.eventBus.emit({
                type: "worker:injected",
                workflowId: workflowIdRef.current,
                message,
                timestamp: new Date().toISOString(),
              })
            }
          } else {
            log.warn("turn-boundary injection failed — pipe closed")
          }
        } else {
          // No pending injection — close the pipe to let the step advance
          stdinHandleRef?.current?.close()
        }
      } : undefined

      const spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, {
        cwd: projectCwd,
        invocationId,
        sessionId: execSessionId,
        handoffFileName: `${step.type}_${step.id}.json`,
        stdin: stdinContent,
        stdinPipe: useStdinPipe && stdinContent !== undefined,
        onTurnComplete,
        onSessionId: (sessionId) => {
          capturedWorkerSessionId.current = sessionId
        },
        onStdout: (chunk) => {
          emitter.workerOutput(workflowIdRef.current, "stdout", chunk, deps.engine.metadata.id)
        },
        onStderr: (chunk) => {
          emitter.workerOutput(workflowIdRef.current, "stderr", chunk, deps.engine.metadata.id)
        },
      })
      // Expose stdinHandle for mid-execution injection (user steering)
      if (stdinHandleRef && spawnResult.stdinHandle) {
        stdinHandleRef.current = spawnResult.stdinHandle
      }
      try {
        const workerResult = await spawnResult.result
        // Capture session ID from worker result (fallback for non-streaming engines)
        if (workerResult.sessionId) {
          capturedWorkerSessionId.current = workerResult.sessionId
        }
        return {
          output: workerResult.exitCode === 0 ? "completed" : (workerResult.failure?.message ?? "failed"),
          handoffPath: workerResult.handoffPath ?? "",
          durationMs: Date.now() - startTime,
          sessionId: workerResult.sessionId,
        }
      } finally {
        // Clear handle when worker finishes (pipe is closed)
        if (stdinHandleRef) {
          stdinHandleRef.current = null
        }
      }
    }

    // Handoff reader callback
    const handoffReader = async (handoffPath: string) => {
      if (!handoffPath) return null
      try {
        const handoff = await readHandoff(handoffPath, WorkerHandoffSchema)
        return handoff as unknown as Record<string, unknown>
      } catch (err) {
        log.warn("handoff read failed, continuing without handoff", {
          path: handoffPath,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      }
    }

    return {
      contextAccumulator,
      evaluator,
      compositeHook,
      dispatcherFn,
      workerFn,
      handoffReader,
      sprintHandler,
    }
  }

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

  /**
   * Start queue-based execution. Creates a new session, builds the queue,
   * wires events, and runs the step executor.
   *
   * VAL-SHELL-013: Shell transitions idle→working on queue start
   * VAL-SHELL-014: Shell transitions working→completed on queue success
   * VAL-SHELL-015: Shell transitions working→completed on queue failure
   * VAL-SHELL-019: Session created when queue starts
   * VAL-SHELL-020: Session lifecycle follows queue progression
   * VAL-SHELL-035: Output blocks render during step execution
   */
  /**
   * Start queue-based execution. Creates a new session, builds the queue,
   * wires events, and runs the step executor.
   *
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
    /** Pre-seed the context accumulator with fixture handoff data (for /test). */
    seedHandoff?: Record<string, unknown> | null,
  ) => {
    // Background previous session (don't destroy — allow concurrent queues)
    const prevFocused = focusedSessionId()
    if (prevFocused && runtimes.has(prevFocused)) {
      runtimes.background(prevFocused)
      activeSession = null
      activeStepExecutor = null
      activeQueue = null
      activeStdinHandleRef.current = null
      activeFlusher = null
      if (activeTranscript) {
        activeTranscript.dispose()
        activeTranscript = null
      }
      activeBudgetTracker = null
      if (storeUnsub) {
        storeUnsub()
        storeUnsub = null
      }
      cleanupQuestionSubscriptions()
      cleanupQueueSubscriptions()
      setActiveStore(null)
      setWorkState(null)
    } else if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
      activeStepExecutor = null
      activeQueue = null
      activeStdinHandleRef.current = null
      if (activeFlusher) {
        activeFlusher.dispose()
        activeFlusher = null
      }
      if (activeTranscript) {
        activeTranscript.dispose()
        activeTranscript = null
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

    // Start workflow — sets workflowStatus to "running" and initializes store
    const planLabel = args.planPath ?? args.description ?? queue.steps.map((s) => s.type).join(" → ")
    session.store.startWorkflow(planLabel)

    // Populate queue step display state for workflow panel BEFORE setting
    // appState to "working". This ensures the panel has step data available
    // on its first render (avoids "Steps: 0/0" / "No steps yet" flash).
    const initialQueueStepStates = queue.steps.map((s) => ({
      id: s.id,
      type: s.type,
      title: s.title,
      status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
    }))
    session.store.setQueueSteps(initialQueueStepStates)
    // Also update the direct reactive signal (bypasses store → workState chain)
    setShellQueueSteps(initialQueueStepStates)

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
      updateSession(persistedSessionId, { outputPath: "output.json" }, projectCwd)

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

      // Start transcript logger — append-only JSONL capturing ALL events
      activeTranscript = createTranscriptLogger({
        sessionId: persistedSessionId,
        baseDir: projectCwd,
      })
      activeTranscript.subscribeTo(session.eventBus)

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

    // Queue event subscriptions (replaces queue event subscriptions)
    cleanupQueueSubscriptions()
    // Re-populate shellQueueSteps after cleanup (cleanupQueueSubscriptions resets
    // the signal to [], overwriting the initial population from line ~909).
    setShellQueueSteps(initialQueueStepStates)
    let stepCounter = 0
    // Sprint detection: a queue with verify-type steps is a sprint queue
    let isSprintQueue = queue.steps.some(s => s.type === "verify")
    let sprintWorkStepCount = 0
    queueUnsubs.push(
      session.eventBus.subscribeToType("queue:initialized", (e) => {
        stepCounter = 0
        sprintWorkStepCount = 0
        // Re-check sprint status in case queue was rebuilt
        isSprintQueue = queue.steps.some(s => s.type === "verify")
        if (isSprintQueue) {
          const maxIter = deps.config.sprint?.max_iterations ?? 5
          setActiveSprintInfo({ iteration: 0, maxIterations: maxIter })
        }
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
      // Sprint iteration tracking for telemetry bar — derived from queue step events.
      // Sprint queues are identified by having verify-type steps. The iteration
      // count is derived from counting work steps that have started.
      // Escalation clears sprint info (non-work/verify steps in sprint queue).
      session.eventBus.subscribeToType("queue:step-started", (e) => {
        if (!isSprintQueue) return
        if (e.stepType === "work") {
          sprintWorkStepCount++
          const maxIter = deps.config.sprint?.max_iterations ?? 5
          setActiveSprintInfo({ iteration: sprintWorkStepCount, maxIterations: maxIter })
        } else if (e.stepType !== "verify") {
          // Non-sprint step (escalation: plan/review) — clear sprint info
          setActiveSprintInfo(null)
        }
      }),
      // Direct reactive queue steps signal updates (bypasses store → workState chain).
      // These mirror the adapter's store mutations but update the dedicated signal
      // so the WorkflowPanel gets reliable fine-grained reactivity.
      session.eventBus.subscribeToType("queue:step-started", (e) => {
        setShellQueueSteps((prev) =>
          prev.map((s) =>
            s.id === e.stepId
              ? { ...s, status: "running" as const, startTime: Date.now() }
              : s,
          ),
        )
      }),
      session.eventBus.subscribeToType("queue:step-completed", (e) => {
        setShellQueueSteps((prev) =>
          prev.map((s) => {
            if (s.id !== e.stepId) return s
            const now = Date.now()
            const duration = s.startTime ? (now - s.startTime) / 1000 : 0
            return { ...s, status: "completed" as const, endTime: now, duration }
          }),
        )
      }),
      session.eventBus.subscribeToType("queue:step-failed", (e) => {
        setShellQueueSteps((prev) =>
          prev.map((s) => {
            if (s.id !== e.stepId) return s
            const now = Date.now()
            return { ...s, status: "failed" as const, endTime: now, error: e.reason }
          }),
        )
      }),
      session.eventBus.subscribeToType("queue:step-inserted", (e) => {
        setShellQueueSteps((prev) => {
          const idx = prev.findIndex((s) => s.id === e.afterStepId)
          const insertIdx = idx >= 0 ? idx + 1 : prev.length
          const newStep: import("../routes/work/state/types").QueueStepState = {
            id: e.stepId,
            type: e.stepType,
            title: e.stepTitle,
            status: "pending",
          }
          return [...prev.slice(0, insertIdx), newStep, ...prev.slice(insertIdx)]
        })
      }),
      session.eventBus.subscribeToType("queue:step-removed", (e) => {
        setShellQueueSteps((prev) => prev.filter((s) => s.id !== e.stepId))
      }),
    )

    // Shared context indexer
    const queueContextIndexer = getOrCreateContextIndexer()

    const capturedSessionId = persistedSessionId
    const capturedProjectCwd = deps.config.project_cwd ?? "."
    const queueSessionId = persistedSessionId
    _isQueueRunning = true
    _userInitiatedPause = false
    _interruptAbort = false

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
      const workflowIdRef = { current: `queue-${queueSessionId ?? "unknown"}` }
      const workflowIdUnsub = session.eventBus.subscribeToType("queue:initialized", (ev) => {
        workflowIdRef.current = ev.workflowId
      })
      queueUnsubs.push(workflowIdUnsub)

      // Resolve dispatcher and evaluator transports
      // Session ID must exist at this point
      const effectiveSessionId = queueSessionId ?? crypto.randomUUID()

      const { dispatcherTransport, evaluatorTransport } = await resolveTransports(
        deps, session.eventBus, workflowIdRef, queueLogBaseDir, effectiveSessionId, capturedProjectCwd,
      )

      const emitter = createFlywheelEmitter(session.eventBus)
      const projectCwdForExec = deps.config.project_cwd ?? process.cwd()

      // Build shared executor dependencies (dispatcher, accumulator, evaluator, hooks, worker, handoff reader)
      const execDeps = buildExecutorDeps({
        deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
        contextIndexer: queueContextIndexer, projectCwd: projectCwdForExec,
        sessionObjective: args.description, queue,
        sessionId: effectiveSessionId,
        stdinHandleRef: activeStdinHandleRef,
        seedHandoff,
      })

      // Create step executor with real per-step execution.
      const stepExec = createStepExecutor({
        queue,
        workflowId: workflowIdRef.current,
        sessionId: effectiveSessionId,
        emitter,
        dispatcher: execDeps.dispatcherFn,
        worker: execDeps.workerFn,
        evaluator: execDeps.evaluator,
        handoffReader: execDeps.handoffReader,
        budgetChecker: queueBudgetTracker && queueBudgetLimits
          ? { isExhausted: () => queueBudgetTracker!.isExhausted(queueBudgetLimits!) }
          : { isExhausted: () => false },
        persist: async (q) => {
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
        accumulator: execDeps.contextAccumulator,
        maxRevisions: deps.config.max_revisions ?? 1,
        onStepCompleted: execDeps.compositeHook,
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
          flusher: activeFlusher!,
          budgetTracker: queueBudgetTracker!,
          storeUnsub: storeUnsub!,
          questionCleanup: () => cleanupQuestionSubscriptions(),
          queueCleanup: () => cleanupQueueSubscriptions(),
          contextIndexer: queueContextIndexer,
          workerPid: null,
          stepExecutor: stepExec,
          queue,
        })
      }

      let queueResult: StepExecutorResult | undefined
      // Track whether this run was interrupted (for skip-cleanup in finally)
      let wasInterruptedRun = false
      try {
        queueResult = await stepExec.run()

        if (!queueResult.completed && !_userInitiatedPause) {
          const isBudgetExhausted = /budget[_ ]exhausted/i.test(queueResult.reason ?? "")
          const isRateLimitPause = /rate limit/i.test(queueResult.reason ?? "")
          const wasInterrupted = _interruptAbort
          // Reset interrupt flag after capturing it
          _interruptAbort = false

          if (wasInterrupted) {
            // Interrupt-abort: step was aborted by first Esc (SIGINT + executor abort).
            // Stay in "working" state so the user can type to resume the worker.
            // Do NOT transition to completed, do NOT show ErrorModal.
            wasInterruptedRun = true
            _isQueueRunning = false
            // Clear the step executor (it's done) but keep everything else alive
            activeStepExecutor = null
            toast.show({
              message: "Worker interrupted — type to resume, or Esc to kill",
              variant: "warning",
              duration: 5000,
            })
            // Update the failed step's display to show "interrupted" instead of "failed"
            setShellQueueSteps((prev) =>
              prev.map((s) =>
                s.status === "failed"
                  ? { ...s, status: "failed" as const, error: "interrupted" }
                  : s,
              ),
            )
            log.info("queue interrupted — staying in working state for resume", {
              sessionId: queueSessionId,
              capturedWorkerSession: capturedWorkerSessionId.current,
            })
            // Don't transition app state — stay in "working"
            return
          } else if (isRateLimitPause) {
            toast.show({
              message: "Queue paused — rate limit reached. Resume when limits lift.",
              variant: "warning",
              duration: 5000,
            })
          } else if (isBudgetExhausted) {
            toast.show({
              message: "Queue stopped — budget exhausted.",
              variant: "warning",
              duration: 5000,
            })
          } else {
            activeStore()?.setError(queueResult.reason ?? "Queue execution failed")
          }

          if (queueSessionId) {
            // VAL-SHELL-020: Budget exhaustion transitions to budget_exhausted
            const targetState = isBudgetExhausted ? "budget_exhausted" : "work:paused"
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              queueSessionId,
              targetState,
            )
            sessionCtx.refreshList()
          }
          if (isStillViewed()) setAppState("completed")
        }
      } catch (err) {
        if (!_userInitiatedPause) {
          // Check if this was an interrupt abort that threw
          const wasInterrupted = _interruptAbort
          _interruptAbort = false

          if (wasInterrupted) {
            wasInterruptedRun = true
            _isQueueRunning = false
            activeStepExecutor = null
            toast.show({
              message: "Worker interrupted — type to resume, or Esc to kill",
              variant: "warning",
              duration: 5000,
            })
            log.info("queue interrupted (exception path) — staying in working state", {
              sessionId: queueSessionId,
            })
            return
          }

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
        // Skip cleanup if this was an interrupted run — resources stay alive for resume
        if (wasInterruptedRun) return

        _isQueueRunning = false

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
            // Convert queue result to QueueResult format for handleQueueCompletion
            const queueResultCompat: import("../../controller/queue-types").QueueResult = {
              completed: queueResult.completed,
              stepsCompleted: queueResult.stepsCompleted,
              stepsTotal: queueResult.stepsTotal,
              reason: queueResult.reason,
              stepResults: queue.steps
                .filter((s) => s.status === "completed")
                .map((s) => ({
                  workflow: s.type as any,
                  completed: true,
                })),
            }
            await handleQueueCompletion(queueResultCompat, {
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

  const cleanupQueueSubscriptions = () => {
    for (const unsub of queueUnsubs) unsub()
    queueUnsubs = []
    setActiveQueueInfo(null)
    setShellQueueSteps([])
    _isQueueRunning = false
  }

  /**
   * Shut down queue runtime without touching
   * session, store, adapter, or subscriptions.
   *
   * Used by both teardownActiveWorkflow() (full cleanup) and
   * pauseQueue() (partial cleanup — keeps store/adapter alive).
   */
  const _clearQueueRuntime = (): Promise<void> | undefined => {
    if (activeStepExecutor) {
      activeStepExecutor.requestShutdown()
      activeStepExecutor = null
    }
    activeQueue = null
    activeStdinHandleRef.current = null
    // Reset interrupt state
    setIsInterrupted(false)
    pendingInjection.current = null
    capturedWorkerSessionId.current = undefined
    // Kill all active worker processes (fire-and-forget)
    const shutdownPromise = killAllActiveProcesses().catch(() => {})
    return shutdownPromise
  }

  const teardownActiveWorkflow = (): Promise<void> | undefined => {
    cleanupQuestionSubscriptions()
    cleanupQueueSubscriptions()
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
    // Dispose transcript logger (flushes remaining buffer, closes file handle)
    if (activeTranscript) {
      activeTranscript.dispose()
      activeTranscript = null
    }
    // Dispose budget tracker (flushes pending data, cancels timers)
    if (activeBudgetTracker) {
      activeBudgetTracker.dispose()
      activeBudgetTracker = null
    }
    const shutdownPromise = _clearQueueRuntime()
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
    setIsInterrupted(false)
    pendingInjection.current = null
    capturedWorkerSessionId.current = undefined

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
   * Pause the queue (user-initiated via double-Esc).
   *
   * Unlike stopWorkflow(), this does NOT fully tear down the session:
   * - Sets suppressQueueError on the adapter so queue:failed doesn't trigger ErrorModal
   * - Requests queue shutdown (which internally fires queue:failed)
   * - Persists session state as work:paused (if a persistent session exists)
   * - Pushes a pause system message to output
   * - Transitions app state to "completed" (keeps output visible)
   */
  const pauseQueue = async () => {
    _userInitiatedPause = true
    escapeHandler.reset()
    setEscHint("")
    setIsInterrupted(false)
    pendingInjection.current = null
    capturedWorkerSessionId.current = undefined

    // Suppress ErrorModal from the queue:failed event that shutdown triggers
    if (activeSession?.adapter) {
      activeSession.adapter.suppressQueueError = true
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

    // Flush and dispose transcript logger (persists final buffered entries)
    if (activeTranscript) {
      activeTranscript.dispose()
      activeTranscript = null
    }

    // Flush and dispose budget tracker (persists final cost/usage data)
    if (activeBudgetTracker) {
      activeBudgetTracker.dispose()
      activeBudgetTracker = null
    }

    // Clean up subscriptions (question wiring, queue event bus listeners)
    cleanupQuestionSubscriptions()
    cleanupQueueSubscriptions()

    // Unsubscribe from timer so the runtime display stops ticking
    unsubscribeTimer()

    // Clean up store subscription
    if (storeUnsub) {
      storeUnsub()
      storeUnsub = null
    }

    // Shut down queue runtime (executor, processes, stdin handles)
    _clearQueueRuntime()

    // Push pause message through the event bus BEFORE destroying the session
    if (activeSession) {
      activeSession.eventBus.emit({
        type: "worker:output",
        workflowId: "queue-pause",
        stream: "stderr",
        data: "⏸ Execution paused. Resume with /work or select from session sidebar.\n",
        timestamp: new Date().toISOString(),
      })
    }

    // Destroy the workflow session (stops timer interval, stops and disconnects adapter)
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    setActiveStore(null)

    // Persist session state as work:paused and remove from sessionControllers
    // so the sidebar groups them as "Paused" instead of "Active".
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

  /**
   * Resume the worker after an interrupt by spawning a new process with --resume.
   *
   * Called when the user types text while in the interrupted state (after first Esc).
   * Spawns a new worker process with --resume <sessionId> and the user's message,
   * then transitions back to normal "working" state.
   */
  const resumeWorkerWithMessage = (message: string) => {
    // SDK path: if the stdinHandle is still open (SDK session stayed alive
    // after interrupt), just send the message directly — no respawn needed.
    const handle = activeStdinHandleRef.current
    if (handle?.isOpen) {
      setIsInterrupted(false)
      setEscHint("")
      escapeHandler.reset()
      pendingInjection.current = null

      if (activeSession?.adapter) {
        activeSession.adapter.suppressQueueError = false
      }

      log.info("resuming SDK session via stdinHandle.write", {
        sessionId: capturedWorkerSessionId.current,
        messageLength: message.length,
      })

      // Emit a system message to show the resume in the output
      if (activeSession) {
        activeSession.eventBus.emit({
          type: "worker:output",
          workflowId: "resume",
          stream: "stderr",
          data: `▶ Resuming with message: ${message.slice(0, 100)}${message.length > 100 ? "…" : ""}\n`,
          timestamp: new Date().toISOString(),
        })
      }

      const written = handle.write(message)
      if (written) {
        log.info("SDK resume message sent", { sessionId: capturedWorkerSessionId.current })
      } else {
        log.warn("SDK resume write failed — handle closed unexpectedly")
        toast.show({ message: "Resume failed — session closed", variant: "error" })
      }
      return
    }

    // CLI path: spawn a new process with --resume
    const resumeSessionId = capturedWorkerSessionId.current
    if (!resumeSessionId) {
      log.warn("no captured session ID for resume — cannot resume worker")
      toast.show({ message: "Cannot resume — no session ID captured", variant: "error" })
      // Fall back to queuing the message
      pendingInjection.current = message
      setIsInterrupted(false)
      setEscHint("")
      escapeHandler.reset()
      return
    }

    // Reset interrupt state
    setIsInterrupted(false)
    setEscHint("")
    escapeHandler.reset()
    pendingInjection.current = null

    // Reset suppressQueueError so normal errors are shown again
    if (activeSession?.adapter) {
      activeSession.adapter.suppressQueueError = false
    }

    const deps = getDepsOrWarn()
    if (!deps) {
      toast.show({ message: "Failed to load config for resume", variant: "error" })
      return
    }

    const projectCwd = deps.config.project_cwd ?? "."

    log.info("resuming worker with --resume", {
      resumeSessionId,
      messageLength: message.length,
    })

    // Emit a system message to show the resume in the output
    if (activeSession) {
      activeSession.eventBus.emit({
        type: "worker:output",
        workflowId: "resume",
        stream: "stderr",
        data: `▶ Resuming worker with message: ${message.slice(0, 100)}${message.length > 100 ? "…" : ""}\n`,
        timestamp: new Date().toISOString(),
      })
    }

    // Spawn a new worker process with --resume
    const useStdinPipe = deps.engine.metadata.supportsStreamingInput
    const engineCmd = deps.engine.buildCommand({
      prompt: message,
      model: deps.config.worker?.model ?? deps.config.model,
      resumeSessionId,
    })

    const stdinContent = useStdinPipe
      ? formatClaudeStdinMessage(message)
      : (engineCmd.stdinPrompt
          ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + message : message)
          : undefined)

    const emitter = activeSession
      ? createFlywheelEmitter(activeSession.eventBus)
      : null

    const workflowIdRef = `resume-${resumeSessionId}`

    // Update queue step display to show "running" again
    setShellQueueSteps((prev) =>
      prev.map((s) =>
        s.error === "interrupted"
          ? { ...s, status: "running" as const, error: undefined }
          : s,
      ),
    )

    // Fire-and-forget async spawn
    queueMicrotask(async () => {
      try {
        const onTurnComplete = useStdinPipe ? (sessionId: string | undefined) => {
          // Capture new session ID
          if (sessionId) capturedWorkerSessionId.current = sessionId
          // Check for pending injection
          if (pendingInjection.current && activeStdinHandleRef.current?.isOpen) {
            const injectMsg = pendingInjection.current
            pendingInjection.current = null
            const written = activeStdinHandleRef.current.write(formatClaudeStdinMessage(injectMsg))
            if (written) {
              log.info("turn-boundary injection sent to resumed worker", { length: injectMsg.length })
            }
          } else {
            activeStdinHandleRef.current?.close()
          }
        } : undefined

        const spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, {
          cwd: projectCwd,
          invocationId: randomUUID(),
          stdin: stdinContent,
          stdinPipe: useStdinPipe && stdinContent !== undefined,
          onTurnComplete,
          onSessionId: (sessionId) => {
            capturedWorkerSessionId.current = sessionId
          },
          onStdout: (chunk) => {
            emitter?.workerOutput(workflowIdRef, "stdout", chunk, deps.engine.metadata.id)
          },
          onStderr: (chunk) => {
            emitter?.workerOutput(workflowIdRef, "stderr", chunk, deps.engine.metadata.id)
          },
        })

        // Store stdin handle for mid-execution injection
        if (spawnResult.stdinHandle) {
          activeStdinHandleRef.current = spawnResult.stdinHandle
        }

        const workerResult = await spawnResult.result

        // Capture session ID from result (fallback for non-streaming engines)
        if (workerResult.sessionId) {
          capturedWorkerSessionId.current = workerResult.sessionId
        }

        // Clear stdin handle
        activeStdinHandleRef.current = null

        if (workerResult.exitCode === 0) {
          // Worker completed successfully — mark the interrupted step as completed
          setShellQueueSteps((prev) =>
            prev.map((s) =>
              s.status === "running"
                ? { ...s, status: "completed" as const }
                : s,
            ),
          )
          toast.show({ message: "Worker completed", variant: "info", duration: 3000 })

          // Check if there are remaining pending steps in the queue
          const hasPendingSteps = activeQueue?.steps.some((s) => s.status === "pending")
          if (hasPendingSteps) {
            // TODO: restart step executor for remaining steps
            log.info("resumed worker completed, pending steps remain — pausing")
          }

          // No executor to continue remaining steps — transition to completed
          // so the runtime doesn't stay stuck in "working" with nothing running
          if (!hasPendingSteps || !activeStepExecutor) {
            await stopWorkflow()
          }
        } else {
          // Worker failed after resume — clean up and transition to completed
          setShellQueueSteps((prev) =>
            prev.map((s) =>
              s.status === "running"
                ? { ...s, status: "failed" as const, error: workerResult.failure?.message ?? "failed" }
                : s,
            ),
          )
          toast.show({
            message: `Worker failed: ${workerResult.failure?.message ?? "unknown error"}`,
            variant: "error",
            duration: 5000,
          })
          await stopWorkflow()
        }
      } catch (err) {
        activeStdinHandleRef.current = null
        const errMsg = err instanceof Error ? err.message : String(err)
        log.error("resume worker spawn failed", { error: errMsg })
        setShellQueueSteps((prev) =>
          prev.map((s) =>
            s.status === "running"
              ? { ...s, status: "failed" as const, error: errMsg }
              : s,
          ),
        )
        toast.show({ message: `Resume failed: ${errMsg}`, variant: "error" })
        await stopWorkflow()
      }
    })
  }

  /**
   * Resume a previously paused session.
   *
   * VAL-SHELL-022: Paused session resumable
   * VAL-SHELL-023: Resume continues from correct queue position
   *
   * Queue-based resume:
   *   1. Loads session data + output blocks + queue state via orchestrator
   *   2. If queue state exists, uses startQueueExecution with the loaded queue
   *      (completed steps are NOT re-executed — cursor starts at first pending)
   *   3. All sessions use queue-based execution
   */
  const resumeSession = async (sessionId: string) => {
    // 1. Clean up any current workflow
    if (activeSession) {
      teardownActiveWorkflow()
    }

    // 2. Get session data + output + queue from orchestrator
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

    // 4. If queue state exists, resume via queue-based execution
    //    The loaded queue has completed steps already marked, and the cursor
    //    is positioned at the first pending step (crash recovery already applied).
    if (result.queue) {
      // Transition session state before starting execution
      // (budget_exhausted → work:active or work:paused → work:active)
      try {
        sessionCtx.manager.updateState(sessionId, "work:active")
        sessionCtx.refreshList()
      } catch (err) {
        toast.show({
          message: `Failed to update session state: ${err instanceof Error ? err.message : String(err)}`,
          variant: "warning",
        })
      }

      // Create a fresh workflow session, inject output blocks, then start queue execution.
      // We use a modified path: create session manually (not via startQueueExecution)
      // to preserve the existing session ID instead of creating a new one.
      const session = createWorkflowSession(result.planPath)
      activeSession = session
      activeQueue = result.queue
      setActiveStore(session.store)
      subscribeToStore(session.store)
      subscribeToTimer(session.timer)

      // Start workflow — sets workflowStatus to "running"
      session.store.startWorkflow(result.planPath ?? "Resumed session")

      // Inject restored output blocks
      injectOutputBlocks(session.store, snapshotToBlocks(result.outputBlocks) as AnyBlock[])

      // Populate queue step display state for workflow panel (resume)
      const resumeQueueStepStates = result.queue.steps.map((s) => ({
        id: s.id,
        type: s.type,
        title: s.title,
        status: s.status as "pending" | "running" | "completed" | "failed" | "skipped",
      }))
      session.store.setQueueSteps(resumeQueueStepStates)
      // Also update the direct reactive signal (bypasses store → workState chain)
      setShellQueueSteps(resumeQueueStepStates)

      setFocusedSessionId(sessionId)
      setViewedSessionId(sessionId)
      setAppState("working")

      // Start output flusher
      const projectCwd = deps.config.project_cwd ?? "."
      const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
      const resumedStore = session.store
      activeFlusher = outputPersistence.createFlusher(
        () => (resumedStore.getState().outputBlocks ?? []) as unknown as { kind: string; [key: string]: unknown }[],
        { intervalMs: 5000 },
      )

      // Start transcript logger (append-only — resumes appending to existing file)
      activeTranscript = createTranscriptLogger({ sessionId, baseDir: projectCwd })
      activeTranscript.subscribeTo(session.eventBus)
      activeTranscript.logEntry("session:resumed", { sessionId })

      sessionStores.set(sessionId, session.store)

      // Create BudgetTracker
      let resumeBudgetTracker: BudgetTracker | null = null
      let resumeBudgetLimits: import("../../schemas/shared").BudgetLimits | null = null
      const persistedSession = readSession(sessionId, projectCwd)
      if (persistedSession) {
        resumeBudgetLimits = persistedSession.budgetLimits
        resumeBudgetTracker = createBudgetTracker({ sessionId, baseDir: projectCwd })
        activeBudgetTracker = resumeBudgetTracker
      }

      // Question wiring
      cleanupQuestionSubscriptions()
      const questionWiring = createQuestionWiring({
        eventBus: session.eventBus,
        onQuestion: (q) => setPendingQuestion(q),
        onClear: () => setPendingQuestion(null),
      })
      activeQuestionWiring = questionWiring

      // Queue event subscriptions
      cleanupQueueSubscriptions()
      // Re-populate shellQueueSteps after cleanup (cleanupQueueSubscriptions resets
      // the signal to [], overwriting the initial population above).
      setShellQueueSteps(resumeQueueStepStates)
      let stepCounter = result.queue.steps.filter((s) => s.status === "completed").length
      queueUnsubs.push(
        session.eventBus.subscribeToType("queue:initialized", (e) => {
          setActiveQueueInfo({
            currentStep: stepCounter + 1,
            totalSteps: e.stepIds.length,
            stepName: result.queue!.steps[result.queue!.cursor]?.type ?? "step",
          })
          setActiveWorkflowName(result.queue!.steps[result.queue!.cursor]?.type ?? "work")
        }),
        session.eventBus.subscribeToType("queue:step-started", (e) => {
          stepCounter++
          setActiveQueueInfo({
            currentStep: stepCounter,
            totalSteps: result.queue!.steps.length,
            stepName: e.stepType,
          })
          setActiveWorkflowName(e.stepType)
        }),
        session.eventBus.subscribeToType("queue:completed", () => {
          setActiveQueueInfo(null)
          if (activeFlusher) {
            activeFlusher.schedule()
            activeFlusher.flush().catch(() => {})
          }
        }),
        session.eventBus.subscribeToType("queue:failed", () => {
          setActiveQueueInfo(null)
        }),
        session.eventBus.subscribeToType("queue:step-completed", () => {
          if (activeFlusher) activeFlusher.schedule()
        }),
        // Direct reactive queue steps signal updates for resume path
        session.eventBus.subscribeToType("queue:step-started", (e) => {
          setShellQueueSteps((prev) =>
            prev.map((s) =>
              s.id === e.stepId
                ? { ...s, status: "running" as const, startTime: Date.now() }
                : s,
            ),
          )
        }),
        session.eventBus.subscribeToType("queue:step-completed", (e) => {
          setShellQueueSteps((prev) =>
            prev.map((s) => {
              if (s.id !== e.stepId) return s
              const now = Date.now()
              const duration = s.startTime ? (now - s.startTime) / 1000 : 0
              return { ...s, status: "completed" as const, endTime: now, duration }
            }),
          )
        }),
        session.eventBus.subscribeToType("queue:step-failed", (e) => {
          setShellQueueSteps((prev) =>
            prev.map((s) => {
              if (s.id !== e.stepId) return s
              const now = Date.now()
              return { ...s, status: "failed" as const, endTime: now, error: e.reason }
            }),
          )
        }),
        session.eventBus.subscribeToType("queue:step-inserted", (e) => {
          setShellQueueSteps((prev) => {
            const idx = prev.findIndex((s) => s.id === e.afterStepId)
            const insertIdx = idx >= 0 ? idx + 1 : prev.length
            const newStep: import("../routes/work/state/types").QueueStepState = {
              id: e.stepId,
              type: e.stepType,
              title: e.stepTitle,
              status: "pending",
            }
            return [...prev.slice(0, insertIdx), newStep, ...prev.slice(insertIdx)]
          })
        }),
        session.eventBus.subscribeToType("queue:step-removed", (e) => {
          setShellQueueSteps((prev) => prev.filter((s) => s.id !== e.stepId))
        }),
      )

      const capturedProjectCwd = projectCwd
      const capturedFlusher = activeFlusher
      _isQueueRunning = true
      _userInitiatedPause = false
      _interruptAbort = false

      queueMicrotask(async () => {
        const isStillViewed = () => viewedSessionId() === sessionId
        const queueContextIndexer = getOrCreateContextIndexer()

        if (!_indexerStarted) {
          try {
            await queueContextIndexer.startIndexing()
            _indexerStarted = true
          } catch { /* silently fall back to empty context */ }
        }

        const queueLogBaseDir = deps.config.project_cwd ?? process.cwd()
        const workflowIdRef = { current: `queue-resume-${sessionId}` }
        const workflowIdUnsub = session.eventBus.subscribeToType("queue:initialized", (ev) => {
          workflowIdRef.current = ev.workflowId
        })
        queueUnsubs.push(workflowIdUnsub)

        // Resolve dispatcher and evaluator transports
        const capturedProjectCwdResume = deps.config.project_cwd ?? process.cwd()
        const { dispatcherTransport, evaluatorTransport } = await resolveTransports(
          deps, session.eventBus, workflowIdRef, queueLogBaseDir, sessionId, capturedProjectCwdResume,
        )

        const emitter = createFlywheelEmitter(session.eventBus)
        const resumeQueue = result.queue!
        const resumeProjectCwd = deps.config.project_cwd ?? process.cwd()

        // Build shared executor dependencies (dispatcher, accumulator, evaluator, hooks, worker, handoff reader)
        // Use the session name (original user description) as objective, not the label
        // (which falls back to planPath when no description was provided).
        const execDeps = buildExecutorDeps({
          deps, emitter, workflowIdRef, dispatcherTransport, evaluatorTransport,
          contextIndexer: queueContextIndexer, projectCwd: resumeProjectCwd,
          sessionObjective: result.session.name ?? undefined, queue: resumeQueue,
          sessionId,
          stdinHandleRef: activeStdinHandleRef,
        })

        const stepExec = createStepExecutor({
          queue: resumeQueue,
          workflowId: workflowIdRef.current,
          sessionId,
          emitter,
          dispatcher: execDeps.dispatcherFn,
          worker: execDeps.workerFn,
          evaluator: execDeps.evaluator,
          handoffReader: execDeps.handoffReader,
          budgetChecker: resumeBudgetTracker && resumeBudgetLimits
            ? { isExhausted: () => resumeBudgetTracker!.isExhausted(resumeBudgetLimits!) }
            : { isExhausted: () => false },
          persist: async (q) => {
            if (deps.config.queue?.persist_queue !== false) {
              try {
                const qp = createQueuePersistence({ sessionId, baseDir: capturedProjectCwd })
                await qp.save(q)
              } catch { /* best-effort */ }
            }
          },
          accumulator: execDeps.contextAccumulator,
          maxRevisions: deps.config.max_revisions ?? 1,
          onStepCompleted: execDeps.compositeHook,
        })

        activeStepExecutor = stepExec

        sessionControllers.set(sessionId, {
          shutdown: async () => { stepExec.requestShutdown() },
        })
        runtimes.register(sessionId, {
          kind: "running" as const,
          sessionId,
          session,
          flusher: activeFlusher!,
          budgetTracker: resumeBudgetTracker!,
          storeUnsub: storeUnsub!,
          questionCleanup: () => cleanupQuestionSubscriptions(),
          queueCleanup: () => cleanupQueueSubscriptions(),
          contextIndexer: queueContextIndexer,
          workerPid: null,
          stepExecutor: stepExec,
          queue: resumeQueue,
        })

        let queueResult: StepExecutorResult | undefined
        let wasInterruptedRun = false
        try {
          queueResult = await stepExec.run()
          if (!queueResult.completed && !_userInitiatedPause) {
            const isBudgetExhausted = /budget[_ ]exhausted/i.test(queueResult.reason ?? "")
            const wasInterrupted = _interruptAbort
            _interruptAbort = false

            if (wasInterrupted) {
              // Interrupt-abort: stay in "working" state for resume
              wasInterruptedRun = true
              _isQueueRunning = false
              activeStepExecutor = null
              toast.show({
                message: "Worker interrupted — type to resume, or Esc to kill",
                variant: "warning",
                duration: 5000,
              })
              setShellQueueSteps((prev) =>
                prev.map((s) =>
                  s.status === "failed"
                    ? { ...s, status: "failed" as const, error: "interrupted" }
                    : s,
                ),
              )
              log.info("queue interrupted (resume path) — staying in working state", {
                sessionId,
                capturedWorkerSession: capturedWorkerSessionId.current,
              })
              return
            } else if (isBudgetExhausted) {
              toast.show({ message: "Queue stopped — budget exhausted.", variant: "warning", duration: 5000 })
            } else {
              activeStore()?.setError(queueResult.reason ?? "Queue execution failed")
            }
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              sessionId,
              isBudgetExhausted ? "budget_exhausted" : "work:paused",
            )
            sessionCtx.refreshList()
            if (isStillViewed()) setAppState("completed")
          }
        } catch (err) {
          if (!_userInitiatedPause) {
            const wasInterrupted = _interruptAbort
            _interruptAbort = false

            if (wasInterrupted) {
              wasInterruptedRun = true
              _isQueueRunning = false
              activeStepExecutor = null
              toast.show({
                message: "Worker interrupted — type to resume, or Esc to kill",
                variant: "warning",
                duration: 5000,
              })
              log.info("queue interrupted (resume exception path) — staying in working state", {
                sessionId,
              })
              return
            }

            activeStore()?.setError(String(err))
            safeUpdateState(
              (id, s) => sessionCtx.manager.updateState(id, s),
              sessionId,
              "work:paused",
            )
            sessionCtx.refreshList()
            if (isStillViewed()) setAppState("completed")
          }
        } finally {
          // Skip cleanup if this was an interrupted run — resources stay alive for resume
          if (wasInterruptedRun) return

          _isQueueRunning = false
          if (resumeBudgetTracker) {
            resumeBudgetTracker.dispose()
            if (activeBudgetTracker === resumeBudgetTracker) activeBudgetTracker = null
          }
          sessionControllers.delete(sessionId)
          runtimes.remove(sessionId)
          if (queueResult && !_userInitiatedPause) {
            try {
              const queueResultCompat: import("../../controller/queue-types").QueueResult = {
                completed: queueResult.completed,
                stepsCompleted: queueResult.stepsCompleted,
                stepsTotal: queueResult.stepsTotal,
                reason: queueResult.reason,
                stepResults: resumeQueue.steps
                  .filter((s) => s.status === "completed")
                  .map((s) => ({ workflow: s.type as any, completed: true })),
              }
              await handleQueueCompletion(queueResultCompat, {
                orchestrator,
                sessionId,
                flusher: capturedFlusher,
                toast,
                updateState: (id, s) => sessionCtx.manager.updateState(id, s),
                refreshList: () => sessionCtx.refreshList(),
              })
            } catch (completionErr) {
              log.error("queue resume completion failed", { error: completionErr instanceof Error ? completionErr : String(completionErr) })
            }
          }
        }
      })
      return
    }

    // 5. Legacy fallback: resume via legacy execution path (non-queue sessions)
    const session = createWorkflowSession(result.planPath)
    activeSession = session
    setActiveStore(session.store)
    subscribeToStore(session.store)
    subscribeToTimer(session.timer)

    session.store.startWorkflow(result.planPath ?? "Resumed session")
    injectOutputBlocks(session.store, snapshotToBlocks(result.outputBlocks) as AnyBlock[])
    setFocusedSessionId(sessionId)

    try {
      sessionCtx.manager.updateState(sessionId, "work:active")
      sessionCtx.refreshList()
    } catch (err) {
      toast.show({
        message: `Failed to update session state: ${err instanceof Error ? err.message : String(err)}`,
        variant: "warning",
      })
    }

    const projectCwd = deps.config.project_cwd ?? "."
    const persistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
    const resumedStore = session.store
    activeFlusher = persistence.createFlusher(
      () => (resumedStore.getState().outputBlocks ?? []) as unknown as { kind: string; [key: string]: unknown }[],
      { intervalMs: 5000 },
    )
    sessionStores.set(sessionId, session.store)

    setViewedSessionId(sessionId)
    setAppState("working")

    queueMicrotask(async () => {
      let resumeCurrentWorkflowId = "unknown"
      const resumeWorkflowIdUnsub = session.eventBus.subscribeToType("queue:initialized", (ev) => {
        resumeCurrentWorkflowId = ev.workflowId
      })
      const resumeEngineName = deps.config.engine

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
          sessionId: sessionId,
          baseDir: deps.config.project_cwd ?? process.cwd(),
        })
        dispatcherTransport = resolved.transport
      } catch { /* fallback to static prompts */ }

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
            sessionId: sessionId,
            baseDir: deps.config.project_cwd ?? process.cwd(),
          })
        } catch { /* evaluation will be skipped */ }
      }

      try {
        // Build a single-step work queue for the resumed session
        const resumeWorkQueue = createQueue([{
          id: randomUUID(),
          type: "work" as const,
          title: "Resume work execution",
          status: "pending" as const,
        }])
        const resumeEmitter = createFlywheelEmitter(session.eventBus)
        const resumeStepExec = createStepExecutor({
          queue: resumeWorkQueue,
          workflowId: resumeCurrentWorkflowId,
          sessionId: sessionId,
          emitter: resumeEmitter,
          dispatcher: async (step, context) => {
            return { prompt: `Execute work: resume plan at ${result.planPath}`, evaluationCriteria: null }
          },
          worker: async (step, prompt) => {
            const engineCmd = deps.engine.buildCommand({
              prompt,
              model: deps.config.worker?.model ?? deps.config.model,
              toolScoping: step.toolScoping ?? undefined,
            })
            const startTime = Date.now()
            const spawnResult = await deps.spawner.spawn(engineCmd.command, engineCmd.args, {
              cwd: deps.config.project_cwd ?? process.cwd(),
              stdin: engineCmd.stdinPrompt
                ? (engineCmd.promptPrefix ? engineCmd.promptPrefix + prompt : prompt)
                : undefined,
              onStdout: (chunk) => {
                resumeEmitter.workerOutput(resumeCurrentWorkflowId, "stdout", chunk, deps.engine.metadata.id)
              },
              onStderr: (chunk) => {
                resumeEmitter.workerOutput(resumeCurrentWorkflowId, "stderr", chunk, deps.engine.metadata.id)
              },
            })
            const workerResult = await spawnResult.result
            return {
              output: workerResult.exitCode === 0 ? "completed" : (workerResult.failure?.message ?? "failed"),
              handoffPath: workerResult.handoffPath ?? "",
              durationMs: Date.now() - startTime,
            }
          },
          evaluator: null,
          handoffReader: async () => null,
          budgetChecker: { isExhausted: () => false },
          persist: async () => {},
          accumulator: { accumulate: () => {}, getContext: () => ({}) },
          maxRevisions: deps.config.max_revisions ?? 0,
        })

        sessionControllers.set(sessionId, {
          shutdown: () => { resumeStepExec.requestShutdown(); return killAllActiveProcesses() },
        })

        await resumeStepExec.run()
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
        }).catch(() => {
          toast.show({ message: `Failed to delete ${sessionName(sessionId)}`, variant: "error" })
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
    setIsInterrupted(false)
    pendingInjection.current = null
    capturedWorkerSessionId.current = undefined
    setAppState("idle")
  }

  /**
   * Background the current session: deselect it from the viewport and return
   * to idle, but keep the queue/controller running. The session stays in
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
    // without destroying them. The session, controller, queue, and flusher
    // continue to run — they're still tracked in sessionControllers/sessionStores.
    //
    // IMPORTANT: We null these refs so the shell doesn't try to interact with
    // them, but the queue's async closure captured its own local references.
    // The queue executor will clean up sessionControllers when it finishes.
    activeSession = null
    activeStepExecutor = null
    activeStdinHandleRef.current = null
    activeFlusher = null
    activeTranscript = null  // Detached but NOT disposed — still running with the backgrounded queue
    activeBudgetTracker = null

    // Clear question/queue UI subscriptions (the queue executor itself doesn't need
    // these signals to function — they only drive UI state like pendingQuestion).
    cleanupQuestionSubscriptions()
    cleanupQueueSubscriptions()
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

  const launchWorkWithQueue = (planPath: string) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    // Parse the plan file and create work steps from its steps
    const queue = buildQueueFromPlan(planPath, deps.config)
    startQueueExecution(queue, { planPath }, deps)
  }

  const launchGenericWithQueue = (name: string, args: Record<string, string>) => {
    const deps = getDepsOrReturnIdle()
    if (!deps) return

    const queue = buildQueueForSlashCommand(name, deps.config)
    startQueueExecution(queue, args, deps)
  }

  /**
   * /start flow: guided question wizard that collects a description and
   * queue mode, then starts the appropriate queue.
   *
   * Questions happen BEFORE the queue starts. Uses a temporary EventBus
   * + QuestionService to drive the existing QuestionPrompt component.
   */
  const launchStartFlow = async (args: Record<string, string>) => {
    // Create a temporary event bus + question wiring for pre-queue questions
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

      // Step 2: Pick workflow type
      const workflowAnswers = await startQS.ask([{
        question: "How far should the workflow go?",
        header: "Workflow",
        options: WORKFLOW_OPTIONS.map((o) => ({
          label: o.label,
          description: o.description,
        })),
        custom: false,
        default: "Plan + Work + Review",
      }])
      const selectedLabel = workflowAnswers[0]?.[0]
      if (!selectedLabel) {
        // User dismissed
        cleanupQuestionSubscriptions()
        return
      }

      // Map label back to WorkflowName value
      const selectedOption = WORKFLOW_OPTIONS.find((o) => o.label === selectedLabel)
      const workflow: WorkflowName = selectedOption?.value ?? "plan-work-review"

      // Step 3: Consolidation preference (skip for sprint — no planning phase)
      let planInteractive = false
      if (workflow !== "sprint") {
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
        planInteractive = consolidationLabel === "Yes, let me review"
      }

      // Step 4: Review triage preference (only if workflow includes review)
      let reviewInteractive = false
      if (workflowHasReview(workflow)) {
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

      // Clean up question subscriptions before starting queue
      // (queue execution will create its own QuestionService)
      cleanupQuestionSubscriptions()

      // Step 5: Build queue from workflow template and start execution
      // HITL preferences are stored as queue-level metadata and passed to step configs
      const startDeps = getDepsOrWarn()
      if (!startDeps) {
        cleanupQuestionSubscriptions()
        return
      }
      const startFlowQueue = buildQueue(workflow, startDeps.config)
      startQueueExecution(startFlowQueue, { description }, startDeps, {
        plan: planInteractive,
        review: reviewInteractive,
      })
    } catch {
      // QuestionRejectedError or other: user dismissed, clean up
      cleanupQuestionSubscriptions()
    }
  }

  // ── /test command ──
  const launchTestStep = async (args: Record<string, string>) => {
    // If stepName provided as argument, look it up directly
    const directMatch = args.stepName
      ? TEST_STEPS.find((s) => s.id === args.stepName)
      : null

    let selectedStep: TestStepDef | null = directMatch ?? null

    if (!selectedStep) {
      // Show picker
      cleanupQuestionSubscriptions()
      const startBus = new EventBus()
      const startWiring = createQuestionWiring({
        eventBus: startBus,
        onQuestion: (q) => setPendingQuestion(q),
        onClear: () => setPendingQuestion(null),
      })
      activeQuestionWiring = startWiring

      try {
        const qs = startWiring.service

        const stepOptions = TEST_STEPS.map((s) => ({
          label: s.label,
          description: `${s.type} step (${s.dispatcherHint ?? s.type})`,
        }))

        const answers = await qs.ask([{
          question: "Which step type do you want to test?",
          header: "Test Step",
          options: stepOptions,
        }])

        cleanupQuestionSubscriptions()
        const selectedLabel = answers[0]?.[0]
        if (selectedLabel) {
          selectedStep = TEST_STEPS.find((s) => s.label === selectedLabel) ?? null
        }
      } catch {
        cleanupQuestionSubscriptions()
        return
      }
    }

    if (!selectedStep) {
      toast.show({ message: "No step selected", variant: "warning" })
      return
    }

    // Set up fixture files
    const deps = getDepsOrReturnIdle()
    if (!deps) return
    const projectCwd = deps.config.project_cwd ?? process.cwd()
    const fixture = setupTestFixture(selectedStep, projectCwd)

    // Build single-step queue
    const queue = buildTestQueue(selectedStep, fixture)

    // Launch it through the normal queue execution path
    const testArgs: Record<string, string> = {
      description: `[test] ${selectedStep.label}`,
    }
    startQueueExecution(queue, testArgs, deps, undefined, fixture.handoffData)
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
    launchWorkWorkflow: launchWorkWithQueue,
    launchGenericWorkflow: launchGenericWithQueue,
    launchStartFlow,
    launchTestStep,
    exit: exitTUI,
    returnToIdle,
  })

  const handleCommand = (workflow: string, args: Record<string, string>) => {
    const meta = dispatch(workflow, args)
    if (meta) {
      setActiveStepLabel(meta.stepLabel)
      if (!_isQueueRunning) {
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
        // If already interrupted (first Esc was pressed), second Esc is full kill
        if (isInterrupted()) {
          escapeHandler.reset()
          setEscHint("")
          setIsInterrupted(false)
          pendingInjection.current = null
          capturedWorkerSessionId.current = undefined
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
            if (activeSession?.adapter) {
              activeSession.adapter.suppressQueueError = true
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
      case "cancel-import":
        setAppState("idle")
        return
    }
  }

  // ── Prompt input handling ──

  const handlePromptInput = (input: string) => {
    const currentAppState = appState()

    if (currentAppState === "idle" || currentAppState === "completed") {
      const trimmed = input.trim()

      // In completed state with a resumable session: sending a non-empty
      // message resumes the paused session instead of parsing commands.
      if (currentAppState === "completed" && isSessionResumable() && trimmed && !trimmed.startsWith("/")) {
        const vid = viewedSessionId()
        if (vid) {
          resumeSession(vid)
          return
        }
      }

      // Command mode: parse like the old LauncherView
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
        const message = input.trim()

        if (isInterrupted()) {
          // Interrupted state: user typed text after first Esc (SIGINT).
          // Resume the worker by spawning a new process with --resume
          // and the user's message as stdin content.
          resumeWorkerWithMessage(message)
          return
        }

        // Working mode without approval: inject message into running worker's stdin
        const handle = activeStdinHandleRef.current
        if (handle && handle.isOpen) {
          // Write directly to the worker. For Claude CLI (stream-json stdin),
          // wrap as NDJSON. For SDK engines (OpenCode), send raw text —
          // the SDK handle wraps it in its own API format.
          const deps = getDepsOrWarn()
          const payload = deps?.engine.metadata.supportsStreamingInput
            ? formatClaudeStdinMessage(message)
            : message
          const written = handle.write(payload)
          if (written) {
            log.info("message injected into worker stdin", { length: message.length })
          } else {
            log.warn("stdin write failed — pipe closed between check and write")
            pendingInjection.current = message
            toast.show({ message: "Message queued for next turn", variant: "info", duration: 2000 })
          }
          // Emit worker:injected event for TUI display
          if (activeSession) {
            activeSession.eventBus.emit({
              type: "worker:injected",
              workflowId: "",
              message,
              timestamp: new Date().toISOString(),
            })
          }
        } else {
          log.info("no stdin handle available for injection — queuing for next turn")
          pendingInjection.current = message
          toast.show({ message: "Message queued for next turn", variant: "info", duration: 2000 })
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

      // Ctrl+S: skip current step
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

      // Up/Down: step navigation (only when not prompt or sidebar focused)
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

    // === Resume key: Ctrl+R (always) or 'r' (when prompt unfocused) ===
    if (
      appState() === "completed" &&
      !showStopModal() &&
      isSessionResumable() &&
      (
        // Ctrl+R works regardless of focus state
        (evt.name === "r" && evt.ctrl && !evt.meta) ||
        // Plain 'r' only when prompt/sidebar not focused (avoids swallowing typing)
        (evt.name === "r" && !evt.ctrl && !evt.meta && !isPromptFocused() && !sidebarFocused())
      )
    ) {
      evt.preventDefault()
      const vid = viewedSessionId()
      if (vid) {
        resumeSession(vid)
      }
      return
    }

    // Tab: cycle focus zones — prompt → sidebar → output → prompt
    // (sidebar is skipped when not visible or no sessions exist)
    if (evt.name === "tab" && !showStopModal() && !approvalPending() && !pendingQuestion()) {
      const hasSessions = sessionCtx.sessions().length > 0
      const sidebarVisible = hasSessions && (dimensions()?.width ?? 120) >= 90
      evt.preventDefault()

      if (isPromptFocused()) {
        // prompt → sidebar (if visible) or output
        setIsPromptFocused(false)
        setSidebarFocused(sidebarVisible)
      } else if (sidebarFocused()) {
        // sidebar → output
        setSidebarFocused(false)
      } else {
        // output → prompt
        setIsPromptFocused(true)
      }
      return
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
          hasActiveWorkflow() ? (
            <WorkflowPanel
              state={layoutState()}
              stepLabel={activeStepLabel()}
              selectedStepIndex={layoutState().selectedStepIndex}
              queueSteps={shellQueueSteps()}
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
