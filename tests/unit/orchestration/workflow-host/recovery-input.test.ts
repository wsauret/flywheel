import { afterEach, beforeEach, expect, test } from "bun:test"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore, type InFlightWrite } from "../../../../src/infra/event-store-types"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import type { ChatInput } from "../../../../src/infra/chat-input"
import type { AgentFactory, AgentOptions, AgentRunTerminal } from "../../../../src/orchestration/agent-runtime/types"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types"
import { publishWorkerAttempt } from "./_workflow-host-fixtures"
import { createConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { checkpointFinalizedToolResult, FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/finalized-tool-result-checkpoint"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import {
  QUEUED_USER_INPUT_IN_FLIGHT_KIND, decodeQueuedUserInput, decodeQueuedUserInputCell,
  holdQueuedUserInput, queuedInputPayload, queuedUserInputPut, readWorkflowQueuedUserInputs,
} from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { consumeWorkflowRecoveryInputs } from "../../../../src/orchestration/workflow-host/recovery-input"
import { createWorkflowAgentInputs } from "../../../../src/orchestration/workflow-host/agent-inputs"
import { publishSkillRevision } from "../../../../src/workflows/skill-schema"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { initializedWorkflowFacts } from "../../../helpers/workflow-root-fixtures"
import { ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, holdAddressedWorkflowMessage } from "../../../../src/orchestration/session/conversation/addressed-workflow-messages"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts"
import { fourLaneControl, wideBindings } from "../../workflows/vm/_tree-fixtures"
import { makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"
import { definition } from "../../workflows/vm/host-test-support"

const sessionId = "workflow-recovery-input"
const step: AttemptRow = { id: "worker", definitionId: "work", briefId: "work", workflowDefinitionId: "wf", name: "Work", status: "running", writes: [], resumeRevertCount: 0 }
const originalInput: ChatInput = {
  text: "human steering",
  attachments: [{ marker: "image", mediaType: "image/png", data: "YWJj" }],
  invocation: { label: "review", args: "original args" },
}
const expectedInput = {
  kind: "user", origin: "human", invocation: originalInput.invocation,
  content: [{ type: "text", text: originalInput.text }, { type: "image", mediaType: "image/png", data: "YWJj" }],
} satisfies ConversationMessage
let baseDir: string
let store: EventStore
let writer: AsyncGuardedEventWriter
let factoryErrors: unknown[]
let inputSessionId: string
let inputConversationId: string | undefined

beforeEach(() => {
  factoryErrors = []
  inputSessionId = sessionId
  inputConversationId = undefined
  baseDir = mkdtempSync(join(tmpdir(), "flywheel-workflow-recovery-input-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  writer = asAsyncEventWriter(store)
})
afterEach(() => {
  store.close()
  rmSync(baseDir, { recursive: true, force: true })
  expect(factoryErrors).toEqual([])
})

function hold(key: string, input: ChatInput = originalInput): void {
  store.putInFlight(inputSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, key, { ...(inputConversationId ? { conversationId: inputConversationId } : { target: "workflow" }), origin: "human", ...input })
}
function heldKeys(): string[] {
  return store.readInFlight(inputSessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND).map(({ key }) => key)
}
async function publishInputMember(conversationId: string): Promise<void> {
  const { member } = await publishWorkerAttempt({ projectRoot: baseDir, reader: asAsyncEventReadSurface(store), writer, workflowId: sessionId, attemptId: step.id, conversationId })
  inputSessionId = member.sessionId
  inputConversationId = conversationId
}
function conversation(options: AgentOptions) {
  if (options.conversation.kind !== "durable-tree") throw new Error("expected durable tree")
  return options.conversation
}
async function branch(conversationId: string) {
  const tree = await tryOpenConversationTree({ sessionId, conversationId, store: asAsyncEventReadSurface(store) })
  if (!tree) throw new Error("expected committed tree")
  try { return await tree.getBranch() } finally { await tree.getStorage().dispose() }
}
function factory(observe: (options: AgentOptions) => AgentRunTerminal): AgentFactory {
  return (options) => {
    let terminal: AgentRunTerminal
    try { terminal = observe(options) } catch (error) { factoryErrors.push(error); throw error }
    return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal }) }
  }
}
function worker(createAgent: AgentFactory, eventWriter = writer) {
  return async (...args: Parameters<ReturnType<typeof createWorkerCallback>["worker"]>) => {
    const conversationId = args[4]
    if (!conversationId) throw new Error("Expected conversation")
    const { manager } = await publishWorkerAttempt({ projectRoot: baseDir, reader: asAsyncEventReadSurface(store), writer, workflowId: sessionId, attemptId: step.id, conversationId })
    return createWorkerCallback({
    awaitModelAccessSettled: async () => {},
    createAgent, createLLMClient: () => { throw new Error("unexpected provider") },
    captureProviderConnection: makeWorkflowDeps().captureProviderConnection,
    auth: testAuthContext(), proactiveCompactionThreshold: () => 270_000,
    resolveRoles: async () => new Map([["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }]]),
    emit: createEmit(new EventBus()), sessionId, projectRoot: baseDir, executionCwd: baseDir,
    userDataRoot: baseDir, accountHome: baseDir,
    moduleSelection: composeFirstPartyModules(),
    agentInputs: createWorkflowAgentInputs({ store: asAsyncEventReadSurface(store), sessionId }),
    deactivateSession: id => manager.updateLifecycleState(id, "inactive"),
    sessionEventWriter: createSessionFactWriter({ sessionId, writer }),
    eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), eventWriter,
    skills: publishSkillRevision(1, new Map()), personas: new Map(),
    resolvedAgents: new Map([["work", definition]]),
    recall: noConversationRecall,
    }).worker(...args)
  }
}

test("worker commits task then original workflow inputs in insertion order before its first factory and reopens without duplicates", async () => {
  const conversationId = "worker-input"
  await publishInputMember(conversationId)
  hold("z-first")
  hold("a-second", { text: "second human input" })
  store.putInFlight("other-session", QUEUED_USER_INPUT_IN_FLIGHT_KIND, "other", { conversationId: "other-conversation", text: "not ours", origin: "human" })
  let calls = 0
  const invoke = () => worker(factory((options) => {
    calls += 1
    expect(heldKeys()).toEqual([])
    expect(conversation(options).priorMessages).toEqual([
      { kind: "user", origin: "system", content: "canonical task" }, expectedInput,
      { kind: "user", origin: "human", content: "second human input" },
    ])
    expect(conversation(options).priorMessages).toHaveLength(3)
    return { kind: "aborted" }
  }))(step, "canonical task", "", undefined, conversationId)
  await invoke()
  await invoke()
  expect(calls).toBe(2)
  expect(store.readInFlight("other-session", QUEUED_USER_INPUT_IN_FLIGHT_KIND).map(row => row.key)).toEqual(["other"])
  expect((await branch(conversationId)).filter((entry) => entry.kind === "message")).toHaveLength(3)
})

// Each agent of a workflow writes its conversation in its own session, while
// a message for the workflow's next agent waits in a cell of the workflow.
test("an agent in its own session commits the workflow's held input under its key and retires the workflow's cell", async () => {
  const conversationId = "direct-canonical"
  const controller = createConversationTreeWriterController({ sessionId: "agent-session", workflowId: sessionId, conversationId, projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
  hold("canonical-cell")
  try {
    expect(await consumeWorkflowRecoveryInputs(asAsyncEventReadSurface(store), sessionId, controller, () => true)).toBe(true)
    expect((await branch(conversationId)).map((entry) => entry.id)).toEqual(["canonical-cell"])
    expect(heldKeys()).toEqual([])
    expect(await consumeWorkflowRecoveryInputs(asAsyncEventReadSurface(store), sessionId, controller, () => true)).toBe(false)
  } finally {
    await controller.dispose()
  }
})

test("an active worker leaves later cells for the next idle invocation", async () => {
  const conversationId = "worker-reassignment"
  await publishInputMember(conversationId)
  hold("initial")
  const seen: AgentOptions[] = []
  await worker(factory((options) => {
    seen.push(options)
    expect(conversation(options).priorMessages).toEqual([
      { kind: "user", origin: "system", content: "canonical task" }, expectedInput,
    ])
    expect(conversation(options).priorMessages).toHaveLength(2)
    if (seen.length === 1) {
      expect(heldKeys()).toEqual([])
      hold("later", { text: "held during active turn" })
    }
    expect(heldKeys()).toEqual(["later"])
    return { kind: "aborted" }
  }))(step, "canonical task", "", undefined, conversationId)
  expect(seen).toHaveLength(1)
  expect(heldKeys()).toEqual(["later"])
  expect((await branch(conversationId)).filter((entry) => entry.kind === "message")).toHaveLength(2)
  await worker(factory((options) => {
    expect(conversation(options).priorMessages.at(-1)).toEqual({ kind: "user", origin: "human", content: "held during active turn" })
    expect(heldKeys()).toEqual([])
    return { kind: "aborted" }
  }))(step, "canonical task", "", undefined, conversationId)
})

test("an agent in its own session that commits a live message its workflow held retires the workflow's cell", async () => {
  // Held while the agent runs, so the agent's loop reads it live and its
  // append carries the cell key as its dispatch id.
  const createAgent: AgentFactory = (options) => ({ send() {}, end() {}, abort() {}, done: (async () => {
    hold("live-delivery", { text: "read while running" })
    await conversation(options).append({ kind: "user", origin: "human", content: "read while running", dispatchIds: ["live-delivery"] })
    return { servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" as const } }
  })() })
  await worker(createAgent)(step, "canonical task", "", undefined, "member-live")
  expect((await branch("member-live")).map((entry) => entry.kind === "message" && entry.message.content)).toContain("read while running")
  expect(heldKeys()).toEqual([])
})

test("failed task seed holds input and a new worker invocation still seeds before consuming it", async () => {
  await publishInputMember("worker-seed-failed")
  hold("after-seed")
  const failingWriter: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (event.type === "chat.entries.appended") throw new Error("seed write failed")
      return writer.append(event)
    },
    appendBatch: async (events) => {
      if (events.some((event) => event.type === "chat.entries.appended")) throw new Error("seed write failed")
      return writer.appendBatch(events)
    },
    appendGuarded: async (event) => {
      if (event.type === "chat.entries.appended") throw new Error("seed write failed")
      return writer.appendGuarded(event)
    },
    appendBatchGuarded: async (events) => {
      if (events.some((event) => event.type === "chat.entries.appended")) throw new Error("seed write failed")
      return writer.appendBatchGuarded(events)
    },
  }
  let calls = 0
  const createAgent = factory((options) => {
    calls += 1
    expect(conversation(options).priorMessages).toEqual([
      { kind: "user", origin: "system", content: "canonical task" }, expectedInput,
    ])
    return { kind: "aborted" }
  })
  await expect(worker(createAgent, failingWriter)(step, "canonical task", "", undefined, "worker-seed-failed")).rejects.toThrow("seed write failed")
  expect(calls).toBe(0)
  expect(heldKeys()).toEqual(["after-seed"])
  await worker(createAgent)(step, "canonical task", "", undefined, "worker-seed-failed")
  expect(calls).toBe(1)
  expect(heldKeys()).toEqual([])
})

test("prepared workflow hold shares the bootstrap transaction and exposes its original input and exact transfer token", async () => {
  const put = queuedUserInputPut("supplied-key", { target: "workflow" }, originalInput)
  expect(put).toEqual({
    op: "put", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: "supplied-key",
    payload: { target: "workflow", origin: "human", ...originalInput },
  })
  expect(heldKeys()).toEqual([])
  await writer.appendBatch(initializedWorkflowFacts("canonical task").map((fact, index) => ({
    aggregateId: `workflow:${sessionId}`, ...fact, sessionId, timestamp: Date.now(),
    ...(index === 0 ? { inFlight: [put] } : {}),
  })))
  const rows = store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)
  expect(rows).toHaveLength(1)
  const row = rows[0]!
  expect(row.payload).not.toHaveProperty("conversationId")
  expect(decodeQueuedUserInputCell(row, sessionId)).toEqual({
    target: "workflow", workflowId: sessionId, key: "supplied-key", origin: "human", raw: row.raw, ...originalInput,
  })
  const decoded = decodeQueuedUserInputCell(row, sessionId)
  if (decoded?.target !== "workflow") throw new Error("expected workflow target")
  expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(store), sessionId)).toEqual([decoded])
  expect(decodeQueuedUserInput(row, sessionId, "unselected-conversation")).toBeNull()
})

test("conversation holds keep their serialization and provenance while generic recovery excludes workflow and other conversations", async () => {
  const conversationId = "conversation-target"
  const key = await holdQueuedUserInput(writer, sessionId, { target: "conversation", conversationId }, originalInput)
  const row = store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)[0]!
  expect(row.raw).toBe(JSON.stringify({
    conversationId, text: originalInput.text, origin: "human",
    attachments: originalInput.attachments, invocation: originalInput.invocation,
  }))
  expect(decodeQueuedUserInput(row, sessionId, conversationId)).toMatchObject({ ...originalInput, key, origin: "human" })
  store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "legacy", { conversationId, text: "unknown provenance" })
  hold("workflow-held")
  store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "other-conversation", { conversationId: "other", text: "not ours" })
  const treeWriter = createConversationTreeWriterController({ sessionId, conversationId, projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
  await treeWriter.commitUserTurn("new human input")
  await treeWriter.dispose()
  expect(heldKeys()).toEqual(["workflow-held", "other-conversation"])
  expect((await branch(conversationId)).filter((entry) => entry.kind === "message").map((entry) => entry.message)).toEqual([
    expectedInput, { kind: "user", content: "unknown provenance" },
    { kind: "user", content: "new human input", origin: "human" },
  ])
})

