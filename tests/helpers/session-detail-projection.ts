import { createSessionDetailProjection, type SessionDetailProjection } from "../../src/orchestration/app-service/session-detail-projection.js"
import { createTranscriptProjectionCache } from "../../src/orchestration/app-service/transcript-projection-cache.js"
import type { RuntimeSummaryProjection } from "../../src/orchestration/app-service/runtime-summary-projection.js"

type ProjectionDeps = Parameters<typeof createSessionDetailProjection>[0]
type Collaborators = "transcriptCache" | "summaries" | "shipped" | "processorHolds"

/** Runtime summaries that never finish loading: a detail shows its totals as
 *  loading. A test that asserts totals states its own summaries. */
export function loadingSummaries(): RuntimeSummaryProjection {
  return { admit: async () => {}, view: () => ({ totalsLoading: true }), subscribe: () => () => {}, settled: async () => {}, dispose() {} }
}

/** The one builder of the executor's detail projection over a test's store,
 *  manager, and readers. A test states the collaborators it asserts on; the
 *  rest are a transcript cache over the same readers, runtime summaries that
 *  stay loading, an output owner that serves each read as it is, and no shell
 *  command that processor admission holds. `dispose` releases the transcript
 *  cache that this builder made. */
export function testSessionDetailProjection(deps: Omit<ProjectionDeps, Collaborators> & Partial<Pick<ProjectionDeps, Collaborators>>): SessionDetailProjection & { dispose(): Promise<void> } {
  const transcriptCache = deps.transcriptCache ?? createTranscriptProjectionCache(deps)
  const projection = createSessionDetailProjection({
    summaries: loadingSummaries(),
    shipped: { serve: (_sessionId, read) => read() },
    processorHolds: { heldToolCallIds: () => [] },
    ...deps,
    transcriptCache,
  })
  return { ...projection, dispose: async () => { if (transcriptCache !== deps.transcriptCache) await transcriptCache.dispose() } }
}
