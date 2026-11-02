/** @jsxImportSource @opentui/solid */

import { describe, expect, it, spyOn } from "bun:test"
import { type Renderable, ScrollBoxRenderable } from "@opentui/core"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { createSignal } from "solid-js"
import type { AuthView } from "../../../../src/tui/hooks/auth-modal-options.js"

const [{ testRender }, { createComponent }, { ThemeProvider }, { AuthModal }, { buildAuthRows }] = await Promise.all([
  import("@opentui/solid"),
  import("solid-js/web"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/auth-modal.js"),
  import("../../../../src/tui/hooks/auth-modal-options.js"),
])
const { createModal, setAuthStatuses } = await import("./auth-modal-test-harness.js")

const noOp = (): void => {}
const EMPTY_PRESENTATION = { value: "", cursor: 0, selection: null, preferredVisualColumn: null } as const

describe("AuthModal list scrolling", () => {
  it.each([[80, 14], [80, 20], [160, 40], [80, 24]])("reveals keyboard selection and restores it after settings at %sx%s", async (width, height) => {
    setAuthStatuses(
      { providerId: "chatgpt", source: "oauth", statusRank: 0, accounts: ["Work", "Personal", "Team", "Research", "Testing"].map((label) => ({ instanceId: label, accountCorrelationId: label, identity: label, displayLabel: label, expired: false, source: "oauth" as const })) },
      { providerId: "exa", source: "stored_key" },
    )
    let harness!: ReturnType<typeof createModal>
    const result = await testRender(() => {
      harness = createModal()
      harness.modal.openAuthModal()
      return createComponent(ThemeProvider, { mode: "dark", get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          get view() { return harness.modal.authView() },
          get rows() { return harness.modal.authRows() },
          get cursor() { return harness.modal.authModalCursor() },
          get inputPresentation() { return harness.modal.authInputPresentation() },
          onSelect: harness.modal.selectProvider, onClose: harness.modal.closeAuthModal,
        })
      } })
    }, { width, height })
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    const list = () => descendants(result.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!
    const expectSelectionVisible = () => {
      const scroll = list()
      const cursor = harness.modal.authModalCursor()
      const selected = scroll.getChildren()[cursor]!
      expect(scroll.getChildren()).toHaveLength(harness.modal.authRows().length)
      expect(selected.height).toBeGreaterThan(0)
      expect(selected.y).toBeGreaterThanOrEqual(scroll.viewport.y)
      expect(selected.y + selected.height).toBeLessThanOrEqual(scroll.viewport.y + scroll.viewport.height)
      expect(result.captureCharFrame()).toContain(">")
      for (let index = cursor - 1; index >= 0; index--) {
        const row = harness.modal.authRows()[index]!
        if (row.kind !== "heading" && row.kind !== "provider-group") break
        expect(scroll.getChildren()[index]!.y).toBeGreaterThanOrEqual(scroll.viewport.y)
      }
    }
    try {
      await result.renderOnce()
      let maximumScroll = 0
      const selectableCount = harness.modal.authRows().filter((row) => row.kind === "profile" || row.kind === "provider" || row.kind === "account").length
      for (const direction of ["down", "up"]) {
        for (let step = 0; step < selectableCount; step++) {
          harness.modals.input({ name: direction })
          await result.renderOnce()
          maximumScroll = Math.max(maximumScroll, list().scrollTop)
          if (height === 20 && direction === "down" && step < 2) expect(list().scrollTop).toBe(0)
          expectSelectionVisible()
          const cursor = harness.modal.authModalCursor()
          const row = harness.modal.authRows()[cursor]!
          if (row.kind === "provider" && row.option.id === "exa") {
            harness.modals.input({ name: "return" })
            await result.renderOnce()
            expect(harness.modal.authView().kind).toBe("provider-settings")
            expect(result.captureCharFrame()).toContain("Authentication › Exa API Key")
            harness.modals.input({ name: "left" })
            await result.renderOnce()
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
            await result.renderOnce()
            expect(harness.modal.authView().kind).toBe("list")
            expect(harness.modal.authModalCursor()).toBe(cursor)
            expectSelectionVisible()
            const frame = result.captureCharFrame()
            expect(frame).toContain("Web Search")
            expect(frame).toContain("> Exa API Key")
            expect(frame).toContain("d disconnect")
            expect(frame).toContain("← back")
          }
        }
      }
      expect(list().scrollTop).toBe(0)
      expect(maximumScroll).toBeGreaterThan(0)
      harness.modals.input({ name: "up" })
      harness.modals.input({ name: "return" })
      await result.renderOnce()
      harness.modals.input({ name: "left" })
      await result.renderOnce()
      const pendingReveal = spyOn(list(), "getChildren")
      try {
        harness.modals.input({ name: "return" })
        expect(harness.modal.authView().kind).toBe("provider-settings")
        pendingReveal.mockClear()
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        expect(pendingReveal).not.toHaveBeenCalled()
      } finally { pendingReveal.mockRestore() }
    } finally { harness.modals.clear(); result.renderer.destroy(); setAuthStatuses() }
  })
})

