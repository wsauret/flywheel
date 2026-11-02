import { workflowAgentInputs } from "../../../helpers/workflow-agent-inputs"
import { testAuthContext } from "../../../helpers/auth-context.js"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { AgentFactory, AgentOptions } from "../../../../src/orchestration/agent-runtime/types"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages"
import { convertWorkflowAgentSessions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-agent-sessions"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-user-inputs"
import { historicalWorkerTaskRootId } from "../../../../src/orchestration/workflow-host/historical-worker-task"
import { createWorkerCallback } from "../../../../src/orchestration/workflow-host/agent-callback"
import { publishSkillRevision } from "../../../../src/workflows/skill-schema"
import { recoverWorkflowContext } from "../../../../src/workflows/context-bundle/context-recovery"
import { validateWorkflowBootstrap } from "../../../../src/workflows/vm/bootstrap-validation"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts"
import type { AttemptRow } from "../../../../src/workflows/view/types"
import { makeWorkflowDeps, noConversationRecall } from "./_workflow-controller-fixtures"
import { definition } from "../../workflows/vm/host-test-support"

const sessionId = "historical-worker-task"
const conversationId = "synthesized-conversation"
const operatorText = "  Keep the completed edits.\nContinue only the remaining work.  "
const canonicalPrompt = "# Original request\nImplement the requested feature.\n\n# Current skill\nVerify the remaining changes."
const step: AttemptRow = { id: "step-1", definitionId: "work", briefId: "work", workflowDefinitionId: "wf", name: "Work", status: "running", writes: [], resumeRevertCount: 0 }
let baseDir: string
let store: EventStore
let writer: AsyncGuardedEventWriter

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "flywheel-historical-worker-task-"))
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  writer = asAsyncEventWriter(store)
})
afterEach(() => {
  store.close()
  rmSync(baseDir, { recursive: true, force: true })
})

// Literal historical wire versions, not current recovery/tree builders.
function oldFootprint() {
  const workflowEnvelope = { aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 9000, actor: "flywheel" }
  const conversationEnvelope = { aggregateId: `conversation:${conversationId}`, sessionId, timestamp: 1000, actor: "flywheel" }
  const ownership = { _tag: "workflow", workflowDefinitionId: "wf" }
  const attempt = {
    id: step.id, logicalNodeId: "logical-step", workflowDefinitionId: "wf", definitionId: "work",
    sequence: 2, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "retry" }, ownership,
    state: { _tag: "pending" }, parentAttemptId: "prior-attempt", conversationId,
    handoff: null, priorRetryFeedback: null, forItem: null,
  }
  const root = {
    ...workflowEnvelope, type: "workflow.control.recovered", version: 1,
    payload: {
      supersededThroughSeq: 0, degradationReasons: [{ kind: "missing_root" }],
      runtimeIdentity: { version: "0.0.8", buildId: "historical-producer" },
      identities: {
        workflow: { source: "recovered", value: "wf" }, step: { source: "recovered", value: "logical-step" },
        attempt: { source: "synthesized", value: step.id }, conversation: { source: "synthesized", value: conversationId },
      },
      control: {
        definitionIdentity: { workflowDefinitionId: "wf", workflowSha256: "a".repeat(64), bindings: [], vmVersion: "2", handoffRegistry: [], skills: [], personas: [] },
        workflowName: "Old generated title, not the task",
        graph: { nodes: [{
          kind: "step", id: "logical-step", workflowDefinitionId: "wf", definitionId: "work", name: "Work",
          order: 0, ownership, state: { _tag: "pending" }, then: null, retry: null,
        }], dependencies: [], joins: [], budgets: [] },
        attempts: [
          { ...attempt, id: "prior-attempt", sequence: 1, parentAttemptId: null, conversationId: null, provenance: { _tag: "authored" }, state: { _tag: "failed", reason: "interrupted" } },
          attempt,
        ],
        frontier: [], issues: [], seals: [],
        guardrails: { maxQueueLength: 100, maxMutationsPerAttempt: 10, maxSessionInserts: 100, sessionInsertsUsed: 0, attemptMutationsUsed: [] },
        status: "paused", followUp: null, aggregateSeq: 2,
      },
    },
  }
  const recovered = { ...workflowEnvelope, type: "attempt.recovered", version: 1, payload: { attemptId: step.id, conversationId } }
  const createdAt = "1970-01-01T00:00:01.000Z"
  const created = { ...conversationEnvelope, type: "chat.tree.created", version: 1, payload: { conversationId, createdAt } }
  const appended = {
    ...conversationEnvelope, type: "chat.entries.appended", version: 1,
    payload: { conversationId, entries: [{ id: "original-operator-entry", parentId: null, timestamp: createdAt, kind: "message", message: { kind: "user", content: operatorText } }] },
  }
  return { root, recovered, created, appended }
}

