import { describe, expect, test } from "bun:test"

import { mutationExposure, queryExposure } from "../../../../src/protocol/client/editor-protocol-coverage.js"

// The real assertion is the typecheck: an unclassified union member fails to
// compile. These runs only keep the module a live import so the classification
// tables cannot rot as dead code.
describe("editor protocol coverage", () => {
  test("classifies the mutations the editor dispatches with their payloads", () => {
    expect(mutationExposure({ type: "session.send", sessionId: "session", input: "hello" })).toBe("exposed")
    expect(mutationExposure({ type: "usage.open", scope: { kind: "defaults" } })).toBe("exposed")
    expect(mutationExposure({ type: "usage.refresh", scope: { kind: "defaults" } })).toBe("exposed")
    expect(mutationExposure({ type: "subscription_spend_consent.save", profileId: "profile", usageGeneration: 3, authorityIncarnation: "authority", authorityRevision: 1, clientSnapshotPosition: 2, envelopeIds: ["mode"], reviewedEnvelopeIds: ["mode"], acceptedEnvelopeIds: ["mode"] })).toBe("exposed")
    expect(mutationExposure({ type: "provider_model.set", queriedProfileId: "profile", queriedEligibilityRevision: 2, target: { kind: "subscription", providerId: "chatgpt", accountCorrelationId: "opaque-account" }, modelId: "gpt", checked: true })).toBe("exposed")
    expect(mutationExposure({ type: "provider_models.recheck", queriedProfileId: "profile", queriedEligibilityRevision: 2, target: { kind: "subscription", providerId: "supergrok", accountCorrelationId: "opaque-account" } })).toBe("exposed")
  })

  test("classifies the queries the editor issues with their payloads", () => {
    expect(queryExposure({ type: "snapshot" })).toBe("exposed")
    expect(queryExposure({ type: "usage.accounts", scope: { kind: "defaults" } })).toBe("exposed")
    expect(queryExposure({ type: "usage.history", scope: { kind: "defaults" }, range: "7d" })).toBe("exposed")
    expect(queryExposure({ type: "provider_models.query", profileId: "profile", target: { kind: "singleton", providerId: "anthropic" } })).toBe("exposed")
  })
})
