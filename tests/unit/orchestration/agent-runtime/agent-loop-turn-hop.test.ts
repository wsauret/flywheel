import { afterEach, expect, test } from "bun:test"
import { tmpdir } from "node:os"

import type { SessionInputProducer } from "../../../../src/infra/chat-input.js"
import type { SessionRelation } from "../../../../src/infra/chat-input-schema.js"
import { messageInput, resumeInput } from "../../../../src/infra/agent-loop-events.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { runAgentLoop } from "../../../../src/orchestration/agent-runtime/agent-loop.js"
import { createBackgroundExecutionOwner } from "../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { FUNCTION_TOOL_PRESENTATION, type ConversationMessage, type LLMClient, type ProviderStreamEvent } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { stableSystemPrompt } from "../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js"
import { createMessageSessionTool, MESSAGE_SESSION_TOOL_NAME } from "../../../../src/orchestration/agent-runtime/tools/message-session.js"
import type { RuntimeTool } from "../../../../src/orchestration/agent-runtime/tools/types.js"
import { trackTurnHop, turnHopOf, type TurnHopTracker } from "../../../../src/orchestration/agent-runtime/turn-hop.js"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages.js"
import { interruptedTurnMessage } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import type { DeliveryOutcome } from "../../../../src/orchestration/session/live-session-control.js"
import { registerLiveSessionControl } from "../../../../src/orchestration/session/live-session-control.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSessionMessaging } from "../../../../src/orchestration/session/session-messaging.js"
import { WorkflowInjectionQueue } from "../../../../src/orchestration/workflow-host/injection-queue.js"
import { fixedRequestToolSurface, RequestToolMap } from "../../../helpers/request-tool-surface.js"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestSubagent } from "../session/_session-manager-fixtures.js"
import { asModelClient, ownHistoryTarget } from "./_model-client.js"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"

afterEach(() => {
  cleanupTmpRoot()
})

function scriptedClient(responses: ProviderStreamEvent[][]): LLMClient {
  return { historyTarget: ownHistoryTarget,
    accessProvider: "anthropic_api",
    modelFamily: "anthropic",
    model: "test-model",
    toolPresentation: FUNCTION_TOOL_PRESENTATION,
    promptNotes: { progress: "", modelNotes: "" },
    contextLimit: 100_000,
    outputLimit: 8_000,
    supportsReasoning: false,
    async *streamWithTools(): AsyncGenerator<ProviderStreamEvent> {
      const response = responses.shift()
      if (!response) throw new Error("No more mock responses")
      for (const event of response) yield event
    },
    priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
  }
}

function call(id: string, name: string, input: { readonly [key: string]: unknown } = {}): ProviderStreamEvent[] {
  return [{ kind: "tool_use", toolCall: { id, name, input } }, { kind: "done", stopReason: "tool_use" }]
}

const END: ProviderStreamEvent[] = [{ kind: "done", stopReason: "end_turn" }]

function fromSession(sessionId: string, hop: number, toolUseId = `${sessionId}-call`): SessionInputProducer {
  return { kind: "session", sessionId, conversationId: `${sessionId}-conversation`, toolUseId, hop }
}

/** A message from `sessionId` with the envelope that names its relation to the reader. */
function related(relation: SessionRelation, sessionId: string, hop: number, toolUseId: string): SessionInputProducer {
  return { ...fromSession(sessionId, hop, toolUseId), envelope: { name: sessionId, relation, waits: false } }
}

/** The history of one session and the hop that its loop holds. */
interface HopReader {
  readonly history: ConversationMessage[]
  readonly hop: TurnHopTracker
}

/** A turn that its person started and that answered while its background
 *  work still runs: the loop reads each later message as a running turn
 *  reads it, but the history shows only the answer before the message. */
function answeredWhileWorkRuns(): HopReader {
  const history: ConversationMessage[] = [
    { kind: "user", content: "start", origin: "human", producer: { kind: "human" } },
    { kind: "assistant", content: [{ type: "text", text: "Started the build in the background." }] },
  ]
  const hop = trackTurnHop(() => history)
  hop.current()
  return { history, hop }
}

