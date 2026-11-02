/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"

const [{ testRender }, { createComponent }, { createSignal }, { ThemeProvider }, { AuthModal }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("solid-js"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/auth-modal.js"),
])
const [{ createModal, currentAuthStatuses, setAuthStatuses }, { subscriptionSpendAccountCorrelationId }] = await Promise.all([
  import("./auth-modal-test-harness.js"),
  import("../../../../src/protocol/subscription-spend-consent-protocol-types.js"),
])

const noOp = (): void => {}
const EMPTY_PRESENTATION = { value: "", cursor: 0, selection: null, preferredVisualColumn: null } as const

describe("AuthModal capability detail", () => {
  it("renders usage, exact evidence, independent consent, and billing destination", async () => {
    const account = { instanceId: "account-1", accountCorrelationId: "opaque", identity: "user@example.com", displayLabel: "user@example.com", expired: false, source: "oauth" as const }
    const option = {
      id: "chatgpt" as const, label: "ChatGPT Subscription", kind: "subscription" as const, source: "oauth" as const, expired: false,
      loginMethod: "browser-auth" as const, modelSelectionAvailable: true, accounts: [account], capabilityAccounts: [], group: "model" as const,
    }
    const capability = {
      accountCorrelationId: "opaque", providerId: "chatgpt", providerDisplayName: "ChatGPT", label: "Personal", plan: "Plus", tier: "Pro",
      providerStatus: "ok" as const, billingUrl: "https://example.com/billing",
      modes: [
        { mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "funded" as const, remaining: { kind: "money" as const, value: 12.5, currency: "USD", provenance: "provider" as const, precision: "exact" as const } }, decision: "accepted" as const },
        { mode: "automatic" as const, envelopeId: "automatic", evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "declined" as const },
      ],
    }
    const consentView = { kind: "available" as const, profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [capability] }
    const savingEnvelopeIds: readonly string[] = []
    const consent = { kind: "detail" as const, cursor: 1, savingEnvelopeIds, consent: consentView, canonicalConsent: consentView, snapshotPosition: 1, envelopeIds: ["prepaid", "automatic"], surface: "settings" as const }
    const [consentState, setConsentState] = createSignal<typeof consent | { readonly kind: "closed" }>({ kind: "closed" })
    const toggles: string[] = []
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-settings", option, target: { kind: "account", account, modelTarget: { kind: "subscription", providerId: option.id, accountCorrelationId: capability.accountCorrelationId }, capability }, originCursor: 1 }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, consent: consentState, onSelect: noOp, onClose: noOp, onToggleConsent: (id) => { toggles.push(id) },
        })
      },
    }), { width: 90, height: 24 })
    try {
      await result.renderOnce()
      const initialFrame = result.captureCharFrame()
      expect(initialFrame).toContain("Authentication › ChatGPT Subscription")
      expect(initialFrame).not.toContain("user@example.com Provider Settings")
      expect(initialFrame).toContain("Account  user@example.com")
      expect(initialFrame).toContain("Plan     Plus · Pro")
      expect(initialFrame).toContain("Usage    Healthy")
      expect(initialFrame).toContain("> Models enter")
      expect(initialFrame).toContain("Prepaid  On")
      expect(initialFrame).toContain("Automatic billing  Off")
      expect(initialFrame).not.toContain("[x]")
      expect(initialFrame).not.toContain("[ ]")
      const prepaidLine = initialFrame.split("\n").findIndex((line) => line.includes("Prepaid"))
      await result.mockMouse.click(initialFrame.split("\n")[prepaidLine]!.indexOf("Prepaid"), prepaidLine)
      expect(toggles).toEqual([])
      const mutedRow = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Prepaid"))
      expect(mutedRow?.fg.equals(resolveTheme(flywheelTheme, "dark").textMuted)).toBe(true)
      setConsentState(consent)
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("PAID USE IN FLYWHEEL")
      expect(frame).toContain("  [x] Prepaid            Funded · Remaining 12.5 USD")
      expect(frame).toContain("> [ ] Automatic billing  Provider billing: on")
      expect(frame).not.toContain("> Models")
      expect(frame).toContain("space/enter toggle · b billing")
      expect(frame).not.toContain("s save")
      expect(frame).not.toContain("exit Flywheel")
      expect(frame).toContain("Billing  https://example.com/billing")
      const liveLine = frame.split("\n").findIndex((line) => line.includes("Prepaid"))
      await result.mockMouse.click(frame.split("\n")[liveLine]!.indexOf("Prepaid"), liveLine)
      expect(toggles).toEqual(["prepaid"])
      setConsentState({ ...consent, savingEnvelopeIds: ["automatic"] })
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("> [ ] Automatic billing  Provider billing: on · Saving...")
      setConsentState({ kind: "closed" })
      await result.renderOnce()
      const closedFrame = result.captureCharFrame()
      expect(closedFrame).not.toContain("[x]")
      const closedLine = closedFrame.split("\n").findIndex((line) => line.includes("Prepaid"))
      await result.mockMouse.click(closedFrame.split("\n")[closedLine]!.indexOf("Prepaid"), closedLine)
      expect(toggles).toEqual(["prepaid"])
    } finally {
      result.renderer.destroy()
    }
  })

  it("asks the paid-use question in plain words inside a closable frame", async () => {
    const account = { instanceId: "account-1", accountCorrelationId: "opaque", identity: "user@example.com", displayLabel: "user@example.com", expired: false, source: "oauth" as const }
    const option = {
      id: "chatgpt" as const, label: "ChatGPT Subscription", kind: "subscription" as const, source: "oauth" as const, expired: false,
      loginMethod: "browser-auth" as const, modelSelectionAvailable: true, accounts: [account], capabilityAccounts: [], group: "model" as const,
    }
    const capability = {
      accountCorrelationId: "opaque", providerId: "chatgpt", providerDisplayName: "ChatGPT", label: "Personal", plan: "Plus",
      providerStatus: "ok" as const, billingUrl: "https://example.com/billing",
      modes: [
        { mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "unknown" as const }, decision: "unreviewed" as const },
        { mode: "automatic" as const, envelopeId: "automatic", evidence: { kind: "automatic-billing" as const, enablement: "enabled" as const }, decision: "unreviewed" as const },
      ],
    }
    const consentView = { kind: "available" as const, profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [capability] }
    const consent = { kind: "detail" as const, cursor: 1, savingEnvelopeIds: ["automatic"], consent: consentView, canonicalConsent: consentView, snapshotPosition: 1, envelopeIds: ["prepaid", "automatic"], surface: "question" as const }
    let continued = false
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "paid-use-question", option, account, capability, originCursor: 1, returnTo: "close" }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, consent: () => consent, onSelect: () => {}, onClose: () => {}, onContinueConsent: () => { continued = true },
        })
      },
    }), { width: 90, height: 28 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Authentication › ChatGPT Subscription › Paid use")
      expect(frame).toContain("ChatGPT Subscription is connected as user@example.com.")
      expect(frame).toContain("automatic billing.")
      expect(frame.replace(/[│\n]/g, " ").replace(/\s+/g, " ")).toContain("Modes you leave unticked stay off.")
      expect(frame).toContain("ALLOW PAID USE IN FLYWHEEL")
      expect(frame).toContain("  [ ] Prepaid            No reading yet")
      expect(frame).toContain("> [ ] Automatic billing  Provider billing: on")
      expect(frame).toContain("Continue")
      expect(frame).toContain("esc continue · b billing")
      expect(frame).not.toContain("exit Flywheel")
      expect(frame).toContain(" x ")
      const continueLine = frame.split("\n").findIndex((line) => line.includes("Continue"))
      await result.mockMouse.click(frame.split("\n")[continueLine]!.indexOf("Continue"), continueLine)
      expect(continued).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders working paid-mode checkboxes regardless of their usage evidence", async () => {
    const account = { instanceId: "go-account", accountCorrelationId: "opaque", identity: "go-account", displayLabel: "OpenCode Go", expired: false, source: "stored_key" as const }
    const option = {
      id: "opencode_go" as const, label: "OpenCode Go Subscription", kind: "subscription" as const, source: "stored_key" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [account], capabilityAccounts: [], group: "model" as const,
    }
    const capability = {
      accountCorrelationId: "opaque", providerId: "opencode_go", providerDisplayName: "OpenCode Go", label: "OpenCode Go",
      providerStatus: "ok" as const, billingUrl: "https://example.com/billing",
      modes: [
        { mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "balance-unavailable" as const }, decision: "unreviewed" as const },
        { mode: "automatic" as const, envelopeId: "automatic", evidence: { kind: "automatic-billing" as const, enablement: "unknown" as const }, decision: "unreviewed" as const },
        { mode: "prepaid" as const, envelopeId: "accepted-unavailable", evidence: { kind: "prepaid" as const, availability: "empty" as const }, decision: "accepted" as const },
      ],
    }
    const consentView = { kind: "available" as const, profileId: "default", usageGeneration: 1, authorityIncarnation: "authority", authorityRevision: 1, accounts: [capability] }
    const consent = { kind: "detail" as const, cursor: 2, savingEnvelopeIds: [], consent: consentView, canonicalConsent: consentView, snapshotPosition: 1, envelopeIds: ["prepaid", "automatic", "accepted-unavailable"], surface: "settings" as const }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-settings", option, target: { kind: "account", account, modelTarget: { kind: "subscription", providerId: option.id, accountCorrelationId: capability.accountCorrelationId }, capability }, originCursor: 1 }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, consent: () => consent, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 90, height: 24 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("API key  go-account")
      expect(frame).not.toContain("> Models")
      expect(frame).toContain("  [ ] Prepaid            Balance: not reported")
      expect(frame).toContain("  [ ] Automatic billing  No reading yet")
      expect(frame).not.toContain("Not reviewed")
      expect(frame).toContain("> [x] Prepaid            Balance: empty")
      expect(frame).not.toContain("currently unavailable")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps account detail responsive without rereading an unchanged auth snapshot", async () => {
    const account = { instanceId: "go-account", accountCorrelationId: subscriptionSpendAccountCorrelationId("default", "opencode_go", "go-account"), identity: "go-account", displayLabel: "OpenCode Go", expired: false, source: "stored_key" as const }
    setAuthStatuses({ providerId: "opencode_go", source: "stored_key", accounts: [account] })
    const authView = {
      providers: currentAuthStatuses(), warnings: [],
      profile: { id: "default", displayName: "Default", source: "default" as const, availableProfiles: [{ id: "default", displayName: "Default" }] },
      subscriptionSpendConsent: { kind: "available" as const, profileId: "default", usageGeneration: 1, authorityIncarnation: "test-authority", authorityRevision: 1, accounts: [{
        accountCorrelationId: subscriptionSpendAccountCorrelationId("default", "opencode_go", account.instanceId), providerId: "opencode_go", providerDisplayName: "OpenCode Go", providerStatus: "ok" as const,
        modes: [{ mode: "prepaid" as const, envelopeId: "prepaid", evidence: { kind: "prepaid" as const, availability: "unknown" as const }, decision: "unreviewed" as const }],
      }] },
    }
    const [authSnapshot, setAuthSnapshot] = createSignal(authView)
    let authReads = 0
    const auth = () => {
      if (++authReads > 25) throw new Error("auth snapshot read loop")
      return authSnapshot()
    }
    let harness: ReturnType<typeof createModal> | undefined
    const result = await testRender(() => {
      harness = createModal("default", auth)
      harness.modal.openAuthModal()
      return <box />
    }, { width: 120, height: 36 })
    try {
      await result.renderOnce()
      const active = harness
      if (active === undefined) throw new Error("auth modal harness was not created")
      active.modal.selectProvider(active.modal.authRows().findIndex((row) => row.kind === "provider" && row.option.id === "opencode_go"))
      for (let i = 0; i < 5 && active.modal.authView().kind !== "provider-settings"; i++) await Bun.sleep(0)
      expect(active.modal.authView().kind).toBe("provider-settings")
      setAuthSnapshot({ ...authView })
      await result.renderOnce()
      active.modals.input({ name: "left" })
      expect(active.modal.authView().kind).toBe("list")
      expect(authReads).toBeLessThan(25)
    } finally {
      result.renderer.destroy()
    }
  })
})
