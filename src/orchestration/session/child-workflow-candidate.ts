import { CorruptEventRowError, type StoredFact } from "../../infra/event-store-types.js"
import type { ToolOutcome } from "../../infra/tool-outcome.js"
import { workflowCallLaunched } from "../../infra/tools/workflow-call-source.js"
import { readAdvancingCompletionEvidence, readTerminalHandoff, terminalWorkflow, workflowStartFailureContent, workflowStopContent, type AgentResult, type FailedAgent, type TerminalHandoff } from "../../workflows/output-contract/workflow-completion.js"
import { createReplayingWorkflowView } from "../../workflows/view/view-projection.js"
import { readWorkflowControl } from "../../workflows/vm/recovery-fold.js"
import { workflowRunOwner } from "../module-catalog.js"
import type { WorkflowRunRecord } from "../workflow-host/run-record.js"
import { readParentTools, type ChildReconciliationReadContext } from "./child-reconciliation-index.js"
import { historicalCompletionEntryId, retainedSettledContent, workflowNotificationLabel } from "./child-session-completion.js"
import { createConversationTreeProjection } from "./conversation/conversation-projection.js"
import { liveWorkflowControl } from "./live-session-control.js"
import type { ReplayedSession } from "./schemas.js"
import { callsRuntimeInvocationTool } from "./tool-execution-projection.js"
import type { ToolExecutionEntry } from "./tool-execution-types.js"

interface CompletionCandidate {
  readonly kind: "terminal"
  readonly conversationId: string
  readonly childSessionId: string
  readonly description: string
  readonly notificationLabel: string
  readonly workflowDefinitionId: string
  readonly tool: ToolExecutionEntry
  readonly terminal: NonNullable<ReturnType<typeof terminalWorkflow>>
  readonly unchangedSinceResult: boolean
  readonly results: readonly AgentResult[]
  readonly handoff: TerminalHandoff | null
  readonly failedAgents: readonly FailedAgent[]
  readonly resumable: boolean
  readonly reason: string | undefined
}

interface NonterminalCandidate {
  readonly kind: "nonterminal"
  readonly toolUseId: string
}

/** A Stop or a start failure already settled the call. Its notification may still be owed. */
export interface SettledCandidate {
  readonly kind: "settled"
  readonly conversationId: string
  readonly childSessionId: string
  readonly content: string
  readonly revision: string
}

/** The parent already holds the completion of a run that has not changed
 *  since its result. Nothing is owed to the parent or to the run. */
interface DeliveredCandidate {
  readonly kind: "delivered"
}

/** Facts after a delivered result that one bounded read checks. Only a
 *  conversion adds facts there without running the workflow, one
 *  registration each, so a page full of them proves nothing. */
const DELIVERED_TAIL_PAGE = 8

/** Reads only the changed workflow's advancing control, output, and parent-call evidence. */
export async function completionCandidate(
  context: ChildReconciliationReadContext,
  parent: ReplayedSession,
  childSessionId: string,
  child: WorkflowRunRecord,
  measurement: { workflowAggregateReads: number },
  prefetchedTool?: ToolExecutionEntry,
): Promise<CompletionCandidate | NonterminalCandidate | SettledCandidate | DeliveredCandidate | null> {
  const { input } = context
  if (parent.kind !== "chat") return null
  const launch = child.launchedFrom
  if (!launch) return null
  const { toolUseId } = launch
  if (!toolUseId || launch.parentSessionId !== input.parentSessionId) return null
  const tool = prefetchedTool ?? (await readParentTools(context, [toolUseId])).get(toolUseId)
  if (!tool) return null
  const adoption = tool.runtimeOrigin?.operation.kind === "adoption"
    && tool.runtimeOrigin.operation.workflowSessionId === childSessionId
    && tool.runtimeOrigin.parentConversationId === parent.conversationId
  if (!adoption && (launch.workflowDefinitionId !== child.workflowDefinitionId || launch.description === undefined
    || !eligibleTool(tool, child.workflowDefinitionId, launch.description))) return null
  const reader = input.projectionReader ?? input.reader
  const label = workflowNotificationLabel(tool.input, child.workflowDefinitionId)
  const stoppedBy = stopOf(tool.resultOutcome)
  if (await delivered(context, parent.conversationId, childSessionId, tool)) return { kind: "delivered" }
  measurement.workflowAggregateReads += 1
  if (stoppedBy) {
    const handoff = await readTerminalHandoff(reader, childSessionId)
    return {
      kind: "settled",
      conversationId: parent.conversationId,
      childSessionId,
      content: retainedSettledContent(workflowStopContent({ label, sessionId: childSessionId, stoppedBy, handoff }), childSessionId, tool),
      revision: tool.resultEventId ?? toolUseId,
    }
  }
  const control = await readWorkflowControl(reader, childSessionId)
  if (control.status !== "completed" && control.status !== "failed") {
    // Start failure settles the call but keeps the workflow resumable. A later
    // terminal run replaces that earlier result through the terminal path.
    if (tool.resultOutcome === "error") {
      return { kind: "settled", conversationId: parent.conversationId, childSessionId, content: retainedSettledContent(workflowStartFailureContent({ label, sessionId: childSessionId }), childSessionId, tool), revision: tool.resultEventId ?? toolUseId }
    }
    return { kind: "nonterminal", toolUseId }
  }
  const queue = await createReplayingWorkflowView(reader, childSessionId).read()
  const terminal = terminalWorkflow(control, queue)
  if (!terminal || !queue) return null
  const evidence = await readAdvancingCompletionEvidence(reader, childSessionId, control, queue)
  const recordedResult = await readRecordedResult(context, tool)
  return {
    kind: "terminal",
    conversationId: parent.conversationId,
    childSessionId,
    description: launch.description ?? child.label,
    notificationLabel: label,
    workflowDefinitionId: child.workflowDefinitionId,
    tool,
    terminal,
    unchangedSinceResult: tool.resultOutcome === "ok" && recordedResult !== undefined
      && recordedResult.id === tool.resultEventId && evidence.executionPosition <= recordedResult.position,
    results: evidence.results,
    handoff: evidence.handoff,
    failedAgents: evidence.failedAgents,
    resumable: evidence.resumable,
    reason: terminal.status === "failed" ? evidence.reason : undefined,
  }
}