/** Appends a message to `reader` and lets its loop read it, as a loop that
 *  waits on background work reads it. */
function readMessage(reader: HopReader, producer: SessionInputProducer): void {
  reader.history.push({ kind: "user", content: "a message", producer })
  reader.hop.observe(messageInput({ text: "a message", producer }, { origin: "session" }), false)
}

/** The hop a tool call reads in the one turn of a resumed loop. */
async function hopOfResumedTurn(history: ConversationMessage[]): Promise<number | undefined> {
  let seen: number | undefined
  const probe: RuntimeTool = {
    name: "probe",
    action: "ui_meta",
    description: "Read the turn hop",
    inputSchema: { type: "object", properties: {} },
    isConcurrencySafe: true,
    async execute(_input, context) {
      seen = context.turnHop?.()
      return { content: "ok", outcome: "ok" }
    },
  }
  await runAgentLoop({
    client: asModelClient(scriptedClient([call("probe-1", "probe"), END])),
    tools: await fixedRequestToolSurface(new RequestToolMap([[probe.name, probe]])),
    systemPrompt: () => stableSystemPrompt("test"),
    instruction: null,
    executionCwd: tmpdir(),
    userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
    providerSessionKey: "turn-hop", promptCacheKey: "turn-hop",
    artifactScopeId: "turn-hop",
    retrievalSessionId: "turn-hop",
    persistence: { history: { append: () => {} } },
    seed: { kind: "resume", priorMessages: history },
    onEvent: () => {},
  })
  return seen
}

test("a turn that a person starts has hop 0, and a turn that a session message woke has its hop plus one, raised by what the turn read", async () => {
  expect(await hopOfResumedTurn([{ kind: "user", content: "hi", origin: "human", producer: { kind: "human" } }])).toBe(0)
  // The first message woke the turn (hop 4). The second reached the running
  // turn, so it can only raise the hop, and hop 2 does not.
  expect(await hopOfResumedTurn([
    { kind: "user", content: "first", producer: fromSession("a", 3) },
    { kind: "user", content: "second", producer: fromSession("b", 2) },
  ])).toBe(4)
  expect(await hopOfResumedTurn([
    { kind: "user", content: "from a session", producer: fromSession("a", 4) },
    { kind: "user", content: "from the person", origin: "human", producer: { kind: "human" } },
  ])).toBe(0)
  // A completion notice starts a turn that continues the chain of the turn
  // before it, so background work does not reset a chain.
  expect(await hopOfResumedTurn([
    { kind: "user", content: "count", producer: fromSession("a", 3) },
    { kind: "assistant", content: [{ type: "text", text: "Started the build in the background." }] },
    { kind: "user", origin: "system", content: "The build finished." },
  ])).toBe(4)
})

test("a loop that resumes a turn cut mid-turn keeps the hop of the turn that it continues", async () => {
  const probeCall = (id: string): ConversationMessage => ({ kind: "assistant", content: [{ type: "tool_use", id, name: "probe", input: {} }] })
  const result = (id: string): ConversationMessage => ({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "ok" }] })
  const woken: ConversationMessage[] = [{ kind: "user", content: "count", producer: fromSession("a", 2) }, probeCall("step-1"), result("step-1")]
  expect(await hopOfResumedTurn(woken)).toBe(3)
  // A planned replacement cut the turn, and its successor resumes it.
  expect(await hopOfResumedTurn([
    ...woken,
    { kind: "user", origin: "system", content: interruptedTurnMessage("runtime", false) },
    { kind: "user", origin: "system", content: CONTINUATION_MESSAGES.resumed },
  ])).toBe(3)
  // An unsolicited message that the turn read raised its hop.
  const raised: ConversationMessage[] = [...woken, { kind: "user", content: "more", producer: fromSession("b", 4) }, probeCall("step-2"), result("step-2")]
  expect(await hopOfResumedTurn(raised)).toBe(4)
  // A reply to the turn's own wait leaves the hop.
  expect(await hopOfResumedTurn([
    ...woken,
    { kind: "assistant", content: [{ type: "tool_use", id: "ask", name: MESSAGE_SESSION_TOOL_NAME, input: { to: "b", text: "which file?", wait: true } }] },
    result("ask"),
    { kind: "user", content: "parser.ts", producer: fromSession("b", 4, "reply") },
    probeCall("step-2"),
    result("step-2"),
  ])).toBe(3)
  // The person's message in the turn resets it.
  expect(await hopOfResumedTurn([...raised, { kind: "user", content: "stop that", origin: "human", producer: { kind: "human" } }, probeCall("step-3"), result("step-3")])).toBe(0)
})

