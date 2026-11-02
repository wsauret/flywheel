import { computeBackoffMs, type BackoffOptions } from "../../infra/backoff.js"
import { errorMessage } from "../../infra/error-message.js"
import type { OutputWindowSnapshot, TranscriptUnavailable } from "../transcript-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"

/** Retry one authoritative window read. A lost lane waits for its successor;
 * exhausted reads return a failure without changing the resident presentation. */
export async function readTranscriptWindow(options: {
  readonly read: () => Promise<OutputWindowSnapshot>
  readonly disposed: () => boolean
  readonly lane: () => number
  readonly waitForLane: (lane: number) => Promise<void>
  readonly backoff: BackoffOptions
  readonly maxAttempts: number
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
}): Promise<{ readonly snapshot: OutputWindowSnapshot } | { readonly failure: TranscriptUnavailable } | undefined> {
  for (let attempt = 0; ; attempt += 1) {
    const lane = options.lane()
    try {
      const snapshot = await options.read()
      return options.disposed() ? undefined : { snapshot }
    } catch (cause) {
      if (options.disposed()) return undefined
      if (lostWithLane(cause)) {
        await options.waitForLane(lane)
        if (options.disposed()) return undefined
        attempt = -1
        continue
      }
      if (attempt + 1 < options.maxAttempts) {
        options.onDiagnostic?.("transcript window read failed; retrying", { attempt, cause })
        await new Promise((resolve) => { setTimeout(resolve, computeBackoffMs(attempt, options.backoff)) })
        if (options.disposed()) return undefined
        continue
      }
      options.onDiagnostic?.("transcript window read failed", cause)
      return { failure: { title: "Transcript could not be recovered", message: "Could not read this session's transcript.", diagnostic: errorMessage(cause) } }
    }
  }
}
