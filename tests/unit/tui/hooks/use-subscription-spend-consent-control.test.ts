import { describe, expect, it, mock } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useSubscriptionSpendConsentControl } from "../../../../src/tui/hooks/use-subscription-spend-consent-control.js"
import type { SubscriptionSpendConsentMutation, SubscriptionSpendConsentMutationResult, SubscriptionSpendConsentView } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"

type AvailableConsent = Extract<SubscriptionSpendConsentView, { kind: "available" }>

const consent: AvailableConsent = {
  kind: "available",
  profileId: "work",
  usageGeneration: 1,
  authorityIncarnation: "authority-1",
  authorityRevision: 4,
  accounts: [
    { accountCorrelationId: "account-a", providerId: "chatgpt", providerDisplayName: "ChatGPT", providerStatus: "ok", modes: [
      { mode: "prepaid", envelopeId: "a-prepaid", evidence: { kind: "prepaid", availability: "funded" }, decision: "unreviewed" },
      { mode: "automatic", envelopeId: "a-automatic", evidence: { kind: "automatic-billing", enablement: "unknown" }, decision: "unreviewed" },
    ] },
    { accountCorrelationId: "account-b", providerId: "chatgpt", providerDisplayName: "ChatGPT", providerStatus: "ok", modes: [
      { mode: "prepaid", envelopeId: "b-prepaid", evidence: { kind: "prepaid", availability: "empty" }, decision: "accepted" },
      { mode: "automatic", envelopeId: "b-automatic", evidence: { kind: "automatic-billing", enablement: "enabled" }, decision: "accepted" },
    ] },
  ],
}

function harness(options: {
  dispatch?: (mutation: SubscriptionSpendConsentMutation) => Promise<SubscriptionSpendConsentMutationResult>
  refresh?: () => Promise<{ consent: SubscriptionSpendConsentView; snapshotPosition: number } | undefined>
} = {}) {
  const modal = createModalStack()
  const owner = modal.replace(() => "auth")
  const dispatch = mock(options.dispatch ?? (async (_mutation: SubscriptionSpendConsentMutation) => ({ kind: "committed" as const, consent })))
  const refresh = mock(options.refresh ?? (async () => ({ consent, snapshotPosition: 22 })))
  const onAnswered = mock((_consent: SubscriptionSpendConsentView, _snapshotPosition: number) => {})
  const onAnswerFailed = mock(() => {})
  const onDismissedTickFailed = mock((_feedback: string) => {})
  let control!: ReturnType<typeof useSubscriptionSpendConsentControl>
  const dispose = createRoot((cleanup) => {
    control = useSubscriptionSpendConsentControl({ dispatch, refresh, onAnswered, onAnswerFailed, onDismissedTickFailed, openBrowser: async () => true })
    return cleanup
  })
  return { control, dispatch, refresh, onAnswered, onAnswerFailed, onDismissedTickFailed, owner, modal, dispose }
}

