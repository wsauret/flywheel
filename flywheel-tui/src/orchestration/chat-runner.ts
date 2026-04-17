import { createChatSession, type ChatSession, type ChatCallbacks, type ChatSessionDeps } from "./chat-session.js"
import { createSessionInfra } from "./session/create-session-infra.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { updateSession } from "./session/persistence.js"
import { disposeSessionResources } from "./session/resources.js"
import { generateSessionTitle } from "./session-title.js"
import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { createAskHookServer, type AskHookServer } from "./ask-hook/server.js"
import { EventBus, createEmit } from "../infra/event-bus.js"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SessionState } from "./session/types.js"
import type { FlywheelConfig } from "./config/schema.js"
import type { SessionEntryBase, ChatSessionEntry } from "./session-store-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import { buildChatWelcomeBlocks } from "./chat-welcome.js"

type ChatUpdateEntryFn = (patch: Partial<ChatSessionEntry>) => void

interface ChatRunnerDeps {
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
  config?: FlywheelConfig
  engineSessionId?: string
}

export interface ChatRunner {
  readonly sessionId: string
  abort(): void
  dispose(): Promise<void>
  injectMessage(text: string): boolean
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
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
  // Why a local guard: onFlush fires on explicit flush calls.
  // Without this, updateSession would write the same engineSessionId to disk
  // repeatedly. The guard skips the disk write when the value hasn't changed.
  let persistedEngineSessionId: string | null = deps.engineSessionId ?? null

  let initialBlocks: AnyBlock[] = []
  if (deps.showWelcome && !priorBlocks) {
    initialBlocks = buildChatWelcomeBlocks(projectCwd)
  }

  // Cast: OutputSession writes Partial<SessionEntryBase> (generic), but
  // the store entry is ChatSessionEntry. Safe because we're always in chat mode.
  const castUpdateEntry = (patch: Partial<SessionEntryBase>) => {
    updateEntry(patch as Partial<ChatSessionEntry>)
  }

  const chatCallbacks: ChatCallbacks = {
    onWaiting: (waiting) => {
      if (waiting) updateState(sessionId, "active")
    },
    onError: (message) => void deps.onError(message),
    onEnded: () => void deps.onEnded(),
  }

  const engine = workflowDeps.engine
  const model = config.worker?.model ?? config.model ?? engine.metadata.defaultModel

  // AskUserQuestion bridge — only wired for the Claude engine since the hook
  // mechanism lives inside Claude's CLI. Other engines get no server.
  let askHookServer: AskHookServer | null = null
  if (engine.metadata.id === "claude") {
    const socketPath = join(tmpdir(), `flywheel-ask-${sessionId}.sock`)
    askHookServer = await createAskHookServer(socketPath)
  }

  const chatSessionDeps: ChatSessionDeps = {
    projectCwd,
    engine,
    model,
    infra,
    eventBus,
    chatId,
    metricsWriter: (patch) => updateEntry(patch as Partial<ChatSessionEntry>),
    updateEntry: castUpdateEntry,
    priorBlocks,
    engineSessionId: deps.engineSessionId,
    askHookServer: askHookServer ?? undefined,
    onFlush: () => {
      const csId = chatSession.outputSession.sessionId
      if (csId) {
        updateEntry({ engineSessionId: csId })
        if (csId !== persistedEngineSessionId) {
          persistedEngineSessionId = csId
          try { updateSession(sessionId, { engineSessionId: csId }, projectCwd) } catch { /* best-effort */ }
        }
      }
      outputFlusher!.schedule()
    },
  }

  const chatSession = await createChatSession(chatCallbacks, chatSessionDeps, initialMessage)

  outputFlusher = outputPersistence.createFlusher(() => chatSession.outputSession.getBlocks())

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
        { engine: workflowDeps.engine, projectCwd },
      )
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    // 1. End the chat session FIRST (signal the engine runner to stop).
    //    Must happen before resource disposal — the runner may still write
    //    to budgetTracker/transcriptWriter while it's shutting down.
    chatSession.end()

    // 2. Close the ask-hook server — any pending hooks get cancel replies so
    //    Claude's permission machinery doesn't hang waiting for stdout.
    if (askHookServer) {
      try { await askHookServer.close() } catch { /* best-effort */ }
    }

    // 3. Unified resource disposal (finalize → flush → dispose)
    const resources = {
      budgetTracker: infra.budgetTracker,
      traceWriter: infra.traceWriter,
      transcriptWriter: infra.transcriptWriter,
      traceCollector: infra.traceCollector,
      outputFlusher,
    }
    await disposeSessionResources(resources, "ok")
  }

  function sendToolResult(toolUseId: string, content: string, isError?: boolean): void {
    chatSession.sendToolResult(toolUseId, content, isError)
  }

  return {
    sessionId,
    abort,
    dispose,
    injectMessage,
    sendToolResult,
    chatSession,
    initialBlocks,
  }
}