function seed() {
  const { root, recovered, created, appended } = oldFootprint()
  expect(parseWorkflowSessionFact({ type: root.type, version: root.version, actor: root.actor, payload: root.payload }).type).toBe("workflow.control.recovered")
  const facts = store.appendBatch([root, recovered, created, appended])
  convertHistory()
  return { facts, key: `workflow-task-recovery:${facts[0]!.id}:${step.id}` }
}

function convertHistory(): void {
  store.appendBatch([
    { aggregateId: "session:parent", sessionId: "parent", timestamp: 0, actor: "flywheel", type: "session.created", version: 5,
      payload: JSON.parse('{"kind":"chat","command":"chat","conversationId":"parent-conversation","label":"Parent","lifecycleState":"inactive","lastUpdated":"2026-10-16T00:00:00.000Z"}') },
    { aggregateId: `session:${sessionId}`, sessionId, timestamp: 0, actor: "flywheel", type: "session.created", version: 5,
      payload: JSON.parse('{"kind":"workflow","command":"workflow","workflowDefinitionId":"wf","label":"Historical","lifecycleState":"inactive","lastUpdated":"2026-10-16T00:00:00.000Z","roleAssignments":{"defaults":{"workflow-agent":{"model":"gpt-5.4","effort":"medium"}},"overrides":{}},"launchedFrom":{"parentSessionId":"parent","conversationId":"parent-conversation","toolUseId":"launch","workflowDefinitionId":"wf","description":"Historical"}}') },
  ])
  expect(convertWorkflowAgentSessions(resolveEventStoreDbFile(baseDir)).converted).toBe(1)
}

async function tree() {
  const member = await workflowMembershipReader(asAsyncEventReadSurface(store)).attempt(sessionId, step.id)
  const opened = await tryOpenConversationTree({ sessionId: member?.sessionId ?? sessionId, conversationId, store: asAsyncEventReadSurface(store), writer })
  if (!opened) throw new Error("Expected historical tree")
  return opened
}

async function branch() {
  const opened = await tree()
  try { return await opened.getBranch() } finally { await opened.getStorage().dispose() }
}

function prior(options: AgentOptions) {
  if (options.conversation.kind !== "durable-tree") throw new Error("Expected durable worker conversation")
  return options.conversation.priorMessages
}

function capturingFactory(captured: AgentOptions[]): AgentFactory {
  return (options) => {
    captured.push(options)
    return { send() {}, end() {}, abort() {}, done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }
  }
}

function worker(createAgent: AgentFactory, eventWriter = writer) {
  return createWorkerCallback({
    awaitModelAccessSettled: async () => {},
    createAgent, createLLMClient: () => { throw new Error("unexpected provider") },
    captureProviderConnection: makeWorkflowDeps().captureProviderConnection,
    auth: testAuthContext(), proactiveCompactionThreshold: () => 270_000,
    resolveRoles: async () => new Map([["workflow-agent", { roleId: "workflow-agent", model: "test-model", effort: "high" }]]),
    emit: createEmit(new EventBus()), sessionId, projectRoot: baseDir, executionCwd: baseDir,
    userDataRoot: baseDir, accountHome: baseDir,
    moduleSelection: composeFirstPartyModules(), agentInputs: workflowAgentInputs(asAsyncEventReadSurface(store), sessionId).agentInputs,
    deactivateSession: id => createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, projectionReader: asAsyncEventReadSurface(store), writer }).updateLifecycleState(id, "inactive"),
    sessionEventWriter: createSessionFactWriter({ sessionId, writer }),
    eventStore: asAsyncEventReadSurface(store), projectionReader: asAsyncEventReadSurface(store), eventWriter,
    skills: publishSkillRevision(1, new Map()), personas: new Map(),
    resolvedAgents: new Map([["work", definition]]),
    recall: noConversationRecall,
  }).worker
}

