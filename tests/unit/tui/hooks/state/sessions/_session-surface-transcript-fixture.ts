import type { OutputTranscriptCache } from "../../../../../../src/tui/transcript/transcript-store/output-transcript-cache-types.js"

export function transcriptCache() {
  const retained: string[] = []
  const released: string[] = []
  const opened: string[] = []
  const cache: OutputTranscriptCache = {
    isCurrent: () => false,
    bindSession: () => ({
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
    }),
    view: () => undefined,
    ensure: () => {},
    startKnownEmpty: () => {},
    open: async (id) => { opened.push(id) },
    refresh: async () => {},
    residentSessionIds: () => [],
    loadPage: async () => "skipped",
    retain: (id) => {
      retained.push(id)
      return { release: () => { released.push(id) } }
    },
    visibleRange: () => undefined,
    streamingOutputChars: () => undefined,
    historyMetadata: () => undefined,
    disclosures: () => ({}),
    setDisclosure: () => {},
  }
  return { cache, retained, released, opened }
}
