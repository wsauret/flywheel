/**
 * Session Store — reactive session data backed by SolidJS createStore.
 *
 * Single source of truth for all session display data: active runners,
 * ended sessions, and historical sessions loaded from disk. The shell
 * picks one as "foreground" for display.
 *
 * Backed by SolidJS createStore — get() returns reactive proxies that
 * auto-track inside createEffect/createMemo. Outside reactive context,
 * reads work as plain property access (no tracking, just a snapshot).
 */

import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createWorkflowRunner, type WorkflowResult } from "./workflow-runner"
import type { WorkflowSessionFactories } from "./workflow-session"
import type { AnyBlock } from "../infra/output-blocks"
import type { Queue } from "../workflows/queue/types"
import type { SessionKind } from "./session/types"
import type { ChatRunner } from "./chat-runner"
import type {
  SessionStore,
  SessionEntry,
  WorkflowSessionEntry,
  ChatSessionEntry,
  ChatStoreHandle,
} from "./session-store-types"

// Factory

/**
 * Creates a session store backed by SolidJS createStore.
 * Callers MUST call disposeAll() on cleanup to dispose the internal reactive root.
 */
export function createSessionStore(factories: WorkflowSessionFactories): SessionStore {
  // Create a SolidJS reactive root that owns all effects/memos in this store.
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
    workflowDeps?: import("./engines/workflow-deps").WorkflowDeps
    chatContext?: string
    onComplete?: () => void
    onRunnerDone?: (sessionId: string, result: WorkflowResult) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): string {
    const { sessionId, queue, description, priorBlocks } = opts

    const overrides = (opts.subprocessCwd || opts.workflowDeps || opts.chatContext)
      ? { subprocessCwd: opts.subprocessCwd, workflowDeps: opts.workflowDeps, chatContext: opts.chatContext }
      : undefined

    const runner = createWorkflowRunner({
      sessionId,
      queue,
      description,
      updateEntry: (id, patch) => updateEntry(id, patch),
      factories,
      priorBlocks,
      overrides,
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
      ended: false,
    }

    setEntries(sessionId, entry)

    // Run in background — do NOT await
    runner.run().then(
      async (result) => {
        opts.onRunnerDone?.(sessionId, result)
        await finish(sessionId)
        opts.onComplete?.()
      },
      async (err) => {
        opts.onRunnerError?.(sessionId, err)
        await finish(sessionId)
        opts.onComplete?.()
      },
    )

    return sessionId
  }

  async function startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    initialCost?: number
    initialTokens?: number
    startedAt?: number
    contextPercent?: number
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
        opts.onRunnerError?.(sessionId, new Error(message))
        await finish(sessionId)
        opts.onComplete?.()
      },
      onEnded: async () => {
        opts.onRunnerDone?.(sessionId)
        await finish(sessionId)
        opts.onComplete?.()
      },
    }

    const runner = await opts.createRunner(storeHandle)

    const entry: ChatSessionEntry = {
      kind: "chat",
      runner,
      description,
      outputBlocks: runner.initialBlocks.length > 0 ? [...runner.initialBlocks] : priorBlocks ? [...priorBlocks] : [],
      tokens: opts.initialTokens ?? 0,
      cost: opts.initialCost ?? 0,
      contextPercent: opts.contextPercent ?? 0,
      startedAt: opts.startedAt ?? Date.now(),
      modelActivity: "idle",
      ended: false,
    }

    setEntries(sessionId, entry)

    return sessionId
  }

  function load(sessionId: string, data: {
    kind: SessionKind
    description: string
    outputBlocks: readonly AnyBlock[]
    tokens?: number
    cost?: number
    contextPercent?: number
    startedAt?: number
    claudeSessionId?: string
  }): void {
    // Don't overwrite a live or already-loaded entry
    if (entries[sessionId]) return
    const base = {
      description: data.description,
      outputBlocks: [...data.outputBlocks],
      tokens: data.tokens ?? 0,
      cost: data.cost ?? 0,
      contextPercent: data.contextPercent ?? 0,
      startedAt: data.startedAt ?? Date.now(),
      modelActivity: "idle" as const,
      ended: true,
      runner: null,
    }
    if (data.kind === "workflow") {
      setEntries(sessionId, { ...base, kind: "workflow", steps: [] } as WorkflowSessionEntry)
    } else {
      setEntries(sessionId, { ...base, kind: "chat", claudeSessionId: data.claudeSessionId } as ChatSessionEntry)
    }
  }

  function get(sessionId: string): SessionEntry | undefined {
    return entries[sessionId]
  }

  function has(sessionId: string): boolean {
    return entries[sessionId] !== undefined
  }

  function isRunning(sessionId: string): boolean {
    const entry = entries[sessionId]
    return entry !== undefined && !entry.ended
  }

  function pause(sessionId: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind !== "workflow") return false
    entry.runner.pause()
    return true
  }

  function abort(sessionId: string): void {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return
    entry.runner.abort()
    // Status transitions happen when run() resolves (workflow) or via callbacks (chat)
  }

  /** Dispose the runner but keep the entry for display. */
  async function finish(sessionId: string): Promise<void> {
    const entry = entries[sessionId]
    if (!entry || entry.ended) return
    setEntries(sessionId, produce((entry) => { entry.ended = true }))
    if (entry.runner) await entry.runner.dispose()
  }

  async function remove(sessionId: string): Promise<void> {
    const entry = entries[sessionId]
    if (!entry) return
    // Dispose BEFORE deleting — onRunnerDone/onRunnerError callbacks read the
    // store entry during disposal (e.g. to persist claudeSessionId). Deleting
    // first silently breaks any callback that calls sessionStore.get().
    if (!entry.ended && entry.runner) await entry.runner.dispose()
    setEntries(produce((e) => { delete e[sessionId] }))
  }

  function injectMessage(sessionId: string, text: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    // Optimistically set activity to "thinking" so the UI shows immediate
    // feedback while waiting for the first NDJSON thinking event to arrive.
    updateEntry(sessionId, { modelActivity: "thinking" })
    return entry.runner.injectMessage(text)
  }

  function cancelShutdown(sessionId: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind !== "workflow") return false
    entry.runner.cancelShutdown()
    return true
  }

  /** Number of actively running sessions (not ended).
   *  Reading Object.keys(entries) on a SolidJS store proxy auto-tracks key
   *  additions/removals when called inside a reactive context. The `ended`
   *  field is also tracked since we read each entry. */
  function runningCount(): number {
    return Object.keys(entries).filter((id) => !entries[id]?.ended).length
  }

  function allIds(): string[] {
    return Object.keys(entries)
  }

  async function disposeAll(): Promise<void> {
    const ids = Object.keys(entries)
    // Abort all first (signal subprocesses to stop)
    for (const id of ids) {
      const entry = entries[id]
      if (entry?.runner) entry.runner.abort()
    }
    // Then dispose all (flushes output, cleans up resources)
    await Promise.all(ids.map(async (id) => {
      const entry = entries[id]
      if (!entry?.runner) return
      try { await entry.runner.dispose() } catch { /* best-effort */ }
    }))
    // Clear all entries
    setEntries(produce((e) => {
      for (const id of ids) delete e[id]
    }))
    // Tear down the reactive root
    disposeRoot()
  }

  return { start, startChat, load, get, has, isRunning, allIds, pause, abort, finish, remove, injectMessage, cancelShutdown, updateEntry, runningCount, disposeAll }
}