/** Whether the full read would find the run terminal, unchanged since its
 *  "ok" result, and its completion committed in the parent, so that it
 *  writes nothing: the state of every settled workflow when its parent
 *  reopens. Bounded reads prove it, so the reopen reads no settled run's
 *  history. Only a terminal run's completion records an "ok" result for its
 *  call, so no run fact after that result means the run is still terminal.
 *  A run that a host runs here takes the full read, which acknowledges its
 *  completion to that host. */
async function delivered(context: ChildReconciliationReadContext, conversationId: string, childSessionId: string, tool: ToolExecutionEntry): Promise<boolean> {
  if (tool.resultOutcome !== "ok" || liveWorkflowControl(context.input.reader, childSessionId)) return false
  const result = await readRecordedResult(context, tool)
  if (!result || result.id !== tool.resultEventId) return false
  const reader = context.input.projectionReader ?? context.input.reader
  const tree = await createConversationTreeProjection(reader, conversationId).replay()
  if (tree.degraded.unreadable) return false
  if (!tree.entriesById[`workflow-completion:${childSessionId}`] && !tree.entriesById[historicalCompletionEntryId(childSessionId)]) return false
  const later = (await reader.readSlice({ aggregateId: `workflow:${childSessionId}`, afterPosition: result.position, limit: DELIVERED_TAIL_PAGE })).facts
  if (later.length === DELIVERED_TAIL_PAGE) return false
  const stored = later.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError))
  return stored.length === later.length && !workflowRunOwner().hasExecutionAfter(stored, result.position)
}

/** The parent's newest result fact of the call, read once a sweep. */
async function readRecordedResult(context: ChildReconciliationReadContext, tool: ToolExecutionEntry): Promise<{ readonly id: string; readonly position: number } | undefined> {
  const { toolUseId } = tool
  const known = context.index.resultPositions.get(toolUseId)
  if (tool.resultEventId === undefined || known?.id === tool.resultEventId) return known
  const reader = context.input.projectionReader ?? context.input.reader
  const [latest] = (await reader.readSlice({
    aggregateId: `session:${context.input.parentSessionId}`,
    types: ["tool.result.recorded", "workflow.tool_result.corrected"],
    toolUseIds: [toolUseId],
    order: "desc",
    limit: 1,
  })).facts
  if (latest instanceof CorruptEventRowError) throw latest
  if (!latest) return known
  const recorded = { id: latest.id, position: latest.position }
  context.index.resultPositions.set(toolUseId, recorded)
  return recorded
}

function stopOf(outcome: ToolOutcome | undefined): "person" | "agent" | undefined {
  return outcome === "stopped" ? "person" : outcome === "cancelled" ? "agent" : undefined
}

function eligibleTool(tool: ToolExecutionEntry, workflowDefinitionId: string, description: string): boolean {
  if (tool.status === "validation_failed") return false
  if (!callsRuntimeInvocationTool(tool)) return false
  return workflowCallLaunched(tool.input, { workflowDefinitionId, description })
}
