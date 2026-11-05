import type { ChildSessionRow, SessionRow, SessionDiffStats, WorkflowDefinitionDrift } from "../../protocol/app-service-types.js"
import type { DurableSessionCatalogRow, SessionLaunchedFrom } from "./session-catalog-types.js"
import type { ReplayedSession } from "./schemas.js"
import { subagentRunOutcome, subagentSessionActions, subagentStoppedBy, type ChildSessionRunEvidence } from "./child-session-run-evidence.js"
import { chatSessionActions, workflowSessionActions, workflowToolCall, type ChildCall } from "./chat-session-run-evidence.js"
import type { ChatTurnEnd } from "./conversation/turn-end-record.js"
import type { WorkflowView } from "../../workflows/view/types.js"
import type { SessionNotice } from "../../infra/session-notice.js"

/** The durable evidence a row's admitted actions read: a child's run, a
 *  chat's turn end, or the turn end of a workflow's current agent. A catalog
 *  listing passes none; a detail read passes the one its session's kind
 *  needs. */
export interface SessionActionEvidence {
  /** The notice of a capacity wait the session owes and no run of it shows
   *  live, derived from its durable row, from the detail read (PI-MODEL-063). */
  readonly capacityNotice?: SessionNotice
  readonly memberActive?: boolean
  readonly workflowMessage?: boolean
  readonly workflowExecutable?: boolean
  /** Whether a workflow whose control cannot execute can run again from its
   *  recorded request, from the detail read. */
  readonly workflowRestartable?: boolean
  /** Whether a Resume runs a failed workflow's failed agents again, from the detail read. */
  readonly workflowRetriesFailedAgents?: boolean
  /** The drift rejection that still holds for a workflow, from the detail read. */
  readonly workflowDefinitionDrift?: WorkflowDefinitionDrift
  readonly childRun?: ChildSessionRunEvidence
  readonly chatTurnEnd?: ChatTurnEnd
  readonly retainedInput?: boolean
  /** A workflow's committed control state, for a durable row listed without it. */
  readonly workflowState?: WorkflowView["status"]
  /** The turn end of the conversation of a workflow's current agent. */
  readonly stepTurnEnd?: ChatTurnEnd
  /** A workflow's launching call, read from its parent chat; absent when
   *  unread. */
  readonly childCall?: ChildCall
  /** Whether a successor owes the session its continuation after a planned
   *  replacement (`awaitsPlannedContinuation`). Such a session shows working
   *  while nothing of it runs, and a person's interrupt of it records the
   *  person's turn end over the planned cut, so its row admits the Interrupt
   *  of its kind whatever its lifecycle (PI-REMOTE-012). */
  readonly continuationOwed?: boolean
}

/** The parent a session answers to, read from its launch: the parent session
 *  and, when the launch names one, the tool call Stop terminates. */
