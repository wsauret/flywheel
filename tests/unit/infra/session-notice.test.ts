import { describe, expect, test } from "bun:test"
import { applySessionNoticeOperation, type SessionNotice } from "../../../src/infra/session-notice.js"

function notice(id: string, scope: string): SessionNotice {
  return {
    id,
    scope,
    presentation: "provider.quota_rollover",
    severity: "warning",
    title: "Quota exhausted",
    message: "Sending this request elsewhere.",
    startedAt: 1_000,
    updatedAt: 1_000,
  }
}

describe("applySessionNoticeOperation", () => {
  test("resolve drops the named notice", () => {
    const current = [notice("a", "scope-a"), notice("b", "scope-b")]
    expect(applySessionNoticeOperation(current, { type: "resolve", id: "a" })).toEqual([notice("b", "scope-b")])
  })

  test("resolve-scope drops every notice in the scope", () => {
    const current = [notice("a", "scope-a"), notice("a2", "scope-a"), notice("b", "scope-b")]
    expect(applySessionNoticeOperation(current, { type: "resolve-scope", scope: "scope-a" }))
      .toEqual([notice("b", "scope-b")])
  })

  test("resolve returns the same array when no notice matches", () => {
    const current: readonly SessionNotice[] = [notice("a", "scope-a")]
    expect(applySessionNoticeOperation(current, { type: "resolve", id: "b" })).toBe(current)
  })

  test("resolve-scope returns the same array when no notice is in the scope", () => {
    const current: readonly SessionNotice[] = [notice("a", "scope-a")]
    expect(applySessionNoticeOperation(current, { type: "resolve-scope", scope: "scope-b" })).toBe(current)
  })

})
