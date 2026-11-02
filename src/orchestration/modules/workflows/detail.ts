import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { publishedDefinitionDrift } from "../../../workflows/vm/definition-identity.js"
import { readWorkflowRecovery } from "../../../workflows/vm/recovery-fold.js"
import type { WorkflowDetail } from "../../../protocol/modules/workflows.js"
import { readWorkflowUsage } from "../../workflow-host/member-totals.js"
import { readChildCall, readWorkflowAgentTurnEnds, resumableAgentTurnEnd, workflowSessionActions, workflowInteractionRefusal, type WorkflowAgentTurnEnd } from "../../session/chat-session-run-evidence.js"
import type { ChatTurnEnd } from "../../session/conversation/turn-end-record.js"
import { workflowActionEvidence } from "../../session/session-catalog-row.js"
import { awaitsPlannedContinuation } from "../../session/planned-session-continuation.js"
import { assessWorkflowRecovery } from "../../workflow-host/recovery-commit.js"
import { recordedExecutionCwd } from "../../session/session-execution-directory.js"
import { createWorkflowRunReader } from "./run-record.js"
import { readWorkflowStatees } from "../../../workflows/view/view-store.js"
import type { SessionManager } from "../../session/manager.js"
import { createWorkflowDurationReader } from "./duration.js"

/** The inputs of a workflow's detail, each of which a change moves alone. A
 *  workflow commit moves all of them. The parent's tool result moves
 *  `record`, an agent's conversation or reply waits move `agents`, a
 *  member's usage moves `usage`, a host that starts or stops moves
 *  `duration`, and an auth change moves `auth`. */
export type WorkflowDetailInput = "record" | "agents" | "usage" | "duration" | "auth"

export const WORKFLOW_DETAIL_INPUTS: ReadonlySet<WorkflowDetailInput> = new Set(["record", "agents", "usage", "duration", "auth"])

/** What the workflow's own durable control and its parent's call say. */
interface WorkflowRecord {
  readonly run: NonNullable<Awaited<ReturnType<ReturnType<typeof createWorkflowRunReader>["read"]>>>
  readonly classification: Awaited<ReturnType<typeof readWorkflowRecovery>>
  readonly restartable: boolean
  readonly childCall: Awaited<ReturnType<typeof readChildCall>>
  readonly continuationOwed: boolean
  readonly controlState: WorkflowDetail["workflowState"]
  readonly executionCwd: string
}

/** One workflow's detail as each of its inputs last read it. */
export interface WorkflowDetailParts {
  readonly record: WorkflowRecord
  /** A resumable turn end of an unfinished started agent; only an executable plan reads one. */
  readonly turnEnd: ChatTurnEnd | undefined
  readonly usage: Awaited<ReturnType<typeof readWorkflowUsage>>
  readonly duration: Pick<WorkflowDetail, "durationMs" | "streamingStartedAt" | "activeIntervals">
  readonly auth: WorkflowDetail["auth"]
}

interface WorkflowDetailReaderInput {
  readonly reader: AsyncEventStateReadSurface
  readonly projectRoot: string
  readonly manager: Pick<SessionManager, "read">
  readonly auth?: (workflowId: string) => Promise<NonNullable<WorkflowDetail["auth"]>>
  readonly isRunning?: (workflowId: string) => boolean
  /** The unfinished started agents with their turn ends. A held detail reads
   *  the owner that keeps them (`createStartedAgentStates`); without one,
   *  each read reads every agent's tail. */
  readonly turnEnds?: (workflowId: string) => Promise<readonly WorkflowAgentTurnEnd[]>
}

/** Reads a workflow's detail parts, or nothing for a run that does not exist.
 *  Given the parts an earlier read returned, it reads again only the inputs
 *  that `stale` names. Aggregate detail is passive: it attaches no member or
 *  host and starts no work. */