test("a session message that a running turn reads raises the hop of what the turn sends next, and the person's input resets it", () => {
  const history: ConversationMessage[] = [{ kind: "user", content: "start", origin: "human", producer: { kind: "human" } }]
  const hop = trackTurnHop(() => history)
  hop.observe(messageInput({ text: "start", producer: { kind: "human" } }, { origin: "human" }), true)
  expect(hop.current()).toBe(0)
  // A reply that reaches the running turn is part of the chain the turn continues.
  hop.observe(messageInput({ text: "reply", producer: fromSession("b", 3) }, { origin: "session" }), false)
  expect(hop.current()).toBe(3)
  hop.observe(messageInput({ text: "older chain", producer: fromSession("c", 1) }, { origin: "session" }), false)
  expect(hop.current()).toBe(3)
  hop.observe(messageInput({ text: "go on", producer: { kind: "human" } }, { origin: "human" }), false)
  expect(hop.current()).toBe(0)
  // The turn answers, and a message from another session wakes the next one.
  history.push({ kind: "assistant", content: [{ type: "text", text: "Done." }] }, { kind: "user", content: "next", producer: fromSession("b", 2) })
  hop.observe(messageInput({ text: "next", producer: fromSession("b", 2) }, { origin: "session" }), true)
  expect(hop.current()).toBe(3)
  // A completion notice that starts the turn after it keeps the chain.
  history.push({ kind: "assistant", content: [{ type: "text", text: "Answered." }] }, { kind: "user", origin: "system", content: "The build finished." })
  hop.observe(messageInput("The build finished.", { origin: "silent-system", backgroundNotificationIds: ["build"] }), true)
  expect(hop.current()).toBe(3)
})

test("a person's Resume after an interrupt cut a turn that read a session message keeps the hop that a resumed loop reads", () => {
  // An interrupt cut the next model request after the turn read the message,
  // so the message is the first of the inputs that end the history.
  for (const [read, expected] of [[0, 4], [4, 4]] as const) {
    const woke = fromSession("a", 3)
    const history: ConversationMessage[] = [{ kind: "user", content: "count", producer: woke }]
    const hop = trackTurnHop(() => history)
    hop.observe(messageInput({ text: "count", producer: woke }, { origin: "session" }), true)
    const midTurn = fromSession("b", read)
    history.push(
      { kind: "assistant", content: [{ type: "tool_use", id: "probe-1", name: "probe", input: {} }] },
      { kind: "toolResult", toolUseId: "probe-1", content: [{ type: "text", text: "ok" }] },
      { kind: "user", content: "more", producer: midTurn },
    )
    hop.observe(messageInput({ text: "more", producer: midTurn }, { origin: "session" }), false)
    history.push({ kind: "user", origin: "system", content: interruptedTurnMessage("runtime", false) }, { kind: "user", origin: "system", content: CONTINUATION_MESSAGES.resumed })
    hop.observe(resumeInput(), true)
    expect(hop.current()).toBe(expected)
    expect(turnHopOf(history)).toBe(expected)
  }
})

