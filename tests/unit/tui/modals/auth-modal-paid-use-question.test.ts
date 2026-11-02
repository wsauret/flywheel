import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { subscriptionSpendAccountCorrelationId, type SubscriptionSpendConsentMutationResult, type SubscriptionSpendConsentView } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { inspectActiveProfileConsent } from "../../../../src/tui/hooks/create-modals.js"
import { usePaidUseQuestion } from "../../../../src/tui/hooks/use-paid-use-question.js"
import { clearMocks, createModal, currentAuthStatuses, runtimeAnswer, setAuthStatuses } from "./auth-modal-test-harness.js"

type AvailableConsent = Extract<SubscriptionSpendConsentView, { readonly kind: "available" }>

const instanceId = "copilot-1"
const accountCorrelationId = subscriptionSpendAccountCorrelationId("default", "github_copilot", instanceId)
const account = { instanceId, accountCorrelationId, identity: "alice", displayLabel: "alice", expired: false, source: "oauth" as const }
const capability = {
  accountCorrelationId, providerId: "github_copilot", providerDisplayName: "Copilot", providerStatus: "ok" as const, billingUrl: "https://github.com/settings/billing",
  modes: [
    { mode: "prepaid" as const, envelopeId: "copilot-prepaid", evidence: { kind: "prepaid" as const, availability: "unknown" as const }, decision: "unreviewed" as const },
    { mode: "automatic" as const, envelopeId: "copilot-automatic", evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "unreviewed" as const },
  ],
}
const waiting: AvailableConsent = { kind: "available", profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [capability] }
const answered: AvailableConsent = { ...waiting, authorityRevision: 2, accounts: [{ ...capability, modes: capability.modes.map((mode) => mode.envelopeId === "copilot-automatic" ? { ...mode, decision: "declined" as const } : mode) }] }
const originalDialogPolicy = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
beforeEach(() => { process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "0" })
afterEach(() => {
  if (originalDialogPolicy === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = originalDialogPolicy
})

function authView(): RuntimeAuthView {
  return {
    providers: currentAuthStatuses(), warnings: [], authFilePath: "/profiles/default/auth.json",
    profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
    subscriptionSpendConsent: waiting,
  }
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20 && !condition(); i++) await Bun.sleep(0)
}

/** Makes the harness's runtime answer the status snapshot at `snapshotPosition`, the only query the paid-use question makes. */
function answerSnapshot(fixture: ReturnType<typeof createModal>, auth: () => RuntimeAuthView, snapshotPosition: number): void {
  fixture.queries.authStatusSnapshot.mockImplementation(async () => ({ auth: auth(), snapshotPosition }))
  fixture.queries["provider_models.query"].mockImplementation(async () => { throw new Error("unexpected query: provider_models.query") })
}

function harness() {
  setAuthStatuses({ providerId: "github_copilot", source: "oauth", accounts: [account] })
  const fixture = createModal("default", authView)
  answerSnapshot(fixture, authView, 5)
  // The Copilot login completes as soon as its question is answered.
  runtimeAnswer.mockImplementation(async (request) => ({ kind: "completed", providerId: request.providerId }))
  fixture.runtime["subscription_spend_consent.save"].mockImplementation(async (request) => (
    { kind: "committed", consent: { ...answered, accounts: [{ ...capability, modes: capability.modes.map((mode) => request.reviewedEnvelopeIds.includes(mode.envelopeId) ? { ...mode, decision: request.acceptedEnvelopeIds.includes(mode.envelopeId) ? "accepted" as const : "declined" as const } : mode) }] } }
  ))
  const consentSaves = () => fixture.sent("subscription_spend_consent.save")
  return { ...fixture, consentSaves }
}

