import { DebugLog } from "../../../../infra/debug-log.js"
import { Log } from "../../../../infra/log.js"
import { LlmStreamError } from "../../../agent-runtime/llm/errors.js"
import { engineFailure } from "../acp/errors.js"

// agy retries a model request that failed with 429 or 503 by itself, about 4 s later, and no ACP frame or hook shows
// it (REPORT.md P3). Flywheel's walk owns retries and failover (decision 6, ARCH-PROVIDERS-087), so the engine's own
// retry must never reach Google. Two signs show a failed attempt 1 to 4 ms after the failed response: a step of type
// `ERROR_MESSAGE` in the session's transcript, which names the session, and a `Run: attempt N failed` line in the
// engine's log, which names none. Each failed attempt writes one of each.

const log = Log.create({ service: "provider-google-antigravity" })

/** How long a log line that names no session waits for a transcript sign that names it. agy waits at least 4 s before
 *  its retry, so a cancel after this wait still stops it. */
export const ATTRIBUTION_WAIT_MS = 1_000

/** The start of each record of agy's log (glog): its level, date and time. A line without it continues the record
 *  before it, as when an error message holds a line break. */
const RECORD_START = /^[IWEF]\d{4} /u
const ATTEMPT_FAILED = /Run: attempt \d+ failed \(/u
const RETRYING = "), retrying in "

/**
 * A reader of agy's log, line by line, that answers the error text of each failed attempt that agy will retry, once
 * the record that reports it is complete, and nothing for every other line. The record starts with
 * `Run: attempt N failed (` and ends with `), retrying in`; the error message between them can span several lines,
 * which the text keeps. A record that ends without `retrying in` reports an attempt that agy does not retry.
 */
export function failedAttemptLogReader(): (line: string) => string | undefined {
  let record: string[] | undefined
  return (line) => {
    if (record === undefined || RECORD_START.test(line)) {
      const header = ATTEMPT_FAILED.exec(line)
      record = header === null ? undefined : [line.slice(header.index + header[0].length)]
    } else {
      record.push(line)
    }
    const last = record?.at(-1)
    const end = last?.lastIndexOf(RETRYING) ?? -1
    if (record === undefined || last === undefined || end < 0) return undefined
    const detail = [...record.slice(0, -1), last.slice(0, end)].join("\n")
    record = undefined
    return detail
  }
}

/** What identifies the failure of one attempt in both of its signs: its HTTP status code, or else its whole text. */
function attemptKey(detail: string): string {
  return /\b(?:Error |\(code )(\d{3})\b/u.exec(detail)?.[1] ?? detail.trim()
}

/** The error text of a transcript line that records a failed attempt (`ERROR_MESSAGE`), or nothing for any other line,
 *  also one that is not JSON, such as a line that agy has not finished writing. */
export function failedAttemptTranscriptDetail(line: string): string | undefined {
  try {
    const step: unknown = JSON.parse(line)
    if (typeof step !== "object" || step === null || !("type" in step) || step.type !== "ERROR_MESSAGE") return undefined
    return "error" in step && typeof step.error === "string" ? step.error : ""
  } catch {
    return undefined
  }
}

/** One sign of a failed attempt: a transcript step of `sessionId`, or a log line of the process. */
type RetrySign =
  | { readonly kind: "transcript"; readonly sessionId: string; readonly detail: string }
  | { readonly kind: "log"; readonly detail: string }

export interface RetryWatch {
  /** A prompt of `sessionId` was sent. */
  open(sessionId: string): void
  /** The prompt of `sessionId` settled. */
  settle(sessionId: string): void
  observe(sign: RetrySign): void
  /** Stops every wait. */
  dispose(): void
}

/** A transcript sign that ended an open prompt before the log line of the same attempt arrived. `key` is the
 *  attempt's `attemptKey`, which the log line must match. */
interface Credit {
  readonly key: string
  readonly clear: () => void
}

/** A log line that waits for a transcript sign of the same failure of one of the prompts that were open when it
 *  arrived. */
interface PendingLine {
  readonly key: string
  readonly suspects: ReadonlySet<string>
  readonly clear: () => void
}

/**
 * The retry watch of one engine process. Each sign of a failed attempt ends exactly the prompts that can have failed,
 * through `cancel` (which sends `session/cancel` and fails the prompt's request with the given error), and never waits
 * past `ATTRIBUTION_WAIT_MS`:
 *
 * - A transcript sign cancels its session's open prompt at once, with the failure that its error text classifies.
 * - A log line whose transcript sign of the same failure (status code) came first is that attempt's, and changes
 *   nothing. A log line of another failure is no such sign's, so a late sign never absorbs it.
 * - A log line while one prompt is open cancels that prompt at once, with the failure its text classifies.
 * - A log line while several prompts are open waits for a transcript sign of one of them. When none comes within the
 *   wait, it cancels each of them that is still open, with a transient failure, because any of them can have failed.
 *
 * A prompt that the watch ended counts as settled for later signs. `timer` is the clock seam.
 */
export function createRetryWatch(options: {
  readonly processId: string
  readonly cancel: (sessionId: string, failure: Error) => void
  readonly timer?: (ms: number, run: () => void) => () => void
}): RetryWatch {
  const timer = options.timer ?? ((ms, run) => {
    const handle = setTimeout(run, ms)
    return () => clearTimeout(handle)
  })
  const open = new Set<string>()
  const credits: Credit[] = []
  const pending: PendingLine[] = []
  const end = (sessionId: string, failure: Error, sign: RetrySign["kind"] | "unattributed") => {
    if (!open.delete(sessionId)) return
    DebugLog.record({ type: "provider.antigravity.retry.cancelled", payload: { processId: options.processId, sessionId, sign } })
    options.cancel(sessionId, failure)
  }
  const removeFrom = <T>(list: T[], item: T) => {
    const index = list.indexOf(item)
    if (index >= 0) list.splice(index, 1)
  }
  return {
    open(sessionId) {
      open.add(sessionId)
    },
    settle(sessionId) {
      open.delete(sessionId)
    },
    observe(sign) {
      if (sign.kind === "transcript") {
        if (!open.has(sign.sessionId)) return
        end(sign.sessionId, engineFailure(sign.detail), "transcript")
        const key = attemptKey(sign.detail)
        const line = pending.find((waiting) => waiting.key === key && waiting.suspects.has(sign.sessionId))
        if (line !== undefined) {
          line.clear()
          removeFrom(pending, line)
          return
        }
        const credit: Credit = { key, clear: timer(ATTRIBUTION_WAIT_MS, () => removeFrom(credits, credit)) }
        credits.push(credit)
        return
      }
      const key = attemptKey(sign.detail)
      const credit = credits.find((waiting) => waiting.key === key)
      if (credit !== undefined) {
        credit.clear()
        removeFrom(credits, credit)
        return
      }
      if (open.size === 0) {
        log.debug("Google Antigravity engine retry line with no open prompt", { processId: options.processId })
        return
      }
      if (open.size === 1) {
        for (const sessionId of open) end(sessionId, engineFailure(sign.detail), "log")
        return
      }
      const suspects = new Set(open)
      const line: PendingLine = {
        key,
        suspects,
        clear: timer(ATTRIBUTION_WAIT_MS, () => {
          removeFrom(pending, line)
          const failure = () => new LlmStreamError("The Google Antigravity engine failed a model request of one of its open prompts and would retry it", "transient")
          for (const sessionId of suspects) end(sessionId, failure(), "unattributed")
        }),
      }
      pending.push(line)
    },
    dispose() {
      for (const waiting of [...credits, ...pending]) waiting.clear()
      credits.length = 0
      pending.length = 0
      open.clear()
    },
  }
}