test("a peer's message that a turn waiting on background work reads raises the hop to its hop plus one, and a peer's message that wakes the reader starts the hop again from its own chain", () => {
  const reader = answeredWhileWorkRuns()
  readMessage(reader, related("other", "b", 2, "b-1"))
  expect(reader.hop.current()).toBe(3)
  expect(turnHopOf(reader.history)).toBe(3)
  // A peer's message at a lower hop leaves the hop.
  readMessage(reader, related("sibling", "c", 1, "c-1"))
  expect(reader.hop.current()).toBe(3)
  expect(turnHopOf(reader.history)).toBe(3)
  // A peer's reply to the reader's own wait, from history that holds a wait
  // between peers, leaves the hop.
  reader.history.push(
    { kind: "assistant", content: [{ type: "tool_use", id: "ask", name: MESSAGE_SESSION_TOOL_NAME, input: { to: "b", text: "which file?", wait: true } }] },
    { kind: "toolResult", toolUseId: "ask", content: [{ type: "text", text: "Waiting" }] },
  )
  readMessage(reader, related("other", "b", 4, "b-2"))
  expect(reader.hop.current()).toBe(3)
  expect(turnHopOf(reader.history)).toBe(3)
  // The next message from that peer answers no wait.
  readMessage(reader, related("other", "b", 4, "b-3"))
  expect(reader.hop.current()).toBe(5)
  expect(turnHopOf(reader.history)).toBe(5)
  // The turn ends. A message from an unrelated chat wakes the reader into a
  // new turn, which joins the chain of that message alone.
  reader.history.push({ kind: "assistant", content: "Done." })
  const question = related("other", "c", 0, "c-2")
  reader.history.push({ kind: "user", content: "a question", producer: question })
  reader.hop.observe(messageInput({ text: "a question", producer: question }, { origin: "session" }), true)
  expect(reader.hop.current()).toBe(1)
  expect(turnHopOf(reader.history)).toBe(1)
})

test("a parent that talks with its children while it waits on them keeps its hop, and a message with no envelope keeps the hop of the message", () => {
  const parent = answeredWhileWorkRuns()
  readMessage(parent, related("other", "peer", 2, "peer-1"))
  expect(parent.hop.current()).toBe(3)
  // The child's running turn reads each message of its parent.
  const child = trackTurnHop(() => [])
  for (let round = 0; round < 6; round += 1) {
    child.observe(messageInput({ text: "revise", producer: related("parent", "parent", parent.hop.current(), `revise-${round}`) }, { origin: "session" }), false)
    readMessage(parent, related("child", "child", child.current(), `report-${round}`))
    expect(parent.hop.current()).toBe(3)
  }
  expect(child.current()).toBe(3)
  readMessage(parent, fromSession("old", 4, "old-1"))
  expect(parent.hop.current()).toBe(4)
})

test("a reply that answers the reader's own wait leaves the hop, and a later message from the same session raises it", () => {
  const ask = (id: string, to: string, wait?: true): ConversationMessage => ({
    kind: "assistant",
    content: [{ type: "tool_use", id, name: MESSAGE_SESSION_TOOL_NAME, input: { target: "session", to, text: "which file?", ...(wait ? { wait } : {}) } }],
  })
  const answered = (id: string): ConversationMessage => ({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "Waiting" }] })
  const from = (producer: SessionInputProducer): ConversationMessage => ({ kind: "user", content: "an answer", producer })
  const history: ConversationMessage[] = [{ kind: "user", content: "start", origin: "human", producer: { kind: "human" } }]
  const hop = trackTurnHop(() => history)
  hop.observe(messageInput({ text: "start", producer: { kind: "human" } }, { origin: "human" }), true)
  history.push(ask("ask-1", "b", true), answered("ask-1"))
  // The loop appends the message before the tracker observes it.
  const reply = fromSession("b", 3, "reply-1")
  history.push(from(reply))
  hop.observe(messageInput({ text: "an answer", producer: reply }, { origin: "session" }), false)
  expect(hop.current()).toBe(0)
  // The wait is answered, so the next message from b is unsolicited.
  const unsolicited = fromSession("b", 3, "reply-2")
  history.push(from(unsolicited))
  hop.observe(messageInput({ text: "more", producer: unsolicited }, { origin: "session" }), false)
  expect(hop.current()).toBe(3)
  // A message sent without a wait solicits nothing.
  history.push(ask("ask-2", "c"), answered("ask-2"))
  const notAwaited = fromSession("c", 4, "reply-3")
  history.push(from(notAwaited))
  hop.observe(messageInput({ text: "an answer", producer: notAwaited }, { origin: "session" }), false)
  expect(hop.current()).toBe(4)
})