describe("subscription spend consent account control", () => {
  it("binds the canonical envelope list and writes only reviewed modes for one account", async () => {
    const fixture = harness()
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    await fixture.control.toggle("a-prepaid")
    expect(fixture.dispatch).toHaveBeenCalledWith({
      type: "subscription_spend_consent.save",
      profileId: "work",
      authorityIncarnation: "authority-1",
      authorityRevision: 4,
      usageGeneration: 1,
      clientSnapshotPosition: 9,
      envelopeIds: ["a-prepaid", "a-automatic", "b-prepaid", "b-automatic"],
      reviewedEnvelopeIds: ["a-prepaid"],
      acceptedEnvelopeIds: ["a-prepaid"],
    })
    fixture.dispose()
  })

  it("starts on the subscription and visits every supported paid mode", async () => {
    const fixture = harness()
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    expect(fixture.control.state()).toMatchObject({ kind: "detail", cursor: -1 })
    expect(fixture.control.handleKey({ name: "return" })).toBe(false)
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.state()).toMatchObject({ kind: "detail", cursor: 0 })
    expect(fixture.control.handleKey({ name: "return" })).toBe(true)
    await Promise.resolve()
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.state()).toMatchObject({ kind: "detail", cursor: 1 })
    fixture.control.handleKey({ name: "up" })
    fixture.control.handleKey({ name: "up" })
    expect(fixture.control.state()).toMatchObject({ kind: "detail", cursor: -1 })
    fixture.dispose()
  })

  it("toggles only the focused billing checkbox with Enter or Space", async () => {
    const accepted = { ...consent, authorityRevision: 5, accounts: consent.accounts.map((account) => account.accountCorrelationId !== "account-a" ? account : { ...account, modes: account.modes.map((mode) => mode.envelopeId !== "a-prepaid" ? mode : { ...mode, decision: "accepted" as const }) }) }
    const replies = [accepted, consent]
    const fixture = harness({ dispatch: async () => ({ kind: "committed", consent: replies.shift()! }) })
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    expect(fixture.control.handleKey({ name: "return" })).toBe(false)
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.handleKey({ name: "return" })).toBe(true)
    await Promise.resolve()
    expect(fixture.control.state()).toMatchObject({ consent: { accounts: [accepted.accounts[0]] } })
    expect(fixture.control.handleKey({ name: "space", sequence: " " })).toBe(true)
    await Promise.resolve()
    expect(fixture.dispatch.mock.calls.map(([mutation]) => [mutation.reviewedEnvelopeIds, mutation.acceptedEnvelopeIds])).toEqual([
      [["a-prepaid"], ["a-prepaid"]],
      [["a-prepaid"], []],
    ])
    expect(fixture.control.state()).toMatchObject({ consent: { accounts: [consent.accounts[0]] } })
    fixture.dispose()
  })

  it("leaves Escape to Provider Settings, which closes without writing", () => {
    const fixture = harness()
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    expect(fixture.control.handleKey({ name: "escape" })).toBe(false)
    expect(fixture.control.handleKey({ name: "q" })).toBe(false)
    expect(fixture.control.handleKey({ name: "s" })).toBe(false)
    expect(fixture.dispatch).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it("allows an accepted unavailable mode to be revoked", async () => {
    const fixture = harness()
    fixture.control.openProviderSettings(consent, 9, "account-b", fixture.owner)
    await fixture.control.toggle("b-prepaid")
    expect(fixture.dispatch.mock.calls[0]?.[0]).toMatchObject({ reviewedEnvelopeIds: ["b-prepaid"], acceptedEnvelopeIds: [] })
    fixture.dispose()
  })

  it("saves an unreviewed mode even when its evidence is unknown", async () => {
    const fixture = harness()
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    await fixture.control.toggle("a-automatic")
    expect(fixture.dispatch.mock.calls[0]?.[0]).toMatchObject({ reviewedEnvelopeIds: ["a-automatic"], acceptedEnvelopeIds: ["a-automatic"] })
    fixture.dispose()
  })

  it("refreshes stale canonical state without closing", async () => {
    const current = { ...consent, authorityRevision: 5, accounts: consent.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => ({ ...mode, decision: "declined" as const })) })) }
    const fixture = harness({ dispatch: async (_mutation) => ({ kind: "stale" }), refresh: async () => ({ consent: current, snapshotPosition: 22 }) })
    fixture.control.openProviderSettings(consent, 9, "account-b", fixture.owner)
    await fixture.control.toggle("b-prepaid")
    expect(fixture.control.state()).toMatchObject({ kind: "detail", snapshotPosition: 22, savingEnvelopeIds: [], consent: { accounts: [current.accounts[1]] }, feedback: "Subscription capacity changed. Review the current modes." })
    fixture.dispose()
  })

  it("holds row keys during a save and ignores a completion after close", async () => {
    let settle!: (value: SubscriptionSpendConsentMutationResult) => void
    const fixture = harness({ dispatch: (_mutation) => new Promise((resolve) => { settle = resolve }) })
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    fixture.control.handleKey({ name: "down" })
    const pending = fixture.control.toggle("a-prepaid")
    expect(fixture.control.state()).toMatchObject({ savingEnvelopeIds: ["a-prepaid"], consent: { accounts: [consent.accounts[0]] } })
    expect(fixture.control.handleKey({ name: "return" })).toBe(true)
    expect(fixture.control.handleKey({ name: "down" })).toBe(true)
    expect(fixture.dispatch).toHaveBeenCalledTimes(1)
    fixture.control.close()
    settle({ kind: "committed", consent })
    await pending
    expect(fixture.control.state()).toEqual({ kind: "closed" })
    expect(fixture.onDismissedTickFailed).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it.each(["storage-failure", "contention", "stale", "throw"] as const)("reports a dismissed tick's %s without reopening settings", async (failure) => {
    const response = Promise.withResolvers<SubscriptionSpendConsentMutationResult>()
    const fixture = harness({ dispatch: () => response.promise })
    fixture.control.openProviderSettings(consent, 9, "account-a", fixture.owner)
    const pending = fixture.control.toggle("a-prepaid")
    fixture.control.close()
    fixture.owner.close()
    if (failure === "throw") response.reject(new Error("disconnected"))
    else response.resolve({ kind: failure })
    await pending
    expect(fixture.control.state()).toEqual({ kind: "closed" })
    expect(fixture.onDismissedTickFailed).toHaveBeenCalledTimes(1)
    expect(fixture.onAnswerFailed).not.toHaveBeenCalled()
    expect(fixture.refresh).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it("asks the question on the first waiting mode with Continue as the last stop", () => {
    const fixture = harness()
    fixture.control.openQuestion(consent, 9, "account-a", fixture.owner)
    expect(fixture.control.state()).toMatchObject({ kind: "detail", cursor: 0, surface: "question" })
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.state()).toMatchObject({ cursor: 1 })
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.state()).toMatchObject({ cursor: -1 })
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.state()).toMatchObject({ cursor: -1 })
    fixture.control.handleKey({ name: "up" })
    expect(fixture.control.state()).toMatchObject({ cursor: 1 })
    fixture.dispose()
  })

  it("saves a question tick in place and Continue declines only unanswered modes", async () => {
    const question = { ...consent, accounts: [{ ...consent.accounts[0]!, modes: consent.accounts[0]!.modes.map((mode) => mode.mode === "automatic" ? { ...mode, evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const } } : mode) }] }
    const accepted = { ...question, authorityRevision: 5, accounts: question.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => mode.envelopeId === "a-prepaid" ? { ...mode, decision: "accepted" as const } : mode) })) }
    const answered = { ...accepted, authorityRevision: 6, accounts: accepted.accounts.map((account) => ({ ...account, modes: account.modes.map((mode) => mode.envelopeId === "a-automatic" ? { ...mode, decision: "declined" as const } : mode) })) }
    const replies = [accepted, answered]
    const fixture = harness({ dispatch: async () => ({ kind: "committed", consent: replies.shift()! }) })
    fixture.control.openQuestion(question, 9, "account-a", fixture.owner)
    await fixture.control.toggle("a-prepaid")
    expect(fixture.control.state()).toMatchObject({ kind: "detail", consent: accepted })
    expect(fixture.onAnswered).not.toHaveBeenCalled()
    fixture.control.handleKey({ name: "down" })
    fixture.control.handleKey({ name: "down" })
    expect(fixture.control.handleKey({ name: "return" })).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.dispatch.mock.calls.map(([mutation]) => [mutation.authorityRevision, mutation.reviewedEnvelopeIds, mutation.acceptedEnvelopeIds])).toEqual([
      [4, ["a-prepaid"], ["a-prepaid"]],
      [5, ["a-automatic"], []],
    ])
    expect(fixture.onAnswered).toHaveBeenCalledWith(answered, 9)
    expect(fixture.control.state()).toEqual({ kind: "closed" })
    fixture.dispose()
  })

  it("declines unanswered modes on Escape even when evidence is unknown", async () => {
    const fixture = harness()
    fixture.control.openQuestion(consent, 9, "account-a", fixture.owner)
    fixture.control.handleKey({ name: "escape" })
    await Promise.resolve()
    await Promise.resolve()
    expect(fixture.dispatch.mock.calls[0]?.[0]).toMatchObject({ reviewedEnvelopeIds: ["a-prepaid", "a-automatic"], acceptedEnvelopeIds: [] })
    expect(fixture.onAnswered).toHaveBeenCalledWith(consent, 9)
    expect(fixture.control.state()).toEqual({ kind: "closed" })
    fixture.dispose()
  })

  it.each(["storage-failure", "stale"] as const)("closes the question and reports a %s answer instead of trapping the person", async (kind) => {
    const fixture = harness({ dispatch: async () => ({ kind }) })
    fixture.control.openQuestion(consent, 9, "account-a", fixture.owner)
    await fixture.control.decline()
    expect(fixture.control.state()).toEqual({ kind: "closed" })
    expect(fixture.onAnswerFailed).toHaveBeenCalledTimes(1)
    expect(fixture.onAnswered).not.toHaveBeenCalled()
    expect(fixture.refresh).not.toHaveBeenCalled()
    fixture.dispose()
  })

  it("keeps a failed tick at the durable value with its feedback", async () => {
    const fixture = harness({ dispatch: async () => ({ kind: "contention" }) })
    fixture.control.openQuestion(consent, 9, "account-a", fixture.owner)
    await fixture.control.toggle("a-prepaid")
    expect(fixture.control.state()).toMatchObject({ kind: "detail", savingEnvelopeIds: [], consent: { accounts: [consent.accounts[0]] }, feedback: "Another update is in progress. Try again." })
    fixture.dispose()
  })
})