test("a failed input append leaves only uncommitted cells held and reopening does not duplicate the seed or prior input", async () => {
  const conversationId = "worker-input-failed"
  await publishInputMember(conversationId)
  hold("committed")
  hold("failed", { text: "second input" })
  // A failed append can clear, so the unattended recovery would send again;
  // the run is cancelled at the first failure to observe that attempt alone.
  const cancel = new AbortController()
  const fail = (): never => {
    cancel.abort()
    throw new Error("input write failed")
  }
  const failingWriter: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (event.inFlight?.some((write) => write.op === "swap" && write.key === "failed")) return fail()
      return writer.append(event)
    },
    appendBatchGuarded: async (events) => {
      if (events.some((event) => event.inFlight?.some((write) => write.op === "swap" && write.key === "failed"))) return fail()
      return writer.appendBatchGuarded(events)
    },
  }
  let calls = 0
  const createAgent = factory((options) => {
    calls += 1
    expect(conversation(options).priorMessages).toEqual([
      { kind: "user", content: "canonical task", origin: "system" }, expectedInput,
      { kind: "user", content: "second input", origin: "human" },
    ])
    return { kind: "aborted" }
  })
  await expect(worker(createAgent, failingWriter)(step, "canonical task", "", cancel.signal, conversationId)).rejects.toThrow("input write failed")
  expect(calls).toBe(0)
  expect(heldKeys()).toEqual(["failed"])
  expect((await branch(conversationId)).filter((entry) => entry.kind === "message")).toHaveLength(2)
  await worker(createAgent)(step, "canonical task", "", undefined, conversationId)
  expect(calls).toBe(1)
  expect(heldKeys()).toEqual([])
  expect((await branch(conversationId)).filter((entry) => entry.kind === "message")).toHaveLength(3)
})

