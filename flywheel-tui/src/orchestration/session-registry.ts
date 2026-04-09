/**
 * Session Registry — reactive runner pool backed by SolidJS createStore.
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
 * Backed by SolidJS createStore — get() returns reactive proxies that
 * auto-track inside createEffect/createMemo. Outside reactive context,
 * reads work as plain property access (no tracking, just a snapshot).
 */

import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createWorkflowRunner, type WorkflowRunner, type WorkflowResult, type StepState } from "./workflow-runner"
import type { WorkflowSessionFactories } from "./workflow-session"
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
  description: string
  outputBlocks: readonly AnyBlock[]
  tokens: number
  cost: number
  contextPercent: number
  readonly startedAt: number
  modelActivity: ModelActivity
  errorMessage?: string
}

export interface WorkflowSessionEntry extends SessionEntryBase {
  readonly kind: "workflow"
  readonly runner: WorkflowRunner
  steps: readonly StepState[]
}

export interface ChatSessionEntry extends SessionEntryBase {
  readonly kind: "chat"
  readonly runner: ChatRunner
}

export type SessionEntry = WorkflowSessionEntry | ChatSessionEntry

/** Handle passed to workflow adapter factory — write data directly to the reactive store. */
export interface WorkflowStoreHandle {
  updateEntry: (patch: Partial<WorkflowSessionEntry>) => void
}

/** Handle passed to chat runner factory — write data directly to the reactive store. */
export interface ChatStoreHandle {
  /** Write data fields directly to the session entry in the reactive store. */
  updateEntry: (patch: Partial<ChatSessionEntry>) => void
  /** Signal a fatal error — removes entry and fires onRunnerError.
   *  Returns void (fire-and-forget). Implementations are async but callers
   *  intentionally drop the promise — cleanup is best-effort. */
  onError: (message: string) => void
  /** Signal normal completion — removes entry and fires onRunnerDone.
   *  Returns void (fire-and-forget). Implementations are async but callers
   *  intentionally drop the promise — cleanup is best-effort. */
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
   *  The createRunner factory receives a store handle for direct writes. */
  startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (handle: ChatStoreHandle) => Promise<ChatRunner>
    onComplete?: () => void
    /** Called when the chat session ends normally. */
    onRunnerDone?: (sessionId: string) => void
    /** Called when the chat session errors. */
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string>

  /** Get a session entry by ID. Returns a reactive proxy — auto-tracks inside createEffect/createMemo. */
  get(sessionId: string): SessionEntry | undefined

  /** Check if a session exists in the registry. */
  has(sessionId: string): boolean

  /** Pause a specific session. Returns false if the entry doesn't support pausing (e.g. chat). */
  pause(sessionId: string): boolean

  /** Abort a specific session. */
  abort(sessionId: string): void

  /** Remove a session from the registry (cleanup). Async — awaits dispose/flush. */
  remove(sessionId: string): Promise<void>

