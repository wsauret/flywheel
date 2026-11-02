import { describe, expect, it } from "bun:test"
import { sessionLoadFailure } from "../../../../src/tui/hooks/session-load-failure"

describe("sessionLoadFailure", () => {
  it("does not report a missing session while the foreground has a catalog row", () => {
    expect(sessionLoadFailure({
      foregroundId: "catalog-backed",
      hasCatalogRow: (id) => id === "catalog-backed",
      loaded: { id: "catalog-backed", view: null },
    })).toBe("")
  })

  it("ignores stale detail loads for an older foreground id", () => {
    expect(sessionLoadFailure({
      foregroundId: "current",
      hasCatalogRow: () => false,
      loaded: { id: "previous", view: null },
    })).toBe("")
  })

  it("passes through load errors when the foreground is not catalog-backed", () => {
    expect(sessionLoadFailure({
      foregroundId: "broken",
      hasCatalogRow: () => false,
      loaded: { id: "broken", view: null, loadError: "detail read failed" },
    })).toBe("detail read failed")
  })
})
