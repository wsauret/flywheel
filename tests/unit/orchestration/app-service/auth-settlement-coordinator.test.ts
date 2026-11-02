import { describe, expect, test } from "bun:test"

import type { AuthOperationNotice, AuthOperationSettlement, RuntimeAuthStatusScope } from "../../../../src/protocol/auth-status-protocol-types.js"
import { createAuthSettlementCoordinator } from "../../../../src/orchestration/app-service/auth-settlement-coordinator.js"

const settlement: AuthOperationSettlement = { kind: "completed", operationId: "op-1", providerId: "openai" }

describe("auth settlement coordinator", () => {
  test("publishes one settlement to the scopes the profile backs in one call", async () => {
    const scopeReads: string[] = []
    const published: { scopes: readonly RuntimeAuthStatusScope[]; settlement: AuthOperationNotice }[] = []
    const coordinator = createAuthSettlementCoordinator({
      refreshConfig: async () => {},
      refreshProfile: async () => {},
      profileScopes: async (profileId) => {
        scopeReads.push(profileId)
        return [{ kind: "defaults" }, { kind: "session", sessionId: "s1" }]
      },
      publish: async (scopes, published_settlement) => { published.push({ scopes, settlement: published_settlement }) },
    })

    await coordinator.publish("profile-a", settlement)

    expect(scopeReads).toEqual(["profile-a"])
    expect(published).toEqual([{ scopes: [{ kind: "defaults" }, { kind: "session", sessionId: "s1" }], settlement }])
  })

  test("settle supersedes the previous in-flight settlement of the same profile", async () => {
    const aborted: string[] = []
    let release: (() => void) | undefined
    const coordinator = createAuthSettlementCoordinator({
      refreshConfig: async () => {},
      refreshProfile: (profileId, signal) => new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => { aborted.push(profileId); resolve() }, { once: true })
        release = resolve
      }),
      profileScopes: async () => [],
      publish: async () => {},
    })

    const first = coordinator.settle("profile-a", "op-1")
    await Promise.resolve()
    const second = coordinator.settle("profile-a", "op-2")
    await first
    expect(aborted).toEqual(["profile-a"])
    release?.()
    await second
  })
})
