import { describe, expect, test } from "bun:test"
import type { AuthProviderAccountStatus, AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import { subscriptionSpendAccountCorrelationId } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { buildAuthRows, buildProviderOptions, type AuthRow } from "../../../../src/tui/hooks/auth-modal-options.js"

/** The heading label, provider id, or account instance id a row shows. */
function rowKey(row: AuthRow): string {
  switch (row.kind) {
    case "heading": return row.label
    case "provider-group":
    case "provider": return row.option.id
    case "account": return row.account.instanceId
    default: return row.kind
  }
}

function status(providerId: AuthProviderStatus["providerId"], overrides: Partial<AuthProviderStatus> = {}): AuthProviderStatus {
  return {
    providerId,
    kind: "singleton",
    source: "unconfigured",
    expired: false,
    modelCapable: true,
    loginMethod: "api-key",
    statusRank: 10,
    group: "model",
    displayName: providerId,
    accounts: [],
    ...overrides,
  }
}

describe("auth modal options", () => {
  test("groups providers and orders each group by rank then display name", () => {
    const options = buildProviderOptions([
      status("google_api", { statusRank: 50, displayName: "Google" }),
      status("openai_api", { statusRank: 20, displayName: "OpenAI" }),
      status("anthropic_api", { statusRank: 20, displayName: "Anthropic" }),
      status("exa", { group: "web", modelCapable: false, displayName: "Exa", statusRank: 0 }),
    ])

    expect(options.map((option) => option.id)).toEqual(["anthropic_api", "openai_api", "google_api", "exa"])
    expect(buildAuthRows(options).map(rowKey)).toEqual([
      "Model Providers", "anthropic_api", "openai_api", "google_api", "Web Search", "exa",
    ])
  })

  test("keeps multiple accounts nested under one provider row", () => {
    const accounts: readonly AuthProviderAccountStatus[] = [
      { instanceId: "one", accountCorrelationId: "opaque-one", identity: "one@example.com", displayLabel: "one@example.com", expired: false, source: "oauth" },
      { instanceId: "two", accountCorrelationId: "opaque-two", identity: "two@example.com", displayLabel: "two@example.com", expired: false, source: "oauth" },
    ]
    const options = buildProviderOptions([status("chatgpt", { kind: "subscription", loginMethod: "browser-auth", statusRank: 60, displayName: "ChatGPT", accounts })])

    expect(buildAuthRows(options).map(rowKey)).toEqual([
      "Model Providers", "chatgpt", "one", "two",
    ])
    expect(buildAuthRows(options)[1]).toMatchObject({ kind: "provider-group", option: { id: "chatgpt" } })
  })

  test("joins subscription capability by provider and opaque account correlation", () => {
    const accounts: readonly AuthProviderAccountStatus[] = [
      { instanceId: "one", accountCorrelationId: subscriptionSpendAccountCorrelationId("default", "chatgpt", "one"), identity: "one@example.com", displayLabel: "one@example.com", expired: false, source: "oauth" },
    ]
    const consent = {
      kind: "available" as const,
      profileId: "default",
      usageGeneration: 4,
      authorityIncarnation: "authority",
      authorityRevision: 2,
      accounts: [{
        accountCorrelationId: subscriptionSpendAccountCorrelationId("default", "chatgpt", "one"),
        providerId: "chatgpt",
        providerDisplayName: "ChatGPT",
        providerStatus: "ok" as const,
        modes: [],
      }],
    }

    const [option] = buildProviderOptions([status("chatgpt", { kind: "subscription", accounts })], consent)
    expect(option?.capabilityAccounts).toHaveLength(1)
    expect(buildAuthRows([option!], undefined, "New Session Defaults", false, consent)[1]).toMatchObject({ kind: "provider", capabilityAccount: consent.accounts[0] })
  })
})