describe("paid-use question (PI-MODEL-018)", () => {
  beforeEach(clearMocks)

  it.each(["1", "0"])("honors automatic-dialog suppression %s when paid evidence arrives later", async (flag) => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = flag
    await createRoot(async (dispose) => {
      const [auth, setAuth] = createSignal<RuntimeAuthView>()
      const review = mock(async () => true)
      try {
        usePaidUseQuestion({ signals: { auth, foregroundId: () => "chat", agentState: () => "idle" }, overlayOpen: () => false, review })
        await Bun.sleep(0)
        setAuth(authView())
        await Bun.sleep(0)
        expect(review).toHaveBeenCalledTimes(flag === "1" ? 0 : 1)
        setAuth({ ...authView() })
        await Bun.sleep(0)
        expect(review).toHaveBeenCalledTimes(flag === "1" ? 0 : 1)
        expect(auth()?.subscriptionSpendConsent).toEqual(waiting)
      } finally {
        dispose()
      }
      setAuth({ ...authView() })
      await Bun.sleep(0)
      expect(review).toHaveBeenCalledTimes(flag === "1" ? 0 : 1)
    })
  })

  it("keeps manual paid-use review available under suppression without recording an answer", async () => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "1"
    await createRoot((dispose) => {
      try {
        const { modal, consentSaves } = harness()
        expect(modal.openPaidUseQuestion(authView(), 9, "github_copilot", accountCorrelationId)).toBe(true)
        expect(modal.authView().kind).toBe("paid-use-question")
        expect(consentSaves()).toEqual([])
      } finally {
        dispose()
      }
    })
  })

  it("gives the arrows back to the list after a rename that started in account settings", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals } = harness()
      expect(modal.openAuthAccountDetail(authView(), 5, "github_copilot", accountCorrelationId)).toBe(true)
      expect(modal.authView().kind).toBe("provider-settings")
      modals.input({ name: "n" })
      expect(modal.authView()).toMatchObject({ kind: "rename-input", instanceId })
      modals.input({ name: "escape" })
      expect(modal.authView().kind).toBe("list")
      const before = modal.authModalCursor()
      modals.input({ name: "up" })
      expect(modal.authModalCursor()).not.toBe(before)
      dispose()
    })
  })

  it.each(["0", "1"])("honors suppression %s after login while preserving consent", async (flag) => {
    process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = flag
    await createRoot(async (dispose) => {
      const { modal, modals, consentSaves } = harness()
      modal.openAuthModal()
      expect(modal.focusProvider("github_copilot")).toBe(true)
      modals.input({ name: "a" })
      await until(() => modal.authView().kind === "login-prompt")
      modals.input({ name: "return" })
      await until(() => modal.authView().kind === (flag === "1" ? "list" : "paid-use-question"))
      if (flag === "1") {
        expect(modal.authView().kind).toBe("list")
        expect(consentSaves()).toEqual([])
        dispose()
        return
      }
      expect(modal.authView()).toMatchObject({ kind: "paid-use-question", returnTo: "list", option: { id: "github_copilot" }, account: { identity: "alice" } })
      expect(modal.subscriptionSpendConsent.state()).toMatchObject({ kind: "detail", surface: "question", cursor: 0 })

      modals.input({ name: "escape" })
      await until(() => modal.authView().kind === "list")
      expect(consentSaves()).toEqual([expect.objectContaining({ reviewedEnvelopeIds: ["copilot-prepaid", "copilot-automatic"], acceptedEnvelopeIds: [] })])
      expect(modal.authView().kind).toBe("list")
      expect(modals.stack.length).toBe(1)
      dispose()
    })
  })

  it("opens standalone, saves a tick in place, and Continue declines the unanswered mode", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, consentSaves, showToast } = harness()
      expect(modal.openPaidUseQuestion(authView(), 9, "github_copilot", accountCorrelationId)).toBe(true)
      expect(modal.authView()).toMatchObject({ kind: "paid-use-question", returnTo: "close" })
      modals.input({ name: "space", sequence: " " })
      await until(() => consentSaves().length === 1 && modal.subscriptionSpendConsent.state().kind === "detail")
      await Promise.resolve()
      modals.input({ name: "down" })
      modals.input({ name: "down" })
      const saved = modal.subscriptionSpendConsent.state()
      expect(saved).toMatchObject({ kind: "detail", cursor: -1, savingEnvelopeIds: [] })
      if (saved.kind !== "detail") throw new Error("expected the paid-use question to remain open")
      expect(saved.consent.accounts[0]?.modes.map((mode) => mode.decision)).toEqual(["accepted", "unreviewed"])
      modals.input({ name: "return" })
      await until(() => modals.stack.length === 0)
      expect(showToast.mock.calls).toEqual([])
      expect(consentSaves()).toEqual([
        expect.objectContaining({ clientSnapshotPosition: 9, reviewedEnvelopeIds: ["copilot-prepaid"], acceptedEnvelopeIds: ["copilot-prepaid"] }),
        expect.objectContaining({ reviewedEnvelopeIds: ["copilot-automatic"], acceptedEnvelopeIds: [] }),
      ])
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("treats Return on the opening question row as Continue without accepting paid use", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, consentSaves } = harness()
      modal.openPaidUseQuestion(authView(), 9, "github_copilot", accountCorrelationId)
      expect(modal.subscriptionSpendConsent.state()).toMatchObject({ cursor: 0 })
      modals.input({ name: "return" })
      await until(() => modals.stack.length === 0)
      expect(consentSaves()).toEqual([
        expect.objectContaining({ reviewedEnvelopeIds: ["copilot-prepaid", "copilot-automatic"], acceptedEnvelopeIds: [] }),
      ])
      expect(modals.stack).toHaveLength(0)
      dispose()
    })
  })

  it.each(["escape", "q", "frame", "enter", "return"])("keeps %s during a tick and declines only the remaining mode after it commits", async (close) => {
    await createRoot(async (dispose) => {
      const { modal, modals, consentSaves, runtime } = harness()
      const question = waiting
      const accepted = { ...question, authorityRevision: 2, accounts: question.accounts.map((row) => ({ ...row, modes: row.modes.map((mode) => mode.mode === "automatic" ? { ...mode, decision: "accepted" as const } : mode) })) }
      const declined = { ...accepted, authorityRevision: 3, accounts: accepted.accounts.map((row) => ({ ...row, modes: row.modes.map((mode) => mode.mode === "prepaid" ? { ...mode, decision: "declined" as const } : mode) })) }
      const response = Promise.withResolvers<SubscriptionSpendConsentMutationResult>()
      runtime["subscription_spend_consent.save"].mockImplementation(async () => consentSaves().length === 1 ? await response.promise : { kind: "committed", consent: declined })
      modal.openPaidUseQuestion({ ...authView(), subscriptionSpendConsent: question }, 9, "github_copilot", accountCorrelationId)
      const tick = modal.subscriptionSpendConsent.toggle("copilot-automatic")
      if (close === "frame") modal.closeAuthModal()
      else modals.input({ name: close })
      expect(consentSaves()).toHaveLength(1)
      expect(modals.stack).toHaveLength(1)
      response.resolve({ kind: "committed", consent: accepted })
      await tick
      await until(() => modals.stack.length === 0)
      expect(consentSaves()).toEqual([
        expect.objectContaining({ authorityRevision: 1, reviewedEnvelopeIds: ["copilot-automatic"], acceptedEnvelopeIds: ["copilot-automatic"] }),
        expect.objectContaining({ authorityRevision: 2, reviewedEnvelopeIds: ["copilot-prepaid"], acceptedEnvelopeIds: [] }),
      ])
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("reports a settings tick's storage failure after the frame closes", async () => {
    await createRoot(async (dispose) => {
      const { modal, modals, runtime, showToast } = harness()
      const response = Promise.withResolvers<SubscriptionSpendConsentMutationResult>()
      runtime["subscription_spend_consent.save"].mockImplementation(async () => await response.promise)
      modal.openAuthAccountDetail(authView(), 9, "github_copilot", accountCorrelationId)
      const tick = modal.subscriptionSpendConsent.toggle("copilot-automatic")
      modal.closeAuthModal()
      expect(modals.stack).toHaveLength(0)
      response.resolve({ kind: "storage-failure" })
      await tick
      expect(modals.stack).toHaveLength(0)
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ variant: "warning", message: expect.stringContaining("could not save paid-use settings") }))
      dispose()
    })
  })

  it("asks one account at a time at startup and moves to the sibling after each answer", async () => {
    await createRoot(async (dispose) => {
      const siblingId = subscriptionSpendAccountCorrelationId("default", "supergrok", "grok-2")
      const exactId = subscriptionSpendAccountCorrelationId("default", "supergrok", "grok-1")
      const grokAccounts = [
        { instanceId: "grok-1", accountCorrelationId: exactId, identity: "Exact", displayLabel: "Exact", expired: false, source: "oauth" as const },
        { instanceId: "grok-2", accountCorrelationId: siblingId, identity: "Sibling", displayLabel: "Sibling", expired: false, source: "oauth" as const },
      ]
      const mode = (envelopeId: string) => ({ mode: "automatic" as const, envelopeId, evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "unreviewed" as const })
      const pair = (decision: "unreviewed" | "declined"): SubscriptionSpendConsentView => ({
        kind: "available", profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1,
        accounts: [
          { accountCorrelationId: exactId, providerId: "supergrok", providerDisplayName: "SuperGrok", providerStatus: "ok", modes: [{ ...mode("exact-automatic"), decision }] },
          { accountCorrelationId: siblingId, providerId: "supergrok", providerDisplayName: "SuperGrok", providerStatus: "ok", modes: [mode("sibling-automatic")] },
        ],
      })
      setAuthStatuses({ providerId: "supergrok", source: "oauth", accounts: grokAccounts })
      const view = (): RuntimeAuthView => ({ ...authView(), subscriptionSpendConsent: pair("unreviewed") })
      const fixture = createModal("default", view)
      answerSnapshot(fixture, view, 3)
      // The first answer leaves the sibling waiting, so the committed view still asks.
      fixture.runtime["subscription_spend_consent.save"].mockImplementation(async () => ({ kind: "committed", consent: pair("declined") }))
      await inspectActiveProfileConsent({
        appService: { query: fixture.runtimeQuery, dispatch: fixture.runtimeDispatch },
        auth: view,
        authScope: () => ({ kind: "session", sessionId: "session-1" }),
        agentState: () => "idle",
        showRefreshFailure: () => {},
        openPaidUseQuestion: (...args) => fixture.modal.openPaidUseQuestion(...args),
      }, false)
      expect(fixture.modal.authView()).toMatchObject({ kind: "paid-use-question", account: { identity: "Exact" }, returnTo: "close" })

      fixture.modals.input({ name: "escape" })
      await until(() => { const current = fixture.modal.authView(); return current.kind === "paid-use-question" && current.account.identity === "Sibling" })
      expect(fixture.modal.authView()).toMatchObject({ kind: "paid-use-question", account: { identity: "Sibling" } })
      expect(fixture.modals.stack.length).toBe(1)
      dispose()
    })
  })
})
