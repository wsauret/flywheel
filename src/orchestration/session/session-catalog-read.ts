import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { BudgetSummary } from "./budget-summary.js"
import type { DiffStatSummary } from "./diff-stat-summary.js"
import type { SessionDiffStats } from "../../protocol/app-service-types.js"
import type { DurableSessionCatalogError, DurableSessionCatalogRow, SessionMetadataCatalog } from "./session-catalog-types.js"
import type { SessionDurationProjectionState } from "./session-duration-projection.js"
import type { SessionForkRecord } from "./session-fork-projection.js"
import { readForks } from "./session-fork-summary.js"
import { recoverSessionMetadata, sessionMetadataErrors, sessionsFromProjection, type PerSessionMetadataState } from "./session-metadata-projection.js"
import type { SessionSummaryRead } from "./session-summary-index.js"
import type { ReplayedSession } from "./schemas.js"
import { recordedExecutionCwd } from "./session-execution-directory.js"

type CurrentCatalogEntry = Omit<SessionMetadataCatalog["entries"][number], "data"> & { readonly data: Exclude<ReplayedSession, { readonly kind: "workflow" }> }

function currentEntries(metadata: SessionMetadataCatalog): CurrentCatalogEntry[] {
  return metadata.entries.flatMap((entry) => entry.data.kind === "workflow" ? [] : [{ ...entry, data: entry.data }])
}

/** Per-session derived maps consumed by the row builder. */
export interface SessionCatalogStats {
  budget: Map<string, BudgetSummary>
  durations: Map<string, SessionDurationProjectionState>
  diffStats: Map<string, DiffStatSummary>
  forks: { [sessionId: string]: SessionForkRecord }
  errors: DurableSessionCatalogError[]
}
/** Adapts one exact derived-index read to the catalog builder while retaining
 * the cheap fork probe that does not fold workspace history. */
export async function sessionCatalogStatsFromSummary(
  result: SessionSummaryRead,
  sessionIds: readonly string[],
  projectionReader: AsyncEventStateReadSurface,
): Promise<SessionCatalogStats> {
  const budget = new Map<string, BudgetSummary>()
  const durations = new Map<string, SessionDurationProjectionState>()
  const diffStats = new Map<string, DiffStatSummary>()
  const errors: DurableSessionCatalogError[] = []
  if (result.status === "ready") {
    for (const sessionId of sessionIds) {
      const summary = result.summaries.get(sessionId)
      if (!summary) continue
      if (summary.budget) budget.set(sessionId, summary.budget)
      if (summary.duration) durations.set(sessionId, summary.duration)
      if (summary.diffStats) diffStats.set(sessionId, summary.diffStats)
      // The wire has no generation scope, so its reason names the reading:
      // the totals beside it stand, and only the speed is withheld.
      const generation = summary.errors.generation === undefined ? undefined : `generation speed: ${summary.errors.generation}`
      const budgetReasons = [summary.errors.budget, summary.errors.descendants, generation].filter((reason): reason is string => reason !== undefined)
      if (budgetReasons.length > 0) errors.push({ sessionId, scope: "budget", reason: budgetReasons.join("; ") })
      if (summary.errors.duration) errors.push({ sessionId, scope: "duration", reason: summary.errors.duration })
      if (summary.errors.diffStats) errors.push({ sessionId, scope: "diffStats", reason: summary.errors.diffStats })
    }
  }
  const forkResult = await readForks(sessionIds, projectionReader)
  return { budget, durations, diffStats, forks: forkResult.forks, errors: [...errors, ...forkResult.errors] }
}

export function buildDurableSessionCatalog(
  metadataResult: SessionMetadataCatalog,
  stats: SessionCatalogStats,
  projectRoot: string,
) {
  const sessions = currentEntries(metadataResult).map((entry) => toDurableSessionCatalogRow(
    entry,
    projectRoot,
    stats.budget.get(entry.id),
    stats.durations.get(entry.id),
    stats.diffStats.get(entry.id),
    stats.forks[entry.id],
  ))
  return {
    sessions,
    errors: [
      ...metadataResult.errors.map((err) => ({ ...err, scope: "metadata" as const })),
      ...stats.errors,
    ],
  }
}

