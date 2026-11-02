import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type AsyncGuardedEventWriter, type EventStoreReadSurface, type FactQuery, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { Schema } from "effect"
import { contentEvidence } from "../../../../src/infra/content-evidence"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { buildDurableSubagentCreated, buildSubagentCompleted, buildSubagentPaused, buildSubagentPrompted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager"
import type { WorkflowPublication } from "../../../../src/orchestration/session/child-session-publication"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../src/orchestration/session/conversation/turn-end-record"
import { redactMessage } from "../../../../src/orchestration/agent-runtime/agent-loop-history"
import { initializedWorkflowFacts } from "../../../helpers/workflow-root-fixtures"
import { WorkflowSessionFactSchema, committedWorkflowEvent, parseWorkflowSessionFact, workflowRootControl } from "../../../../src/workflows/vm/session-facts"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../src/workflows/vm/transition"
import thenHistories from "./golden/then-continuation-histories.json"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../../src/orchestration/session/conversation/queued-background-notifications"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { completedSurveyFacts } from "../../workflows/vm/_tree-fixtures"
import { loadToolExecutionTimelineFromEvents } from "../../../../src/orchestration/session/tool-execution-projection"

export function parentTools(store: LocalSqliteEventStore) {
  return loadToolExecutionTimelineFromEvents(store.read({ aggregateId: "session:parent" }))
}

interface SetupOptions {
  readonly description?: string
  readonly taskInput?: { readonly summary?: string; readonly task_summary?: string }
  /** Publish the parent as a store written before `session.created` v4 would. */
  readonly historicalParent?: true
  readonly historicalWorkflow?: true
  readonly refusal?: true
  readonly runtimeOrigin?: true
  readonly survey?: Parameters<typeof completedSurveyFacts>[0]
  readonly rejectedContinuation?: true
  /** The source fields of the recorded call, or the historical top-level id. */
  readonly callSource?: { readonly [field: string]: unknown }
}

export async function setupWorkflowParent(store: LocalSqliteEventStore, projectRoot: string, status: "completed" | "failed" | "paused", suffix: string, options: SetupOptions) {
  const writer = localAsyncWriter(store)
  const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
  const parentSessionId = options.historicalParent
    ? await createHistoricalChat(store, writer, `parent${suffix}`, `conversation${suffix}`, projectRoot)
    : await manager.createChat({ id: `parent${suffix}`, conversationId: `conversation${suffix}`, name: "Parent" })
  const description = options.description ?? "Implement the reviewed change"
  const toolUseId = `workflow-tool${suffix}`
  const input = {
    ...(options.callSource ?? { workflow_definition_id: "workflow" }),
    ...(options.taskInput ?? { summary: "Reviewed change" }),
    description,
  }
  if (!options.runtimeOrigin) await recordWorkflowCall(store, parentSessionId, toolUseId, input)
  const decodeWorkflowFact = Schema.decodeUnknownSync(WorkflowSessionFactSchema)
  let facts = terminalWorkflowFacts(description, status).map((fact) => decodeWorkflowFact(fact))
  if (options.refusal) facts = refusedContinuationFacts()
  let conversationSequence = 0
  if (options.survey) facts = await completedSurveyFacts(options.survey, () => `survey-conversation-${++conversationSequence}`)
  if (options.rejectedContinuation) facts = historicalGatedCompletionFacts()
  if (options.historicalWorkflow) {
    store.append({
      aggregateId: `session:child${suffix}`, sessionId: `child${suffix}`, type: "session.created", version: 5, actor: "flywheel", timestamp: Date.now(),
      payload: { kind: "workflow", command: "workflow", workflowDefinitionId: "workflow", label: description, lifecycleState: "inactive", lastUpdated: new Date().toISOString(),
        launchedFrom: { parentSessionId, conversationId: `conversation${suffix}`, workflowDefinitionId: "workflow", toolUseId, description } },
    })
    store.append({ aggregateId: `session:${parentSessionId}`, sessionId: parentSessionId, type: "session.child.linked", version: 1, actor: "flywheel", timestamp: Date.now(),
      payload: { childSessionId: `child${suffix}`, lastUpdated: new Date().toISOString() } })
    for (const fact of facts) store.append({ ...fact, aggregateId: `workflow:child${suffix}`, sessionId: `child${suffix}`, timestamp: Date.now() })
    return { store, writer, parentSessionId, conversationId: `conversation${suffix}`, toolUseId, description }
  }
  await publishHistory(manager, store, {
    id: `child${suffix}`,
    description,
    workflowDefinitionId: "workflow",
    initialRoles: {},
    launchedFrom: {
      parentSessionId, conversationId: `conversation${suffix}`, workflowDefinitionId: "workflow", toolUseId, description,
    },
    ...(options.runtimeOrigin ? {
      runtimeInvocation: {
        payload: {
          toolUseId,
          initiator: "person" as const,
          parentConversationId: `conversation${suffix}`,
          parentEntryId: `workflow-command${suffix}`,
          operation: {
            kind: "launch" as const,
            input: { workflowDefinitionId: "workflow", ...(options.taskInput ?? { summary: "Reviewed change" }), description },
          },
        },
        anchor: { kind: "user" as const, content: `Launched the workflow workflow: ${description}`, origin: "human" as const },
      },
    } : {}),
    facts,
  })
  return { store, writer, parentSessionId, conversationId: `conversation${suffix}`, toolUseId, description }
}

/** Replays fixture events at their recorded encoding through current atomic member publication.
 * Registration adds an aggregate fact, so frozen proposal ids cannot be copied into the new run. */
async function publishHistory(manager: SessionManager, store: LocalSqliteEventStore, input: WorkflowPublication): Promise<void> {
  const root = input.facts.find((fact) => fact.type === "workflow.control.initialized")
  if (!root || root.type !== "workflow.control.initialized") throw new Error("Expected a workflow root")
  const initialCount = workflowRootControl(root).aggregateSeq
  await manager.publishWorkflow({ ...input, facts: input.facts.slice(0, initialCount) })
  let pending: typeof input.facts[number][] = []
  const proposalFor = (terminal: Extract<typeof input.facts[number], { type: "workflow.control.committed" }>) => {
    const control = replayWorkflowControl(store.read({ aggregateId: `workflow:${input.id}` }))
    const result = transitionDecodedWorkflow(replayDecodedWorkflow(control), committedWorkflowEvent(terminal), terminal.version)
    if (result.command.kind !== "commit") throw new Error("Expected fixture event to propose a commit")
    return result.command.proposal
  }
  const commit = async (facts: typeof input.facts) => {
    const result = await manager.commitWorkflow({ workflowId: input.id, events: facts.map((fact, index) => ({
      aggregateId: `workflow:${input.id}`, sessionId: input.id, timestamp: Date.now(), ...fact,
      ...(index === 0 ? { expectedSeq: store.aggregateSeq(`workflow:${input.id}`) + 1 } : {}),
    })) })
    if (result.kind !== "stored") throw new Error(`Fixture workflow publication conflicted: ${JSON.stringify(result)}`)
  }
  for (const fact of input.facts.slice(initialCount)) {
    pending.push(fact)
    if (fact.type !== "workflow.control.committed") continue
    const proposal = proposalFor(fact)
    await commit([...pending.slice(0, -1), parseWorkflowSessionFact({ ...fact, payload: { ...fact.payload, proposalId: proposal.proposalId } })])
    pending = []
  }
  if (pending.length) await commit(pending)
}

export async function reconcileChatLaunchedWorkflowCompletions(
  input: Omit<Parameters<typeof reconcileChildSessionCompletions>[0], "reader"> & { reader: EventStoreReadSurface },
) {
  const projectionReader = input.projectionReader ?? asAsyncEventReadSurface(input.reader)
  return reconcileChildSessionCompletions({
    ...input,
    reader: asAsyncEventReadSurface(input.reader),
    projectionReader,
    deliverNotification: async (notification) => {
      if (!notification.key) return false
      const held = input.reader.readInFlight(
        input.parentSessionId,
        QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
      ).find((row) => row.key === notification.key)
      const conversationId = held?.payload.conversationId
      if (typeof conversationId !== "string") return false
      const tree = await tryOpenConversationTree({
        conversationId,
        sessionId: input.parentSessionId,
        store: projectionReader,
        writer: input.writer,
      })
      if (!tree) return false
      const [append] = await tree.prepareMessagesAppend([{
        id: notification.key,
        message: redactMessage({ kind: "user", content: notification.text, replyRequired: true }, false),
      }])
      tree.getStorage().dispose()
      if (append) {
        await input.writer.appendBatch([{
          ...append,
          inFlight: [{
            op: "drop",
            kind: QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND,
            key: notification.key,
          }],
        }])
      }
      return true
    },
  })
}

export function terminalWorkflowFacts(description: string, status: "completed" | "failed" | "paused") {
  return initializedWorkflowFacts(description).map((fact) => {
    if (fact.type === "workflow.control.initialized") {
      return { ...fact, payload: { control: { ...fact.payload.control, status, frontier: [] } } }
    }
    if (fact.type === "queue.created" && "rows" in fact.payload) {
      return {
        ...fact,
        payload: {
          rows: {
            ...fact.payload.rows,
            status,
            attempts: fact.payload.rows.attempts.map((attempt) => ({
              ...attempt,
              status: status === "completed" ? "completed" as const : status === "failed" ? "failed" as const : "pending" as const,
            })),
          },
        },
      }
    }
    if (fact.type === "queue.tree.changed") {
      return { ...fact, payload: { tree: { ...fact.payload.tree, nodes: fact.payload.tree.nodes.map((node) => ({
        ...node, disposition: status === "completed" ? "completed" as const : status === "failed" ? "failed" as const : "pending" as const,
      })) } } }
    }
    return fact
  })
}

/** A completed gated chain in the flat view format, before tree publication:
 *  the facts that the last build before phases wrote for a `then` follow-up
 *  whose condition did not hold. */
export function historicalGatedCompletionFacts() {
  return thenHistories.gatedCompletion.map((fact) => parseWorkflowSessionFact(fact))
}

/** A failed run whose `then` follow-up the queue limit refused: the facts
 *  that the last build before phases wrote. */
export function refusedContinuationFacts() {
  return thenHistories.refusedContinuation.map((fact) => parseWorkflowSessionFact(fact))
}

export async function recordTerminalResult(store: LocalSqliteEventStore, parentSessionId: string, toolUseId: string, message: string): Promise<void> {
  const evidence = contentEvidence(message)
  const factWriter = createSessionFactWriter({ sessionId: parentSessionId, writer: asAsyncEventWriter(store) })
  await factWriter.record({
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId,
      outcome: "ok",
      contentBytes: evidence.bytes,
      contentSha256: evidence.sha256,
      contentPreview: evidence.preview,
      modelRequestId: "request",
    },
  })
  factWriter.dispose()
}

