import type { AsyncEventReadSurface, AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { PERSON_STOP_INSTRUCTION } from "../../infra/tool-outcome.js"
import { createEventProjection, parseProjectionFact } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { expandJoinReferences, joinedListNodeId } from "../context-bundle/context.js"
import { accumulatedEntry, parseWorkflowContextFact, type HandoffEntry } from "../context-bundle/context-facts.js"
import { attemptNodeIdOf } from "../vm/graph-types.js"
import { advanceRetryEvidence, NO_RETRY_EVIDENCE, resumesFailedAgentsWith, type FailedAgentRetryEvidence } from "../vm/fact-fold.js"
import { readWorkflowRecovery } from "../vm/recovery-fold.js"
import { itemScopeOf } from "../vm/list-transitions.js"
import { recoverWorkflowControl } from "../vm/recovery.js"
import { parseWorkflowSessionFact, workflowAggregateId } from "../vm/session-facts.js"
import type { WorkflowTree, WorkflowTreeAgent, WorkflowTreeNode } from "../../protocol/workflow-view-protocol-types.js"
import { roundCount, workflowCoverage, workflowProgress } from "../../protocol/client/workflow-progress.js"
import { createReplayingWorkflowView } from "../view/view-projection.js"
import type { WorkflowView } from "../view/types.js"
import type { CommittedWorkflowControl } from "../vm/committed-control.js"
import { parseHandoffFact } from "./facts.js"
import { reduceHandoffRecord, loadHandoffsFromEvents, type HandoffRecord } from "./projection.js"
import { renderAgentOutput } from "./render.js"

interface HandoffSources {
  readonly handoffs: Map<string, HandoffRecord>
  readonly itemAgents: Set<string>
  readonly joins: Map<string, { readonly [key: string]: unknown }>
  latest: { readonly kind: "attempt"; readonly id: string } | { readonly kind: "join"; readonly entry: HandoffEntry } | null
}

interface CompletionSources {
  readonly failures: Map<string, string>
  executionPosition: number
  refusal: string | undefined
  retry: FailedAgentRetryEvidence
}

function handoffSources(reader: AsyncEventReadSurface, sessionId: string) {
  return heldProjection(reader, `terminal-handoff:${sessionId}`, () => createEventProjection<HandoffSources>(reader, {
    aggregateId: workflowAggregateId(sessionId),
    factTypes: ["handoff.written", "handoff.validated", "group.expanded", "context.accumulated"],
    initialState: () => ({ handoffs: new Map(), itemAgents: new Set(), joins: new Map(), latest: null }),
    reduce: (state, event) => {
      if (event.type === "handoff.written" || event.type === "handoff.validated") {
        const fact = parseProjectionFact(event, parseHandoffFact)
        const record = reduceHandoffRecord(state.handoffs.get(fact.payload.attemptId), fact)
        state.handoffs.set(record.attemptId, record)
        if (fact.type === "handoff.written" && !state.itemAgents.has(attemptNodeIdOf(record.attemptId) ?? "") && record.content !== undefined) {
          state.latest = { kind: "attempt", id: record.attemptId }
        }
      }
      if (event.type === "group.expanded") {
        for (const id of itemAgentNodeIds([event])) state.itemAgents.add(id)
      }
      const entry = workflowJoinEntry(event)
      if (entry) {
        state.latest = { kind: "join", entry }
        // SAFETY: workflowJoinEntry accepts only entries with a joined list id.
        state.joins.set(joinedListNodeId(entry.entryId)!, entry.handoff)
      }
      return state
    },
  }))
}

function completionSources(reader: AsyncEventReadSurface, sessionId: string) {
  return heldProjection(reader, `workflow-completion:${sessionId}`, () => createEventProjection<CompletionSources>(reader, {
    aggregateId: workflowAggregateId(sessionId),
    initialState: () => ({ failures: new Map(), executionPosition: 0, refusal: undefined, retry: NO_RETRY_EVIDENCE }),
    reduce: (state, event) => {
      if (event.type === "attempt.failed") {
        const fact = parseProjectionFact(event, parseWorkflowSessionFact)
        if (fact.type === "attempt.failed") {
          state.failures.delete(fact.payload.attemptId)
          state.failures.set(fact.payload.attemptId, fact.payload.reason)
        }
      }
      if (event.type === "workflow.control.recovered") { state.refusal = undefined; state.retry = NO_RETRY_EVIDENCE }
      if (event.type === "attempt.insertion_rejected") {
        const fact = parseProjectionFact(event, parseWorkflowSessionFact)
        if (fact.type === "attempt.insertion_rejected") state.refusal = fact.payload.reason
      }
      if (isWorkflowExecutionFact(event)) state.executionPosition = event.position
      state.retry = advanceRetryEvidence(state.retry, event)
      return state
    },
  }))
}

function projectedTerminalHandoff(state: HandoffSources): TerminalHandoff | null {
  if (state.latest === null) return null
  if (state.latest.kind === "attempt") return state.handoffs.get(state.latest.id) ?? null
  const { entry } = state.latest
  const expanded = expandJoinReferences(entry.handoff, (attemptId) =>
    state.itemAgents.has(attemptNodeIdOf(attemptId) ?? "") ? state.handoffs.get(attemptId)?.content : undefined)
  return {
    attemptId: entry.entryId, agentName: entry.agentName, definitionId: entry.definitionId,
    workflowDefinitionId: entry.workflowDefinitionId, content: expanded.value, validationIssues: [],
    unexpandedReferences: expanded.unexpanded,
  }
}

/** A run's registration, which a conversion migration can also write after the
 *  run ended, executes nothing; every other workflow fact counts as execution. */
export function isWorkflowExecutionFact(fact: Pick<StoredFact, "type">): boolean {
  return fact.type !== "workflow.run.registered"
}

/** A terminal result is available only when the queue and committed control
 * describe the same executions and conversations. Returns null during publication gaps. */
export function terminalWorkflow(control: CommittedWorkflowControl, queue: WorkflowView | null) {
  if (!queue || (control.status !== "completed" && control.status !== "failed")) return null
  if (queue.status !== control.status || queue.attempts.length !== control.attempts.length) return null
  const identitiesMatch = queue.attempts.every((row, index) => {
    const attempt = control.attempts[index]
    return attempt !== undefined && row.id === attempt.id && (row.lastConversationId ?? null) === attempt.conversationId
  })
  if (!identitiesMatch) return null
  const progress = workflowProgress({ attempts: [], tree: queue.tree })
  return {
    status: control.status,
    completedAgents: progress.done,
    totalAgents: progress.total,
    aggregateSeq: control.aggregateSeq,
    tree: queue.tree,
  }
}

/** The ids of the agent nodes that the workflow's list expansions added:
 *  the agents that an item owns, which version 3 of `group.expanded`
 *  records and versions 1 and 2 record under the retired `branch` owner. */
function itemAgentNodeIds(events: readonly StoredFact[]): ReadonlySet<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== "group.expanded") continue
    const fact = parseProjectionFact(event, parseWorkflowSessionFact)
    if (fact.type !== "group.expanded") continue
    for (const change of fact.payload.changes) {
      if (change.kind !== "add_node") continue
      const owner = change.node.ownership._tag
      if (owner === "item" || owner === "branch") ids.add(change.node.id)
    }
  }
  return ids
}