describe("AuthModal provider models", () => {
  it.each([false, true])("keeps exact account preferences editable with rejected auth: %s", async (rejected) => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: {
            kind: "provider-models",
            profileId: "default",
            eligibilityRevision: 1,
            target: { kind: "singleton", providerId: "openai_api" },
            providerTitle: "OpenAI API",
            catalog: rejected ? { kind: "unavailable", reason: "authentication-invalid" } : { kind: "available", provenance: "models-dev-live", liveOutcome: "valid" },
            rows: [{ modelId: "gpt-5", checked: true, optInAvailable: true, configured: true }],
            preferenceAvailable: true,
            query: "",
            loading: false,
            cursor: 0,
            originCursor: 0,
          },
          rows: [],
          cursor: 0,
          inputPresentation: EMPTY_PRESENTATION,
          onSelect: noOp,
          onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("Enable new models automatically")
      expect(frame).not.toContain("alt+a auto new")
      expect(frame).toContain("[x] gpt-5")
      if (rejected) expect(frame).toContain("Preferences can be saved. Reconnect before sending requests.")
    } finally { result.renderer.destroy() }
  })
})

describe("AuthModal profile row", () => {
  it.each(["dark", "light"] as const)("bounds deletion choices and renders disabled and busy states in %s", async (mode) => {
    const candidates = Array.from({ length: 40 }, (_, index) => ({ id: `profile-${index}`, displayName: `Destination ${index} ${"long name ".repeat(10)}` }))
    const initial = { kind: "profile-delete-confirmation", phase: "ready", id: "work", label: "Work", choice: "cancel", preview: { kind: "choose", source: { id: "work", displayName: "Work" }, candidates } } as const
    const [view, setView] = createSignal<AuthView>(initial)
    const [pending, setPending] = createSignal(false)
    const result = await testRender(() => createComponent(ThemeProvider, { mode, get children() {
      return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, get view() { return view() }, get profileAttemptPending() { return pending() }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
    } }), { width: 80, height: 20 })
    const descendants = (node: Renderable): Renderable[] => [node, ...node.getChildren().flatMap(descendants)]
    try {
      await result.renderOnce()
      const disabled = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Delete (disabled)"))
      expect(disabled?.fg.equals(resolveTheme(flywheelTheme, mode).textMuted)).toBe(true)
      expect(result.captureCharFrame()).toContain("> Cancel")
      const scroll = descendants(result.renderer.root).find((node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable)!
      expect(scroll.height).toBeLessThan(10)
      setView({ ...initial, successorId: "profile-39" })
      await result.renderOnce()
      await result.renderOnce()
      expect(scroll.scrollTop).toBeGreaterThan(0)
      expect(result.captureCharFrame()).toContain("> Destination 39")
      expect(result.captureCharFrame()).not.toContain("Delete (disabled)")
      setPending(true)
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Deleting...")
      expect(result.captureCharFrame()).not.toContain("Cancel")
    } finally { result.renderer.destroy() }
  })

  it.each(["default", "environment"] as const)("renders the profile scope and available actions for %s selection", async (source) => {
    const rows = buildAuthRows([], { id: "default", displayName: "Default", source, availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] }, "New Session Defaults", false, undefined, undefined, { enabled: true, changing: false, feedback: "Save failed" })
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "list" },
          rows,
          cursor: 0,
          inputPresentation: EMPTY_PRESENTATION,
          onSelect: noOp,
          onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Profile: Default")
      expect(frame).toContain("1/2")
      expect(frame).toContain("New Session Defaults")
      expect(frame).toContain("[x] Enable new models automatically for this profile")
      expect(frame).toContain("Save failed")
      expect(frame).toContain("a auto models")
      if (source === "environment") {
        expect(frame).toContain("FLYWHEEL_AUTH_PROFILE locks profile changes")
        for (const action of ["cycle", "g scope", "n new", "r rename", "d delete"]) expect(frame).not.toContain(action)
      } else {
        expect(frame).toContain("n new")
        expect(frame).toContain("d delete")
      }
    } finally { result.renderer.destroy() }
  })
})

