import { describe, expect, test } from "bun:test"

import { LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { ATTRIBUTION_WAIT_MS, createRetryWatch, failedAttemptLogReader, failedAttemptTranscriptDetail } from "../../../../../src/orchestration/modules/provider-google-antigravity/retry-watch.js"

// The lines as agy 1.5.14 writes them (REPORT.md P3, F3c), with the message shortened.
const LOG_503 = "I1121 20:06:32.465201     919 run.go:308] Run: attempt 1 failed (Error 503, Message: The model is overloaded., Status: UNAVAILABLE, Details: []), retrying in 4s"
const LOG_429 = "I1121 20:06:32.465201     919 run.go:308] Run: attempt 1 failed (Error 429, Message: rate, Status: RESOURCE_EXHAUSTED, Details: []), retrying in 4s"
const TRANSCRIPT_503 = JSON.stringify({ step_index: 6, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", error: "API error (attempt 1): Error 503, Message: The model is overloaded., Status: UNAVAILABLE, Details: []" })
const TRANSCRIPT_429 = JSON.stringify({ step_index: 6, source: "SYSTEM", type: "ERROR_MESSAGE", status: "DONE", error: "API error (attempt 1): Error 429, Message: rate, Status: RESOURCE_EXHAUSTED, Details: []" })

/** A watch on a manual clock, which records each cancel in order. */
function watched() {
  const timers = new Set<{ readonly due: number; readonly run: () => void }>()
  let now = 0
  const cancels: { readonly sessionId: string; readonly failure: Error; readonly at: number }[] = []
  const watch = createRetryWatch({
    processId: "p1",
    cancel: (sessionId, failure) => cancels.push({ sessionId, failure, at: now }),
    timer(ms, run) {
      const timer = { due: now + ms, run }
      timers.add(timer)
      return () => timers.delete(timer)
    },
  })
  const advance = (ms: number) => {
    now += ms
    for (const timer of [...timers].filter(({ due }) => due <= now)) {
      timers.delete(timer)
      timer.run()
    }
  }
  return { watch, cancels, advance, pendingTimers: () => timers.size }
}

const kindOf = (failure: Error | undefined) => failure instanceof LlmStreamError ? failure.kind : failure?.name

/** The error texts that a fresh log reader answers for `lines`, in order. */
const logDetails = (lines: readonly string[]) => {
  const read = failedAttemptLogReader()
  return lines.map(read).filter((detail) => detail !== undefined)
}
const log = (line: string) => ({ kind: "log", detail: logDetails([line])[0] ?? "" }) as const
const transcript = (sessionId: string, line: string) => ({ kind: "transcript", sessionId, detail: failedAttemptTranscriptDetail(line) ?? "" }) as const

describe("the retry watch", () => {
  test("reads a failed attempt from agy's log line and transcript step, and nothing from other lines", () => {
    expect(logDetails([LOG_503])).toEqual(["Error 503, Message: The model is overloaded., Status: UNAVAILABLE, Details: []"])
    expect(logDetails(["E1121 errorreport.go:282] agent executor error: generating and executing: Error 429"])).toEqual([])
    expect(failedAttemptTranscriptDetail(TRANSCRIPT_429)).toStartWith("API error (attempt 1): Error 429")
    expect(failedAttemptTranscriptDetail(JSON.stringify({ type: "PLANNER_RESPONSE", status: "DONE" }))).toBeUndefined()
    expect(failedAttemptTranscriptDetail('{"type":"ERROR_MES')).toBeUndefined()
  })

  test("reads a failed attempt whose error message spans several log lines once its record is complete", () => {
    const read = failedAttemptLogReader()
    const lines = [
      "I1121 20:06:32.465201     919 run.go:308] Run: attempt 1 failed (Error 503, Message: The model is overloaded.",
      "Please try again later.",
      "Status: UNAVAILABLE, Details: []), retrying in 4s",
    ]
    expect(lines.map(read)).toEqual([undefined, undefined, "Error 503, Message: The model is overloaded.\nPlease try again later.\nStatus: UNAVAILABLE, Details: []"])
    // A record that ends without "retrying in" reports an attempt that agy does not retry, and a later record ends it.
    expect(logDetails(["I1121 run.go:308] Run: attempt 3 failed (Error 429, Message: rate", "limit)", "I1121 run.go:312] Run: giving up", LOG_429])).toEqual([
      "Error 429, Message: rate, Status: RESOURCE_EXHAUSTED, Details: []",
    ])
  })

  test("a log line takes only the transcript sign of the same failure: a late sign of another prompt is not absorbed", () => {
    for (const order of ["transcript first", "log first"] as const) {
      const { watch, cancels, advance } = watched()
      watch.open("S")
      watch.open("T")
      // S failed with 503 and T with 429; T's transcript sign never comes.
      if (order === "transcript first") watch.observe(transcript("S", TRANSCRIPT_503))
      watch.observe(log(LOG_429))
      if (order === "log first") watch.observe(transcript("S", TRANSCRIPT_503))
      watch.observe(log(LOG_503))
      advance(ATTRIBUTION_WAIT_MS * 2)
      expect(cancels.map(({ sessionId, failure }) => `${sessionId}:${String(kindOf(failure))}`).toSorted()).toEqual(
        order === "transcript first" ? ["S:overload", "T:rate_limit"] : ["S:overload", "T:transient"],
      )
    }
  })

  test("a transcript sign cancels its session at once with the failure it classifies, and its later log line changes nothing", () => {
    const { watch, cancels, advance } = watched()
    watch.open("S")
    watch.open("T")
    watch.observe(transcript("S", TRANSCRIPT_429))
    watch.observe(log(LOG_429))
    advance(ATTRIBUTION_WAIT_MS * 2)
    expect(cancels.map(({ sessionId, at }) => ({ sessionId, at }))).toEqual([{ sessionId: "S", at: 0 }])
    expect(kindOf(cancels[0]?.failure)).toBe("rate_limit")
  })

  test("a log line with one open prompt cancels that prompt at once with the failure it classifies", () => {
    const { watch, cancels } = watched()
    watch.open("S")
    watch.observe(log(LOG_503))
    expect(cancels.map(({ sessionId, at }) => ({ sessionId, at }))).toEqual([{ sessionId: "S", at: 0 }])
    expect(kindOf(cancels[0]?.failure)).toBe("overload")
    // The transcript step of the same attempt, read later, cancels nothing more.
    watch.observe(transcript("S", TRANSCRIPT_503))
    expect(cancels).toHaveLength(1)
  })

  test("a log line with several open prompts waits for the transcript sign that names one, and only that one is cancelled", () => {
    const { watch, cancels, advance, pendingTimers } = watched()
    watch.open("S")
    watch.open("T")
    watch.observe(log(LOG_503))
    advance(ATTRIBUTION_WAIT_MS / 2)
    expect(cancels).toEqual([])
    watch.observe(transcript("T", TRANSCRIPT_503))
    advance(ATTRIBUTION_WAIT_MS * 2)
    expect(cancels.map(({ sessionId }) => sessionId)).toEqual(["T"])
    expect(pendingTimers()).toBe(0)
  })

  test("a log line that no transcript sign names within the wait cancels every prompt that was open, with a transient failure", () => {
    const { watch, cancels, advance } = watched()
    watch.open("S")
    watch.open("T")
    watch.observe(log(LOG_429))
    // A prompt opened after the failure cannot have failed.
    watch.open("U")
    advance(ATTRIBUTION_WAIT_MS - 1)
    expect(cancels).toEqual([])
    advance(1)
    expect(cancels.map(({ sessionId, at }) => ({ sessionId, at }))).toEqual([{ sessionId: "S", at: ATTRIBUTION_WAIT_MS }, { sessionId: "T", at: ATTRIBUTION_WAIT_MS }])
    expect(cancels.map(({ failure }) => kindOf(failure))).toEqual(["transient", "transient"])
  })

  test("a transcript sign whose log line never comes does not absorb a later attempt's log line", () => {
    const { watch, cancels, advance } = watched()
    watch.open("S")
    watch.open("T")
    watch.observe(transcript("S", TRANSCRIPT_503))
    advance(ATTRIBUTION_WAIT_MS)
    watch.open("S")
    watch.observe(log(LOG_503))
    advance(ATTRIBUTION_WAIT_MS)
    expect(cancels.map(({ sessionId, at }) => `${sessionId}@${String(at)}`).toSorted()).toEqual(["S@0", `S@${String(ATTRIBUTION_WAIT_MS * 2)}`, `T@${String(ATTRIBUTION_WAIT_MS * 2)}`])
  })

  test("signs of a prompt that settled, and a log line with no open prompt, cancel nothing", () => {
    const { watch, cancels, advance } = watched()
    watch.open("S")
    watch.settle("S")
    watch.observe(transcript("S", TRANSCRIPT_503))
    watch.observe(log(LOG_503))
    advance(ATTRIBUTION_WAIT_MS * 2)
    expect(cancels).toEqual([])
  })
})