export async function replaceWorkflowState(store: LocalSqliteEventStore, childSessionId: string, description: string, status: "completed" | "failed" | "paused"): Promise<void> {
  const facts = terminalWorkflowFacts(description, status)
  const aggregateSeq = store.aggregateSeq(`workflow:${childSessionId}`) + 1 + facts.length
  for (const fact of facts) {
    const adjusted = fact.type === "workflow.control.initialized"
      ? { ...fact, payload: { control: { ...fact.payload.control, aggregateSeq } } }
      : fact
    store.append({ aggregateId: `workflow:${childSessionId}`, sessionId: childSessionId, timestamp: Date.now(), type: adjusted.type, version: adjusted.version, actor: adjusted.actor, payload: adjusted.payload })
  }
}

export async function recordCompletionEntry(
  store: LocalSqliteEventStore, writer: AsyncEventWriter, parentSessionId: string, conversationId: string, childSessionId: string, message: string,
  options: { readonly entryId?: string; readonly replyRequired?: true } = {},
): Promise<void> {
  const entryId = options.entryId ?? `workflow-completion:${childSessionId}`
  const tree = await tryOpenConversationTree({
    conversationId,
    sessionId: parentSessionId,
    store: asAsyncEventReadSurface(store),
    writer,
  })
  if (!tree) throw new Error("missing parent conversation")
  const message_ = redactMessage({ kind: "user", content: message, ...(options.replyRequired === true ? { replyRequired: true } : {}) }, false)
  const [append] = await tree.prepareMessagesAppend([{ id: entryId, message: message_ }])
  await tree.getStorage().dispose()
  if (!append) throw new Error("completion entry was not prepared")
  await writer.appendBatch([append])
}

