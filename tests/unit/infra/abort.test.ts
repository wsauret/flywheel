import { describe, expect, test } from "bun:test"

import { awaitWithAbortSignal, isAbortError } from "../../../src/infra/abort.js"

describe("isAbortError", () => {
  test("returns true for a DOMException named AbortError", () => {
    expect(isAbortError(new DOMException("Aborted", "AbortError"))).toBe(true)
  })

  test("returns true for an Error named AbortError", () => {
    const err = new Error("aborted")
    err.name = "AbortError"
    expect(isAbortError(err)).toBe(true)
  })

  test("returns false for an ordinary Error", () => {
    expect(isAbortError(new Error("boom"))).toBe(false)
  })

  test("returns false for a DOMException with a different name", () => {
    expect(isAbortError(new DOMException("nope", "TimeoutError"))).toBe(false)
  })

  test("returns false for non-error values", () => {
    expect(isAbortError("AbortError")).toBe(false)
    expect(isAbortError({ name: "AbortError" })).toBe(false)
    expect(isAbortError(null)).toBe(false)
    expect(isAbortError(undefined)).toBe(false)
  })
})

describe("awaitWithAbortSignal", () => {
  test("rejects with the reason of a signal that aborted before the call and still observes the abandoned operation", async () => {
    const controller = new AbortController()
    const reason = new DOMException("The caller left", "AbortError")
    controller.abort(reason)
    const operation = Promise.withResolvers<string>()
    const unhandled: unknown[] = []
    const record = (error: unknown) => { unhandled.push(error) }
    process.on("unhandledRejection", record)
    try {
      const waited = awaitWithAbortSignal(operation.promise, controller.signal)
      operation.reject(new Error("Query closed before response received"))

      expect(await waited.then(() => undefined, (error: unknown) => error)).toBe(reason)
      await Bun.sleep(0)
      expect(unhandled).toEqual([])
    } finally {
      process.off("unhandledRejection", record)
    }
  })
})
