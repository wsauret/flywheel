import type { RuntimePosition } from "../runtime-ui-protocol-types.js"
import type { TranscriptStatus, TranscriptView } from "./transcript-store.js"
import { showsNothingOfOutput } from "./transcript-store-paging.js"

/** What the store held when a render left the pane empty. */
export interface EmptyRenderEvidence {
  readonly status: TranscriptStatus
  readonly heldPosition: RuntimePosition | null
  readonly pendingCount: number
}

/** Records the renders that leave a session with output showing no blocks,
 *  as ids and counts. The first render of an episode writes what produced it;
 *  later ones only count, and the count is written when blocks return or the
 *  store closes. The episode lasts while the pane stays empty, however quiet:
 *  a time window would end it on silence and record the same blank pane again. */
export function createEmptyRenderEpisodes(sessionId: string, onDiagnostic: ((message: string, detail?: unknown) => void) | undefined, evidence: () => EmptyRenderEvidence) {
  let repeats: number | undefined
  const end = (): void => {
    if (repeats !== undefined && repeats > 0) onDiagnostic?.("transcript rendered no blocks again", { sessionId, count: repeats })
    repeats = undefined
  }
  return {
    /** A read or a committed patch rendered `view`. */
    note(view: TranscriptView, source: "read" | "patch"): void {
      if (!showsNothingOfOutput(view)) { end(); return }
      if (repeats !== undefined) { repeats += 1; return }
      repeats = 0
      onDiagnostic?.("transcript rendered no blocks for a session with output", {
        sessionId, source, ...evidence(), totalBlocks: view.totalBlocks, visibleMessageCount: view.visibleMessageCount,
      })
    },
    end,
  }
}
