import { countFindMatches, type FindAnswer, type FindJob } from "./transcript-find.js"

globalThis.addEventListener("message", (event: MessageEvent<FindJob>) => {
  try {
    globalThis.postMessage({ kind: "done", counts: countFindMatches(event.data) } satisfies FindAnswer, [])
  } catch (error) {
    globalThis.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) } satisfies FindAnswer, [])
  }
}, { once: true })
