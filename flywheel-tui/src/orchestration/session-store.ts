import { createRoot } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { createWorkflowRunner } from "./workflow-runner.js"
import type { WorkflowResult } from "./workflow-runner-types.js"
import type { WorkflowSessionFactories } from "./session-store-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { Queue } from "../workflows/queue/types.js"
import type { SessionKind } from "./session/types.js"
import type { ChatRunner } from "./chat-runner-types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import type {
  SessionStore,
  SessionEntry,
  WorkflowSessionEntry,
  ChatSessionEntry,
  ChatStoreHandle,
} from "./session-store-types.js"

export function createSessionStore(factories: WorkflowSessionFactories): SessionStore {
  let disposeRoot!: () => void
  let entries!: Record<string, SessionEntry>
  let setEntries!: ReturnType<typeof createStore<Record<string, SessionEntry>>>[1]
  createRoot((dispose) => {
    disposeRoot = dispose
    const [store, setter] = createStore<Record<string, SessionEntry>>({})
    entries = store
    setEntries = setter
  })

  function updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>) {
    if (!entries[sessionId]) return
    setEntries(sessionId, patch)
  }

  function start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    workerCwd?: string
    workflowDeps?: WorkflowDeps
    chatContext?: string
    onRunnerDone?: (sessionId: string, result: WorkflowResult) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): string {
    const { sessionId, queue, description, priorBlocks } = opts

    const runner = createWorkflowRunner({
      sessionId,
      queue,
      description,
      updateEntry,
      factories,
      priorBlocks,
      overrides: {
        workerCwd: opts.workerCwd,
        workflowDeps: opts.workflowDeps,
        chatContext: opts.chatContext,
      },
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

    runner.run().then(
      async (result) => {
        opts.onRunnerDone?.(sessionId, result)
        await finish(sessionId)
      },
      async (err) => {
        opts.onRunnerError?.(sessionId, err)
        await finish(sessionId)
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
    onRunnerDone?: (sessionId: string) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string> {
    const { sessionId, description = "Chat", priorBlocks } = opts

    const storeHandle: ChatStoreHandle = {
      updateEntry: (patch) => updateEntry(sessionId, patch),
      onError: async (message) => {
        opts.onRunnerError?.(sessionId, new Error(message))
        await finish(sessionId)
      },
      onEnded: async () => {
        opts.onRunnerDone?.(sessionId)
        await finish(sessionId)
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
    engineSessionId?: string
  }): void {
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
      setEntries(sessionId, { ...base, kind: "chat", engineSessionId: data.engineSessionId } as ChatSessionEntry)
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
  }

  async function finish(sessionId: string): Promise<void> {
    const entry = entries[sessionId]
    if (!entry || entry.ended) return
    setEntries(sessionId, produce((entry) => { entry.ended = true }))
    if (entry.runner) await entry.runner.dispose()
  }

  async function remove(sessionId: string): Promise<void> {
    const entry = entries[sessionId]
    if (!entry) return
    // Dispose before deleting — callbacks during disposal read the store entry.
    if (!entry.ended && entry.runner) await entry.runner.dispose()
    setEntries(produce((e) => { delete e[sessionId] }))
  }

  function injectMessage(sessionId: string, text: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    // Optimistic UI update — the builder won't see a thinking event until ~100ms later.
    updateEntry(sessionId, { modelActivity: "thinking" })
    return entry.runner.injectMessage(text)
  }

  function injectToolResult(sessionId: string, toolUseId: string, content: string, isError?: boolean): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind !== "chat") return false
    entry.runner.sendToolResult(toolUseId, content, isError)
    return true
  }

  function answerQuestion(sessionId: string, toolUseId: string, answers: Record<string, string>): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind === "chat") entry.runner.chatSession.answerQuestion(toolUseId, answers)
    else entry.runner.answerQuestion(toolUseId, answers)
    return true
  }

  function cancelQuestion(sessionId: string, toolUseId: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind === "chat") entry.runner.chatSession.cancelQuestion(toolUseId)
    else entry.runner.cancelQuestion(toolUseId)
    return true
  }

  function cancelShutdown(sessionId: string): boolean {
    const entry = entries[sessionId]
    if (!entry || entry.ended || !entry.runner) return false
    if (entry.kind !== "workflow") return false
    entry.runner.cancelShutdown()
    return true
  }

  function runningCount(): number {
    return Object.keys(entries).filter((id) => !entries[id]?.ended).length
  }

  function allIds(): string[] {
    return Object.keys(entries)
  }

  async function disposeAll(): Promise<void> {
    const ids = Object.keys(entries)
    for (const id of ids) {
      const entry = entries[id]
      if (entry?.runner) entry.runner.abort()
    }
    await Promise.all(ids.map(async (id) => {
      const entry = entries[id]
      if (!entry?.runner) return
      try { await entry.runner.dispose() } catch { /* best-effort */ }
    }))
    setEntries(produce((e) => {
      for (const id of ids) delete e[id]
    }))
    disposeRoot()
  }

  return { start, startChat, load, get, has, isRunning, allIds, pause, abort, remove, injectMessage, injectToolResult, answerQuestion, cancelQuestion, cancelShutdown, updateEntry, runningCount, disposeAll }
}