export async function addWorkflowChild(
  store: LocalSqliteEventStore,
  executionCwd: string,
  parentSessionId: string,
  childSessionId: string,
  toolUseId: string,
  description: string,
): Promise<void> {
  const input = { workflow_definition_id: "workflow", summary: "Reviewed change", description }
  await recordWorkflowCall(store, parentSessionId, toolUseId, input)
  const manager = createSessionManager({ projectRoot: executionCwd, executionCwd, store })
  const decodeWorkflowFact = Schema.decodeUnknownSync(WorkflowSessionFactSchema)
  await manager.publishWorkflow({
    id: childSessionId,
    description,
    workflowDefinitionId: "workflow",
    initialRoles: {},
    launchedFrom: await workflowParentBinding(manager, { parentSessionId, workflowDefinitionId: "workflow", toolUseId, description }),
    facts: terminalWorkflowFacts(description, "completed").map((fact) => decodeWorkflowFact(fact)),
  })
}

/** Publishes subagent child `child-<index>` of `parentSessionId` with one run,
 *  launched from the parent's call `tool-<index>`, and ends the run as
 *  `status` states. A `created` run is still running. A `paused` child's
 *  conversation holds `history` messages, each in its own batch, then the
 *  person's interrupt and a message the person queued behind it. */
export async function addSubagentChild(
  store: EventStoreReadSurface,
  writer: AsyncGuardedEventWriter,
  executionCwd: string,
  parentSessionId: string,
  parentConversationId: string,
  index: number,
  status: "created" | "completed" | "paused",
  history = 0,
): Promise<void> {
  const childSessionId = `child-${index}`
  const childRunId = `run-${index}`
  const toolUseId = `tool-${index}`
  const toolInput = { persona: "explorer", description: "Review" }
  const evidence = contentEvidence(JSON.stringify(toolInput))
  const parentWriter = createSessionFactWriter({ sessionId: parentSessionId, writer })
  await parentWriter.record({
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: { toolUseId, toolName: "subagent", input: toolInput, inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview, executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request" },
  })
  parentWriter.dispose()
  const manager = createSessionManager({ projectRoot: executionCwd, executionCwd, store, writer })
  await manager.publishSubagent({
    id: childSessionId, conversationId: `conversation-${index}`, description: "Review", executionCwd,
    launchedFrom: { parentSessionId, conversationId: parentConversationId, toolUseId }, initialRoles: {},
    runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
      childSessionId, childRunId, conversationId: `conversation-${index}`,
      parentSessionId, parentConversationId, parentToolCallId: toolUseId,
      modelRequestId: "request", persona: { name: "explorer", kind: "persona" },
      capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
      admittedModuleIds: [], skillsRevision: 1, model: "test/model", tools: [], executionCwd,
      budget: { maxTurns: 4, maxTokens: 1_000 }, parentDepth: 0, description: "Review",
    })),
    assignment: "review",
    promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt: "review", task: "review", toolNames: [] })),
  })
  if (status === "created") return
  const childWriter = createSessionFactWriter({ sessionId: childSessionId, writer })
  await childWriter.record(status === "completed"
    ? buildSubagentCompleted({ childRunId, status: "completed", isError: false, content: "Reviewed.", durationMs: 1 })
    : buildSubagentPaused({ childRunId, pausedBy: "person" }))
  childWriter.dispose()
  if (status !== "paused") return
  const tree = await tryOpenConversationTree({ conversationId: `conversation-${index}`, sessionId: childSessionId, store: asAsyncEventReadSurface(store), writer })
  if (!tree) throw new Error(`missing conversation of ${childSessionId}`)
  for (let i = 0; i < history; i += 1) await tree.appendMessage({ kind: "user", content: `message ${i}`, origin: "human" })
  const end = interruptedTurnEnd("person")
  await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, childRunId))
  await tree.appendMessage({ kind: "user", content: "Also check the tests.", origin: "human" })
  tree.getStorage().dispose()
}

