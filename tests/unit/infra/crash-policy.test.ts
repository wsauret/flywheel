import { describe, expect, test } from "bun:test"

import { exitAfter, makeCrashPolicy, type UncaughtKind } from "../../../src/infra/crash-policy.js"

interface LogRecord {
  readonly level: "warn" | "error"
  readonly message: string
  readonly fields: { readonly [key: string]: unknown }
}

function recordingLog() {
  const records: LogRecord[] = []
  return {
    records,
    log: {
      warn: (message: unknown, fields: { readonly [key: string]: unknown } = {}) => { records.push({ level: "warn", message: String(message), fields }) },
      error: (message: unknown, fields: { readonly [key: string]: unknown } = {}) => { records.push({ level: "error", message: String(message), fields }) },
    },
  }
}

/** A policy whose fatal function and immediate exit only record their calls.
 *  The fatal function never settles unless a case says so, as a real one
 *  that ends its process never returns. */
function recordedPolicy(options: { readonly fatal?: (failure: unknown, kind: UncaughtKind) => Promise<void> } = {}) {
  const { log, records } = recordingLog()
  const fatals: { readonly error: unknown; readonly kind: UncaughtKind }[] = []
  let exits = 0
  const policy = makeCrashPolicy({
    role: "project-executor",
    log,
    fatal: (failure, kind) => {
      fatals.push({ error: failure, kind })
      return options.fatal?.(failure, kind) ?? new Promise<void>(() => {})
    },
    exitNow: () => { exits += 1 },
    repeatWindowMs: 5,
  })
  return { policy, records, fatals, exits: () => exits }
}

/** An abort reason as a withdrawn operation rejects with it. Every reason it
 *  makes comes from the same place, so they are one condition. */
function abortReason(): Error {
  const controller = new AbortController()
  controller.abort()
  const reason: unknown = controller.signal.reason
  if (!(reason instanceof Error)) throw new Error("an abort reason is an Error on Bun")
  return reason
}

describe("makeCrashPolicy", () => {
  test("contains a floating abort with one WARN, and counts its repeats once when the window ends", async () => {
    const { policy, records, fatals, exits } = recordedPolicy()

    policy.unhandledRejection(abortReason())
    policy.unhandledRejection(abortReason())

    expect(fatals).toEqual([])
    expect(exits()).toBe(0)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: "warn", message: "project-executor abort rejection contained" })
    expect(records[0]?.fields.errorDetail).toMatchObject({ name: "AbortError" })

    await Bun.sleep(25)
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ level: "warn", message: "project-executor abort rejection contained again", fields: { count: 1 } })
  })

  test("records an abort of another condition in full", () => {
    const { policy, records } = recordedPolicy()

    policy.unhandledRejection(abortReason())
    policy.unhandledRejection(new DOMException("Maintenance job withdrawn", "AbortError"))

    expect(records.map((record) => record.fields.error)).toEqual(["The operation was aborted.", "Maintenance job withdrawn"])
  })

  test("reports the count of contained repeats before a fatal failure ends the process", () => {
    const { policy, records, fatals } = recordedPolicy()

    policy.unhandledRejection(abortReason())
    policy.unhandledRejection(abortReason())
    policy.unhandledRejection(new Error("request lost"))

    expect(records.map((record) => record.fields.count)).toEqual([undefined, 1])
    expect(fatals).toHaveLength(1)
  })

  test("gives a TimeoutError and a plain Error rejection to the fatal function", () => {
    for (const reason of [new DOMException("The operation timed out.", "TimeoutError"), new Error("request lost")]) {
      const { policy, fatals, records } = recordedPolicy()
      policy.unhandledRejection(reason)
      expect(fatals).toEqual([{ error: reason, kind: "unhandled rejection" }])
      expect(records).toEqual([])
    }
  })

  test("gives every uncaught exception to the fatal function, an abort-named one too", () => {
    const { policy, fatals } = recordedPolicy()
    const reason = abortReason()

    policy.uncaughtException(reason)

    expect(fatals).toEqual([{ error: reason, kind: "uncaught exception" }])
  })

  test("a second fatal failure while the fatal function runs ends the process without it", () => {
    const { policy, fatals, exits } = recordedPolicy()

    policy.uncaughtException(new Error("corrupt state"))
    policy.unhandledRejection(new Error("request lost"))

    expect(fatals).toHaveLength(1)
    expect(exits()).toBe(1)
  })

  test("a fatal function that fails ends the process without it", async () => {
    const { policy, exits } = recordedPolicy({ fatal: async () => { throw new Error("record failed") } })

    policy.unhandledRejection(new Error("request lost"))
    await Bun.sleep(0)

    expect(exits()).toBe(1)
  })
})

describe("exitAfter", () => {
  test("exits once its step settles", async () => {
    const { log, records } = recordingLog()
    const order: string[] = []
    let finish = (): void => {}
    const step = new Promise<void>((resolve) => { finish = resolve })

    const exited = exitAfter({ log, settle: () => step, boundMs: 1_000, exit: () => { order.push("exit") } })
    await Bun.sleep(0)
    order.push("settled")
    finish()
    await exited

    expect(order).toEqual(["settled", "exit"])
    expect(records).toEqual([])
  })

  test("exits at its bound, with one WARN, when its step never settles", async () => {
    const { log, records } = recordingLog()
    let exits = 0

    await exitAfter({ log, settle: () => new Promise<void>(() => {}), boundMs: 5, exit: () => { exits += 1 } })

    expect(exits).toBe(1)
    expect(records).toEqual([expect.objectContaining({ level: "warn", fields: { boundMs: 5 } })])
  })

  test("exits with one WARN when its step fails", async () => {
    const { log, records } = recordingLog()
    let exits = 0

    await exitAfter({ log, settle: async () => { throw new Error("writer lane closed") }, boundMs: 1_000, exit: () => { exits += 1 } })

    expect(exits).toBe(1)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ level: "warn", fields: { error: "writer lane closed" } })
  })
})
