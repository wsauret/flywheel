import { EventBus } from "../../../../src/infra/event-bus"
import type { ChatSessionDeps } from "../../../../src/orchestration/chat/session"
import { createChatRunnerLifecycle } from "../../../../src/orchestration/chat/runner-lifecycle"
import { ChatSessionState, type ChatCallbacks } from "../../../../src/orchestration/chat/types"
import type { AgentRunResult, Agent, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import type { BackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { askUserStub, createTestChatSessionDeps, makeMemoryTreeWriter, outputSessionStub } from "./_chat-session-agent-runtime-fixtures"

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
  // The turn pipeline runs as a forked Effect fiber; a macrotask lets its
  // scheduler reach the post-createContext send before assertions.
  await new Promise((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

/** `prepare` changes the deps before the lifecycle reads them, such as to
 *  point them at a real store whose capacity ledger is registered. */
export function makeLifecycle(selection?: Pick<ChatSessionDeps, "moduleSelection">, prepare?: (deps: ChatSessionDeps) => void) {
  const resolvers: Array<(result: AgentRunResult) => void> = []
  const sends: Array<Array<Parameters<Agent["send"]>[0]>> = []
  let background: BackgroundExecutionOwner | undefined
  const runnerOptions: AgentOptions[] = []
  const awaitDurableFacts = async (): Promise<void> => {}
  const eventBus = new EventBus()
  const runnerStarted = Promise.withResolvers<void>()
  const createAgent = (options: AgentOptions): Agent => {
    runnerOptions.push(options)
    const sent: Array<Parameters<Agent["send"]>[0]> = []
    background = options.runtimeSurfaces?.background
    sends.push(sent)
    const done = new Promise<AgentRunResult>((resolve) => { resolvers.push(resolve) })
    return { send(text: Parameters<Agent["send"]>[0]) { sent.push(text); runnerStarted.resolve() }, end() {}, abort() {}, done }
  }
  const deps = createTestChatSessionDeps({
    sessionId: "session-respawn",
    createAgent,
    treeWriter: makeMemoryTreeWriter(),
    ...selection,
  })
  prepare?.(deps)
  const state = new ChatSessionState(undefined, () => {})
  const ended = { count: 0 }
  const callbacks: ChatCallbacks = { onError() {}, onEnded() { ended.count += 1 } }
  const failures: string[] = []
  const session = { ...outputSessionStub("session-respawn"), pushSystemMessage(message: string) { failures.push(message) } }
  const lifecycle = createChatRunnerLifecycle({
    deps,
    eventBus,
    session,
    state,
    askUser: askUserStub(),
    setConnectionState() {},
    awaitDurableFacts,
    applyNestedStoredFact: async () => {},
  })
  return { lifecycle, resolvers, sends, state, background: () => background, deps, runnerOptions, awaitDurableFacts, eventBus, failures, session, callbacks, ended, runnerStarted: runnerStarted.promise }
}

/** Points the lifecycle's reads and its tree writer at a real store under `projectRoot`. */
export function useStore(deps: ChatSessionDeps, projectRoot: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  deps.infra.eventStore = asAsyncEventReadSurface(store)
  deps.infra.projectionReader = asAsyncEventReadSurface(store)
  deps.treeWriter = createConversationTreeWriterController({
    projectRoot, sessionId: deps.sessionId, conversationId: deps.conversationId, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store),
  })
  return store
}
