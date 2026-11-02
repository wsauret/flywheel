import { createEffect } from "solid-js"
import type { Accessor } from "solid-js"
import type { RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"
import type { OutputTranscriptCache } from "../transcript-store/output-transcript-cache-types.js"

/** Refreshes resident transcripts when server-side visibility changes require hydration or row re-estimation. */
export function createTranscriptVisibilityRefresh(deps: {
  readonly config: Accessor<RuntimeConfigView | undefined>
  readonly transcriptCache: Pick<OutputTranscriptCache, "refresh" | "residentSessionIds">
  readonly onFailure: (sessionId: string, cause: unknown) => void
}): void {
  let previousShowThinking: boolean | undefined

  createEffect(() => {
    const values = deps.config()?.values
    if (values === undefined) return

    const showThinking = values.showThinking
    const refresh = previousShowThinking === false && showThinking
    previousShowThinking = showThinking
    if (!refresh) return

    for (const sessionId of deps.transcriptCache.residentSessionIds()) {
      void deps.transcriptCache.refresh(sessionId).catch((cause: unknown) => { deps.onFailure(sessionId, cause) })
    }
  })
}
