import type { OutputTranscriptCache } from "../../../../src/tui/transcript-store/output-transcript-cache-types.js"

export function transcriptCache() {
  const retained: string[] = []
  const released: string[] = []
  const opened: string[] = []
  const cache: OutputTranscriptCache = {
    protectReader: () => {},
    isCurrent: () => false,
    mutationEvidence: () => undefined,
    reportProjectionFailure: (_sessionId, error): never => { throw error },
    view: () => undefined,
    ensure: () => {},
    startKnownEmpty: () => {},
    recoverOutputCursor: () => {},
    open: async (id) => { opened.push(id) },
    refresh: async () => {},
    residentSessionIds: () => [],
    loadPage: async () => "skipped",
    loadAround: async () => {},
    hydrateAnchor: async () => {},
    hydrateBlockBody: async () => {},
    takeEstimateUpdates: () => [],
    evictBefore: () => {},
    retain: (id) => {
      retained.push(id)
      return { release: () => { released.push(id) } }
    },
    visibleRange: () => undefined,
    visibleMessageCount: () => 0,
    streamingOutputChars: () => undefined,
    jumpToLatest: async () => {},
    freshness: () => undefined,
    historyMetadata: () => undefined,
    disclosure: () => undefined,
    disclosures: () => ({}),
    setDisclosure: () => {},
  }
  return { cache, retained, released, opened }
}
