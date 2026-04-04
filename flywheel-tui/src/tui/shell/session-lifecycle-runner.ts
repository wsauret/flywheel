/**
 * Session Lifecycle Runner — extracted from flywheel-shell.tsx
 *
 * Encapsulates session lifecycle management: creating WorkflowSession instances,
 * setting up persistence (output flusher, transcript logger, budget tracker),
 * wiring stores, question wiring, cleanup/teardown, and backgrounding.
 *
 * All dependencies are injected via SessionLifecycleOptions — no SolidJS signals
 * or component-level state captured in closures. The shell accesses mutable state
 * through getter methods.
 *
 * NOTE: sessionControllers, runtimes, and sessionStores remain in the shell
 * (they're shared across sessions / used by viewport logic).
 */

import type { WorkflowSession } from "../session/workflow-session"
import type { OutputFlusher } from "../../session/output-persistence"
import type { TranscriptLogger } from "../../session/transcript"
import type { BudgetTracker } from "../../session/budget-tracker"
import type { BudgetLimits } from "../../schemas"
import type { QuestionWiring } from "../utils/question-wiring"
import type { QuestionRequest } from "../../queue/question-service"
import type { UIActions } from "../routes/work/context/ui-state/types"
import type { ModelActivity } from "../adapters/structured-output-builder"
import type { TimerService } from "../shared/services/timer"
import type { EventBus } from "../../events/event-bus"
import type { AnyBlock } from "../types"
import type { OutputSnapshot } from "../../session/output-schemas"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Dependencies injected by the shell component.
 * Follows the project's `createX(deps)` convention.
 */
export interface SessionLifecycleOptions {
  // ── Session creation/destruction ──
  createWorkflowSession: (label: string) => WorkflowSession
  destroyWorkflowSession: (session: WorkflowSession) => void

  // ── Persistence factories ──
  createOutputPersistence: (opts: { sessionId: string; baseDir: string }) => {
    createFlusher(
      getBlocks: () => { kind: string; [key: string]: unknown }[],
      opts?: { intervalMs?: number },
    ): OutputFlusher
  }
  createTranscriptLogger: (opts: { sessionId: string; baseDir: string }) => TranscriptLogger
  createBudgetTracker: (opts: { sessionId: string; baseDir: string }) => BudgetTracker
  readSession: (id: string, baseDir: string) => { budgetLimits: BudgetLimits } | null

  // ── Question wiring ──
  createQuestionWiring: (opts: {
    eventBus: EventBus
    onQuestion: (q: QuestionRequest) => void
    onClear: () => void
  }) => QuestionWiring

  // ── Output block injection (resume) ──
  injectOutputBlocks: (store: UIActions, blocks: AnyBlock[]) => void
  snapshotToBlocks: (snapshots: OutputSnapshot[]) => AnyBlock[]

  // ── Callbacks for UI state ──
  onModelActivityChange: (activity: ModelActivity) => void
  setActiveStore: (store: UIActions | null) => void
  setWorkState: (state: null) => void
  subscribeToStore: (store: UIActions) => void
  unsubscribeStore: () => void
  subscribeToTimer: (timer: TimerService) => void
  unsubscribeTimer: () => void
  onQuestionChange: (q: QuestionRequest | null) => void
  /** Called when the lifecycle manager creates/clears question wiring (so the shell can track it for rendering). */
  onQuestionWiringChange: (wiring: QuestionWiring | null) => void
  cleanupQueueSubscriptions: () => void
}

/** Return value from initSession / initResumeSession. */
export interface SessionInitResult {
  session: WorkflowSession
  persistedSessionId: string | null
  budgetTracker: BudgetTracker | null
  budgetLimits: BudgetLimits | null
}

// ---------------------------------------------------------------------------
// SessionLifecycleManager
// ---------------------------------------------------------------------------

export interface SessionLifecycleManager {
  /**
   * Initialize a new session for queue execution.
   *
   * Creates a WorkflowSession, wires store + timer + adapter, sets up
   * output persistence, transcript logger, budget tracker, and question wiring.
   */
  initSession(opts: {
    queue: { steps: { type: string; id: string; title: string; status: string }[] }
    args: Record<string, string>
    projectCwd: string
    persistedSessionId: string | null
    sessionStore: UIActions
  }): SessionInitResult

  /**
   * Initialize a session from a resume result.
   *
   * Creates a WorkflowSession from a resume result, injects output blocks,
   * sets up persistence/transcript/budget/question wiring.
   */
  initResumeSession(opts: {
    result: {
      planPath: string
      outputBlocks: OutputSnapshot[]
      session: { name?: string | null }
      queue: { steps: { type: string; id: string; title: string; status: string }[] }
    }
    projectCwd: string
    sessionId: string
  }): SessionInitResult

  /**
   * Background the current session without destroying it.
   *
   * Nulls the managed refs, unsubscribes the store, cleans up
   * question/queue subscriptions. The queue executor's async closure
   * keeps its own captured references alive.
   */
  backgroundCurrent(): void