test("a child that asks its idle parent six questions in one run and waits for each answer wakes it at hop 0 every time", async () => {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const manager = createSessionManager(deps)
  const reader = asAsyncEventReadSurface(store)
  const messaging = createSessionMessaging({ manager, projectionReader: reader, eventWriter: asAsyncEventWriter(store) }, unusedChildSessionControl())
  const parent = await manager.createChat({ name: "Root" })
  const child = await publishTestSubagent(manager, root, "child", parent)
  const queue = new WorkflowInjectionQueue()
  const notices: string[] = []
  const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: (text) => { notices.push(text) } }))
  const outcomes: DeliveryOutcome[] = []
  const hops: number[] = []
  const answers: Promise<unknown>[] = []
  // The parent is idle: each question wakes a turn of it, and that turn
  // answers through the real delivery, which ends the child's wait.
  const unregisterParent = registerLiveSessionControl(reader, {
    sessionId: parent,
    state: async () => "idle",
    deliver: async (input, decide) => {
      const outcome = decide("idle")
      outcomes.push(outcome)
      if (input.producer?.kind === "session") hops.push(input.producer.hop)
      if (outcome.status === "delivered" && input.producer) {
        const sender = { sessionId: parent, conversationId: `${parent}-conversation`, toolUseId: `answer-${outcomes.length}`, hop: turnHopOf([{ kind: "user", content: input.text, producer: input.producer }]) }
        answers.push(new Promise((resolve) => { setTimeout(resolve, 0) }).then(() => messaging.send({ sender, target: "session", to: child, text: `answer ${outcomes.length}`, personWords: () => undefined })))
      }
      return outcome
    },
    notify: async () => false,
  })
  // The child is the running subagent run that reads each answer.
  const unregisterChild = registerLiveSessionControl(reader, {
    sessionId: child,
    state: async () => "running",
    child: { runId: `${child}-run`, parentSessionId: parent, parentConversationId: `${parent}-conversation`, parentToolCallId: `${child}-tool`, modules: async () => undefined, backgroundTasks: background.tasks, stop: () => {}, interrupt: async () => true, progress: () => ({ toolUses: 0, totalTokens: 0, startedAtMs: 0 }) },
    deliver: async (input, decide) => {
      queue.enqueueMessage(input)
      return decide("running")
    },
    notify: async () => false,
  })
  try {
    const tool = createMessageSessionTool(messaging, background.tasks)
    const responses = Array.from({ length: 6 }, (_, index) => call(`ask-${index}`, tool.name, { target: "session", to: parent, text: `question ${index}`, wait: true }))
    await runAgentLoop({
      client: asModelClient(scriptedClient([...responses, END])),
      tools: await fixedRequestToolSurface(new RequestToolMap([[tool.name, tool]])),
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "do the work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      providerSessionKey: "child", promptCacheKey: "child",
      artifactScopeId: "child",
      retrievalSessionId: "child",
      sessionId: child,
      conversationId: "child-conversation",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: queue,
      background,
      completeOnIdle: {},
    })
    await Promise.all(answers)
  } finally {
    unregisterChild()
    unregisterParent()
    await background.close()
  }
  expect(hops).toEqual(Array.from({ length: 6 }, () => 0))
  expect(outcomes).toEqual(Array.from({ length: 6 }, () => ({ status: "delivered", startsTurn: true })))
  expect(notices).toEqual([])
})