/** An agent that failed for good, as the parent's completion result names it. */
export interface FailedAgent {
  readonly name: string
  readonly reason: string
}

/** Each agent that is failed now, in the order it last failed, with the
 *  reason of that failure. An agent of an item is named with its item key
 *  (`failedAgentName`). An agent that a Resume ran again and that then
 *  finished is not failed any more (`attempts` holds the status of each
 *  agent now). An agent fails for good only from encoding 8, so the result
 *  of a run that an earlier build finished states no failed agent, as it did
 *  then. */
export function failedAgents(events: readonly StoredFact[], attempts: readonly { readonly id: string; readonly name: string; readonly status: string }[]): readonly FailedAgent[] {
  const recovered = recoverWorkflowControl(events)
  const control = recovered.executable ? recovered.control : null
  const superseded = supersededAttempts(control)
  const failed = new Map(attempts.filter(({ id, status }) => status === "failed" && !superseded.has(id)).map(({ id, name }) => [id, name]))
  const latest = new Map<string, FailedAgent>()
  for (const event of events) {
    if (event.type !== "attempt.failed") continue
    const fact = parseProjectionFact(event, parseWorkflowSessionFact)
    if (fact.type !== "attempt.failed") continue
    const name = failed.get(fact.payload.attemptId)
    if (name === undefined) continue
    latest.delete(fact.payload.attemptId)
    latest.set(fact.payload.attemptId, { name: failedAgentName(control, fact.payload.attemptId, name), reason: fact.payload.reason })
  }
  return [...latest.values()]
}

