import { Scope } from "effect"
import { EventBus } from "../../../../src/infra/event-bus"
import { chatInputContent, type ChatInputLike } from "../../../../src/infra/chat-input"
import { asAsyncEventReadSurface, type AsyncEventStateReadSurface, type AsyncEventWriter, type EventStoreReadSurface, type StoredFact } from "../../../../src/infra/event-store-types"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import type { SessionEntryBasePatch } from "../../../../src/orchestration/session-store/types"
import type { SessionBudgetStore } from "../../../../src/orchestration/session/budget-store-types"
import type { AuthContext } from "../../../../src/infra/auth/auth-context"
import { createChatSession, type ChatSessionDeps } from "../../../../src/orchestration/chat/session"
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"
import { newTestRunner } from "../../../helpers/agent-runner.js"
import { asModelClient } from "../agent-runtime/_model-client"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnMessage, turnEndEntryId, turnEndOfEntry, type TurnEnd } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { redactMessage } from "../../../../src/orchestration/agent-runtime/agent-loop-history"
import type { ResolvedRoles } from "../../../../src/orchestration/config/roles"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import type { AskUserController } from "../../../../src/orchestration/runner/ask-user-controller"
import type { OutputSession } from "../../../../src/orchestration/runner/output-session"
import type { SessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { repoDefinitions } from "../../../helpers/project-definitions"
import { testDirectories } from "../../../helpers/directories"
import { MODULE_IDS } from "../../../../src/protocol/module-ids.js"
import type { WorkflowsMode } from "../../../../src/protocol/module-protocol-types.js"
import { capabilityAccessHolding } from "../agent-runtime/tools/_fixtures"
import { authProviders } from "../../../helpers/auth-context.js"

export function makeMemoryTreeWriter(): ConversationTreeWriterController {
  // Production-shaped mock: durably mirrors the chat-tree-writer contract by
  // accumulating idle user turns and canonical in-loop messages, so
  // `buildContext()` returns the model-visible history the same way a real
  // tree would.
  const messages: import("../../../../src/orchestration/agent-runtime/llm/types").ConversationMessage[] = []
  const keys = new Set<string>()
  let entryId = 0
  return {
    recordedPersonMessage: async () => undefined,
    reserveMessageId: async () => crypto.randomUUID(),
    releaseMessageId() {},
    async commitUserTurn(input: ChatInputLike) {
      messages.push({ kind: "user", content: chatInputContent(input) })
      entryId += 1
      return `e${entryId}`
    },
    async commitQueuedUserInput() { throw new Error("queued-input recovery requires the SQLite writer in this test") },
    async acceptRetainedOperation() {},
    async commitTurnEnd() { return { kind: "user", content: "interrupted", origin: "system" } },
    async commitHeldMessage(input: ChatInputLike) {
      const producer = typeof input === "string" ? undefined : input.producer
      messages.push({ kind: "user", content: chatInputContent(input), ...(producer?.kind === "session" ? { producer } : { origin: "human" as const }) })
      entryId += 1
      return `e${entryId}`
    },
    async commitSystemTurn(text: string, key?: string) {
      // Production-shaped: the real controller funnels system-produced turns
      // through redactMessage (mask + origin="system" provenance stamp), and
      // a key the tree already holds commits nothing.
      if (key !== undefined && keys.has(key)) return key
      if (key !== undefined) keys.add(key)
      messages.push(redactMessage({ kind: "user", content: text }, false))
      entryId += 1
      return `e${entryId}`
    },
    async commitBackgroundNotification(notification) {
      messages.push({
        kind: "user",
        content: notification.text,
        origin: "system",
        ...(notification.key ? { backgroundNotificationIds: [notification.key] } : {}),
      })
      entryId += 1
      return `e${entryId}`
    },
    async commitSystemMessage(message) {
      const input = typeof message === "string" ? { content: message } : message
      messages.push({ kind: "system", content: input.content, ...(input.displayOnly ? { displayOnly: true } : {}) })
      entryId += 1
      return `e${entryId}`
    },
    beginTurn: () => {},
    suspendPending: () => {},
    async endTurn() {},
    async recordCanonicalMessage(message) {
      messages.push({ ...message })
      entryId += 1
    },
    async settleSuspendedTurn() {},
    async holdQueuedUserInput() { return crypto.randomUUID() },
    async holdBackgroundNotification(text, notificationKey) {
      const message = redactMessage({ kind: "user", content: text }, false)
      if (message.kind !== "user" || typeof message.content !== "string") throw new Error("expected text notification")
      return { ...(notificationKey ? { key: notificationKey } : {}), text: message.content }
    },
    holdsBackgroundNotification: () => false,
    async waitForBackgroundNotification() {},
    async dropQueuedUserInputs() {},
    async flushSavePoint() {},
    async buildContext() {
      // Production hoists displayOnly onto the entry and filters it before the
      // rebuild; mirror that here so a marker leaking into context is caught.
      return { messages: messages.filter((m) => !("displayOnly" in m && m.displayOnly)).map((m) => ({ ...m })) }
    },
    async captureCommittedForkMessages() {
      return messages.filter((m) => !("displayOnly" in m && m.displayOnly)).map((m) => ({ ...m }))
    },
    async captureRawLiveMessages() {
      return structuredClone(messages.filter((m) => !("displayOnly" in m && m.displayOnly)))
    },
    async recordCompaction(input) {
      entryId += 1
      messages.length = 0
      return { entryId: `e${entryId}`, tokensAfter: input.measureTokensAfter([]), messages: [] }
    },
    getLeafId: async () => (entryId > 0 ? `e${entryId}` : null),
    // The fake writes no durable tree, so the tree it holds is empty.
    getState: () => createConversationTreeProjection(asAsyncEventReadSurface(inMemoryEventReader([])), "memory").replay(),
    recall: () => { throw new Error("recall not provided in this test") },
    async dispose() {},
  }
}

export const noopOnTreeFailure = <ErrorValue>(_err: ErrorValue): void => {}

/** Store-entry view of the session's rendered output: captures the stable
 *  outputBlocks array each flush publishes through updateEntry, the same
 *  surface the production store entry exposes. Tests assert on this view;
 *  the chat runner itself has no block read method. `inner` composes a test's
 *  own patch observer onto the same updateEntry. */
export function captureBlocks(inner?: (patch: SessionEntryBasePatch) => void) {
  let blocks: readonly AnyBlock[] = []
  return {
    updateEntry: (patch: SessionEntryBasePatch) => {
      if (patch.outputBlocks !== undefined) blocks = patch.outputBlocks
      inner?.(patch)
    },
    blocks: () => blocks,
  }
}

export function createSessionBudgetStore(): SessionBudgetStore {
  return {
    recordRuntimeEvent: async () => {},
    applyStoredFact: async () => {},
    getTotalCost: async () => 0,
    recordInvocation: async () => {},
    getInvocationsUsed: async () => 0,
    getTokensUsed: async () => 0,
    getOutputTokensUsed: async () => 0,
    metrics: async () => ({ tokens: 0, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 }),
    recordContextUtilization: async () => {},
    getContextUtilization: async () => ({ promptTokens: 0, contextWindow: 100_000, percent: 0 }),
    isExhausted: async () => false,
    dispose: () => {},
    recordProcessStarted: async () => {},
  }
}

export function createSessionFactWriter(): SessionFactWriter {
  let position = 0
  const record = async (fact: Parameters<SessionFactWriter["record"]>[0]): Promise<StoredFact> => {
    position += 1
    const stored: StoredFact = {
      ...fact, position, id: `event-${position}`, seq: position - 1,
      aggregateId: "session:test", sessionId: "test", timestamp: Date.now(),
    }
    return stored
  }
  return {
    record,
    recordBatch: (facts) => Promise.all(facts.map((fact) => record(fact))),
    recordGuarded: async (fact) => ({ kind: "stored", events: [await record(fact)] }),
    transaction: async (fn) => { fn() },
    flush: async () => ({ kind: "drained", acked: [] }),
    drain: async () => ({ kind: "drained", acked: [] }),
    dispose: () => {},
  }
}

/** Inert output surface for lifecycle tests that assert on runner and mailbox
 *  behavior, not on rendered blocks. */
export function outputSessionStub(sessionId: string): OutputSession {
  const blocks: readonly AnyBlock[] = []
  return {
    dispatchRuntimeEvent() {},
    applyProjectionEvent() {},
    pushQuestion() {},
    beginTurn() {},
    pushUserMessage() {},
    seedBlocks() {},
    hasQueued() { return false },
    drainQueued() { return [] },
    recallQueued() { return null },
    withdrawQueued() { return null },
    pushSystemMessage() {},
    pushDivider() {},
    answerQuestion() {},
    cancelQuestion() {},
    getBlocks() { return blocks },
    endTurn() {},
    streamPhase: null,
    sessionId,
    flush() {},
    dispose() {},
  }
}

export function askUserStub(): AskUserController {
  return {
    ask: async () => ({ kind: "cancelled" }),
    answerQuestion() {},
    cancelQuestion() {},
    suspendAll: () => false,
  }
}

/** An event store with no facts. Reads through it (learning reconciliation,
 *  skill-load telemetry) settle as no-ops. */
export function emptyEventReader(): EventStoreReadSurface {
  return {
    toolContent: { resolve: () => null },
    read: () => [],
    readTolerant: () => [],
    readLatestPayloadByAggregateAndType: () => null,
    readLatestByAggregateAndTypes: () => [],
    currentPosition: () => 0,
    countByAggregate: () => 0,
    aggregateSeq: () => -1,
    readInFlight: () => [],
    sessionsWithInFlight: () => [],
    hasInFlightProfile: () => false,
    foldEvidence: () => ({ head: 0, generation: 0, anchor: null }),
  }
}

export const testAuth: AuthContext = {
  providers: authProviders(),
  credentialLineages: {}, droppedCredentials: [],
}

export const testRoles: ResolvedRoles = new Map([
  ["chat", { roleId: "chat", model: "test", effort: "high" }],
])

/** Typed builder for ChatSessionDeps in unit tests. The caller passes the
 *  fields under test; everything else gets a benign stub so the contract
 *  stays honest and `as any` stays out of the test files. The `createLLMClient`
 *  default throws if hit — tests that don't drive `compact()` never call it. */
export function createTestChatSessionDeps(
  overrides: Pick<ChatSessionDeps, "sessionId" | "createAgent"> & Partial<ChatSessionDeps>,
): ChatSessionDeps {
  const eventStore = asAsyncEventReadSurface(emptyEventReader())
  return {
    ...testDirectories("/scratch"),
    definitions: repoDefinitions(),
    personas: repoDefinitions().personas(),
    createLLMClient: () => { throw new Error("createLLMClient not stubbed in this test") },
    prepareRequest: () => { throw new Error("prepareRequest not stubbed in this test") },
    captureProviderConnection: () => { throw new Error("captureProviderConnection not provided in this test") },
    resolveEnvSnapshot: () => { throw new Error("resolveEnvSnapshot not provided in this test") },
    conversationId: `conversation-${overrides.sessionId}`,
    createChildConversation: () => { throw new Error("createChildConversation not provided in this test") },
    moduleSelection: () => composeFirstPartyModules(),
    proactiveCompactionThreshold: () => 270_000,
    workflowMode: (): WorkflowsMode => "ask",
    // A unit chat session holds a full selection; a case that studies a
    // disabled capability passes its own boundary.
    capabilityAccess: capabilityAccessHolding(MODULE_IDS),
    auth: testAuth,
    resolveRoles: async () => testRoles,
    subscribeRoleChanges: () => async () => {},
    infra: {
      budgetStore: createSessionBudgetStore(),
      sessionEventWriter: createSessionFactWriter(),
      toolExecutionStore: {
        applyStoredFact: async () => {},
        loadTimeline: async () => [],
        dispose: () => {},
      },
      eventStore,
      projectionReader: eventStore,
    },
    // Nothing is acquired for unit sessions; dispose() still closes the scope.
    resourceScope: Scope.makeUnsafe("sequential"),
    eventBus: new EventBus(),
    treeWriter: makeMemoryTreeWriter(),
    onTreeFailure: noopOnTreeFailure,
    updateEntry: () => {},
    refreshEnvironment: async () => {},
    ...overrides,
  }
}

type ConversationTree = Awaited<ReturnType<typeof createConversationTree>>

/** Appends the record of a turn that `end` ended, as the runtime or a
 *  recovery writes it. */
export async function appendTurnEnd(tree: ConversationTree, end: TurnEnd): Promise<void> {
  const content = end.reason === "paused" ? interruptedTurnMessage(end.pausedBy, false) : "The process running this turn exited before the turn finished."
  await tree.appendMessage({ kind: "user", content, origin: "system" }, turnEndEntryId(end, crypto.randomUUID()))
}

/** A chat session over a conversation that the store holds, with the
 *  entries that `seed` appends, as a runner that attaches after a restart
 *  finds it. Its client answers each request with one line. It records the
 *  context of each request and, for each park, whether the park waits for
 *  the person. `turnEnds` reads the turn ends on the conversation's branch,
 *  oldest first. */
export async function createStoredChatSession(input: {
  readonly sessionId: string
  readonly conversationId: string
  readonly projectRoot: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly seed: (tree: ConversationTree) => Promise<void>
  readonly overrides?: Partial<ChatSessionDeps>
}) {
  const { sessionId, conversationId, projectRoot, reader, writer } = input
  const handle = { conversationId, sessionId, store: reader, writer }
  const tree = await tryOpenConversationTree(handle) ?? await createConversationTree(handle)
  await input.seed(tree)
  tree.getStorage().dispose()
  const calls: ConversationMessage[][] = []
  const parks: boolean[] = []
  const createClient = async () => asModelClient({
    accessProvider: "anthropic_api", modelFamily: "anthropic", model: "test", contextLimit: 100_000, outputLimit: 8_000,
    supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
    async *streamWithTools(options) {
      calls.push([...options.messages])
      yield { kind: "text_delta", text: "The letter is Q.", blockKey: "b0" } as const
      yield { kind: "done", stopReason: "end_turn" } as const
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  })
  const eventBus = new EventBus()
  eventBus.subscribeToType("agent.turn.parked", (event) => { parks.push(event.data.userResumeRequired) })
  const base = createTestChatSessionDeps({ sessionId, createAgent: (options) => newTestRunner(options, createClient) })
  const chat = createChatSession({ onError: () => {}, onEnded: () => {} }, {
    ...base,
    conversationId,
    eventBus,
    infra: { ...base.infra, eventStore: reader, projectionReader: reader },
    treeWriter: createConversationTreeWriterController({ conversationId, sessionId, projectRoot, store: reader, projectionReader: reader, writer }),
    ...input.overrides,
  })
  /** Resolves once the chat parked `count` times, and fails after three seconds. */
  const parked = async (count: number): Promise<void> => {
    const deadline = Date.now() + 3000
    while (parks.length < count && Date.now() < deadline) await Bun.sleep(2)
    if (parks.length < count) throw new Error(`the chat parked ${parks.length} times, not ${count}`)
  }
  const turnEnds = async (): Promise<TurnEnd[]> => {
    const reopened = await tryOpenConversationTree(handle)
    if (!reopened) return []
    try {
      return (await reopened.getBranch()).flatMap((entry) => {
        const end = turnEndOfEntry(entry)
        return end ? [end] : []
      })
    } finally {
      reopened.getStorage().dispose()
    }
  }
  return { chat, calls, parks, parked, turnEnds }
}
