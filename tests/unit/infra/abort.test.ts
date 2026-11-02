import { describe, expect, test } from "bun:test"

import { isAbortError } from "../../../src/infra/abort.js"

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