/** The attempts that a continuation replaced, which are not failed now. */
function supersededAttempts(control: CommittedWorkflowControl | null): ReadonlySet<string> {
  return new Set((control?.attempts ?? []).flatMap((attempt) => attempt.provenance._tag === "continuation" && attempt.parentAttemptId !== null ? [attempt.parentAttemptId] : []))
}

/** The name of a failed agent as a completion states it: an agent of an
 *  item also names its item key, such as `Review, item a.ts`. */
function failedAgentName(control: CommittedWorkflowControl | null, attemptId: string, name: string): string {
  const attempt = control?.attempts.find(({ id }) => id === attemptId)
  const item = control === null || attempt === undefined ? null : itemScopeOf(control, attempt)
  return item === null ? name : `${name}, item ${item.key}`
}

/** The terminal handoff of a workflow. A post-join artifact expands the
 *  item handoffs it references, as an agent that reads it after the join
 *  receives them. `unexpandedReferences` names, in item order, each item
 *  handoff that stayed a reference because its content did not fit the
 *  expansion cap. It is absent for any other handoff. */
export interface TerminalHandoff extends HandoffRecord {
  readonly unexpandedReferences?: readonly string[]
}

/** The last workflow-scope handoff of a workflow, or null before any agent
 *  handed off. It is the latest of the handoffs that agents outside a list
 *  wrote and the post-join artifacts of settled lists. An item handoff is
 *  evidence local to its list, so it is never the result. For a completed
 *  workflow it is the result of the terminal agent; for a failed one it can
 *  be a blocked result or successful work whose continuation was refused. A
 *  post-join artifact expands its references through the expansion that
 *  the context bundle uses, with the item handoff records as the content. */
export function terminalHandoff(events: readonly StoredFact[]): TerminalHandoff | null {
  // A failed agent of an item writes its handoff with no context entry, so
  // the item agent nodes that expansion recorded, not the context scope,
  // find every item handoff.
  const itemAgents = itemAgentNodeIds(events)
  const itemLocal = (attemptId: string): boolean => itemAgents.has(attemptNodeIdOf(attemptId) ?? "")
  const records = new Map(loadHandoffsFromEvents(events).map((record) => [record.attemptId, record]))
  let latest: TerminalHandoff | null = null
  for (const event of events) {
    if (event.type === "handoff.written") {
      const { attemptId } = parseProjectionFact(event, parseHandoffFact).payload
      const record = itemLocal(attemptId) ? undefined : records.get(attemptId)
      if (record?.content !== undefined) latest = record
    }
    const entry = workflowJoinEntry(event)
    if (entry !== null) {
      const expanded = expandJoinReferences(entry.handoff, (attemptId) => itemLocal(attemptId) ? records.get(attemptId)?.content : undefined)
      latest = {
        attemptId: entry.entryId,
        agentName: entry.agentName,
        definitionId: entry.definitionId,
        workflowDefinitionId: entry.workflowDefinitionId,
        content: expanded.value,
        validationIssues: [],
        unexpandedReferences: expanded.unexpanded,
      }
    }
  }
  return latest
}

/** The workflow-scope join entry that a stored fact records, or null for
 *  any other fact. */
function workflowJoinEntry(event: StoredFact): HandoffEntry | null {
  if (event.type !== "context.accumulated") return null
  const fact = parseProjectionFact(event, parseWorkflowContextFact)
  if (fact.type !== "context.accumulated") return null
  const { entry, scope } = accumulatedEntry(fact)
  return scope === null && joinedListNodeId(entry.entryId) !== null ? entry : null
}