describe("AuthModal provider settings", () => {
  it("renders invalid auth as Needs attention in the provider list", async () => {
    const option = {
      id: "anthropic_api" as const, label: "Anthropic API Key", kind: "singleton" as const, source: "invalid" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
    }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows: buildAuthRows([option]), cursor: 1, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 72, height: 14 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Anthropic API Key")
      expect(frame).toContain("needs attention")
      expect(frame).not.toContain(" invalid")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the same intermediary settings surface for a configured API provider", async () => {
    const option = {
      id: "anthropic_api" as const, label: "Anthropic API Key", kind: "singleton" as const, source: "stored_key" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
      keyHint: "••••wxyz", catalog: { kind: "available" as const, provenance: "first-party" as const, liveOutcome: "valid" as const },
    }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-settings", option, target: { kind: "provider", modelTarget: { kind: "singleton", providerId: option.id } }, originCursor: 1 }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Authentication › Anthropic API Key")
      expect(frame).toContain("ACCOUNT")
      expect(frame).toContain("Status   Active")
      expect(frame).toContain("API key  ••••wxyz")
      expect(frame).not.toContain("Catalog")
      expect(frame).toContain("Models enter")
      expect(frame).toContain("r reconnect · d disconnect · ← back")
      expect(frame).not.toContain("enter/m models")
      expect(frame).not.toContain("PAID USE")
      expect(frame).not.toContain("Include and prefer free routes")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the exact-account OpenRouter free-route preference", async () => {
    const option = {
      id: "openrouter" as const, label: "OpenRouter API Key", kind: "singleton" as const, source: "stored_key" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
    }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: {
            kind: "provider-settings",
            option,
            target: { kind: "provider", modelTarget: { kind: "singleton", providerId: option.id } },
            originCursor: 1,
            freeRoutes: { enabled: true, eligibilityRevision: 2, changing: false },
          },
          rows: [],
          cursor: 0,
          inputPresentation: EMPTY_PRESENTATION,
          onSelect: noOp,
          onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("ROUTING")
      expect(frame).toContain("[x] Include and prefer free routes")
      expect(frame).toContain("f free routes · r reconnect")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps auth-invalid account and catalog status consistent", async () => {
    const catalog = { kind: "unavailable" as const, reason: "authentication-invalid" as const, discoveryReason: "timeout" as const }
    const account = { instanceId: "account", accountCorrelationId: "opaque", identity: "me@example.com", displayLabel: "me@example.com", expired: false, source: "oauth" as const, catalog }
    const option = {
      id: "github_copilot" as const, label: "GitHub Copilot", kind: "subscription" as const, source: "oauth" as const, expired: false,
      loginMethod: "device-code" as const, modelSelectionAvailable: true, accounts: [account], capabilityAccounts: [], group: "model" as const, catalog,
    }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "provider-settings", option, target: { kind: "account", account, modelTarget: { kind: "subscription", providerId: option.id, accountCorrelationId: "opaque" } }, originCursor: 1 },
          rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 72, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Status   Needs attention · reconnect to continue")
      expect(frame).toContain("Catalog  Authentication invalid · Discovery timed out")
      expect(frame).toContain("Discovery timed out")
      expect(frame).not.toContain("Status   Active")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders provider attention in Authentication and Provider Settings", async () => {
    const option = {
      id: "github_copilot" as const, label: "GitHub Copilot", kind: "subscription" as const, source: "oauth" as const, expired: false,
      loginMethod: "device-code" as const, modelSelectionAvailable: true, accounts: [{ instanceId: "account", accountCorrelationId: "opaque", identity: "account", displayLabel: "Account", expired: false, source: "oauth" as const }], capabilityAccounts: [], group: "model" as const,
      attention: { kind: "malformed" as const, message: "Stored authentication data is malformed." },
    }
    const capabilityAccount = { accountCorrelationId: "opaque", providerId: "github_copilot", providerDisplayName: "GitHub Copilot", label: "Account", providerStatus: "exhausted" as const, modes: [] }
    const rows = buildAuthRows([option]).map((row) => row.kind === "provider" ? { ...row, capabilityAccount } : row)
    const list = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows, cursor: 1, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 80, height: 20 })
    const settings = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "provider-settings", option, target: { kind: "account", account: option.accounts[0]!, modelTarget: { kind: "subscription", providerId: option.id, accountCorrelationId: "opaque" } }, originCursor: 1, attentionPath: "/profile/auth.json" }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 80, height: 20 })
    try {
      await list.renderOnce()
      expect(list.captureCharFrame()).toContain("needs attention · usage Exhausted")
      const status = list.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("needs attention · usage Exhausted"))
      expect(status?.fg.equals(resolveTheme(flywheelTheme, "dark").warning)).toBe(true)
      await settings.renderOnce()
      const settingsFrame = settings.captureCharFrame()
      expect(settingsFrame).toContain("Status               Needs attention")
      expect(settingsFrame).not.toContain("reconnect to continue")
      expect(settingsFrame).toContain("Attention            Stored authentication data is malformed.")
      expect(settingsFrame).toContain("Authentication file  /profile/auth.json")
    } finally {
      list.renderer.destroy()
      settings.renderer.destroy()
    }
  })

  it("names a Claude account's plan on its row, and a refused login tells the person to log in again", async () => {
    const refused = { kind: "login-rejected" as const, message: "Claude refused the login of person@example.com in this profile. Log in again." }
    const person = { instanceId: "uuid-person", accountCorrelationId: "opaque-person", identity: "person@example.com", displayLabel: "person@example.com", plan: "Claude Max", expired: true, source: "oauth" as const, attention: refused }
    const other = { instanceId: "uuid-other", accountCorrelationId: "opaque-other", identity: "other@example.com", displayLabel: "other@example.com", plan: "Claude Pro", expired: false, source: "oauth" as const }
    const option = {
      id: "claude_agent_sdk" as const, label: "Anthropic Subscription", kind: "subscription" as const, source: "oauth" as const, expired: false,
      loginMethod: "browser-auth" as const, modelSelectionAvailable: true, accounts: [person, other], capabilityAccounts: [], group: "model" as const,
    }
    const list = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows: buildAuthRows([option]), cursor: 2, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 80, height: 20 })
    const settings = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "provider-settings", option, target: { kind: "account", account: person, modelTarget: { kind: "subscription", providerId: option.id, accountCorrelationId: "opaque-person" } }, originCursor: 2 }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 100, height: 20 })
    try {
      await list.renderOnce()
      const lines = list.captureCharFrame().split("\n")
      expect(lines.find((line) => line.includes("person@example.com"))).toMatch(/└ person@example\.com · Claude Max\s+needs attention/)
      expect(lines.find((line) => line.includes("other@example.com"))).toMatch(/└ other@example\.com · Claude Pro\s+active/)
      await settings.renderOnce()
      const frame = settings.captureCharFrame().replace(/[│\s]+/g, " ")
      expect(frame).toContain("Status Needs attention")
      expect(frame).toContain(`Attention ${refused.message}`)
      expect(frame).toContain("Plan Claude Max")
    } finally {
      list.renderer.destroy()
      settings.renderer.destroy()
    }
  })

  it("renders wrapped file attention after the profile row", async () => {
    const path = "/a/very/long/profile/directory/whose/authentication/file/path/is/selectable/auth.json"
    const rows = buildAuthRows([], { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] }, "New Session Defaults", false, undefined, { kind: "malformed", path, message: "The authentication file is malformed." })
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows, cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame.indexOf("Authentication file needs attention")).toBeGreaterThan(frame.indexOf("Profile: Default"))
      expect(frame).toContain("auth.json")
      expect(result.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("Authentication file needs attention"))).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("AuthModal attention footers", () => {
  it("advertises provider actions for singleton attention and account actions for multi-account attention, with rename only where the account takes a label", async () => {
    const account = { instanceId: "account", accountCorrelationId: "opaque", identity: "account", displayLabel: "Account", expired: false, source: "oauth" as const }
    const singleton = {
      id: "anthropic_api" as const, label: "Anthropic", kind: "singleton" as const, source: "stored_key" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
      attention: { kind: "malformed" as const, message: "Malformed." },
    }
    const multi = { ...singleton, id: "chatgpt" as const, kind: "subscription" as const, source: "oauth" as const, loginMethod: "browser-auth" as const, accounts: [account, { ...account, instanceId: "other" }] }
    // An external login names each account by its email and takes no label, so its account row offers no rename.
    const external = { ...multi, id: "claude_agent_sdk" as const, label: "Anthropic Subscription", loginProgram: "Example CLI" }
    const singletonRows = buildAuthRows([singleton])
    const multiRows = buildAuthRows([multi])
    const externalRows = buildAuthRows([external])
    const singletonResult = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows: singletonRows, cursor: 1, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp }) } }), { width: 80, height: 20 })
    const multiResult = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows: multiRows, cursor: 2, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp }) } }), { width: 80, height: 20 })
    const externalResult = await testRender(() => createComponent(ThemeProvider, { mode: "dark", get children() { return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows: externalRows, cursor: 2, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp }) } }), { width: 80, height: 20 })
    try {
      await singletonResult.renderOnce()
      await multiResult.renderOnce()
      await externalResult.renderOnce()
      expect(singletonResult.captureCharFrame()).toContain("enter provider settings")
      expect(singletonResult.captureCharFrame()).toContain("d disconnect")
      expect(singletonResult.captureCharFrame()).not.toContain("r rename")
      expect(singletonResult.captureCharFrame()).not.toContain("a add")
      expect(multiResult.captureCharFrame()).toContain("enter provider settings  r rename  d disconnect  a add")
      expect(externalResult.captureCharFrame()).toContain("enter provider settings  d disconnect  a add")
      expect(externalResult.captureCharFrame()).not.toContain("r rename")
    } finally {
      singletonResult.renderer.destroy()
      multiResult.renderer.destroy()
      externalResult.renderer.destroy()
    }
  })

  it("keeps a realistic authentication path fully visible and selectable", async () => {
    const path = "/Users/person/Library/Application Support/Flywheel/profiles/default/auth.json"
    const option = {
      id: "anthropic_api" as const, label: "Anthropic", kind: "singleton" as const, source: "stored_key" as const, expired: false,
      loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const,
      attention: { kind: "malformed" as const, message: "Stored authentication data is malformed." },
    }
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "provider-settings", option, target: { kind: "provider", modelTarget: { kind: "singleton", providerId: option.id } }, originCursor: 1, attentionPath: path }, rows: [], cursor: 0, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("/Users/person/Library/Application Support/Flywheel/")
      expect(frame).toContain("profiles/default/auth.json")
      expect(frame).not.toContain("...")
      expect(result.captureSpans().lines.flatMap((line) => line.spans).some((span) => span.text.includes("auth.json"))).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("AuthModal subscription rows", () => {
  const account = (instanceId: string, displayLabel: string) => ({ instanceId, accountCorrelationId: `opaque-${instanceId}`, identity: displayLabel, displayLabel, expired: false, source: "oauth" as const })
  const option = (accounts: ReturnType<typeof account>[]) => ({
    id: "chatgpt" as const,
    label: "ChatGPT Subscription",
    kind: "subscription" as const,
    source: "oauth" as const,
    expired: false,
    loginMethod: "browser-auth" as const,
    modelSelectionAvailable: true,
    accounts,
    capabilityAccounts: [],
    group: "model" as const,
  })

  it("aligns grouped and singleton providers at the same root column", async () => {
    const singleton = { id: "anthropic_api" as const, label: "Anthropic API Key", kind: "singleton" as const, source: "stored_key" as const, expired: false, loginMethod: "api-key" as const, modelSelectionAvailable: true, accounts: [], capabilityAccounts: [], group: "model" as const }
    const rows = buildAuthRows([singleton, option([account("account-1", "personal"), account("account-2", "work")])])
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() { return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows, cursor: 1, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp }) },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const singletonColumn = lines.find((line) => line.includes(singleton.label))?.indexOf(singleton.label)
      const groupedColumn = lines.find((line) => line.includes("ChatGPT Subscription"))?.indexOf("ChatGPT Subscription")
      const accountColumn = lines.find((line) => line.includes("personal"))?.indexOf("personal")
      expect(singletonColumn).toBeGreaterThanOrEqual(0)
      expect(groupedColumn).toBe(singletonColumn)
      expect(accountColumn ?? -1).toBeGreaterThan(groupedColumn ?? -1)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders one subscription as the compact provider row", async () => {
    const rows = buildAuthRows([option([account("account-1", "legacy")])])
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "list" },
          rows,
          cursor: 1,
          inputPresentation: EMPTY_PRESENTATION,
          onSelect: noOp,
          onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("ChatGPT Subscription")
      expect(frame).not.toContain("legacy")
      expect(frame).not.toContain("r rename")
      expect(frame).toContain("d disconnect  a add")
      expect(frame).toContain("enter provider settings")
      expect(frame).not.toContain("enter adjust models")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders nested account rows after a second subscription is added", async () => {
    const rows = buildAuthRows([option([account("account-1", "legacy"), account("account-2", "work")])])
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "list" },
          rows,
          cursor: 2,
          inputPresentation: EMPTY_PRESENTATION,
          onSelect: noOp,
          onClose: noOp,
        })
      },
    }), { width: 80, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("└ legacy")
      expect(frame).toContain("└ work")
      expect(frame).toContain("r rename")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps account status visible when its label is long at width 40", async () => {
    const rows = buildAuthRows([option([
      account("account-1", "an extremely long personal account label"),
      account("account-2", "another account"),
    ])])
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {}, view: { kind: "list" }, rows, cursor: 2, inputPresentation: EMPTY_PRESENTATION, onSelect: noOp, onClose: noOp })
      },
    }), { width: 40, height: 20 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("active")
      expect(frame).not.toContain("extremely long personal account label")
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("AuthModal controlled input", () => {
  it("keeps a long masked API key inside the modal frame", async () => {
    const result = await testRender(() => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(AuthModal, { onAnswerLoginQuestion: () => {},
          view: { kind: "api-key-input", providerId: "anthropic_api", label: "Anthropic" },
          rows: [], cursor: 0, inputPresentation: { value: "*".repeat(120), cursor: 120, selection: null, preferredVisualColumn: null }, onSelect: noOp, onClose: noOp,
        })
      },
    }), { width: 60, height: 10 })
    try {
      await result.renderOnce()
      const inputLine = result.captureCharFrame().split("\n").find((line) => line.includes("****"))
      expect(inputLine?.match(/│/g)?.length).toBe(4)
    } finally {
      result.renderer.destroy()
    }
  })
})