export function parentIdentity(launchedFrom: SessionLaunchedFrom | undefined): Pick<SessionRow, "parentSessionId" | "parentToolUseId"> {
  if (launchedFrom === undefined) return {}
  return {
    parentSessionId: launchedFrom.parentSessionId,
    ...(launchedFrom.toolUseId !== undefined ? { parentToolUseId: launchedFrom.toolUseId } : {}),
  }
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown ? Omit<T, Key & keyof T> : never
type CatalogTotalKey = "totalsLoading" | "totalCost" | "totalBilledCost" | "priceUnavailable" | "totalTokens" | "contextPercent" | "contextPromptTokens" | "durationMs" | "diffStats"
interface CatalogTotalsDraft {
  readonly totalCost?: number
  readonly totalBilledCost?: number
  readonly priceUnavailable?: boolean
  readonly totalTokens?: number
  readonly contextPercent?: number
  readonly contextPromptTokens?: number
  readonly durationMs?: number
  readonly diffStats?: SessionDiffStats
}
type CatalogRowDraft = DistributiveOmit<SessionRow, CatalogTotalKey> & CatalogTotalsDraft
type CatalogRowPresentation = DistributiveOmit<CatalogRowDraft, "executionCwd">
type CatalogTotals = Pick<Extract<SessionRow, { readonly totalsLoading: false }>, "totalCost" | "totalBilledCost" | "priceUnavailable" | "totalTokens" | "contextPercent" | "contextPromptTokens" | "durationMs" | "diffStats">

/** Project durable metadata without inventing runtime activity or uncomputed
 *  statistics. Admitted actions come from durable evidence: a caller that
 *  serves one session's detail reads it, and one that lists the catalog
 *  passes none, so a listed chat admits no Resume until its detail is read. */
export function projectSessionCatalogRow(session: DurableSessionCatalogRow & { kind: "workflow" }, evidence?: SessionActionEvidence): Extract<ChildSessionRow, { kind: "workflow" }>
export function projectSessionCatalogRow(session: DurableSessionCatalogRow & { kind: "chat" }, evidence?: SessionActionEvidence): Extract<SessionRow, { kind: "chat" }>
export function projectSessionCatalogRow(session: DurableSessionCatalogRow & { kind: "subagent" }, evidence?: SessionActionEvidence): Extract<SessionRow, { kind: "subagent" }>
export function projectSessionCatalogRow(session: DurableSessionCatalogRow & { kind: "workflow-agent" }, evidence?: SessionActionEvidence): Extract<SessionRow, { kind: "workflow-agent" }>
export function projectSessionCatalogRow(session: DurableSessionCatalogRow, evidence?: SessionActionEvidence): SessionRow
export function projectSessionCatalogRow(session: DurableSessionCatalogRow, evidence: SessionActionEvidence = {}): SessionRow {
  const common = {
    id: session.id,
    title: session.label || session.name || session.id,
    lifecycleState: session.lifecycleState,
    notices: evidence.capacityNotice ? [evidence.capacityNotice] : [],
    lastUpdated: session.lastUpdated,
    activity: "absent" as const,
    ...(session.degraded ? { degraded: true as const, unavailableFields: session.unavailableFields ?? [] } : {}),
    ...(session.shortLabel ? { shortTitle: session.shortLabel } : {}),
  }
  const stoppedBy = session.kind === "subagent" ? subagentStoppedBy(evidence.childRun) : evidence.childCall?.stoppedBy
  const stopped = stoppedBy !== undefined ? { stoppedBy } : {}
  const presentation: CatalogRowPresentation = session.kind === "subagent"
    ? {
      ...common,
      kind: "subagent",
      inputMode: { kind: "message" },
      admittedActions: subagentSessionActions(session.lifecycleState, evidence.childRun, evidence.continuationOwed),
      ...subagentRunOutcome(evidence.childRun),
      ...stopped,
    }
    : session.kind === "workflow-agent"
      ? { ...common, kind: "workflow-agent", inputMode: { kind: "message" }, workflowMembership: session.workflowMembership, admittedActions: evidence.memberActive ? ["session.send", ...chatSessionActions("workflow-agent", session.lifecycleState, evidence.chatTurnEnd, evidence.continuationOwed)] : ["session.delete"] }
      : { ...common, kind: "chat", inputMode: { kind: "chat" }, admittedActions: chatSessionActions("chat", session.lifecycleState, evidence.chatTurnEnd, evidence.continuationOwed, evidence.retainedInput) }
  return mergeListMetadata(presentation, session)
}

/** The workflow evidence one row's admission reads. */
export function workflowActionEvidence(toolUseId: string | undefined, evidence: SessionActionEvidence): Parameters<typeof workflowSessionActions>[2] {
  const toolCall = workflowToolCall(toolUseId, evidence.childCall)
  return {
    ...(evidence.workflowMessage !== undefined ? { message: evidence.workflowMessage } : {}),
    ...(evidence.workflowExecutable !== undefined ? { executable: evidence.workflowExecutable } : {}),
    ...(evidence.workflowRetriesFailedAgents === true ? { retriesFailedAgents: true } : {}),
    ...(evidence.workflowRestartable === true ? { restartable: true } : {}),
    ...(evidence.stepTurnEnd ? { stepTurnEnd: evidence.stepTurnEnd } : {}),
    ...(toolCall ? { toolCall } : {}),
    ...(evidence.continuationOwed ? { continuationOwed: true } : {}),
  }
}

/** Combine process-local presentation fields with durable metadata. Totals are
 * all present or all absent; a partial historical read becomes loading. */
export function mergeListMetadata(row: CatalogRowPresentation, metadata: DurableSessionCatalogRow): SessionRow {
  const diffStats = row.diffStats ?? metadata.diffStats
  // The optional fields are gathered into typed objects before the spread:
  // spreading a dozen conditional objects over a row union makes the compiler
  // enumerate every combination.
  const identity: Pick<SessionRow, "lastUpdated" | "executionCwd" | "createdAt" | "parentSessionId" | "parentToolUseId" | "childSessionIds"> = {
    lastUpdated: metadata.lastUpdated,
    executionCwd: metadata.executionCwd,
    ...(metadata.createdAt !== undefined ? { createdAt: metadata.createdAt } : {}),
    ...(metadata.parentSessionId !== undefined ? { parentSessionId: metadata.parentSessionId } : {}),
    ...(metadata.launchedFrom?.toolUseId !== undefined ? { parentToolUseId: metadata.launchedFrom.toolUseId } : {}),
    ...(metadata.childSessionIds !== undefined ? { childSessionIds: metadata.childSessionIds } : {}),
  }
  const totals: CatalogTotalsDraft = {
    ...statField("totalCost", row.totalCost ?? metadata.totalCost),
    ...statField("totalBilledCost", row.totalBilledCost ?? metadata.totalBilledCost),
    ...((metadata.priceUnavailable ?? row.priceUnavailable) !== undefined ? { priceUnavailable: metadata.priceUnavailable ?? row.priceUnavailable } : {}),
    ...statField("totalTokens", row.totalTokens ?? metadata.totalTokens),
    ...statField("contextPercent", row.contextPercent ?? metadata.contextPercent),
    ...statField("contextPromptTokens", row.contextPromptTokens ?? metadata.contextPromptTokens),
    ...statField("durationMs", row.durationMs ?? metadata.durationMs),
    ...(diffStats ? { diffStats } : {}),
  }
  return completeCatalogRow({ ...row, ...identity, ...totals })
}

/** Applies the runtime summary as one complete total replacement while keeping
 * the foreground row's fresher activity and metadata. */
export function replaceCatalogTotals<Row extends SessionRow>(
  row: Row,
  summary: { readonly totalsLoading: true } | { readonly totalsLoading: false; readonly row: CatalogTotals },
): Row {
  if (summary.totalsLoading) return loadingCatalogRow(row)
  return readyCatalogRow(row, summary.row)
}

/** Completes one catalog row with an exact aggregate replacement. */
export function readyCatalogRow<Row extends SessionRow>(
  row: Row,
  totals: CatalogTotals,
): Extract<Row, { readonly totalsLoading: false }> {
  return {
    ...loadingCatalogRow(row),
    totalsLoading: false,
    totalCost: totals.totalCost,
    totalBilledCost: totals.totalBilledCost,
    priceUnavailable: totals.priceUnavailable,
    totalTokens: totals.totalTokens,
    contextPercent: totals.contextPercent,
    contextPromptTokens: totals.contextPromptTokens,
    durationMs: totals.durationMs,
    ...(totals.diffStats ? { diffStats: totals.diffStats } : {}),
  }
}

function completeCatalogRow(row: CatalogRowDraft): SessionRow {
  if (row.totalCost === undefined
    || row.totalBilledCost === undefined
    || row.priceUnavailable === undefined
    || row.totalTokens === undefined
    || row.contextPercent === undefined
    || row.contextPromptTokens === undefined
    || row.durationMs === undefined) return loadingCatalogRow(row)
  return {
    ...row,
    totalsLoading: false,
    totalCost: row.totalCost,
    totalBilledCost: row.totalBilledCost,
    priceUnavailable: row.priceUnavailable,
    totalTokens: row.totalTokens,
    contextPercent: row.contextPercent,
    contextPromptTokens: row.contextPromptTokens,
    durationMs: row.durationMs,
    ...(row.diffStats ? { diffStats: row.diffStats } : {}),
  }
}

function loadingCatalogRow<Row extends SessionRow>(row: Row): Extract<Row, { readonly totalsLoading: true }>
function loadingCatalogRow(row: CatalogRowDraft): SessionRow
function loadingCatalogRow(row: CatalogRowDraft | SessionRow): SessionRow {
  const {
    totalCost: _totalCost,
    totalBilledCost: _totalBilledCost,
    priceUnavailable: _priceUnavailable,
    totalTokens: _totalTokens,
    contextPercent: _contextPercent,
    contextPromptTokens: _contextPromptTokens,
    durationMs: _durationMs,
    diffStats: _diffStats,
    ...metadata
  } = row
  return { ...metadata, totalsLoading: true }
}

function statField(key: "totalCost" | "totalBilledCost" | "totalTokens" | "contextPercent" | "contextPromptTokens" | "durationMs", value: number | undefined): CatalogTotalsDraft {
  return value === undefined ? {} : { [key]: value }
}

/** Converts one scoped metadata replay to the metadata-only catalog shape.
 *  The caller resolves the session's `executionCwd`, because an agent of a
 *  workflow reads its workflow's directory through membership. */
export function durableCatalogRowFromSession(id: string, session: Exclude<ReplayedSession, { readonly kind: "workflow" }>, executionCwd: string): DurableSessionCatalogRow {
  return {
    id,
    ...(session.name !== undefined ? { name: session.name } : {}),
    label: session.label,
    ...(session.shortLabel !== undefined ? { shortLabel: session.shortLabel } : {}),
    lifecycleState: session.lifecycleState,
    ...(session.kind === "workflow-agent" ? { kind: session.kind, workflowMembership: session.workflowMembership } : { kind: session.kind }),
    command: session.command,
    lastUpdated: session.lastUpdated,
    executionCwd,
    ...(session.createdAt !== undefined ? { createdAt: session.createdAt } : {}),
    ...(session.activatedAt !== undefined ? { activatedAt: session.activatedAt } : {}),
    ...(session.repo !== undefined ? { repo: session.repo } : {}),
    ...(session.branch !== undefined ? { branch: session.branch } : {}),
    conversationId: session.conversationId,
    ...(session.providerConversationId !== undefined ? { providerConversationId: session.providerConversationId } : {}),
    ...(session.launchedFrom !== undefined ? { launchedFrom: session.launchedFrom, parentSessionId: session.launchedFrom.parentSessionId } : {}),
    ...(session.childSessionIds !== undefined ? { childSessionIds: session.childSessionIds } : {}),
  }
}