/** The last workflow-scope handoff of workflow `sessionId` (refer to
 *  {@link terminalHandoff}). */
export async function readTerminalHandoff(reader: AsyncEventReadSurface, sessionId: string): Promise<TerminalHandoff | null> {
  return projectedTerminalHandoff(await handoffSources(reader, sessionId).replay())
}

/** Reads advancing completion sources after control and queue agree on a
 *  terminal revision. `control` is null for a history whose control does
 *  not replay. */
export async function readAdvancingCompletionEvidence(reader: AsyncEventStateReadSurface, sessionId: string, control: CommittedWorkflowControl | null, queue: WorkflowView) {
  const [sources, outputs] = await Promise.all([completionSources(reader, sessionId).replay(), handoffSources(reader, sessionId).replay()])
  const superseded = supersededAttempts(control)
  const failed = new Map(queue.attempts.filter(({ id, status }) => status === "failed" && !superseded.has(id)).map(({ id, name }) => [id, name]))
  return {
    executionPosition: sources.executionPosition,
    handoff: projectedTerminalHandoff(outputs),
    results: treeResults(queue.tree, { handoffs: outputs.handoffs, failures: sources.failures }, outputs.joins),
    failedAgents: [...sources.failures].flatMap(([id, reason]) => {
      const name = failed.get(id)
      return name === undefined ? [] : [{ name: failedAgentName(control, id, name), reason }]
    }),
    reason: sources.refusal,
    resumable: control !== null && resumesFailedAgentsWith(sources.retry, control),
  }
}

/** One agent's result as the parent's completion lists it. */
export interface AgentResult {
  /** The agent's record id with its place, such as `review, item a` or
   *  `review, round 2`, or `join of <phase>` for the output of a join, named
   *  by the id of the last phase of the stream that it folds. An agent that
   *  never had an attempt is named by its display name. */
  readonly label: string
  readonly status: "completed" | "failed" | "skipped" | "not run"
  readonly reason?: string
  /** The handoff as the agent wrote it, or the join's output. */
  readonly content?: { readonly [key: string]: unknown }
}

/** The reason of the latest failure of each attempt. */
function failureReasons(events: readonly StoredFact[]): ReadonlyMap<string, string> {
  const reasons = new Map<string, string>()
  for (const event of events) {
    if (event.type !== "attempt.failed") continue
    const fact = parseProjectionFact(event, parseWorkflowSessionFact)
    if (fact.type === "attempt.failed") reasons.set(fact.payload.attemptId, fact.payload.reason)
  }
  return reasons
}

/** The latest output of each settled join, keyed by its list node, with
 *  its item handoffs left as references: the completion lists the handoff
 *  of each item on its own. */
function joinOutputs(events: readonly StoredFact[]): ReadonlyMap<string, { readonly [key: string]: unknown }> {
  const outputs = new Map<string, { readonly [key: string]: unknown }>()
  for (const event of events) {
    const entry = workflowJoinEntry(event)
    const listNodeId = entry === null ? null : joinedListNodeId(entry.entryId)
    if (entry !== null && listNodeId !== null) outputs.set(listNodeId, entry.handoff)
  }
  return outputs
}

interface ResultSources {
  readonly handoffs: ReadonlyMap<string, HandoffRecord>
  readonly failures: ReadonlyMap<string, string>
}

/** The result of one attempt, from its execution status and logical-node evidence. */
function attemptResult(label: string, status: string, attemptId: string | undefined, sources: ResultSources, nodeReason?: string): AgentResult {
  switch (status) {
    case "completed": {
      const content = attemptId === undefined ? undefined : sources.handoffs.get(attemptId)?.content
      return { label, status: "completed", ...(content ? { content } : {}) }
    }
    case "failed": {
      const reason = nodeReason ?? (attemptId === undefined ? undefined : sources.failures.get(attemptId))
      return { label, status: "failed", ...(reason ? { reason } : {}) }
    }
    case "skipped": return { label, status: "skipped", ...(nodeReason ? { reason: nodeReason } : {}) }
    default: return { label, status: "not run" }
  }
}

/** Where an agent stands in its phase: the key of its item, and the round
 *  of its phase in a repeat. */
