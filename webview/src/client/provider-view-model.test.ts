import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { RuntimeAuthStatusSnapshotResult } from "../../../src/protocol/auth-status-protocol-types.js"
import { subscriptionSpendAccountCorrelationId } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { buildProviderViewState, createProviderConsentMutation } from "./provider-view-model.js"

const profileId = "profile"
const firstAccountId = subscriptionSpendAccountCorrelationId(profileId, "supergrok", "first")
const secondAccountId = subscriptionSpendAccountCorrelationId(profileId, "chatgpt", "second")

function snapshot(): RuntimeAuthStatusSnapshotResult {
  return {
    snapshotPosition: 12,
    auth: {
      warnings: [],
      profile: { id: profileId, displayName: "Personal", source: "default", availableProfiles: [] },
      settlement: { kind: "completed", operationId: "oauth-op", providerId: "supergrok" },
      providers: [
        {
          providerId: "supergrok", kind: "subscription", source: "oauth", expired: false, configured: true, modelCapable: true, loginMethod: "device-code", statusRank: 1, group: "model", displayName: "SuperGrok",
          accounts: [{ instanceId: "first", accountCorrelationId: firstAccountId, identity: "person@example.com", displayLabel: "Personal", expired: false, source: "oauth" }],
        },
        {
          providerId: "chatgpt", kind: "subscription", source: "oauth", expired: false, configured: true, modelCapable: true, loginMethod: "browser-auth", statusRank: 2, group: "model", displayName: "ChatGPT",
          accounts: [{ instanceId: "second", accountCorrelationId: secondAccountId, identity: "person@example.com", displayLabel: "Work", expired: false, source: "oauth" }],
        },
      ],
      subscriptionSpendConsent: {
        kind: "available", profileId, usageGeneration: 9, authorityIncarnation: "authority", authorityRevision: 4,
        accounts: [
          {
            accountCorrelationId: firstAccountId, providerId: "supergrok", providerDisplayName: "SuperGrok", providerStatus: "ok", billingUrl: "https://example.com/billing", modes: [
              { mode: "prepaid", envelopeId: "first-prepaid", evidence: { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } }, decision: "unreviewed" },
              { mode: "automatic", envelopeId: "first-automatic", evidence: { kind: "automatic-billing", enablement: "disabled" }, decision: "accepted" },
            ],
          },
          {
            accountCorrelationId: secondAccountId, providerId: "chatgpt", providerDisplayName: "ChatGPT", providerStatus: "warning", modes: [
              { mode: "prepaid", envelopeId: "second-prepaid", evidence: { kind: "prepaid", availability: "empty" }, decision: "unreviewed" },
              { mode: "automatic", envelopeId: "second-automatic", evidence: { kind: "automatic-billing", enablement: "enabled" }, decision: "unreviewed" },
            ],
          },
        ],
      },
    },
  }
}