test.each([true, false])("independent SQLite writers commit one held entry with same tree = %s", async (sameTree) => {
  const firstId = "first-target"
  const secondId = sameTree ? firstId : "second-target"
  const first = createConversationTreeWriterController({ sessionId, conversationId: firstId, projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
  await first.buildContext()
  const otherStore = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  const second = createConversationTreeWriterController({
    sessionId, conversationId: secondId, projectRoot: baseDir, store: asAsyncEventReadSurface(otherStore), projectionReader: asAsyncEventReadSurface(otherStore), writer: asAsyncEventWriter(otherStore),
  })
  try {
    await second.buildContext()
    hold("shared-cell")
    const firstCell = (await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(store), sessionId))[0]!
    const secondCell = (await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(otherStore), sessionId))[0]!
    const results = await Promise.all([first.commitQueuedUserInput(firstCell), second.commitQueuedUserInput(secondCell)])
    expect(results.filter((result) => result === "committed")).toHaveLength(sameTree ? 2 : 1)
    expect(results.filter((result) => result === "contended")).toHaveLength(sameTree ? 0 : 1)
    const entries = (await Promise.all([...new Set([firstId, secondId])].map(branch))).flat()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: "shared-cell", message: expectedInput })
    expect(heldKeys()).toEqual([])
    if (sameTree) expect(await second.commitQueuedUserInput(secondCell)).toBe("committed")
  } finally {
    await first.dispose()
    await second.dispose()
    otherStore.close()
  }
})