/** Records the model's launching call before the child publication. */
export async function recordWorkflowCall(store: LocalSqliteEventStore, parentSessionId: string, toolUseId: string, input: { readonly [field: string]: unknown }): Promise<void> {
  const evidence = contentEvidence(JSON.stringify(input))
  const factWriter = createSessionFactWriter({ sessionId: parentSessionId, writer: asAsyncEventWriter(store) })
  await factWriter.record({
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId,
      toolName: "workflow",
      input,
      inputBytes: evidence.bytes,
      inputSha256: evidence.sha256,
      inputPreview: evidence.preview,
      executionMode: "background",
      traceKind: "subagent",
      childHasOwnViewport: true,
      modelRequestId: "request",
    },
  })
  factWriter.dispose()

}

interface MeasuredReaderRows {
  metadataAggregates: string[]
  parentTools: number
  conversation: number
  contentResolves: number
}

export function measuredReader(store: LocalSqliteEventStore, parentSessionId: string, conversationId: string) {
  const rows: MeasuredReaderRows = {
    metadataAggregates: [],
    parentTools: 0,
    conversation: 0,
    contentResolves: 0,
  }
  const reader: EventStoreReadSurface = {
    ...store,
    read(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("reconciliation must not fold the full session metadata family")
      }
      const events = store.read(query)
      if (events.length > 0 && query.aggregateId?.startsWith("session:") && query.types?.includes("session.created")) rows.metadataAggregates.push(query.aggregateId)
      if (query.aggregateId === `session:${parentSessionId}` && query.types?.includes("tool.input.completed")) rows.parentTools += events.length
      if (query.aggregateId === `conversation:${conversationId}`) rows.conversation += events.length
      return events
    },
    readTolerant(query: FactQuery = {}) {
      if (!query.aggregateId && !query.sessionId && query.types?.includes("session.auth.profile.selected")) {
        throw new Error("reconciliation must not fold the full session metadata family")
      }
      const events = store.readTolerant(query)
      if (events.length > 0 && query.aggregateId?.startsWith("session:") && query.types?.includes("session.created")) rows.metadataAggregates.push(query.aggregateId)
      if (query.aggregateId === `conversation:${conversationId}`) rows.conversation += events.length
      return events
    },
    toolContent: {
      resolve(sessionId, reference) {
        rows.contentResolves += 1
        return store.toolContent.resolve(sessionId, reference)
      },
    },
  }
  return { reader, rows }
}