test("a running chat that wakes an idle peer each round and reads each reply mid-turn reaches the wake limit at hop 5", async () => {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const manager = createSessionManager(deps)
  const reader = asAsyncEventReadSurface(store)
  const peer = await manager.createChat({ name: "Peer" })
  const sender = await manager.createChat({ name: "Sender" })
  const queue = new WorkflowInjectionQueue()
  const outcomes: DeliveryOutcome[] = []
  const hops: number[] = []
  // The peer is idle: each message wakes a turn of it, and that turn's
  // reply reaches the sender while the sender's own turn still runs.
  const unregister = registerLiveSessionControl(reader, {
    sessionId: peer,
    state: async () => "idle",
    deliver: async (input, decide) => {
      const outcome = decide("idle")
      outcomes.push(outcome)
      if (input.producer?.kind === "session") hops.push(input.producer.hop)
      if (outcome.status === "delivered" && input.producer) {
        const wokenTurnHop = turnHopOf([{ kind: "user", content: input.text, producer: input.producer }])
        queue.enqueueMessage({ text: `answer ${outcomes.length}`, producer: fromSession(peer, wokenTurnHop, `reply-${outcomes.length}`) })
      }
      return outcome
    },
    notify: async () => false,
  })
  try {
    const tool = createMessageSessionTool(createSessionMessaging({ manager, projectionReader: reader, eventWriter: asAsyncEventWriter(store) }, unusedChildSessionControl()))
    const responses = Array.from({ length: 6 }, (_, index) => call(`send-${index}`, tool.name, { target: "session", to: peer, text: `count ${index}` }))
    await runAgentLoop({
      client: asModelClient(scriptedClient([...responses, END])),
      tools: await fixedRequestToolSurface(new RequestToolMap([[tool.name, tool]])),
      systemPrompt: () => stableSystemPrompt("test"),
      instruction: "do the work",
      executionCwd: tmpdir(),
      userDataRoot: `${tmpdir()}/.test-account`, projectRoot: tmpdir(),
      providerSessionKey: "sender", promptCacheKey: "sender",
      artifactScopeId: "sender",
      retrievalSessionId: "sender",
      sessionId: sender,
      conversationId: "sender-conversation",
      persistence: { history: { append: () => {} } },
      seed: { kind: "fresh" },
      onEvent: () => {},
      inputSource: queue,
      completeOnIdle: {},
    })
  } finally {
    unregister()
  }
  expect(hops).toEqual([0, 1, 2, 3, 4, 5])
  const wakes: DeliveryOutcome[] = Array.from({ length: 5 }, () => ({ status: "delivered", startsTurn: true }))
  expect(outcomes).toEqual([...wakes, { status: "held", reason: "wake_limit" }])
})

test("two chats that wait on their background work and message each other reach the wake limit at hop 5, and a child still reaches its waiting parent", async () => {
  const root = makeTmpDir()
  const { deps, store } = makeDepsWithStore(root)
  const manager = createSessionManager(deps)
  const reader = asAsyncEventReadSurface(store)
  const messaging = createSessionMessaging({ manager, projectionReader: reader, eventWriter: asAsyncEventWriter(store) }, unusedChildSessionControl())
  const a = await manager.createChat({ name: "A" })
  const b = await manager.createChat({ name: "B" })
  // Each chat answered its person and waits on its background work, so its
  // loop reads each message that it is given without a wake.
  const chats = new Map([a, b].map((sessionId) => [sessionId, answeredWhileWorkRuns()]))
  const unregister = [a, b].map((sessionId) => registerLiveSessionControl(reader, {
    sessionId,
    state: async () => "waiting_on_work",
    deliver: async (input, decide) => {
      const outcome = decide("waiting_on_work")
      if (outcome.status !== "refused" && input.producer?.kind === "session") readMessage(chats.get(sessionId)!, input.producer)
      return outcome
    },
    notify: async () => false,
  }))
  const send = (from: string, to: string, toolUseId: string, hop: number) => messaging.send({
    target: "session",
    sender: { sessionId: from, conversationId: `${from}-conversation`, toolUseId, hop },
    to,
    // Each round asks a new question, so the duplicate drop never applies.
    text: `is your part done? (${toolUseId})`,
    personWords: () => undefined,
  })
  try {
    const hops: number[] = []
    const statuses: string[] = []
    let [from, to] = [a, b]
    for (let round = 0; round < 8 && !statuses.at(-1)?.startsWith("held"); round += 1) {
      const hop = chats.get(from)!.hop.current()
      hops.push(hop)
      const result = await send(from, to, `round-${round}`, hop)
      statuses.push(result.status === "held" ? `${result.status}:${result.reason}` : result.status)
      ;[from, to] = [to, from]
    }
    expect(hops).toEqual([0, 1, 2, 3, 4, 5])
    expect(statuses).toEqual(["delivered", "delivered", "delivered", "delivered", "delivered", "held:wake_limit"])
    const child = await publishTestSubagent(manager, root, "child", a)
    expect((await send(child, a, "report", 9)).status).toBe("delivered")
  } finally {
    for (const release of unregister) release()
  }
})