test("stale workflow raw cannot publish an entry or retire its replacement", async () => {
  hold("stale")
  const cell = (await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(store), sessionId))[0]!
  hold("stale", { text: "replacement" })
  const replacement = store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)
  const writes: (readonly InFlightWrite[])[] = []
  const observed: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (event.inFlight) writes.push([...event.inFlight])
      return writer.append(event)
    },
    appendBatchGuarded: async (events) => {
      for (const event of events) if (event.inFlight) writes.push([...event.inFlight])
      return writer.appendBatchGuarded(events)
    },
  }
  const controller = createConversationTreeWriterController({ sessionId, conversationId: "stale-target", projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: observed })
  try {
    expect(await controller.commitQueuedUserInput(cell)).toBe("contended")
    expect(await branch("stale-target")).toEqual([])
    expect(store.readInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual(replacement)
    expect(writes).toEqual([[{ op: "swap", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: cell.key, expectedRaw: cell.raw, payload: null, sessionId }]])
  } finally {
    await controller.dispose()
  }
})

test("workflow contention stops the snapshot in order and requests refresh even without delivery", async () => {
  hold("z-first")
  hold("a-later", { text: "later" })
  let replace = true
  const contending: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (replace && event.inFlight?.some((write) => write.op === "swap" && write.key === "z-first")) {
        replace = false
        hold("z-first", { text: "replacement" })
      }
      return writer.append(event)
    },
    appendBatchGuarded: async (events) => {
      if (replace && events.some((event) => event.inFlight?.some((write) => write.op === "swap" && write.key === "z-first"))) {
        replace = false
        hold("z-first", { text: "replacement" })
      }
      return writer.appendBatchGuarded(events)
    },
  }
  const controller = createConversationTreeWriterController({ sessionId, conversationId: "ordered-target", projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: contending })
  try {
    expect(await consumeWorkflowRecoveryInputs(asAsyncEventReadSurface(store), sessionId, controller, () => true)).toBe(true)
    expect(await branch("ordered-target")).toEqual([])
    expect(heldKeys()).toEqual(["z-first", "a-later"])
    expect(await consumeWorkflowRecoveryInputs(asAsyncEventReadSurface(store), sessionId, controller, () => true)).toBe(true)
    expect((await branch("ordered-target")).map((entry) => entry.id)).toEqual(["z-first", "a-later"])
    expect((await controller.buildContext()).messages.map((message) => message.content)).toEqual(["replacement", "later"])
    expect(heldKeys()).toEqual([])
  } finally {
    await controller.dispose()
  }
})