function placeOf(agent: WorkflowTreeAgent, nodes: ReadonlyMap<string, WorkflowTreeNode>): string | undefined {
  const phase = agent.parentId === null ? undefined : nodes.get(agent.parentId)
  const round = phase?.kind === "phase" && phase.round !== undefined ? `round ${phase.round.number}` : undefined
  const parts = [...(agent.item === undefined ? [] : [`item ${agent.item.key}`]), ...(round === undefined ? [] : [round])]
  return parts.length === 0 ? undefined : parts.join(", ")
}

/** Each agent of the tree in preorder, which is graph order, and the output
 *  of each list's join right after the agents of its last phase. */
function treeResults(tree: WorkflowTree, sources: ResultSources, joins: ReadonlyMap<string, { readonly [key: string]: unknown }>): AgentResult[] {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]))
  const agents = tree.nodes.filter((node): node is WorkflowTreeAgent => node.kind === "agent")
  // A history agent names the control node that ran it, and the follow-ups
  // of one node in a run before phases each sit in a phase of their own.
  const repetitions = Map.groupBy(agents.filter(({ item }) => item === undefined), (agent) => JSON.stringify([agent.nodeId ?? agent.parentId, agent.definitionId]))
  const labels = new Map<string, string>()
  for (const repeated of repetitions.values()) {
    for (const [index, agent] of repeated.entries()) labels.set(agent.id, repeated.length > 1 ? `${agent.definitionId}, iteration ${index + 1}` : agent.definitionId)
  }
  const results: AgentResult[] = []
  for (const phase of tree.nodes) {
    if (phase.kind !== "phase") continue
    for (const agent of agents.filter(({ parentId }) => parentId === phase.id)) {
      const place = placeOf(agent, nodes)
      const label = labels.get(agent.id) ?? agent.definitionId
      results.push(attemptResult(place ? `${label}, ${place}` : label, agent.disposition, agent.currentAttemptId, sources, agent.reason))
    }
    const content = phase.join === undefined || phase.list === undefined ? undefined : joins.get(phase.list.id)
    if (content) results.push({ label: `join of ${phase.phaseId}`, status: "completed", content })
  }
  return results
}

/** Each agent's result in preorder, with the output of each join after the
 *  agents of its items. A missing workflow view has no agent results. A
 *  historical view must cross the view reader first. */
export function agentResults(events: readonly StoredFact[], queue: Pick<WorkflowView, "tree"> | null | undefined): readonly AgentResult[] {
  if (!queue) return []
  const sources: ResultSources = {
    handoffs: new Map(loadHandoffsFromEvents(events).map((record) => [record.attemptId, record])),
    failures: failureReasons(events),
  }
  return treeResults(queue.tree, sources, joinOutputs(events))
}

/** What the parent's completion result states of workflow `sessionId`
 *  beside its verdict: each agent's result, the terminal handoff that a
 *  completion recorded before it listed every agent, the agents that failed,
 *  whether a Resume runs them again, and the operational tree, whose joins carry
 *  each survey's coverage. It reads the held recovery, queue, and completion
 *  sources that advanced with each commit of the run, as reconciliation
 *  does, so the live result and its durable record state the same words,
 *  and the read never replays the run's transitions. A history whose
 *  control does not replay names no superseded agent and resumes none. */
export async function readWorkflowCompletionEvidence(reader: AsyncEventStateReadSurface, sessionId: string): Promise<Pick<WorkflowCompletionInput, "handoff" | "results" | "tree" | "failedAgents" | "resumable">> {
  const [{ plan }, queue] = await Promise.all([readWorkflowRecovery(reader, sessionId), createReplayingWorkflowView(reader, sessionId).read()])
  if (!queue) throw new Error(`Workflow ${sessionId} has no loaded queue for completion`)
  const evidence = await readAdvancingCompletionEvidence(reader, sessionId, plan.executable ? plan.control : null, queue)
  return { handoff: evidence.handoff, results: evidence.results, tree: queue.tree, failedAgents: evidence.failedAgents, resumable: evidence.resumable }
}