export function createWorkflowDetailPartsReader(input: WorkflowDetailReaderInput) {
  const runs = createWorkflowRunReader(input.reader)
  const duration = createWorkflowDurationReader(input.reader)
  const turnEnds = input.turnEnds ?? ((workflowId: string) => readWorkflowAgentTurnEnds(input.reader, workflowId))
  const readRecord = async (workflowId: string): Promise<WorkflowRecord | null> => {
    const run = await runs.read(workflowId)
    if (!run) return null
    const classification = await readWorkflowRecovery(input.reader, workflowId)
    const recovery = classification.plan.executable ? undefined : await assessWorkflowRecovery(input.reader, workflowId)
    const childCall = await readChildCall(input.reader, run.launchedFrom)
    const continuationOwed = await awaitsPlannedContinuation({ reader: input.reader, projectionReader: input.reader, manager: input.manager }, workflowId)
    const controlState = (await readWorkflowStatees([workflowId], input.reader)).statuses.get(workflowId)
    return {
      run, classification, restartable: recovery?.kind === "recoverable", childCall, continuationOwed, controlState,
      executionCwd: recordedExecutionCwd(run, input.projectRoot),
    }
  }
  return async (workflowId: string, held?: { readonly parts: WorkflowDetailParts; readonly stale: ReadonlySet<WorkflowDetailInput> }): Promise<WorkflowDetailParts | null> => {
    const record = held && !held.stale.has("record") ? held.parts.record : await readRecord(workflowId)
    if (!record) return null
    const executable = record.classification.plan.executable
    // A plan that turned executable holds no turn end read yet.
    const keepsTurnEnd = held && !held.stale.has("agents") && held.parts.record.classification.plan.executable === executable
    return {
      record,
      turnEnd: !executable ? undefined : keepsTurnEnd ? held.parts.turnEnd : resumableAgentTurnEnd(await turnEnds(workflowId)),
      usage: held && !held.stale.has("usage") ? held.parts.usage : await readWorkflowUsage(input.reader, workflowId),
      duration: held && !held.stale.has("duration") ? held.parts.duration : await duration(workflowId, input.isRunning?.(workflowId) ?? false),
      auth: held && !held.stale.has("auth") ? held.parts.auth : input.auth ? await input.auth(workflowId) : null,
    }
  }
}

/** The published detail that a workflow's parts compose. */
export function composeWorkflowDetail(workflowId: string, parts: WorkflowDetailParts): WorkflowDetail {
  const { record, turnEnd, usage } = parts
  const { run, classification: { plan, retry, rejection }, childCall, controlState } = record
  const actions = workflowSessionActions(controlState === "running" ? "active" : "inactive", controlState, workflowActionEvidence(run.launchedFrom.toolUseId, {
    workflowExecutable: plan.executable,
    workflowMessage: workflowInteractionRefusal(controlState, childCall?.stoppedBy) === undefined,
    workflowRestartable: record.restartable,
    workflowRetriesFailedAgents: retry, continuationOwed: record.continuationOwed,
    ...(turnEnd ? { stepTurnEnd: turnEnd } : {}),
    ...(childCall ? { childCall } : {}),
  }))
  const admittedActions: WorkflowDetail["admittedActions"][number][] = actions.flatMap((action) => {
    switch (action) {
      case "session.send": return ["workflow.send" as const]
      case "workflow.interrupt": return ["workflow.interrupt" as const]
      case "workflow.resume": return ["workflow.resume" as const]
      case "workflow.restart": return ["workflow.restart" as const]
      case "background.terminate": return ["workflow.stop" as const]
      case "session.delete": return ["workflow.delete" as const]
      default: return []
    }
  })
  return {
    workflowId, title: run.label || run.name || workflowId,
    ...parts.duration, totalsLoading: false,
    ...(run.shortLabel ? { shortTitle: run.shortLabel } : {}),
    workflowDefinitionId: run.workflowDefinitionId,
    createdAt: run.createdAt, lastUpdated: run.lastUpdated,
    executionCwd: record.executionCwd,
    roleAssignments: run.roleAssignments, launchedFrom: run.launchedFrom,
    ...(run.authProfileId ? { authProfileId: run.authProfileId } : {}),
    ...(childCall?.stoppedBy ? { stoppedBy: childCall.stoppedBy } : {}),
    auth: parts.auth,
    ...(controlState ? { workflowState: controlState } : {}),
    readability: plan.executable ? "readable" : "unavailable",
    ...(rejection && !childCall?.stoppedBy ? { definitionDrift: publishedDefinitionDrift(rejection.workflowId, rejection.changes) } : {}),
    admittedActions, totals: publishedUsage(usage.display), policyUsage: publishedUsage(usage.policy),
    attribution: run.historicalResidualAggregateId ? "partial" : "available",
  }
}

/** Reads a workflow's whole detail once, or nothing for a run that does not exist. */
export function createWorkflowDetailReader(input: WorkflowDetailReaderInput): (workflowId: string) => Promise<WorkflowDetail | null> {
  const read = createWorkflowDetailPartsReader(input)
  return async (workflowId) => {
    const parts = await read(workflowId)
    return parts && composeWorkflowDetail(workflowId, parts)
  }
}

function publishedUsage(usage: WorkflowDetail["totals"]): WorkflowDetail["totals"] {
  const { totalCost, totalBilledCost, priceUnavailable, totalInputTokens, totalOutputTokens } = usage
  return { totalCost, totalBilledCost, priceUnavailable, totalInputTokens, totalOutputTokens }
}
