import type { SessionSurfaceDeps } from "../../../../../../src/tui/hooks/state/sessions/create-session-surface.js"

/** A transcript cache that holds no session: these surface tests read
 *  detail, status, and budget, never the transcript. */
export function transcriptCache() {
  return {
    cache: {
      mount: () => ({
        view: {
          protectReader: () => {},
          mutationEvidence: () => undefined,
          reportProjectionFailure: (error): never => { throw error },
          visibleRange: () => undefined,
          visibleMessageCount: () => 0,
          jumpToLatest: async () => {},
          freshness: () => undefined,
          loadAround: async () => {},
          takeEstimateUpdates: () => [],
          evictBefore: () => {},
          disclosure: () => undefined,
          setDisclosure: () => {},
          hydrateBlockBody: () => {},
        },
        outputView: () => undefined,
        streamingOutputChars: () => undefined,
      }),
      loadPage: async () => "skipped",
    } satisfies SessionSurfaceDeps["transcriptCache"],
  }
}
