/**
 * Session Registry — pure runner pool.
 *
 * Manages multiple concurrent session runners (workflow and chat). Each
 * registered session runs independently in the background. The shell picks
 * one as "foreground" for display, while others continue executing.
 *
 * If an entry exists, the session is active. Entries are removed synchronously
 * when runners complete or error. Lifecycle state (completed/paused/error)
 * is NOT tracked here — callers receive `onRunnerDone`/`onRunnerError`
 * callbacks and update their own state machines.
 *
 * Uses a discriminated union on `kind` ("workflow" | "chat") so consumers
 * can type-narrow to access session-specific fields (e.g. `steps` on
 * workflow entries, but not on chat entries).
 *
 * No UI imports — pure orchestration with callback-based notifications.
 */

import { createWorkflowRunner, type WorkflowRunner, type WorkflowResult, type StepState } from "./workflow-runner"
import type { AnyBlock } from "../infra/output-blocks"
import type { Queue } from "../workflows/queue/types"
import type { ModelActivity } from "../infra/events"
import type { ChatRunner } from "./chat-runner"
import type { SessionKind } from "./session/types"

// ---------------------------------------------------------------------------
// Types — discriminated union on `kind`
// ---------------------------------------------------------------------------

interface SessionEntryBase {
  readonly kind: SessionKind
  readonly description: string
  readonly outputBlocks: readonly AnyBlock[]
  readonly tokens: number
  readonly cost: number
  readonly contextPercent: number
  readonly startedAt: number
  readonly modelActivity: ModelActivity
  readonly errorMessage?: string
}

export interface WorkflowSessionEntry extends SessionEntryBase {
  readonly kind: "workflow"
  readonly runner: WorkflowRunner
  readonly steps: readonly StepState[]
}

export interface ChatSessionEntry extends SessionEntryBase {
  readonly kind: "chat"
  readonly runner: ChatRunner
}

export type SessionEntry = WorkflowSessionEntry | ChatSessionEntry

/** Callbacks passed into createRunner so the runner can update the registry entry. */
export interface ChatRegistryCallbacks {
  onBlocks: (blocks: AnyBlock[]) => void
  onTokens: (n: number) => void
  onCost: (n: number) => void
  onContextPercent: (n: number) => void
  onModelActivity: (activity: ModelActivity) => void
  onSessionName: (name: string) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface SessionRegistry {
  /** Start a new workflow and register it. Returns sessionId. */
  start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    /** Override the subprocess cwd. Defaults to projectCwd.
     * Used by /test (temp dir isolation) and git worktrees (branch-specific working dir).
     * Session metadata/persistence stays in projectCwd; only the spawned process runs here. */
    subprocessCwd?: string
    /** Called when the run completes or errors (e.g., temp dir cleanup). */
    onComplete?: () => void
    /** Called when the runner finishes successfully. */
    onRunnerDone?: (sessionId: string, result: WorkflowResult) => void
    /** Called when the runner errors. */
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): string

  /** Start a new chat session and register it. Returns sessionId.
   *  Async because ChatRunner creation is async.
   *  The createRunner factory receives callbacks wired to the registry's updateEntry. */
  startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (callbacks: ChatRegistryCallbacks) => Promise<ChatRunner>
    onComplete?: () => void
    /** Called when the chat session ends normally. */
    onRunnerDone?: (sessionId: string) => void
    /** Called when the chat session errors. */
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string>

  /** Get a session entry by ID. */
  get(sessionId: string): SessionEntry | undefined

  /** Check if a session exists in the registry. */
  has(sessionId: string): boolean

  /** Pause a specific session. Returns false if the entry doesn't support pausing (e.g. chat). */
  pause(sessionId: string): boolean

  /** Abort a specific session. */
  abort(sessionId: string): void

  /** Remove a session from the registry (cleanup). */
  remove(sessionId: string): void

  /** Subscribe to registry changes. Returns unsubscribe function. */
  subscribe(cb: () => void): () => void

  /** Inject a user message into a running session's worker. */
  injectMessage(sessionId: string, text: string): boolean

  /** Cancel shutdown for a session so it continues after current step. Returns false for non-workflow entries. */
  cancelShutdown(sessionId: string): boolean

  /** Number of active sessions (every entry is active). */
  runningCount(): number

  /** All session IDs currently in the registry. */
  allIds(): string[]