  /** Update a specific field on an entry. Used by runners to write directly to the store. */
  updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void

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

/**
 * Creates a session registry backed by SolidJS createStore.
 * Callers MUST call disposeAll() on cleanup to dispose the internal reactive root.
 */
export function createSessionRegistry(factories: WorkflowSessionFactories): SessionRegistry {
  // Create a SolidJS reactive root that owns all effects/memos in this registry.
  // disposeRoot() tears down the reactive graph on shutdown.
  // Definite assignment (!) is safe: createRoot's callback runs synchronously.
  let disposeRoot!: () => void
  let entries!: Record<string, SessionEntry>
  let setEntries!: ReturnType<typeof createStore<Record<string, SessionEntry>>>[1]
  createRoot((dispose) => {
    disposeRoot = dispose
    const [store, setter] = createStore<Record<string, SessionEntry>>({})
    entries = store
    setEntries = setter
  })

  function updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void {
    if (!entries[sessionId]) return
    setEntries(sessionId, patch)
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
      updateEntry: (id, patch) => updateEntry(id, patch),
      factories,
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

    setEntries(sessionId, entry)

    // Run in background — do NOT await
    runner.run().then(
      async (result) => {
        opts.onRunnerDone?.(sessionId, result)
        await remove(sessionId)
        opts.onComplete?.()
      },
      async (err) => {
        opts.onRunnerError?.(sessionId, err)
        await remove(sessionId)
        opts.onComplete?.()
      },
    )

    return sessionId
  }

  async function startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    createRunner: (handle: ChatStoreHandle) => Promise<ChatRunner>
    onComplete?: () => void
    onRunnerDone?: (sessionId: string) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string> {
    const { sessionId, description = "Chat", priorBlocks } = opts

    // Create a store handle for the runner — data writes go directly to the reactive store
    const storeHandle: ChatStoreHandle = {
      updateEntry: (patch) => updateEntry(sessionId, patch),
      onError: async (message) => {
        updateEntry(sessionId, { errorMessage: message })
        opts.onRunnerError?.(sessionId, new Error(message))
        await remove(sessionId)
        opts.onComplete?.()
      },
      onEnded: async () => {
        opts.onRunnerDone?.(sessionId)
        await remove(sessionId)
        opts.onComplete?.()
      },
    }

    const runner = await opts.createRunner(storeHandle)

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

    setEntries(sessionId, entry)

    return sessionId
  }

  function get(sessionId: string): SessionEntry | undefined {
    return entries[sessionId]
  }

  function has(sessionId: string): boolean {
    return entries[sessionId] !== undefined
  }

  function pause(sessionId: string): boolean {
    const entry = entries[sessionId]
    if (!entry) return false
    if (entry.kind !== "workflow") return false
    entry.runner.pause()
    return true
  }

  function abort(sessionId: string): void {
    const entry = entries[sessionId]
    if (!entry) return
    entry.runner.abort()
    // Status transitions happen when run() resolves (workflow) or via callbacks (chat)
  }

  async function remove(sessionId: string): Promise<void> {
    const entry = entries[sessionId]
    if (!entry) return
    // Delete entry BEFORE awaiting dispose — UI updates aren't blocked by I/O
    setEntries(produce((e) => { delete e[sessionId] }))
    // Then await dispose (flushes output, cleans up resources)
    await entry.runner.dispose()
  }

  function injectMessage(sessionId: string, text: string): boolean {
    const entry = entries[sessionId]
    if (!entry) return false
    // Optimistically set activity to "thinking" so the UI shows immediate
    // feedback while waiting for the first NDJSON thinking event to arrive.
    updateEntry(sessionId, { modelActivity: "thinking" })
    return entry.runner.injectMessage(text)
  }

  function cancelShutdown(sessionId: string): boolean {
    const entry = entries[sessionId]
    if (!entry) return false
    if (entry.kind !== "workflow") return false
    entry.runner.cancelShutdown()
    return true
  }

  /** Number of active sessions. Reading Object.keys(entries) on a SolidJS store
   *  proxy auto-tracks key additions/removals when called inside a reactive context
   *  (createEffect, createMemo). Outside reactive context, returns a plain snapshot. */
  function runningCount(): number {
    return Object.keys(entries).length
  }

  function allIds(): string[] {
    return Object.keys(entries)
  }

  async function disposeAll(): Promise<void> {
    const ids = Object.keys(entries)
    // Abort all first (signal subprocesses to stop)
    for (const id of ids) {
      const entry = entries[id]
      if (entry) entry.runner.abort()
    }
    // Then dispose all (flushes output, cleans up resources)
    await Promise.all(ids.map(async (id) => {
      const entry = entries[id]
      if (!entry) return
      try { await entry.runner.dispose() } catch { /* best-effort */ }
    }))
    // Clear all entries
    setEntries(produce((e) => {
      for (const id of ids) delete e[id]
    }))
    // Tear down the reactive root
    disposeRoot()
  }

  return { start, startChat, get, has, allIds, pause, abort, remove, injectMessage, cancelShutdown, updateEntry, runningCount, disposeAll }
}
