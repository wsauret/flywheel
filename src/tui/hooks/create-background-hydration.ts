import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { OutputTranscriptCache } from "../transcript-store/output-transcript-cache-types.js"

const log = Log.create({ service: "background-hydration" })

/** Backstop drain for windows that did not arrive whole: the open fetch pulls
 *  the entire under-budget window in one response, so this loop usually finds
 *  hasBefore=false and no-ops. It only pages when the row/byte payload budgets
 *  truncated the open response, draining older pages until the head is reached
 *  so the whole thread is hydrated and measured for instant jump-to-top and
 *  free scrolling.
 *
 *  A session past `residentBlockBudget` is left to virtualize + page on demand --
 *  the same budget the viewport's eager gate reads from the same totalBlocks,
 *  so the two decisions never disagree.
 *
 *  Loads go through the cache's `loadPage`; the user's near-edge pager may
 *  occasionally request the same older page concurrently, which `spliceRange`
 *  dedupes - benign. A per-session guard keeps at most one drain loop running.
 *
 *  Failures are LOGGED, never surfaced as a toast: this is a non-essential
 *  prefetch, and a transient RpcClient socket blip during a tab switch (the
 *  connection reconnects on its own) must not interrupt the user. On error the
 *  loop simply stops - a later re-open re-triggers it - and the user can still
 *  page older history on demand once the connection recovers. */
export function createBackgroundHydration(deps: {
  readonly transcriptCache: Pick<OutputTranscriptCache, "loadPage" | "historyMetadata">
  readonly residentBlockBudget: number
}) {
  const draining = new Set<string>()

  async function hydrateToHead(id: string, isForeground: () => boolean): Promise<void> {
    if (draining.has(id)) return
    draining.add(id)
    try {
      let pages = 0
      while (isForeground()) {
        const history = deps.transcriptCache.historyMetadata(id)
        if (!history) return
        if (history.totalBlocks > deps.residentBlockBudget) {
          log.info("background hydration left to virtualization", { sessionId: id, totalBlocks: history.totalBlocks, pages })
          return
        }
        if (!history.window.hasBefore) {
          if (pages > 0) log.info("background hydration reached head", { sessionId: id, pages })
          return
        }
        const result = await deps.transcriptCache.loadPage(id, "older")
        if (result === "skipped") return
        pages += 1
      }
    } catch (err) {
      // Non-essential prefetch: a transient socket blip (e.g. mid tab-switch
      // reconnect) must not toast. Log and stop; a later re-open re-triggers it.
      log.info("background hydration stopped on error", { sessionId: id, error: errorMessage(err) })
    } finally {
      draining.delete(id)
    }
  }

  return { hydrateToHead }
}
