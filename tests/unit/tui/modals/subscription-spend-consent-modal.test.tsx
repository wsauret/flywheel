import { describe, expect, it } from "bun:test"
import { paidUseQuestionFooterRows, paidUseQuestionLines, subscriptionSpendFooterRows } from "../../../../src/tui/modals/subscription-spend-consent-modal.js"
import { paidUseEvidence } from "../../../../src/protocol/client/provider-account-copy.js"

describe("subscription spend consent presentation", () => {
  it("presents provider evidence and inactive account controls", () => {
    expect(paidUseEvidence({ kind: "automatic-billing", enablement: "enabled" }).status).toBe("Provider billing: on")
    expect(paidUseEvidence({ kind: "prepaid", availability: "empty" }).status).toBe("Balance: empty")
    expect(subscriptionSpendFooterRows(undefined, true)).toEqual(["b billing · r reconnect · d disconnect · ← back"])
    expect(subscriptionSpendFooterRows(undefined, false)).toEqual(["r reconnect · d disconnect · ← back"])
  })

  it("uses billing controls only while a consent checkbox is focused", () => {
    expect(subscriptionSpendFooterRows({ cursor: 0 }, true)).toEqual([
      "↑↓ choose · space/enter toggle · b billing",
      "r reconnect · d disconnect · ← back",
    ])
    expect(subscriptionSpendFooterRows({ cursor: 0 }, false)).toEqual([
      "↑↓ choose · space/enter toggle",
      "r reconnect · d disconnect · ← back",
    ])
  })

  it("explains the paid-use question and never offers to exit", () => {
    const capability = {
      accountCorrelationId: "opaque", providerId: "github_copilot", providerDisplayName: "GitHub", providerStatus: "ok" as const,
      modes: [
        { mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "unknown" as const }, decision: "unreviewed" as const },
        { mode: "automatic" as const, envelopeId: "automatic", evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "unreviewed" as const },
      ],
    }
    expect(paidUseQuestionLines("Copilot Subscription", "alice", capability)).toEqual([
      "Copilot Subscription is connected as alice.",
      "GitHub reports that this account can also pay for use beyond its plan: automatic billing.",
      "Flywheel keeps paid use off until you allow it here. Modes you leave unticked stay off.",
    ])
    expect(paidUseQuestionFooterRows(true)).toEqual(["↑↓ choose · space toggle · enter continue", "esc continue · b billing"])
    expect(paidUseQuestionFooterRows(false).join(" ")).not.toContain("exit")
  })

})