test("commits the missing canonical task before factory context and newly held input, preserving historical bytes", async () => {
  const { facts, key } = seed()
  const originalBytes = JSON.stringify(store.read({ sessionId }))
  expect(await historicalWorkerTaskRootId(asAsyncEventReadSurface(store), sessionId, step.id, conversationId)).toBe(facts[0]!.id)
  expect(JSON.stringify(store.read({ sessionId }))).toBe(originalBytes)
  const member = await workflowMembershipReader(asAsyncEventReadSurface(store)).attempt(sessionId, step.id)
  if (!member) throw new Error("Expected converted member")
  store.putInFlight(member.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND, "new-operator-input", { conversationId, origin: "human", text: "Now verify only." })
  const captured: AgentOptions[] = []
  let durableAtFactory: Promise<boolean> | undefined
  await worker((options) => {
    durableAtFactory = branch().then((entries) => entries.some((entry) => entry.id === key))
    return capturingFactory(captured)(options)
  })(step, canonicalPrompt, "", undefined, conversationId)

  expect(await durableAtFactory).toBe(true)
  expect(captured).toHaveLength(1)
  const messages = prior(captured[0]!)
  expect(messages).toHaveLength(3)
  expect(messages[0]).toEqual({ kind: "user", content: operatorText })
  expect(messages[1]).toMatchObject({ kind: "user", origin: "system" })
  expect(messages[1]!.content).toContain(canonicalPrompt)
  expect(messages[1]!.content).toContain("not a new request")
  expect(messages[1]!.content).toContain("Recorded operator instructions and completed work still apply.")
  expect(messages[2]).toEqual({ kind: "user", origin: "human", content: "Now verify only." })
  const entries = await branch()
  expect(entries[0]).toMatchObject(oldFootprint().appended.payload.entries[0]!)
  expect(entries[1]).toMatchObject({ id: key, parentId: "original-operator-entry" })
  expect(entries[2]).toMatchObject({ id: "new-operator-input", parentId: key })
  expect(JSON.stringify(store.read({ sessionId }))).toBe(originalBytes)
  expect(store.readInFlight(member.sessionId, QUEUED_USER_INPUT_IN_FLIGHT_KIND)).toEqual([])
})

test("retains later assistant, tool-result, and operator history without replaying tools or inserting a prefill nudge", async () => {
  const { key } = seed()
  const opened = await tree()
  await opened.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "finished-tool", name: "write", input: { path: "done.txt" } }] })
  await opened.appendMessage({ kind: "toolResult", toolUseId: "finished-tool", content: [{ type: "text", text: "already written" }] })
  await opened.appendMessage({ kind: "user", content: "Do not redo that write", origin: "human" })
  await opened.appendMessage({ kind: "assistant", content: [{ type: "text", text: "waiting at the historical leaf" }] })
  const originalBranch = await opened.getBranch()
  await opened.getStorage().dispose()
  const originalFacts = store.read({ aggregateId: `conversation:${conversationId}` })
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured))(step, canonicalPrompt, "", undefined, conversationId)
  expect(captured).toHaveLength(1)
  expect(prior(captured[0]!).slice(0, 5)).toEqual<unknown>(
    originalBranch.filter((entry) => entry.kind === "message").map((entry) => entry.message),
  )
  expect(JSON.stringify(prior(captured[0]!))).not.toContain(CONTINUATION_MESSAGES.unexpected_exit)
  expect((await branch()).slice(0, 5)).toEqual(originalBranch)
  expect((await branch()).at(-1)).toMatchObject({ id: key, parentId: originalBranch.at(-1)!.id })
  expect(store.read({ aggregateId: `conversation:${conversationId}` })).toHaveLength(originalFacts.length + 1)
  expect(store.read({ aggregateId: `conversation:${conversationId}` }).slice(0, originalFacts.length)).toEqual(originalFacts)
})

test("reentry after task commit keeps the first task even when the assembled prompt changes", async () => {
  const { key } = seed()
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured))(step, canonicalPrompt, "", undefined, conversationId)
  const committed = await branch()
  await worker(capturingFactory(captured))(step, "Later enriched prompt must not replace the first committed task", "", undefined, conversationId)
  expect(captured).toHaveLength(2)
  expect(await branch()).toEqual(committed)
  expect((await branch()).filter((entry) => entry.id === key)).toHaveLength(1)
  expect(prior(captured[1]!)).toEqual(prior(captured[0]!))
})

test("crash after durable task append but before factory creation resumes without another task", async () => {
  const { key } = seed()
  // The process ends at the crash, so no later run of this worker sends again.
  const processEnd = new AbortController()
  const crash = (): never => {
    processEnd.abort()
    throw new Error("crash after task commit")
  }
  const crashed: AsyncGuardedEventWriter = {
    ...writer,
    append: async (event) => {
      await writer.append(event)
      return crash()
    },
    appendBatch: async (events) => {
      await writer.appendBatch(events)
      return crash()
    },
    appendGuarded: async (event) => {
      await writer.appendGuarded(event)
      return crash()
    },
    appendBatchGuarded: async (events) => {
      await writer.appendBatchGuarded(events)
      return crash()
    },
  }
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured), crashed)(step, canonicalPrompt, "", processEnd.signal, conversationId).catch(() => undefined)
  expect(captured).toHaveLength(0)
  const committed = await branch()
  expect(committed.at(-1)).toMatchObject({ id: key })
  await worker(capturingFactory(captured))(step, "Later enrichment after restart", "", undefined, conversationId)
  expect(captured).toHaveLength(1)
  expect(await branch()).toEqual(committed)
  expect(prior(captured[0]!)[1]!.content).toContain(canonicalPrompt)
})

