import type { Database } from "bun:sqlite"
import { readStoredSessionSummary, writeStoredSessionSummary, type StoredSessionSummary } from "./session-summary-index-sql.js"

/** The local summary rows of one replay, kept decoded between its pages.
 *  Decoding a stored budget costs more than folding a fact into it, and the
 *  replay visits each session again on almost every page.
 *
 *  The fold is deterministic, so a row read or written at one watermark
 *  stays the row at that watermark, whichever writer committed it. A page's
 *  rows join the kept rows only when the page commits at the watermark that
 *  the replay expected. When another writer moved the watermark, or a
 *  transaction runs again, nothing the replay holds can be trusted, so it
 *  starts again from the stored rows. A kept row equals what a read of the
 *  stored row returns, so the cache cannot change a total. */
export interface ReplayLocalSummaries {
  read(sessionId: string): StoredSessionSummary | undefined
  write(sessionId: string, summary: StoredSessionSummary): void
  beginPage(): void
  keepPage(): void
  forget(): void
}

export function createReplayLocalSummaries(db: Database): ReplayLocalSummaries {
  const kept = new Map<string, StoredSessionSummary>()
  const page = new Map<string, StoredSessionSummary>()
  return {
    read(sessionId) {
      const held = page.get(sessionId) ?? kept.get(sessionId)
      if (held) return held
      const stored = readStoredSessionSummary(db, sessionId)
      if (stored) page.set(sessionId, stored)
      return stored
    },
    write(sessionId, summary) {
      writeStoredSessionSummary(db, sessionId, summary)
      // The stored row omits the settled usage ids; session_summary_usage
      // deduplicates semantic usage instead.
      page.set(sessionId, { ...summary, budget: { ...summary.budget, settledUsageEntryIds: {} } })
    },
    beginPage() {
      page.clear()
    },
    keepPage() {
      for (const [sessionId, summary] of page) kept.set(sessionId, summary)
      page.clear()
    },
    forget() {
      kept.clear()
      page.clear()
    },
  }
}