  /** Abort and dispose all sessions, flushing output. For clean shutdown. */
  disposeAll(): Promise<void>
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionRegistry(): SessionRegistry {
  const entries = new Map<string, SessionEntry>()
  const subscribers = new Set<() => void>()

  function notify(): void {
    for (const cb of subscribers) {
      try { cb() } catch { /* subscriber errors must not propagate */ }
    }
  }

  function updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void {
    const existing = entries.get(sessionId)
    if (!existing) return
    entries.set(sessionId, { ...existing, ...patch } as SessionEntry)
    notify()
  }

  function start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    subprocessCwd?: string
    onComplete?: () => void
    onRunnerDone?: (sessionId: string, result: WorkflowResult) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): string {
    const { sessionId, queue, description, priorBlocks } = opts

    const runner = createWorkflowRunner({
      sessionId,
      queue,
      description,
      callbacks: {
        onBlocks: (blocks) => updateEntry(sessionId, { outputBlocks: blocks }),
        onSteps: (steps) => updateEntry(sessionId, { steps }),
        onTokens: (n) => updateEntry(sessionId, { tokens: n }),
        onCost: (n) => updateEntry(sessionId, { cost: n }),
        onMetrics: (tokens, cost) => updateEntry(sessionId, { tokens, cost }),
        onSessionName: (name) => updateEntry(sessionId, { description: name }),
        onModelActivity: (activity) => updateEntry(sessionId, { modelActivity: activity }),
      },
      priorBlocks,
      overrides: opts.subprocessCwd ? { subprocessCwd: opts.subprocessCwd } : undefined,
    })

    const entry: WorkflowSessionEntry = {
      kind: "workflow",
      runner,
      description,
      outputBlocks: priorBlocks ? [...priorBlocks] : [],
      steps: [],
      tokens: 0,
      cost: 0,
      contextPercent: 0,
      startedAt: Date.now(),
      modelActivity: "idle",
    }

    entries.set(sessionId, entry)
    notify()

    // Run in background — do NOT await
    runner.run().then(
      (result) => {
        opts.onRunnerDone?.(sessionId, result)
        remove(sessionId)
        opts.onComplete?.()
      },
      (err) => {
        opts.onRunnerError?.(sessionId, err)
        remove(sessionId)
        opts.onComplete?.()
      },
    )

    return sessionId
  }

  async function startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (callbacks: ChatRegistryCallbacks) => Promise<ChatRunner>
    onComplete?: () => void
    onRunnerDone?: (sessionId: string) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string> {
    const { sessionId, description = "Chat", priorBlocks } = opts

    // Wire callbacks to the registry's updateEntry so subscriber notifications fire
    const registryCallbacks: ChatRegistryCallbacks = {
      onBlocks: (blocks) => updateEntry(sessionId, { outputBlocks: blocks }),
      onTokens: (n) => updateEntry(sessionId, { tokens: n }),
      onCost: (n) => updateEntry(sessionId, { cost: n }),
      onContextPercent: (n) => updateEntry(sessionId, { contextPercent: n }),
      onModelActivity: (activity) => updateEntry(sessionId, { modelActivity: activity }),
      onSessionName: (name) => updateEntry(sessionId, { description: name }),
      onError: (message) => {
        updateEntry(sessionId, { errorMessage: message })
        opts.onRunnerError?.(sessionId, new Error(message))
        remove(sessionId)
        opts.onComplete?.()
      },
      onEnded: () => {
        opts.onRunnerDone?.(sessionId)
        remove(sessionId)
        opts.onComplete?.()
      },
    }

    const runner = await opts.createRunner(registryCallbacks)

    const entry: ChatSessionEntry = {
      kind: "chat",
      runner,
      description,
      outputBlocks: priorBlocks ? [...priorBlocks] : [],
      tokens: 0,
      cost: 0,
      contextPercent: 0,
      startedAt: Date.now(),
      modelActivity: "idle",
    }

    entries.set(sessionId, entry)
    notify()

    return sessionId
  }

  function get(sessionId: string): SessionEntry | undefined {
    return entries.get(sessionId)
  }

  function has(sessionId: string): boolean {
    return entries.has(sessionId)
  }

  function pause(sessionId: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    if (entry.kind !== "workflow") return false
    entry.runner.pause()
    return true
  }

  function abort(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.abort()
    // Status transitions happen when run() resolves (workflow) or via callbacks (chat)
  }

  function remove(sessionId: string): void {
    const entry = entries.get(sessionId)
    if (!entry) return
    entry.runner.dispose()
    entries.delete(sessionId)
    notify()
  }

  function injectMessage(sessionId: string, text: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    // Optimistically set activity to "thinking" so the UI shows immediate
    // feedback while waiting for the first NDJSON thinking event to arrive.
    updateEntry(sessionId, { modelActivity: "thinking" })
    return entry.runner.injectMessage(text)
  }

  function cancelShutdown(sessionId: string): boolean {
    const entry = entries.get(sessionId)
    if (!entry) return false
    if (entry.kind !== "workflow") return false
    entry.runner.cancelShutdown()
    return true
  }

  function subscribe(cb: () => void): () => void {
    subscribers.add(cb)
    return () => { subscribers.delete(cb) }
  }

  function runningCount(): number {
    return entries.size
  }

  function allIds(): string[] {
    return [...entries.keys()]
  }

  async function disposeAll(): Promise<void> {
    const ids = [...entries.keys()]
    // Abort all first (signal subprocesses to stop)
    for (const id of ids) {
      const entry = entries.get(id)
      if (entry) entry.runner.abort()
    }
    // Then dispose all (flushes output, cleans up resources)
    await Promise.all(ids.map(async (id) => {
      const entry = entries.get(id)
      if (!entry) return
      try { await entry.runner.dispose() } catch { /* best-effort */ }
      entries.delete(id)
    }))
    notify()
  }

  return { start, startChat, get, has, allIds, pause, abort, remove, injectMessage, cancelShutdown, subscribe, runningCount, disposeAll }
}
