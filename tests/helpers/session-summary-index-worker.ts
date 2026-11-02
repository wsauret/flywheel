import { asAsyncEventReadSurface, type AsyncEventReadSurface } from "../../src/infra/event-store-types.js"
import { openReadonlyEventReader } from "../../src/infra/sqlite-event-store.js"
import { acquireSessionSummaryIndex } from "../../src/orchestration/session/session-summary-index.js"
// The summary index folds workflow run accounting from the installed catalog,
// which the module registry publishes into this realm when it loads, as the
// runtime background Worker does through its own imports.
import "../../src/orchestration/modules.js"

declare const self: {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  postMessage(message: unknown): void
}

let releasePage: (() => void) | undefined

self.addEventListener("message", (event: MessageEvent) => {
  const message: unknown = event.data
  if (typeof message !== "object" || message === null || !("kind" in message)) return
  if (message.kind === "release") {
    releasePage?.()
    return
  }
  if (message.kind !== "start" || !("eventDbFile" in message) || !("summaryDbFile" in message)) return
  const eventDbFile = String(message.eventDbFile)
  const summaryDbFile = String(message.summaryDbFile)
  const reader = openReadonlyEventReader(eventDbFile)
  const base = asAsyncEventReadSurface(reader)
  let firstPage = true
  const gate = new Promise<void>((resolve) => { releasePage = resolve })
  const source: AsyncEventReadSurface = {
    capturePosition: () => base.capturePosition(),
    latestPosition: (type) => base.latestPosition?.(type) ?? Promise.resolve(0),
    async readPage(query, upperPosition, afterPosition, tolerant) {
      const page = await base.readPage(query, upperPosition, afterPosition, tolerant)
      if (firstPage) {
        firstPage = false
        self.postMessage({ kind: "page-ready" })
        await gate
      }
      return page
    },
  }
  const index = acquireSessionSummaryIndex(summaryDbFile, source, { shared: false })
  void index.replay()
    .then(() => index.readImmediate(["session-a"]))
    .then((result) => {
      const summary = result.summaries.get("session-a")
      self.postMessage({
        kind: "result",
        status: result.status,
        throughPosition: result.throughPosition,
        totalCost: summary?.budget?.totalCost,
        totalTokens: summary?.budget?.totalTokens,
      })
    })
    .catch((error: unknown) => { self.postMessage({ kind: "failed", error: String(error) }) })
    .finally(async () => {
      await index.dispose()
      reader.close()
    })
})