export function buildDurableSessionMetadataCatalog(metadataResult: SessionMetadataCatalog, projectRoot: string) {
  return {
    sessions: currentEntries(metadataResult).map((entry) => toDurableSessionCatalogRow(entry, projectRoot)),
    errors: metadataResult.errors.map((err) => ({ ...err, scope: "metadata" as const })),
  }
}

/** Converts strict projection state and recovers only its quarantined
 * aggregates. Recovered rows follow normal rows so strict ordering is stable. */
export async function sessionMetadataCatalogFromState(state: PerSessionMetadataState, reader: AsyncEventStateReadSurface): Promise<SessionMetadataCatalog> {
  const errors = [...sessionMetadataErrors(state)].map(([sessionId, reason]) => ({ sessionId, reason }))
  const recovered = (await Promise.all(errors.map(async ({ sessionId }) => {
    const data = await recoverSessionMetadata(reader, sessionId)
    return data ? { id: sessionId, data, degraded: true as const, unavailableFields: ["metadata"] as const } : null
  }))).filter((entry): entry is NonNullable<typeof entry> => entry !== null)
    .sort((a, b) => Date.parse(b.data.lastUpdated) - Date.parse(a.data.lastUpdated))
  return {
    entries: [...sessionsFromProjection(state), ...recovered],
    errors,
  }
}

function toDurableSessionCatalogRow(
  entry: CurrentCatalogEntry,
  projectRoot: string,
  budget?: { totalCost: number; totalBilledCost: number; priceUnavailable: boolean; totalTokens: number; contextPercent: number; contextPromptTokens: number; compactionTriggerTokens?: number },
  duration?: { accumulatedActiveMs: number },
  diffStats?: SessionDiffStats,
  fork?: SessionForkRecord,
): DurableSessionCatalogRow {
  const { id, data: session } = entry
  return {
    id,
    name: session.name,
    label: session.label,
    shortLabel: session.shortLabel,
    lifecycleState: session.lifecycleState,
    // An agent of a workflow runs on its workflow's profile, so a copy that
    // an earlier build wrote on the agent is not the agent's selection.
    ...(session.kind === "workflow-agent" || session.authProfileId === undefined ? {} : { authProfileId: session.authProfileId }),
    ...(session.kind === "workflow-agent" ? { kind: session.kind, workflowMembership: session.workflowMembership } : { kind: session.kind }),
    command: session.command,
    // Absent, not zero, when this build did not compute stats (metadata-only
    // list): a zero here is a placeholder pretending to be data, and it
    // clobbers background-warmed stats when the row is republished.
    ...(budget ? { totalCost: budget.totalCost, totalBilledCost: budget.totalBilledCost, priceUnavailable: budget.priceUnavailable, totalTokens: budget.totalTokens, contextPercent: budget.contextPercent, contextPromptTokens: budget.contextPromptTokens, ...(budget.compactionTriggerTokens === undefined ? {} : { compactionTriggerTokens: budget.compactionTriggerTokens }) } : {}),
    ...(duration ? { durationMs: duration.accumulatedActiveMs } : {}),
    ...(diffStats ? { diffStats } : {}),
    lastUpdated: session.lastUpdated,
    createdAt: session.createdAt,
    // A child is never a catalog row (ARCH-PROTOCOL-048), so a workflow
    // agent's directory is not read through membership here; its detail does.
    executionCwd: recordedExecutionCwd(session, projectRoot),
    activatedAt: session.activatedAt,
    repo: session.repo,
    branch: session.branch,
    conversationId: session.conversationId,
    providerConversationId: session.providerConversationId,
    ...(entry.degraded ? {
      degraded: true,
      unavailableFields: entry.unavailableFields ?? [],
    } : {}),
    ...(session.launchedFrom ? {
      launchedFrom: session.launchedFrom,
      parentSessionId: session.launchedFrom.parentSessionId,
    } : {}),
    ...(session.childSessionIds && session.childSessionIds.length > 0
      ? { childSessionIds: [...session.childSessionIds] }
      : {}),
    ...(fork ? { fork } : {}),
  }
}