test("generic recovery refuses an explicit input behind a contended conversation cell", async () => {
  const conversationId = "generic-contention"
  store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "first", { conversationId, ...originalInput })
  store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "later", { conversationId, text: "later" })
  let replace = true
  const contending: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (replace && event.inFlight?.some((write) => write.op === "swap" && write.key === "first")) {
        replace = false
        store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "first", { conversationId, text: "replacement" })
      }
      return writer.append(event)
    },
    appendBatchGuarded: async (events) => {
      if (replace && events.some((event) => event.inFlight?.some((write) => write.op === "swap" && write.key === "first"))) {
        replace = false
        store.putInFlight(sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "first", { conversationId, text: "replacement" })
      }
      return writer.appendBatchGuarded(events)
    },
  }
  const controller = createConversationTreeWriterController({ sessionId, conversationId, projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: contending })
  try {
    await expect(controller.commitUserTurn("explicit")).rejects.toThrow("recovery contended")
    expect(await branch(conversationId)).toEqual([])
    expect(heldKeys()).toEqual(["first", "later"])
    await controller.commitUserTurn("explicit")
    expect((await controller.buildContext()).messages).toEqual([
      { kind: "user", content: "replacement" }, { kind: "user", content: "later" },
      { kind: "user", content: "explicit", origin: "human" },
    ])
  } finally {
    await controller.dispose()
  }
})