/** One terminal handoff as the parent reads it. A post-join artifact lists
 *  the item handoffs that stayed references after its JSON, so the parent
 *  knows which results it must read from the workflow. The words are
 *  stored: reconciliation compares a recorded Stop notification with them,
 *  and delivers the Stop again when they differ, so they keep the spelling
 *  that earlier builds recorded. */
function handoffBlock(handoff: TerminalHandoff): string {
  const block = `step "${handoff.agentName}":\n${JSON.stringify(handoff.content, null, 2)}` // stored notification text
  const references = handoff.unexpandedReferences ?? []
  return references.length === 0
    ? block
    : `${block}\n\nThese branch handoffs stay references because their content did not fit the expansion cap. Read them in the workflow: ${references.join(", ")}`
}

export interface WorkflowCompletionInput {
  readonly status: "completed" | "failed"
  readonly label: string
  readonly sessionId: string
  readonly reason?: string
  /** Each agent's result in graph order ({@link agentResults}). */
  readonly results: readonly AgentResult[]
  /** The terminal handoff, which only {@link terminalOnlyCompletionContent}
   *  states. */
  readonly handoff: TerminalHandoff | null
  /** The loaded workflow's canonical operational tree. */
  readonly tree: WorkflowTree
  /** Each agent that failed for good ({@link failedAgents}). */
  readonly failedAgents: readonly FailedAgent[]
  /** Whether a Resume runs the failed agents again (`resumesFailedAgents`). */
  readonly resumable: boolean
}

/** The most bytes that the agent results of one completion take. The
 *  results share it from the end of the graph backward, because a later
 *  agent reads and condenses the earlier ones: the final report survives a
 *  run whose item results alone would fill the limit. The content names each result
 *  that did not fit and how to read it. */
export const COMPLETION_AGENT_RESULTS_CAP_BYTES = 65_536

/** One agent result as the parent reads it: a heading with its label and
 *  status, then its handoff as a later agent reads it, whose commands run
 *  are the checks that the agent recorded, with their exit codes. */
function agentResultBlock(result: AgentResult): string {
  const reason = result.reason ? ` (${result.reason})` : ""
  switch (result.status) {
    case "completed": return result.content
      ? `## ${result.label}: completed\n\n${renderAgentOutput(result.content, [])}`
      : `## ${result.label}: completed, with no recorded handoff`
    case "failed": return `## ${result.label}: failed${reason}`
    case "skipped": return `## ${result.label}: skipped${reason}`
    case "not run": return `## ${result.label}: did not run`
  }
}

/** The agent results that fit the cap, latest first, listed in graph order,
 *  and a note that names each one that did not fit and how to read it. */
function agentResultsSection(sessionId: string, results: readonly AgentResult[]): string {
  const blocks: string[] = []
  const omitted: string[] = []
  let used = 0
  for (const result of results.toReversed()) {
    const block = agentResultBlock(result)
    const bytes = Buffer.byteLength(block, "utf8")
    if (used + bytes > COMPLETION_AGENT_RESULTS_CAP_BYTES) {
      omitted.unshift(result.label)
      continue
    }
    used += bytes
    blocks.unshift(block)
  }
  const note = omitted.length === 0
    ? []
    : [`These agent results did not fit the ${COMPLETION_AGENT_RESULTS_CAP_BYTES}-byte limit of this message: ${omitted.join("; ")}. Read each handoff with \`flywheel events search --session ${sessionId} --type handoff.written --json\`, which names the agent of each one.`]
  return ["Agent results, in the order of the workflow:", ...blocks, ...note].join("\n\n")
}