export function localAsyncWriter(store: LocalSqliteEventStore): AsyncGuardedEventWriter {
  return {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
    putInFlight: async (sessionId, kind, key, payload) => store.putInFlight(sessionId, kind, key, payload),
  }
}

/** The parent creation row as every store written before 2026-09-20 holds it:
 *  `session.created` v3 with the chat payload of that day. Reconciliation runs
 *  on every activation, so it must read this row or no older session opens.
 *  Remove with the v3 salvage rule after 2027-09-20. */
export async function createHistoricalChat(store: LocalSqliteEventStore, writer: AsyncGuardedEventWriter, id: string, conversationId: string, executionCwd: string): Promise<string> {
  const now = new Date().toISOString()
  const tree = await createConversationTree({
    conversationId,
    sessionId: id,
    now: () => now,
    store: asAsyncEventReadSurface(store),
    writer,
  })
  tree.getStorage().dispose()
  store.append({
    aggregateId: `session:${id}`,
    sessionId: id,
    timestamp: Date.parse(now),
    type: "session.created",
    version: 3,
    actor: "flywheel",
    payload: { label: "Parent", lastUpdated: now, authProfileId: "Personal", lifecycleState: "active", executionCwd, name: "Parent", createdAt: now, activatedAt: now, kind: "chat", command: "chat", conversationId },
  })
  return id
}