test("held-input commit rejects an active turn without buffering", async () => {
  const controller = createConversationTreeWriterController({ sessionId, conversationId: "active-target", projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
  await controller.buildContext()
  hold("idle-only")
  const cell = (await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(store), sessionId))[0]!
  try {
    controller.beginTurn()
    await expect(controller.commitQueuedUserInput(cell)).rejects.toThrow("active turn")
    await controller.endTurn()
    expect(await branch("active-target")).toEqual([])
    expect(heldKeys()).toEqual(["idle-only"])
    expect(await controller.commitQueuedUserInput(cell)).toBe("committed")
  } finally {
    await controller.dispose()
  }
})

test("queued-input commit propagates non-swap append failures unchanged", async () => {
  hold("failure")
  const cell = (await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(store), sessionId))[0]!
  let failure: Error = new Error("storage unavailable")
  const failing: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      if (event.type === "chat.entries.appended") throw failure
      return writer.append(event)
    },
    appendBatchGuarded: async (events) => {
      if (events.some((event) => event.type === "chat.entries.appended")) throw failure
      return writer.appendBatchGuarded(events)
    },
  }
  const controller = createConversationTreeWriterController({ sessionId, conversationId: "failed-target", projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer: failing })
  try {
    await expect(controller.commitQueuedUserInput(cell)).rejects.toBe(failure)
    failure = new Error("second storage failure")
    await expect(controller.commitQueuedUserInput(cell)).rejects.toBe(failure)
    expect(await branch("failed-target")).toEqual([])
    expect(heldKeys()).toEqual(["failure"])
  } finally {
    await controller.dispose()
  }
})

test("direct held-input commit recovers finalized results and interruption before the original input", async () => {
  const conversationId = "direct-preparation"
  const controller = createConversationTreeWriterController({ sessionId, conversationId, projectRoot: baseDir, store: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), writer })
  const factWriter = createSessionFactWriter({ sessionId, writer })
  try {
    await controller.commitUserTurn("initial task")
    // The step's own request makes the call, which is what makes it this
    // conversation's work among the session's facts.
    store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "model.requested", version: 5, actor: "flywheel", timestamp: Date.now(),
      payload: {
        requestId: "request-one", identity: { providerSessionKey: conversationId, conversationId }, turn: 1,
        model: "test-model", accessProvider: "openai_api", modelFamily: "openai", interactionProfileId: "default",
      },
    })
    store.append({
      aggregateId: `session:${sessionId}`, sessionId, type: "tool.input.completed", version: 1,
      actor: "flywheel", timestamp: Date.now(), payload: { toolUseId: "read-one", toolName: "read", modelRequestId: "request-one", input: {} },
    })
    controller.beginTurn()
    controller.recordCanonicalMessage({
      kind: "assistant", content: [{ type: "tool_use", id: "read-one", name: "read", input: {} }],
    })
    await controller.flushSavePoint(new Set(["read-one"]))
    await checkpointFinalizedToolResult(factWriter, {
      conversationId, toolUseId: "read-one", toolName: "read", budgetExempt: true, turnBudgetChars: 200_000,
      registrationOrdinal: 0, content: [{ type: "text", text: "recovered result" }], outcome: "ok",
    })
    controller.suspendPending()
    hold("after-preparation")
    expect(await consumeWorkflowRecoveryInputs(asAsyncEventReadSurface(store), sessionId, controller, () => true)).toBe(true)
    const messages = (await controller.buildContext()).messages
    expect(messages.map((message) => message.kind)).toEqual(["user", "assistant", "toolResult", "user", "user"])
    expect(messages[2]).toMatchObject({ toolUseId: "read-one", content: [{ type: "text", text: "recovered result" }] })
    expect(messages[3]).toMatchObject({ origin: "system" })
    expect(String(messages[3]?.content)).toContain("exited before the turn finished")
    expect(messages[4]).toEqual(expectedInput)
    expect((await branch(conversationId)).at(-1)?.id).toBe("after-preparation")
    expect(store.readInFlight(sessionId, [QUEUED_USER_INPUT_IN_FLIGHT_KIND, FINALIZED_TOOL_RESULT_IN_FLIGHT_KIND])).toEqual([])
  } finally {
    factWriter.dispose()
    await controller.dispose()
  }
})