  /**
   * Destroy the current session that is NOT tracked in runtimes.
   *
   * Used when starting a new session and the previous one isn't
   * backgrounded (no prevFocused in runtimes).
   */
  destroyCurrent(): void

  /**
   * Full teardown: disposes all active resources (flusher, transcript,
   * budget tracker, question wiring, store subscription), then destroys
   * the WorkflowSession.
   */
  teardown(): void

  /**
   * Pause cleanup: flushes and disposes persistence resources, cleans
   * up subscriptions, destroys the session. Used by pauseQueue.
   */
  teardownForPause(): Promise<void>

  // ── Getters ──
  getActiveSession(): WorkflowSession | null
  getActiveFlusher(): OutputFlusher | null
  getActiveBudgetTracker(): BudgetTracker | null
  getActiveTranscript(): TranscriptLogger | null
  getActiveQuestionWiring(): QuestionWiring | null
  getStoreUnsub(): (() => void) | null

  // ── Setters (for external mutation by queue execution callbacks) ──
  setActiveSession(session: WorkflowSession | null): void
  setActiveFlusher(flusher: OutputFlusher | null): void
  setActiveBudgetTracker(tracker: BudgetTracker | null): void
  setStoreUnsub(unsub: (() => void) | null): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionLifecycleManager(
  opts: SessionLifecycleOptions,
): SessionLifecycleManager {
  const {
    createWorkflowSession,
    destroyWorkflowSession,
    createOutputPersistence,
    createTranscriptLogger,
    createBudgetTracker,
    readSession,
    createQuestionWiring,
    injectOutputBlocks,
    snapshotToBlocks,
    onModelActivityChange,
    setActiveStore,
    setWorkState,
    subscribeToStore,
    unsubscribeStore,
    subscribeToTimer,
    unsubscribeTimer,
    onQuestionChange,
    onQuestionWiringChange,
    cleanupQueueSubscriptions,
  } = opts

  // ── Mutable state (previously spread as `let` refs in the shell) ──
  let activeSession: WorkflowSession | null = null
  let activeFlusher: OutputFlusher | null = null
  let activeTranscript: TranscriptLogger | null = null
  let activeBudgetTracker: BudgetTracker | null = null
  let storeUnsub: (() => void) | null = null
  let activeQuestionWiring: QuestionWiring | null = null

  // ── Internal helpers ──

  function cleanupQuestionSubscriptions(): void {
    if (activeQuestionWiring) {
      activeQuestionWiring.cleanup()
      activeQuestionWiring = null
      onQuestionWiringChange(null)
    }
    onQuestionChange(null)
  }

  /**
   * Wire persistence (output flusher + transcript logger) for a session.
   * Shared between initSession and initResumeSession.
   */
  function wirePersistence(
    sessionId: string,
    projectCwd: string,
    session: WorkflowSession,
  ): void {
    // Output flusher
    const persistence = createOutputPersistence({
      sessionId,
      baseDir: projectCwd,
    })
    const sessionStore = session.store
    const getOutputBlocks = () =>
      (sessionStore.getState().outputBlocks ?? []) as unknown as {
        kind: string
        [key: string]: unknown
      }[]
    activeFlusher = persistence.createFlusher(getOutputBlocks, {
      intervalMs: 5000,
    })

    // Transcript logger
    activeTranscript = createTranscriptLogger({
      sessionId,
      baseDir: projectCwd,
    })
    activeTranscript.subscribeTo(session.eventBus)
  }

  /**
   * Wire budget tracker for a session.
   * Returns the tracker and budget limits (or nulls if session not found).
   */
  function wireBudgetTracker(
    sessionId: string,
    projectCwd: string,
  ): { budgetTracker: BudgetTracker | null; budgetLimits: BudgetLimits | null } {
    const persistedSession = readSession(sessionId, projectCwd)
    if (!persistedSession) {
      return { budgetTracker: null, budgetLimits: null }
    }
    const budgetLimits = persistedSession.budgetLimits
    const budgetTracker = createBudgetTracker({
      sessionId,
      baseDir: projectCwd,
    })
    activeBudgetTracker = budgetTracker
    return { budgetTracker, budgetLimits }
  }

  /**
   * Wire question subscriptions for a session.
   */
  function wireQuestionWiring(eventBus: EventBus): void {
    cleanupQuestionSubscriptions()
    const questionWiring = createQuestionWiring({
      eventBus,
      onQuestion: (q) => onQuestionChange(q),
      onClear: () => onQuestionChange(null),
    })
    activeQuestionWiring = questionWiring
    onQuestionWiringChange(questionWiring)
  }

  /**
   * Create a fresh WorkflowSession and wire it to UI signals.
   * Shared between initSession and initResumeSession.
   */
  function createAndWireSession(label: string): WorkflowSession {
    const session = createWorkflowSession(label)
    activeSession = session
    session.adapter.onModelActivityChange = (activity) =>
      onModelActivityChange(activity)
    onModelActivityChange("idle")
    setActiveStore(session.store)
    subscribeToStore(session.store)
    subscribeToTimer(session.timer)
    return session
  }

  // ── Public API ──

  function initSession(initOpts: {
    queue: { steps: { type: string; id: string; title: string; status: string }[] }
    args: Record<string, string>
    projectCwd: string
    persistedSessionId: string | null
    sessionStore: UIActions
  }): SessionInitResult {
    const { queue, args, projectCwd, persistedSessionId } = initOpts

    // Create fresh session
    const sessionLabel = queue.steps.map((s) => s.type).join(" -> ")
    const session = createAndWireSession(sessionLabel)

    // Start workflow
    const planLabel =
      args.planPath ??
      args.description ??
      queue.steps.map((s) => s.type).join(" -> ")
    session.store.startWorkflow(planLabel)

    // Set up persistence if we have a persisted session ID
    if (persistedSessionId) {
      wirePersistence(persistedSessionId, projectCwd, session)
    }

    // Budget tracker
    let budgetTracker: BudgetTracker | null = null
    let budgetLimits: BudgetLimits | null = null
    if (persistedSessionId) {
      const btResult = wireBudgetTracker(persistedSessionId, projectCwd)
      budgetTracker = btResult.budgetTracker
      budgetLimits = btResult.budgetLimits
    }

    // Question wiring
    wireQuestionWiring(session.eventBus)

    return {
      session,
      persistedSessionId,
      budgetTracker,
      budgetLimits,
    }
  }

  function initResumeSession(resumeOpts: {
    result: {
      planPath: string
      outputBlocks: OutputSnapshot[]
      session: { name?: string | null }
      queue: { steps: { type: string; id: string; title: string; status: string }[] }
    }
    projectCwd: string
    sessionId: string
  }): SessionInitResult {
    const { result, projectCwd, sessionId } = resumeOpts

    // Create fresh session
    const session = createAndWireSession(result.planPath)

    // Start workflow
    session.store.startWorkflow(result.planPath ?? "Resumed session")

    // Inject restored output blocks
    injectOutputBlocks(
      session.store,
      snapshotToBlocks(result.outputBlocks) as AnyBlock[],
    )

    // Set up persistence
    wirePersistence(sessionId, projectCwd, session)

    // Log resume entry in transcript
    if (activeTranscript) {
      activeTranscript.logEntry("session:resumed", { sessionId })
    }

    // Budget tracker
    const btResult = wireBudgetTracker(sessionId, projectCwd)

    // Question wiring
    wireQuestionWiring(session.eventBus)

    return {
      session,
      persistedSessionId: sessionId,
      budgetTracker: btResult.budgetTracker,
      budgetLimits: btResult.budgetLimits,
    }
  }

  function backgroundCurrent(): void {
    // Null the managed refs without disposing — the queue executor's
    // async closure keeps its own captured references alive.
    activeSession = null
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
  }

  function destroyCurrent(): void {
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
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

  function teardown(): void {
    cleanupQuestionSubscriptions()
    cleanupQueueSubscriptions()
    unsubscribeTimer()
    unsubscribeStore()
    // Dispose output flusher (does NOT flush -- just cancels timers)
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
    if (activeSession) {
      destroyWorkflowSession(activeSession)
      activeSession = null
    }
    storeUnsub = null
    activeQuestionWiring = null
    setActiveStore(null)
    // Note: we do NOT clear workState here so completed view can still show output
  }

  async function teardownForPause(): Promise<void> {
    // Flush output BEFORE shutting down runtime (data must be persisted first)
    if (activeFlusher) {
      try {
        activeFlusher.schedule()
        await activeFlusher.flush()
      } catch {
        // Best effort -- don't block pause on flush failure
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

    // Clean up subscriptions
    cleanupQuestionSubscriptions()
    cleanupQueueSubscriptions()

    // Unsubscribe from timer so the runtime display stops ticking
    unsubscribeTimer()

    // Clean up store subscription
    unsubscribeStore()
    storeUnsub = null
    activeQuestionWiring = null
    // Null session ref (caller captures it before calling teardownForPause if needed)
    activeSession = null
  }

  // ── Return public interface ──

  return {
    initSession,
    initResumeSession,
    backgroundCurrent,
    destroyCurrent,
    teardown,
    teardownForPause,

    // Getters
    getActiveSession: () => activeSession,
    getActiveFlusher: () => activeFlusher,
    getActiveBudgetTracker: () => activeBudgetTracker,
    getActiveTranscript: () => activeTranscript,
    getActiveQuestionWiring: () => activeQuestionWiring,
    getStoreUnsub: () => storeUnsub,

    // Setters (for external mutation by queue execution callbacks)
    setActiveSession: (session) => {
      activeSession = session
    },
    setActiveFlusher: (flusher) => {
      activeFlusher = flusher
    },
    setActiveBudgetTracker: (tracker) => {
      activeBudgetTracker = tracker
    },
    setStoreUnsub: (unsub) => {
      storeUnsub = unsub
    },
  }
}
