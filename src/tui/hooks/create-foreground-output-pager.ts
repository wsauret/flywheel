import type { LoadDirection, OutputTranscriptCache } from "../transcript-store/output-transcript-cache-types.js"

export interface ForegroundOutputPager { readonly pageForegroundOutput: (direction: LoadDirection) => void }

/** Loads one page per session at a time. Edge observations are frame-local:
 * after a read lands, only a fresh frame can request another page. Failures
 * release the session and are reported through onFailure. */
export function createForegroundOutputPager(deps: {
  readonly foregroundId: () => string | undefined
  readonly transcriptCache: Pick<OutputTranscriptCache, "loadPage">
  readonly onFailure: (sessionId: string, cause: unknown) => void
}): ForegroundOutputPager {
  const inFlight = new Set<string>()

  function pageForegroundOutput(direction: LoadDirection): void {
    const id = deps.foregroundId()
    if (!id || inFlight.has(id)) return
    inFlight.add(id)
    void deps.transcriptCache.loadPage(id, direction)
      .catch((cause: unknown) => {
        deps.onFailure(id, cause)
      })
      .finally(() => { inFlight.delete(id) })
  }

  return { pageForegroundOutput }
}
