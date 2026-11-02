import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { RuntimeBackgroundSummaryResult } from "../../protocol/runtime-protocol-schemas.js"
import { buildDurableSessionCatalog, sessionCatalogStatsFromSummary, sessionMetadataCatalogFromState } from "../session/session-catalog-read.js"
import { projectSessionCatalogRow } from "../session/session-catalog-row.js"
import { createSessionMetadataProjection } from "../session/session-metadata-projection.js"
import type { SessionSummaryIndex } from "../session/session-summary-index.js"

export interface RuntimeBackgroundSnapshotProjector {
  /** Returns metadata immediately and omits every scalar total until the index is current. */
  readImmediate(sessionIds?: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
  /** Joins the index replay owned by this Worker project, then rereads exact rows. */
  waitForTotals(sessionIds?: readonly string[]): Promise<RuntimeBackgroundSummaryResult>
}

/** Builds cold catalog rows from metadata plus the one rebuildable summary
 * index. Metadata replay and summary replay remain independently scoped so a
 * stale index never delays a passive catalog read. */
export function createRuntimeBackgroundSnapshotProjector(
  reader: AsyncEventStateReadSurface,
  summaries: Pick<SessionSummaryIndex, "readImmediate" | "waitForTotals">,
  projectRoot: string,
): RuntimeBackgroundSnapshotProjector {
  const metadata = createSessionMetadataProjection(reader)

  async function project(
    read: SessionSummaryIndex["readImmediate"] | SessionSummaryIndex["waitForTotals"],
    requested?: readonly string[],
  ): Promise<RuntimeBackgroundSummaryResult> {
    const completeMetadata = await sessionMetadataCatalogFromState(await metadata.replay(), reader)
    let selectedMetadata = completeMetadata
    if (requested !== undefined) {
      const entriesById = new Map(completeMetadata.entries.map((entry) => [entry.id, entry]))
      const requestedIds = new Set(requested)
      selectedMetadata = {
        entries: requested.flatMap((sessionId) => {
          const entry = entriesById.get(sessionId)
          return entry ? [entry] : []
        }),
        errors: completeMetadata.errors.filter((error) => requestedIds.has(error.sessionId)),
      }
    }
    const ids = selectedMetadata.entries.map((entry) => entry.id)
    const summary = await read(ids)
    const list = buildDurableSessionCatalog(
      selectedMetadata,
      await sessionCatalogStatsFromSummary(summary, ids, reader),
      projectRoot,
    )
    const generationSpeeds: { [sessionId: string]: number } = {}
    for (const [sessionId, entry] of summary.summaries) {
      if (entry.averageGenerationTokensPerSecond !== undefined) generationSpeeds[sessionId] = entry.averageGenerationTokensPerSecond
    }
    return {
      rows: list.sessions.map((session) => projectSessionCatalogRow(session)),
      errors: list.errors,
      totalsLoading: summary.status === "loading",
      generationSpeeds,
    }
  }

  return {
    readImmediate: (sessionIds) => project(summaries.readImmediate.bind(summaries), sessionIds),
    waitForTotals: (sessionIds) => project(summaries.waitForTotals.bind(summaries), sessionIds),
  }
}
