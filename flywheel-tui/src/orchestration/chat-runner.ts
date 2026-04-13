import { createChatSession, type ChatSession, type ChatCallbacks, type ChatSessionDeps } from "./chat-session"
import { createSessionInfra } from "./session/create-session-infra"
import { createOutputPersistence } from "./session/output-persistence"
import { updateSession } from "./session/persistence"
import { disposeSessionResources } from "./session/resources"
import { generateSessionTitle } from "./session-title"
import { prepareWorkflowDeps } from "./engines/workflow-deps"
import { EventBus, createEmit } from "../infra/event-bus"
import { randomUUID } from "node:crypto"
import type { SessionState } from "./session/state-machine"
import type { FlywheelConfig } from "./config/schema"
import type { ProcessSpawner } from "./engines/subprocess/spawner"
import type { SessionEntryBase } from "./session-store-types"
import type { AnyBlock } from "../infra/output-blocks"
import { buildChatWelcomeBlocks } from "./chat-welcome.js"

type ChatUpdateEntryFn = (patch: Partial<import("./session-store-types").ChatSessionEntry>) => void

export interface ChatRunnerDeps {
  sessionId: string
  projectCwd: string
  updateState: (id: string, state: SessionState) => void
  updateEntry: ChatUpdateEntryFn
  onSessionName?: (name: string) => void
  onError: (message: string) => void
  onEnded: () => void
  initialMessage?: string
  priorBlocks?: AnyBlock[]
  showWelcome?: boolean
  spawner?: ProcessSpawner
  config?: FlywheelConfig
  claudeSessionId?: string
}

export interface ChatRunner {
  readonly sessionId: string
  abort(): void
  dispose(): Promise<void>
  injectMessage(text: string): boolean
  readonly chatSession: ChatSession
  readonly initialBlocks: readonly AnyBlock[]
}

export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectCwd, updateState, updateEntry, initialMessage, priorBlocks } = deps

  const workflowDeps = prepareWorkflowDeps()
  const config = deps.config ?? workflowDeps.config

  const eventBus = new EventBus()
  const emit = createEmit(eventBus)
  const chatId = randomUUID()

  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config,
    description: "chat",
    emitter: emit,
    workflowId: chatId,
  })

  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let outputFlusher: ReturnType<typeof outputPersistence.createFlusher>

  let disposed = false
  let firstMessageSent = priorBlocks != null && priorBlocks.length > 0
  let lastWaiting: boolean | null = null
  let persistedClaudeSessionId: string | null = deps.claudeSessionId ?? null

  if (priorBlocks && priorBlocks.length > 0) {
    updateEntry({ outputBlocks: [...priorBlocks] })
  }

  let initialBlocks: AnyBlock[] = []
  if (deps.showWelcome && !priorBlocks) {
    initialBlocks = buildChatWelcomeBlocks(projectCwd)
  }

  // Cast: OutputSession writes Partial<SessionEntryBase> (generic), but
  // the store entry is ChatSessionEntry. Safe because we're always in chat mode.
  const wrappedUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    const chatPatch = patch as Partial<import("./session-store-types").ChatSessionEntry>
    if (chatPatch.outputBlocks && priorBlocks && priorBlocks.length > 0) {
      updateEntry({ ...chatPatch, outputBlocks: [...priorBlocks, ...chatPatch.outputBlocks] })
    } else {
      updateEntry(chatPatch)
    }
  }

  const chatCallbacks: ChatCallbacks = {
    onWaiting: (waiting) => {
      if (waiting && lastWaiting !== true) {
        updateState(sessionId, "active")
      } else if (!waiting && lastWaiting !== false) {
        updateState(sessionId, "paused")
      }
      lastWaiting = waiting
    },
    onError: (message) => void deps.onError(message),
    onEnded: () => void deps.onEnded(),
  }

  const engine = workflowDeps.engine
  const engineName = config.engine
  const model = config.subprocess?.model ?? config.model ?? engine.metadata.defaultModel

  const chatSessionDeps: ChatSessionDeps = {
    projectCwd,
    engine,
    engineName,
    model,
    spawner: deps.spawner ?? workflowDeps.spawner,
    traceCollector: infra.traceCollector,
    budgetTracker: infra.budgetTracker,
    transcriptWriter: infra.transcriptWriter,
    eventBus,
    chatId,
    metricsWriter: (patch) => updateEntry(patch as Partial<import("./session-store-types").ChatSessionEntry>),
    updateEntry: wrappedUpdateEntry,
    claudeSessionId: deps.claudeSessionId,
    onFlush: () => {
      const csId = chatSession.outputSession.sessionId
      if (csId) {
        updateEntry({ claudeSessionId: csId })
        if (csId !== persistedClaudeSessionId) {
          persistedClaudeSessionId = csId
          try { updateSession(sessionId, { claudeSessionId: csId }, projectCwd) } catch { /* best-effort */ }
        }
      }
      outputFlusher!.schedule()
    },
  }

  const chatSession = await createChatSession(chatCallbacks, chatSessionDeps, initialMessage)

  // Wire flusher now that OutputSession exists
  outputFlusher = outputPersistence.createFlusher(() => {
    const sessionBlocks = chatSession.outputSession.getBlocks()
    return priorBlocks && priorBlocks.length > 0
      ? [...priorBlocks, ...sessionBlocks]
      : sessionBlocks
  })

  // ── SessionRunner implementation ──

  function abort(): void {
    chatSession.interrupt()
  }

  function injectMessage(text: string): boolean {
    chatSession.send(text)

    // Auto-name the session from the first user message
    if (!firstMessageSent) {
      firstMessageSent = true
      generateSessionTitle(
        text,
        (title) => {
          updateEntry({ description: title })
          deps.onSessionName?.(title)
        },
        { engine: workflowDeps.engine, spawner: workflowDeps.spawner, projectCwd },
      )
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // 1. End the chat session FIRST (signal subprocess to stop).
    //    Must happen before resource disposal — the subprocess may still write
    //    to budgetTracker/transcriptWriter while it's shutting down.
    chatSession.end()

    // 2. Unified resource disposal (finalize → flush → dispose)
    const resources = {
      budgetTracker: infra.budgetTracker,
      traceWriter: infra.traceWriter,
      transcriptWriter: infra.transcriptWriter,
      traceCollector: infra.traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, "ok")
  }

  return {
    sessionId,
    abort,
    dispose,
    injectMessage,
    chatSession,
    initialBlocks,
  }
}