test("compaction can remove the task from provider context without removing its idempotency evidence", async () => {
  const { key } = seed()
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured))(step, canonicalPrompt, "", undefined, conversationId)
  const opened = await tree()
  await opened.appendCompaction({ sourceLeafId: key, tokensBefore: 1000, tokensAfter: 0, opening: [] })
  await opened.appendMessage({ kind: "user", origin: "system", content: "Continue from the retained working notes." })
  const compacted = await opened.getBranch()
  await opened.getStorage().dispose()
  await worker(capturingFactory(captured))(step, "Do not append this later prompt", "", undefined, conversationId)
  expect(captured).toHaveLength(2)
  expect(prior(captured[1]!)).toEqual([{ kind: "user", origin: "system", content: "Continue from the retained working notes." }])
  expect(await branch()).toEqual(compacted)
  expect((await branch()).filter((entry) => entry.id === key)).toHaveLength(1)
})

test("a newer complete root supplies canonical context without erasing the older producer identity", async () => {
  const old = oldFootprint()
  const envelope = { aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 500, actor: "flywheel" }
  store.append({ ...envelope, type: "context.input.seeded", version: 1, payload: { workflowDefinitionId: "wf", userRequest: "Old context must remain fenced" } })
  old.root.payload.control.aggregateSeq = 3
  const historical = store.appendBatch([old.root, old.recovered, old.created, old.appended])
  const newPrompt = "New canonical request from the complete bootstrap"
  store.appendBatch([
    {
      ...old.root, version: 3,
      payload: {
        ...old.root.payload, supersededThroughSeq: 2,
        identities: {
          ...old.root.payload.identities,
          attempt: { source: "recovered", value: step.id }, conversation: { source: "recovered", value: conversationId },
        },
        control: { ...old.root.payload.control, aggregateSeq: 6 },
      },
    },
    { ...envelope, type: "context.input.seeded", version: 1, payload: { workflowDefinitionId: "wf", userRequest: newPrompt } },
    {
      ...envelope, type: "queue.created", version: 9,
      payload: { queue: {
        steps: old.root.payload.control.attempts.map((attempt) => ({
          id: attempt.id, definitionId: attempt.definitionId, contentId: "work", workflowDefinitionId: "wf", name: "Work",
          status: attempt.state._tag, writes: [], resumeRevertCount: 0,
          ...(attempt.conversationId ? { lastConversationId: attempt.conversationId } : {}),
        })),
        cursor: 1, status: "paused", mutationLog: [],
      } },
    },
  ])
  const workflowFacts = store.read({ aggregateId: `workflow:${sessionId}` })
  expect(validateWorkflowBootstrap(workflowFacts).executable).toBe(true)
  const currentContext = recoverWorkflowContext(workflowFacts)
  expect(currentContext.seed?.fact.payload.userRequest).toBe(newPrompt)
  const userPrompt = `${currentContext.seed!.fact.payload.userRequest}\n\n# Current skill\nEnriched binding context`
  convertHistory()
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured))(step, userPrompt, "", undefined, conversationId)
  expect(captured).toHaveLength(1)
  expect((await branch()).at(-1)).toMatchObject({ id: `workflow-task-recovery:${historical[0]!.id}:${step.id}` })
  expect(prior(captured[0]!)[1]!.content).toContain(userPrompt)
  expect(JSON.stringify(prior(captured[0]!))).not.toContain("Old context must remain fenced")
  expect(JSON.stringify(prior(captured[0]!))).not.toContain("Old generated title")
})

test("a failed append blocks agent creation and retains the original operator entry", async () => {
  seed()
  const original = await branch()
  const captured: AgentOptions[] = []
  // A failed append can clear, so the unattended recovery would send again;
  // the run is cancelled at the first failure to observe that attempt alone.
  const cancel = new AbortController()
  const refuse = (message: string): never => {
    cancel.abort()
    throw new Error(message)
  }
  const rejected: AsyncGuardedEventWriter = {
    ...writer,
    append: async () => refuse("append failed"),
    appendBatch: async () => refuse("append batch failed"),
    appendGuarded: async () => refuse("guarded append failed"),
    appendBatchGuarded: async () => refuse("guarded append batch failed"),
  }
  await worker(capturingFactory(captured), rejected)(step, canonicalPrompt, "", cancel.signal, conversationId).catch(() => undefined)
  expect(captured).toHaveLength(0)
  expect(await branch()).toEqual(original)
})

