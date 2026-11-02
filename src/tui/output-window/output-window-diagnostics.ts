import type { Accessor } from "solid-js"
import { createEffect } from "solid-js"
import { Log } from "../../infra/log.js"
import { renderProbeEnabled } from "../../infra/render-probe.js"
import type { TranscriptFreshness, TranscriptSnapshot } from "../transcript-store/output-transcript-cache-types.js"
import type { TranscriptWindowProjection } from "./output-window-projection.js"

const renderLog = Log.create({ service: "output-window" })
const RENDER_OBSERVATION_LOG_MS = 10_000

export function createOutputWindowRenderDiagnostics(deps: {
  readonly freshness: Accessor<TranscriptFreshness | undefined>
  readonly snapshot: Accessor<TranscriptSnapshot | undefined>
  readonly projection: Accessor<TranscriptWindowProjection>
}): void {
  if (!renderProbeEnabled()) return
  let lastObservedRevision = 0
  let lastObservedLogAt = 0

  createEffect(() => {
    const freshness = deps.freshness()
    if (!freshness || freshness.revision === lastObservedRevision) return
    lastObservedRevision = freshness.revision
    const timestamp = Date.now()
    if (timestamp - lastObservedLogAt < RENDER_OBSERVATION_LOG_MS) return
    lastObservedLogAt = timestamp
    const snap = deps.snapshot()
    const projected = deps.projection()
    const consistencyToken = snap?.source.kind === "historical" ? snap.source.consistencyToken : undefined
    renderLog.info("output window observed transcript revision", {
      transcriptRevision: freshness.revision,
      transcriptSource: freshness.source,
      transcriptUpdatedAt: freshness.updatedAt,
      snapshotSource: snap?.source.kind,
      status: snap?.status.kind,
      consistencyToken,
      totalBlocks: snap?.totalBlocks,
      windowStart: snap?.window.startBlockIndex,
      windowEnd: snap?.window.endBlockIndex,
      blocks: snap?.blocks.length ?? 0,
      timelineBlocks: projected.timelineBlocks.length,
      pendingBlocks: projected.pendingBlocks.length,
      zeroHeightBlocks: projected.zeroHeightBlockIndices.length,
    })
  })
}
