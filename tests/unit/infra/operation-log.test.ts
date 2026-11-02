import { describe, expect, it } from "bun:test"
import { InvariantViolation } from "../../../src/infra/invariant.js"
import { logCompletion, loggedOperation, loggedSyncOperation, recordBackgroundFailure, type OperationLogger } from "../../../src/infra/operation-log.js"

type LogFields = { [key: string]: unknown } | undefined

interface LogCall {
  readonly level: "debug" | "info" | "warn" | "error"
  readonly message: unknown
  readonly extra: LogFields
}

function recordingLogger() {
  const calls: LogCall[] = []
  return {
    calls,
    log: {
      debug: (message?: unknown, extra?: LogFields) => { calls.push({ level: "debug", message, extra }) },
      info: (message?: unknown, extra?: LogFields) => { calls.push({ level: "info", message, extra }) },
      warn: (message?: unknown, extra?: LogFields) => { calls.push({ level: "warn", message, extra }) },
      error: (message?: unknown, extra?: LogFields) => { calls.push({ level: "error", message, extra }) },
    } satisfies OperationLogger,
  }
}

describe("operation log", () => {
  it("logs async operation start and summarized completion", async () => {
    const { calls, log } = recordingLogger()

    const result = await loggedOperation(
      { log, operation: "hydrate range", fields: { sessionId: "s1" }, summarize: (value: readonly string[]) => ({ rows: value.length }) },
      async () => ["a", "b"],
    )

    expect(result).toEqual(["a", "b"])
    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "hydrate range start"],
      ["info", "hydrate range done"],
    ])
    expect(calls[1]?.extra).toMatchObject({ sessionId: "s1", rows: 2 })
    expect(typeof calls[1]?.extra?.durationMs).toBe("number")
  })

  it("logs sync operation failures with structured error detail", () => {
    const { calls, log } = recordingLogger()
    const cause = new Error("inner")
    const failure = new Error("outer", { cause })

    expect(() => loggedSyncOperation({ log, operation: "read rows", fields: { aggregateId: "a1" } }, () => {
      throw failure
    })).toThrow("outer")

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "read rows start"],
      ["error", "read rows failed"],
    ])
    // The rendered message carries the cause; the detail keeps it structured too.
    expect(calls[1]?.extra).toMatchObject({
      aggregateId: "a1",
      error: "outer: inner",
      errorDetail: { kind: "error", message: "outer: inner", cause: { kind: "error", message: "inner" } },
    })
  })

  it("records an aborted operation as interrupted at its completion level, not as a failure", async () => {
    const { calls, log } = recordingLogger()
    const abort = new DOMException("Owner closed", "AbortError")

    await expect(loggedOperation({ log, operation: "send turn", fields: { sessions: 2 } }, async () => {
      throw abort
    })).rejects.toBe(abort)
    await expect(loggedOperation({ log, operation: "read summary", level: "debug" }, async () => {
      throw abort
    })).rejects.toBe(abort)

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "send turn start"],
      ["info", "send turn interrupted"],
      ["debug", "read summary start"],
      ["debug", "read summary interrupted"],
    ])
    expect(calls[1]?.extra).toMatchObject({ sessions: 2, error: "Owner closed" })
  })

  it("records a failure at the failure level its caller states", async () => {
    const { calls, log } = recordingLogger()

    await expect(loggedOperation({ log, operation: "read summary", failureLevel: "warn" }, async () => {
      throw new Error("index unavailable")
    })).rejects.toThrow("index unavailable")

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "read summary start"],
      ["warn", "read summary failed"],
    ])
    expect(calls[1]?.extra).toMatchObject({ error: "index unavailable", errorDetail: { kind: "error", message: "index unavailable" } })
  })

  it("records a background failure at WARN, an invariant violation at ERROR, and an abort at DEBUG", () => {
    const { calls, log } = recordingLogger()
    const violation = new InvariantViolation({ kind: "schema-mismatch", eventType: "session.duration.recorded", eventPosition: 7, aggregateId: "session:s1", detail: "payload does not parse" })

    recordBackgroundFailure(log, "record session duration", { sessionId: "s1" }, new Error("generation closed"))
    recordBackgroundFailure(log, "record session duration", { sessionId: "s1" }, violation)
    recordBackgroundFailure(log, "record session duration", { sessionId: "s1" }, new DOMException("Owner closed", "AbortError"))

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["warn", "record session duration failed"],
      ["error", "record session duration failed"],
      ["debug", "record session duration interrupted"],
    ])
    expect(calls[0]?.extra).toMatchObject({ sessionId: "s1", error: "generation closed", errorDetail: { kind: "error", message: "generation closed" } })
  })

  it("puts the completion record at debug for a hot-path operation", () => {
    const { calls, log } = recordingLogger()

    loggedSyncOperation({ log, operation: "list catalog", level: "debug" }, () => 7)

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "list catalog start"],
      ["debug", "list catalog done"],
    ])
  })

  it("records a completion under its slow threshold at debug and one past it at info", () => {
    const { calls, log } = recordingLogger()

    loggedSyncOperation({ log, operation: "flush", slowMs: 60_000 }, () => 1)
    loggedSyncOperation({ log, operation: "flush", slowMs: 0 }, () => 1)

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "flush start"],
      ["debug", "flush done"],
      ["debug", "flush start"],
      ["info", "flush done"],
    ])
    expect(calls[1]?.extra).not.toHaveProperty("slowMs")
    expect(calls[3]?.extra).toMatchObject({ slowMs: 0 })
  })

  it("records a slow operation's failure at error whatever its threshold", () => {
    const { calls, log } = recordingLogger()

    expect(() => loggedSyncOperation({ log, operation: "flush", slowMs: 60_000 }, () => { throw new Error("disk full") })).toThrow("disk full")

    expect(calls.map((call) => [call.level, call.message])).toEqual([
      ["debug", "flush start"],
      ["error", "flush failed"],
    ])
  })

  it("records one completion with its duration and names the threshold only when slow", () => {
    const { calls, log } = recordingLogger()

    logCompletion(log, "tool execution done", { tool: "bash" }, { durationMs: 12, slowMs: 60_000 })
    logCompletion(log, "tool execution done", { tool: "bash" }, { durationMs: 61_000, slowMs: 60_000 })

    expect(calls).toEqual([
      { level: "debug", message: "tool execution done", extra: { tool: "bash", durationMs: 12 } },
      { level: "info", message: "tool execution done", extra: { tool: "bash", durationMs: 61_000, slowMs: 60_000 } },
    ])
  })
})