function completionHead(input: WorkflowCompletionInput, review: string): string {
  const reason = input.reason ? ` Reason: ${input.reason}.` : ""
  const progress = workflowProgress({ attempts: [], tree: input.tree })
  const coverage = workflowCoverage(progress)
  const survey = coverage.length > 0 ? ` The survey reports ${coverage.join("; ")}.` : ""
  const loops = progress.loops.map(({ label, state }) => state.outcome === "bound"
    ? ` The loop "${label}" stopped at its bound of ${roundCount(state.maxIterations)} without a dry evaluation.`
    : state.outcome === "stuck"
      ? ` The loop "${label}" stopped as stuck in round ${state.iteration}: its last evaluation found the same work as the one before.`
      : "").join("")
  const failed = input.failedAgents.length === 0
    ? ""
    : ` ${input.failedAgents.length} ${input.failedAgents.length === 1 ? "agent" : "agents"} failed: ${input.failedAgents.map((agent) => `"${agent.name}" (${agent.reason})`).join("; ")}.`
  const resume = input.resumable
    ? ` A Resume runs the failed agents and the agents that wait on them again, and every finished agent that does not read a failed agent's output keeps its result: use process action "resume" with process_id "${input.sessionId}".`
    : ""
  return `Workflow ${input.status}: "${input.label}" (workflow ${input.sessionId}). ${progress.done}/${progress.total} agents finished.${failed}${resume}${reason}${survey}${loops} ${review}`
}

/** The result content a parent agent receives when a workflow it launched
 *  settles: the terminal verdict, each agent that failed and why, whether a
 *  Resume runs those agents again, the coverage that each survey's join
 *  reports, each bound or stuck loop stop, and each agent's result in graph order, as a subagent's
 *  completion carries its handoff (ARCH-WORKFLOWS-035, PI-AGENT-117, PI-AGENT-103). Each result carries the checks
 *  that its agent recorded, so the parent sees what the run already checked
 *  and decides what it verifies itself. Incomplete coverage and loop stops
 *  do not change the workflow's terminal status. The notification's words
 *  tell the parent that a completed run's results are partial. The live notification and the durable
 *  parent-conversation entry both render through this one function so the
 *  two deliveries never disagree. */
export function workflowCompletionContent(input: WorkflowCompletionInput): string {
  const head = completionHead(input, "Review the agent results and continue the original request.")
  return input.results.length === 0 ? head : `${head}\n\n${agentResultsSection(input.sessionId, input.results)}`
}

/** The completion content that builds before 2026-10-11 recorded: the
 *  terminal handoff only. A parent's recorded result is history, so the
 *  parent's reconciliation reads a result in these words as current for an
 *  unchanged run, and never corrects it or delivers the completion again.
 *  It stays while a store can hold a result in these words, which is for as
 *  long as Flywheel reads those stores. */
export function terminalOnlyCompletionContent(input: WorkflowCompletionInput): string {
  const head = completionHead(input, "Review the terminal result and continue the original request.")
  if (!input.handoff?.content) return head
  return `${head}\n\nTerminal handoff from ${handoffBlock(input.handoff)}`
}

/** What the parent's model reads when its workflow tool call ends by Stop:
 *  the call failed, who stopped the run, and the last handoff an agent wrote
 *  before the Stop. That handoff is work the run finished, so the parent
 *  does not redo it; the words frame it as a record, never as a request to
 *  continue, and a person's Stop still ends with its instruction. The same
 *  words are the durable tool result and the notification that reaches the
 *  waiting parent. */
export function workflowStopContent(input: {
  readonly label: string
  readonly sessionId: string
  readonly stoppedBy: "person" | "agent"
  readonly handoff: TerminalHandoff | null
}): string {
  const head = `Workflow stopped: "${input.label}" (workflow ${input.sessionId}).`
  const evidence = input.handoff?.content
    ? `\n\nThe last handoff before the Stop, a record of finished work and not a request to continue, is from ${handoffBlock(input.handoff)}\n\n`
    : " "
  return input.stoppedBy === "person"
    ? `${head} The user stopped it before it finished; it will not resume.${evidence}${PERSON_STOP_INSTRUCTION}`
    : `${head} You canceled it before it finished; it will not resume.${evidence.trimEnd()}`
}

/** What the parent's model reads when its workflow tool call ends because the
 *  published run could not start. The same words are the durable tool result
 *  and the notification that reaches the waiting parent. The run stays
 *  paused, so the words do not say it will never run. Reconciliation retains
 *  earlier terminology when its bytes match the recorded result. */
export function workflowStartFailureContent(input: { readonly label: string; readonly sessionId: string }): string {
  return `Workflow failed to start: "${input.label}" (workflow ${input.sessionId}). Its runtime stopped before the first step. The workflow is paused, and the user can resume it from its workflow card.`
}
