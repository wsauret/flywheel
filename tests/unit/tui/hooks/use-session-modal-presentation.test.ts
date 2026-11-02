import { describe, expect, it } from "bun:test"
import type { DurableSessionCatalogError } from "../../../../src/orchestration/session/session-catalog-types.js"
import { sessionDetailWarning } from "../../../../src/tui/hooks/use-session-modal.js"

function listError(scope: DurableSessionCatalogError["scope"]): DurableSessionCatalogError {
  return { sessionId: "session-1", scope, reason: "bad event" }
}

describe("sessionDetailWarning", () => {
  it("returns empty when the opened session has no enrichment errors", () => {
    expect(sessionDetailWarning([listError("budget")], "other-session")).toBe("")
  })

  it("complains once for the opened session without leaking scope names", () => {
    expect(sessionDetailWarning([
      listError("budget"),
      listError("budget"),
      listError("metadata"),
    ], "session-1")).toBe("Some details for this session couldn't be loaded")
  })
})