test.each([
  "ordinary", "recovered attempt", "recovered conversation", "other attempt", "other conversation",
  "control attempt", "control conversation", "control step", "control workflow", "not pending", "not retry",
  "no parent", "handoff", "feedback", "malformed", "unsupported root", "unsupported attempt",
  "aggregate sequence", "superseded sequence", "uncorrelated publication", "tree before root",
  "multiple initial entries", "origin metadata", "invocation metadata", "display metadata", "follow-up metadata", "wrong entry time",
  "unsupported tree", "unsupported entries", "structured operator text", "wrong initial parent", "wrong conversation payload",
  "different session", "nonadjacent attempt sequence",
])("does not repair a %s footprint", async (damage) => {
  const footprint = oldFootprint()
  const { root, recovered, created, appended } = footprint
  const selected = root.payload.control.attempts[1]!
  let events: EventStoreAppend[] = [root, recovered, created, appended]
  switch (damage) {
    case "ordinary": events = [created, appended]; break
    case "recovered attempt": root.payload.identities.attempt.source = "recovered"; break
    case "recovered conversation": root.payload.identities.conversation.source = "recovered"; break
    case "other attempt": root.payload.identities.attempt.value = "other"; recovered.payload.attemptId = "other"; break
    case "other conversation": root.payload.identities.conversation.value = "other"; recovered.payload.conversationId = "other"; break
    case "control attempt": selected.id = "other"; break
    case "control conversation": selected.conversationId = "other"; break
    case "control step": root.payload.identities.step.value = "other"; break
    case "control workflow": root.payload.identities.workflow.value = "other"; break
    case "not pending": selected.state._tag = "completed"; break
    case "not retry": selected.provenance._tag = "authored"; break
    case "no parent": selected.parentAttemptId = null; break
    case "handoff": Object.assign(selected, { handoff: { summary: "done" } }); break
    case "feedback": Object.assign(selected, { priorRetryFeedback: "retry feedback" }); break
    case "malformed": Object.assign(root.payload, { control: {} }); break
    case "unsupported root": root.version = 99; break
    case "unsupported attempt": recovered.version = 99; break
    case "aggregate sequence": root.payload.control.aggregateSeq = 3; break
    case "superseded sequence": root.payload.supersededThroughSeq = 1; break
    case "uncorrelated publication": events.splice(2, 0, { ...recovered, aggregateId: "unrelated:session" }); break
    case "tree before root": events = [created, appended, root, recovered]; break
    case "multiple initial entries": appended.payload.entries.push({ ...appended.payload.entries[0]!, id: "second-entry" }); break
    case "origin metadata": Object.assign(appended.payload.entries[0]!.message, { origin: "system" }); break
    case "invocation metadata": Object.assign(appended.payload.entries[0]!.message, { invocation: { label: "work" } }); break
    case "display metadata": Object.assign(appended.payload.entries[0]!, { displayOnly: true }); break
    case "follow-up metadata": Object.assign(appended.payload.entries[0]!, { followUpRequestSequence: 1 }); break
    case "wrong entry time": appended.payload.entries[0]!.timestamp = "1970-01-01T00:00:02.000Z"; break
    case "unsupported tree": created.version = 99; break
    case "unsupported entries": appended.version = 99; break
    case "structured operator text": Object.assign(appended.payload.entries[0]!.message, { content: [{ type: "text", text: operatorText }] }); break
    case "wrong initial parent": Object.assign(appended.payload.entries[0]!, { parentId: "missing-parent" }); break
    case "wrong conversation payload": appended.payload.conversationId = "other"; break
    case "different session": root.sessionId = "other"; recovered.sessionId = "other"; break
    case "nonadjacent attempt sequence": events.splice(1, 0, { ...recovered, type: "workflow.paused", payload: { reason: "interleaved" } }); break
  }
  store.appendBatch(events)
  expect(await historicalWorkerTaskRootId(asAsyncEventReadSurface(store), sessionId, step.id, conversationId)).toBeNull()
  const captured: AgentOptions[] = []
  await worker(capturingFactory(captured))(step, canonicalPrompt, "", undefined, conversationId).catch(() => undefined)
  expect(JSON.stringify(store.read({ aggregateId: `conversation:${conversationId}` }))).not.toContain("workflow-task-recovery:")
})