test("a message a step did not drain reaches the next step exactly once, and a held one survives a crash to the next process", async () => {
  const reader = asAsyncEventReadSurface(store)
  const step1 = createConversationTreeWriterController({ sessionId, conversationId: "step-1", projectRoot: baseDir, store: reader, projectionReader: reader, writer })
  const step2 = createConversationTreeWriterController({ sessionId, conversationId: "step-2", projectRoot: baseDir, store: reader, projectionReader: reader, writer })
  try {
    const inputs = createWorkflowAgentInputs({ store: reader, sessionId })
    const delivered = { status: "delivered", startsTurn: false } as const
    // Accepted between steps: only the cell holds it.
    hold("between", { text: "between steps" })
    inputs.deliver({ text: "between steps", dispatchIds: ["between"] }, delivered)

    const first = inputs.open({ attemptId: "step-1:attempt:1", conversationId: "step-1" })
    expect(await first.adopt(step1)).toBe(true)
    expect(heldKeys()).toEqual([])
    // Accepted while step 1 runs, and step 1 ends before it drains it.
    hold("undrained", { text: "read me once" })
    inputs.deliver({ text: "read me once", dispatchIds: ["undrained"] }, delivered)
    expect(first.queue.holdsMessage("undrained")).toBe(true)
    first.release()
    expect(heldKeys()).toEqual(["undrained"])

    // The process stops here; the next one adopts the cell at its first step.
    const nextInputs = createWorkflowAgentInputs({ store: reader, sessionId })
    const second = nextInputs.open({ attemptId: "step-2:attempt:1", conversationId: "step-2" })
    expect(await second.adopt(step2)).toBe(true)
    nextInputs.deliver({ text: "read me once", dispatchIds: ["undrained"] }, delivered)
    expect(second.queue.drainPending()).toBeNull()
    expect(heldKeys()).toEqual([])

    const texts = async (conversationId: string) => (await branch(conversationId)).flatMap((entry) => entry.kind === "message" && entry.message.kind === "user" ? [entry.message.content] : [])
    expect(await texts("step-1")).toEqual(["between steps"])
    expect(await texts("step-2")).toEqual(["read me once"])
  } finally {
    await step1.dispose()
    await step2.dispose()
  }
})

// A step that resumes keeps its conversation, so its prompt predates every
// message addressed to its lane since it started. A restart loses the live
// delivery, so the resumed step takes the held message itself.
test("a resumed step takes a held message addressed to its lane that its conversation does not hold, once, and a step of another lane never does, also when a build before the agent lexicon held it", async () => {
  const reader = asAsyncEventReadSurface(store)
  const control = fourLaneControl()
  const view = flattenWorkflowView(control, wideBindings)
  store.appendBatch([buildWorkflowControlInitializedFact(control), ...queueFactsForState(null, view)].map((fact, index) => ({ ...fact, aggregateId: workflowAggregateId(sessionId), sessionId, timestamp: index + 1 })))
  const group = "input-mapped:node:1"
  const attemptOf = (agentNodeId: string) => {
    const node = view.tree?.nodes.find(({ id }) => id === agentNodeId)
    return node?.kind === "agent" ? node.currentAttemptId ?? "" : ""
  }
  const lane = (ordinal: number) => ({ addressedTo: [{ _tag: "item" as const, listNodeId: group, itemNodeId: `${group}:item:${ordinal}`, key: `t${ordinal}` }] as const, leafIds: [], label: `lane t${ordinal}` })
  const parent = { kind: "session" as const, sessionId: "parent", conversationId: "parent-conversation", toolUseId: "send-1", hop: 0, envelope: { name: "Planner", relation: "parent" as const, waits: false } }
  // A build before the agent lexicon held this cell with a `branch` address.
  await writer.putInFlight?.(sessionId, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, "msg:parent:send-1", {
    ...queuedInputPayload({ text: "Keep the old flag names.", producer: parent }),
    addressedTo: [{ _tag: "branch", groupNodeId: group, branchNodeId: `${group}:item:2`, key: "t2" }],
  })
  await holdAddressedWorkflowMessage(writer, sessionId, "for-t3", { text: "Start with the tests." }, lane(3))
  const running = { attemptId: attemptOf(`${group}:item:2:phase:1`), conversationId: "step-t2" }
  const writerFor = (conversationId: string) => createConversationTreeWriterController({ sessionId, conversationId, projectRoot: baseDir, store: reader, projectionReader: reader, writer })
  const resumed = writerFor("step-t2")
  try {
    const input = createWorkflowAgentInputs({ store: reader, sessionId }).open(running)
    await input.adopt(resumed)
    const taken = input.queue.drain()
    expect(taken?.input).toMatchObject({ text: "Keep the old flag names.", producer: parent, dispatchIds: ["msg:parent:send-1"] })
    expect(input.queue.drain()).toBeNull()

    // The step read it, so its conversation holds it under its key, and the
    // next resume takes nothing.
    hold("msg:parent:send-1", { text: "Keep the old flag names." })
    await createWorkflowAgentInputs({ store: reader, sessionId }).open(running).adopt(resumed)
    const again = createWorkflowAgentInputs({ store: reader, sessionId }).open(running)
    await again.adopt(resumed)
    expect(again.queue.drain()).toBeNull()
  } finally {
    await resumed.dispose()
  }
})