describe("provider view model", () => {
  test("shows evidence without preventing edits to any supported paid mode", () => {
    const state = buildProviderViewState(snapshot().auth)

    assert.equal(state.pendingCount, 2)
    assert.equal(state.profileName, "Personal")
    assert.deepEqual(state.providers.map((provider) => provider.name), ["SuperGrok", "ChatGPT"])
    assert.deepEqual(state.providers[0]?.accounts[0]?.modes.map((mode) => [mode.label, mode.status, mode.checked]), [
      ["Prepaid", "Funded", false],
      ["Automatic billing", "Provider billing: off", true],
    ])
    assert.deepEqual(state.providers[1]?.accounts[0]?.modes.map((mode) => mode.status), ["Balance: empty", "Provider billing: on"])
    assert.deepEqual(state.providers[0]?.accounts[0]?.modes[0]?.details, ["Remaining 12.5 USD"])
    assert.deepEqual(state.providers.flatMap((provider) => provider.accounts.flatMap((account) => account.modes.map((mode) => mode.pending))), [true, false, false, true])
    const current = snapshot().auth
    if (current.subscriptionSpendConsent.kind !== "available") throw new Error("expected available consent")
    const withoutPositiveEvidence = { ...current, subscriptionSpendConsent: {
      ...current.subscriptionSpendConsent,
      accounts: current.subscriptionSpendConsent.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => ({
        ...mode,
        decision: "unreviewed" as const,
        evidence: mode.mode === "prepaid" ? { kind: "prepaid" as const, availability: "unknown" as const } : { kind: "automatic-billing" as const, enablement: "disabled" as const },
      })) })),
    } }
    assert.equal(buildProviderViewState(withoutPositiveEvidence).pendingCount, 0)
  })

  test("names each account's plan, states what a provider or account needs, offers Log in again for a refused login, offers Rename only where the account takes a label, and says what Disconnect does", () => {
    const current = snapshot()
    const claudeAccount = subscriptionSpendAccountCorrelationId(profileId, "claude_agent_sdk", "uuid-person")
    const refused = "Claude refused the login of person@example.com in this profile. Log in again."
    const providerProblem = "Stored authentication data is malformed."
    const auth = { ...current.auth, providers: [...current.auth.providers, {
      providerId: "claude_agent_sdk", kind: "subscription" as const, source: "oauth" as const, expired: false, configured: true, modelCapable: true, loginMethod: "browser-auth" as const, loginProgram: "Claude", statusRank: 3, group: "model" as const, displayName: "Anthropic Subscription",
      attention: { kind: "malformed" as const, message: providerProblem },
      accounts: [{ instanceId: "uuid-person", accountCorrelationId: claudeAccount, identity: "person@example.com", displayLabel: "person@example.com", plan: "Claude Max", expired: true, source: "oauth" as const, attention: { kind: "login-rejected" as const, message: refused } }],
    }] }

    const claude = buildProviderViewState(auth).providers.find((provider) => provider.id === "claude_agent_sdk")
    assert.equal(claude?.problem, providerProblem)
    assert.equal(claude?.status, "Needs attention")
    assert.deepEqual(claude?.accounts.map(({ label, status, problem, repair, renamable }) => ({ label, status, problem, repair, renamable })), [
      { label: "person@example.com · Claude Max", status: "Needs attention", problem: refused, repair: "Log in again", renamable: false },
    ])
    // A login that Flywheel stores takes a label; an external login names each account by its email and takes none.
    assert.equal(buildProviderViewState(auth).providers.find((provider) => provider.id === "supergrok")?.accounts[0]?.renamable, true)
    // Disconnect of a login that a program owns logs the account out of that program, for every app that shares the
    // login; Disconnect of a credential that Flywheel stores removes it from the profile.
    assert.equal(claude?.accounts[0]?.disconnectDetail, "This logs person@example.com out of this Flywheel profile. Claude and other apps keep their own logins. Log in again to reconnect.")
    assert.equal(claude?.disconnectDetail, "This logs every account out of this Flywheel profile. Claude and other apps keep their own logins. Log in again to reconnect.")
    const supergrok = buildProviderViewState(auth).providers.find((provider) => provider.id === "supergrok")
    assert.equal(supergrok?.disconnectDetail, "Its stored credential is removed from this profile. Sign in again to reconnect.")
    assert.equal(supergrok?.accounts[0]?.disconnectDetail, "Its stored credential is removed from this profile. Sign in again to reconnect.")
    // An account whose credential only expired offers Reconnect, and a healthy account offers no repair.
    const expired = { ...auth, providers: auth.providers.map((provider) => provider.providerId === "chatgpt" ? { ...provider, accounts: provider.accounts.map((account) => ({ ...account, expired: true })) } : provider) }
    assert.equal(buildProviderViewState(expired).providers.find((provider) => provider.id === "chatgpt")?.accounts[0]?.repair, "Reconnect")
    assert.equal(buildProviderViewState(auth).providers.find((provider) => provider.id === "supergrok")?.accounts[0]?.repair, undefined)
  })

  test("says what the terminal says about a login: a catalog that the provider refused, or a provider that cannot serve, needs attention", () => {
    const current = snapshot()
    const claudeAccount = subscriptionSpendAccountCorrelationId(profileId, "claude_agent_sdk", "uuid-person")
    const providerProblem = "Stored authentication data is malformed."
    const refusedCatalog = { kind: "unavailable" as const, reason: "authentication-invalid" as const }
    const auth = { ...current.auth, providers: [...current.auth.providers.map((provider) => provider.providerId === "supergrok" ? { ...provider, catalog: refusedCatalog } : provider), {
      providerId: "claude_agent_sdk", kind: "subscription" as const, source: "oauth" as const, expired: false, configured: true, modelCapable: true, loginMethod: "browser-auth" as const, loginProgram: "Claude", statusRank: 3, group: "model" as const, displayName: "Anthropic Subscription",
      attention: { kind: "malformed" as const, message: providerProblem },
      accounts: [{ instanceId: "uuid-person", accountCorrelationId: claudeAccount, identity: "person@example.com", displayLabel: "person@example.com", expired: false, source: "oauth" as const, catalog: refusedCatalog }],
    }] }

    const providers = buildProviderViewState(auth).providers
    assert.equal(providers.find((provider) => provider.id === "supergrok")?.status, "Needs attention")
    assert.deepEqual(providers.find((provider) => provider.id === "claude_agent_sdk")?.accounts.map(({ status, problem }) => ({ status, problem })), [{ status: "Needs attention", problem: undefined }])
  })

  test("builds a generation-bound decision for one tick and preserves other modes", () => {
    const current = snapshot()
    const mutation = createProviderConsentMutation(current, "supergrok", firstAccountId, "first-prepaid", true)

    assert.deepEqual(mutation, {
      type: "subscription_spend_consent.save",
      profileId,
      usageGeneration: 9,
      authorityIncarnation: "authority",
      authorityRevision: 4,
      clientSnapshotPosition: 12,
      envelopeIds: ["first-prepaid", "first-automatic", "second-prepaid", "second-automatic"],
      reviewedEnvelopeIds: ["first-prepaid"],
      acceptedEnvelopeIds: ["first-prepaid"],
    })
    assert.deepEqual(createProviderConsentMutation(current, "supergrok", firstAccountId, "first-automatic", false), {
      ...mutation, reviewedEnvelopeIds: ["first-automatic"], acceptedEnvelopeIds: [],
    })
    assert.deepEqual(createProviderConsentMutation(current, "chatgpt", secondAccountId, "second-prepaid", true), {
      ...mutation, reviewedEnvelopeIds: ["second-prepaid"], acceptedEnvelopeIds: ["second-prepaid"],
    })
  })

  test("counts nothing pending and writes nothing for an account that is not shown", () => {
    const current = snapshot()
    const hidden = { ...current.auth, providers: [] }
    assert.equal(buildProviderViewState(hidden).pendingCount, 0)
    assert.equal(createProviderConsentMutation({ ...current, auth: hidden }, "supergrok", firstAccountId, "first-prepaid", true), undefined)
    const replaced = { ...current.auth, providers: current.auth.providers.map((provider) => provider.providerId === "supergrok" ? { ...provider, accounts: [{ ...provider.accounts[0]!, instanceId: "replacement", accountCorrelationId: subscriptionSpendAccountCorrelationId(profileId, "supergrok", "replacement") }] } : provider) }
    assert.equal(buildProviderViewState(replaced).pendingCount, 1)
    assert.equal(createProviderConsentMutation({ ...current, auth: replaced }, "supergrok", firstAccountId, "first-prepaid", true), undefined)
  })
})
