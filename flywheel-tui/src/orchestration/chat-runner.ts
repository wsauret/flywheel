import { createChatSession, type ChatSession, type ChatSessionDeps } from "./chat-session.js"
import type { ChatCallbacks } from "./chat-types.js"
import type { ChatRunner } from "./chat-runner-types.js"
import { createSessionInfra } from "./session/create-session-infra.js"
import { createOutputPersistence } from "./session/output-persistence.js"
import { updateSession } from "./session/persistence.js"
import { disposeSessionResources } from "./session/resources.js"
import { generateSessionTitle } from "./session-title.js"
import { prepareWorkflowDeps } from "./engines/workflow-deps.js"
import { createAskHookServer, type AskHookServer } from "./ask-hook/server.js"
import { EventBus, createEmit } from "../infra/event-bus.js"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { SessionState } from "./session/types.js"
import { resolveTierConfigs } from "./config/schema.js"
import { validateResolvedModels } from "./config/model-tiers.js"
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
  config?: FlywheelConfig
  engineSessionId?: string
}

export async function createChatRunner(deps: ChatRunnerDeps): Promise<ChatRunner> {
  const { sessionId, projectCwd, updateState, updateEntry, initialMessage } = deps

  const workflowDeps = prepareWorkflowDeps()
  const config = deps.config ?? workflowDeps.config

  const eventBus = new EventBus()
  const emit = createEmit(eventBus)

  const infra = createSessionInfra({
    sessionId,
    projectCwd,
    config,
    description: "chat",
    emitter: emit,
    workflowId: sessionId,
  })

  const outputPersistence = createOutputPersistence({ sessionId, baseDir: projectCwd })
  let outputFlusher: ReturnType<typeof outputPersistence.createFlusher>

  let disposed = false
  let firstMessageSent = deps.priorBlocks != null && deps.priorBlocks.length > 0
  let persistedEngineSessionId: string | null = deps.engineSessionId ?? null

  const initialBlocks: readonly AnyBlock[] = deps.priorBlocks ?? buildChatWelcomeBlocks(projectCwd)

  const chatCallbacks: ChatCallbacks = {
    onWaiting: (waiting) => {
      if (waiting) updateState(sessionId, "active")
    },
    onError: (message) => void deps.onError(message),
    onEnded: () => void deps.onEnded(),
  }

  const engine = workflowDeps.engine
  const tiers = resolveTierConfigs(config)
  const model = tiers.worker.model

  const validationErrors = validateResolvedModels([
    { component: "chat", model, engineId: engine.metadata.id },
  ], workflowDeps.auth)
  if (validationErrors.length > 0) {
    const details = validationErrors.map(e => `  ${e.component} (${e.model}): ${e.issue}`).join("\n")
    throw new Error(`Model configuration errors:\n${details}`)
  }

  let askHookServer: AskHookServer | null = null
  if (engine.metadata.id === "claude") {
    const socketPath = join(tmpdir(), `flywheel-ask-${sessionId}.sock`)
    askHookServer = await createAskHookServer(socketPath)
  }

  const chatSessionDeps: ChatSessionDeps = {
    projectCwd,
    engine,
    model,
    auth: workflowDeps.auth,
    infra,
    eventBus,
    sessionId,
    metricsWriter: (patch) => updateEntry(patch as Partial<ChatSessionEntry>),
    updateEntry: (patch) => updateEntry(patch as Partial<ChatSessionEntry>),
    priorBlocks: initialBlocks,
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

    if (!firstMessageSent) {
      firstMessageSent = true
      generateSessionTitle(
        text,
        (title) => {
          updateEntry({ description: title })
          deps.onSessionName?.(title)
        },
        { engine: workflowDeps.engine, auth: workflowDeps.auth, projectCwd, model },
      )
    }

    return true
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true

    chatSession.end()

    if (askHookServer) {
      try { await askHookServer.close() } catch { /* best-effort */ }
    }

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
