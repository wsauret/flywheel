import { expect, test } from "bun:test"
import { Redacted } from "effect"
import { createAuthModalLoginQuestion } from "../../../../src/tui/hooks/auth-modal-login-question.js"
import type { AuthModalDeps } from "../../../../src/tui/hooks/auth-modal-types.js"
import type { AuthView } from "../../../../src/tui/hooks/auth-modal-options.js"
import type { RuntimeAuthView, RuntimeAuthLoginQuestion } from "../../../../src/protocol/auth-status-protocol-types.js"
import { createRoot, createSignal } from "solid-js"
import { createModal, LOCAL_SIGN_IN } from "./auth-modal-test-harness.js"
import { signInPage } from "../../../../src/tui/terminal-attach.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch } from "../../../helpers/runtime-dispatch.js"
import { useLoginQuestion } from "../../../../src/tui/hooks/use-login-question.js"
import { useAutomaticAuth } from "../../../../src/tui/hooks/automatic-dialogs.js"
import { SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE } from "../../../../src/protocol/subscription-spend-consent-protocol-types.js"

const question: RuntimeAuthLoginQuestion = { questionId: "episode", providerId: "claude_agent_sdk", instanceId: "account", profileId: "personal", profileDisplayName: "Personal", providerDisplayName: "Anthropic Subscription", accountDisplayName: "personal@example.com" }
function auth(settlement?: RuntimeAuthView["settlement"], questions = [question]): RuntimeAuthView {
  return { providers: [], warnings: [], authFilePath: "/scratch/auth.json", profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [] }, subscriptionSpendConsent: { kind: "unavailable", profileId: "default", message: SUBSCRIPTION_SPEND_DETECTION_FAILURE_MESSAGE }, loginQuestions: questions, ...(settlement === undefined ? {} : { settlement }) }
}
const acknowledge = async () => ({ ok: true as const })
function fixture(response: Promise<import("../../../../src/protocol/auth-login-protocol-types.js").RuntimeAuthLoginResult> = Promise.resolve({ kind: "browser", providerId: question.providerId, operationId: "op", authorizeUri: "https://example.com/login" }), page = LOCAL_SIGN_IN) {
  let view: AuthView = { kind: "list" }
  let currentAuth = auth()
  let closes = 0
  const requests: Parameters<AuthModalDeps["appService"]["dispatch"]>[0][] = []
  const toasts: unknown[] = []
  const dispatch = recordedDispatch((request) => { requests.push(request) }, runtimeDispatch({
    "auth.login": () => response,
    "auth.login.decline": acknowledge, "auth.login.complete": acknowledge, "auth.login.cancel": acknowledge,
  }))
  const opened: string[] = []
  const helper = createAuthModalLoginQuestion({ auth: () => currentAuth, dispatch, showToast: (toast) => { toasts.push(toast) }, signInPage: page, openSignInPage: (url) => { if (page.opensLocally) opened.push(url) }, setView: (next) => { view = next }, prepareInput: () => {}, close: () => { closes++; helper.cancel() } })
  return { helper, dispatch, requests, toasts, opened, view: () => view, closes: () => closes, publish: (next: RuntimeAuthView) => { currentAuth = next; helper.observe(next) } }
}
async function tick() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

test.each(["0", "1"])("automatic provider setup preserves an occupied API-key editor with suppression %s", async (suppression) => {
  const previous = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = suppression
  try {
    await createRoot(async (dispose) => {
      const provider = { providerId: "anthropic_api", displayName: "Anthropic API Key", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 0, group: "model", accounts: [] } as const
      const none = { ...auth(undefined, []), providers: [provider] }
      const usable: RuntimeAuthView = { ...none, providers: [provider, { ...provider, providerId: "openai_api", source: "stored_key" }] }
      const [published, publish] = createSignal<RuntimeAuthView | undefined>()
      const { modal, modals } = createModal("default", published)
      let shown = 0
      try {
        publish(usable)
        modal.openAuthModal()
        modal.selectProvider(modal.authRows().findIndex(row => row.kind === "provider"))
        modals.input({ name: "x", sequence: "x" })
        const draft = modal.authInputPresentation()
        expect(modal.authView().kind).toBe("api-key-input")
        expect(draft.value).toBe("*")
        expect(modal.apiKeyDraft()).toBe("x")
        useAutomaticAuth({ auth: published, overlayOpen: () => modals.stack.length > 0, open: () => { shown++; modal.openAuthModal() } })
        await tick()
        publish(none)
        await tick()
        expect(modal.authView().kind).toBe("api-key-input")
        expect(modal.authInputPresentation()).toEqual(draft)
        expect(modal.apiKeyDraft()).toBe("x")
        expect(shown).toBe(0)
        const blocker = modals.replace("another overlay")
        await tick()
        expect(blocker.isOpen()).toBe(true)
        expect(shown).toBe(0)
        publish(usable)
        await tick()
        modals.dismiss()
        await tick()
        expect(shown).toBe(0)
        publish(none)
        await tick()
        expect(shown).toBe(suppression === "1" ? 0 : 1)
        modals.dismiss()
        publish(structuredClone(none))
        await tick()
        expect(shown).toBe(suppression === "1" ? 0 : 1)
        modal.openAuthModal()
        modal.selectProvider(modal.authRows().findIndex(row => row.kind === "provider"))
        expect(modal.authView().kind).toBe("api-key-input")
        modal.openAuthModal()
        expect(modal.authView().kind).toBe("list")
      } finally { dispose() }
    })
  } finally {
    if (previous === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
    else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = previous
  }
})

test("automatic questions retain episode identity across scopes and queue behind the current modal", async () => {
  const previous = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "0"
  try {
    await createRoot(async (dispose) => {
      const second = { ...question, questionId: "second" }
      const [published, setPublished] = createSignal<RuntimeAuthView | undefined>(auth(undefined, [question, second]))
      const f = fixture()
      const { modal, modals } = createModal("default", published, { appService: { dispatch: f.dispatch, query: async () => { throw new Error("unexpected query") }, subscribe: () => () => {}, onLane: fakeLanes().onLane } })
      const shown: string[] = []
      const blocker = modals.replace("another modal")
      useLoginQuestion({ auth: published, overlayOpen: () => modals.stack.length > 0, open: (id) => { shown.push(id); return modal.openLoginQuestion(id) } })
      try {
        await tick()
        expect(shown).toEqual([])
        blocker.close()
        await tick()
        expect(shown).toEqual(["episode"])
        expect(modal.authView()).toMatchObject({ kind: "login-question", question })
        setPublished(undefined)
        await tick()
        setPublished({ ...auth(undefined, [question, second]), profile: { ...auth().profile, id: "other" } })
        await tick()
        expect(shown).toEqual(["episode"])
        modals.input({ name: "right" })
        modals.input({ name: "return" })
        await tick()
        expect(shown).toEqual(["episode", "second"])
        expect(f.requests[0]).toMatchObject({ type: "auth.login.decline", loginQuestionId: "episode" })
        setPublished(auth(undefined, []))
        await tick()
        expect(modals.stack).toHaveLength(0)
        expect(f.requests).toHaveLength(1)
        setPublished(auth(undefined, [{ ...question, questionId: "renewed-episode" }]))
        await tick()
        expect(shown).toEqual(["episode", "second", "renewed-episode"])
        dispose()
        setPublished(auth(undefined, [{ ...question, questionId: "after-disposal" }]))
        await tick()
        expect(shown).toHaveLength(3)
      } finally { dispose() }
    })
  } finally {
    if (previous === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
    else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = previous
  }
})

test("verification suppresses automatic questions without preventing Auth-row login", async () => {
  const previous = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "1"
  try {
    await createRoot(async (dispose) => {
      const f = fixture()
      const provider = { providerId: "anthropic_api", displayName: "Anthropic API Key", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 0, group: "model", accounts: [] } as const
      const { modal, modals } = createModal("default", () => ({ ...auth(), providers: [provider] }), { appService: { dispatch: f.dispatch, query: async () => { throw new Error("unexpected query") }, subscribe: () => () => {}, onLane: fakeLanes().onLane } })
      let presentations = 0
      useLoginQuestion({ auth: () => auth(), overlayOpen: () => modals.stack.length > 0, open: (id) => { presentations++; return modal.openLoginQuestion(id) } })
      try {
        await tick()
        expect(presentations).toBe(0)
        modal.openAuthModal()
        const row = modal.authRows().findIndex((candidate) => candidate.kind === "provider" && candidate.option.id === provider.providerId)
        modal.selectProvider(row)
        await tick()
        expect(modal.authView().kind).toBe("api-key-input")
      } finally { dispose() }
    })
  } finally {
    if (previous === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
    else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = previous
  }
})

test("a terminal attached through the relay lets no runtime open the page, opens it where the person sits, and takes the pasted code", async () => {
  const f = fixture(undefined, signInPage({ kind: "relay" }))
  f.helper.open(question)
  f.helper.answer(true)
  await tick()
  expect(f.requests[0]).toEqual({ type: "auth.login", providerId: question.providerId, instanceId: question.instanceId, loginQuestionId: question.questionId })
  expect(f.view()).toMatchObject({ kind: "browser-auth", url: "https://example.com/login" })
  expect(f.opened).toEqual(["https://example.com/login"])
  expect(f.helper.submit("code")).toBe(true)
  expect(f.requests.filter((request) => request.type === "auth.login.complete")).toHaveLength(1)
})

test("uses the exact hidden-profile question, accepts one code and correlates settlement", async () => {
  const f = fixture()
  f.helper.open(question)
  expect(f.view()).toMatchObject({ kind: "login-question", choice: "login", question })
  f.helper.answer(true)
  await tick()
  expect(f.requests[0]).toEqual({ type: "auth.login", providerId: question.providerId, instanceId: question.instanceId, loginQuestionId: question.questionId, openBrowser: true })
  expect(f.view()).toMatchObject({ kind: "browser-auth", url: "https://example.com/login" })
  expect(f.helper.submit("code")).toBe(true)
  f.helper.submit("second code")
  const codes = f.requests.filter((request) => request.type === "auth.login.complete")
  expect(codes).toHaveLength(1)
  if (codes[0]?.type === "auth.login.complete") expect(Redacted.value(codes[0].input)).toBe("code")
  f.publish(auth({ kind: "completed", operationId: "other", providerId: question.providerId }, []))
  expect(f.closes()).toBe(0)
  f.publish(auth({ kind: "completed", operationId: "op", providerId: question.providerId }, []))
  expect(f.closes()).toBe(1)
  expect(f.toasts).toHaveLength(1)
  expect(f.requests.filter((request) => request.type === "auth.login.cancel")).toEqual([])
})

test("declines once on close, but owner removal closes without a mutation", () => {
  const f = fixture()
  f.helper.open(question)
  f.helper.cancel()
  f.helper.cancel()
  expect(f.requests).toEqual([{ type: "auth.login.decline", providerId: question.providerId, loginQuestionId: "episode" }])
  const remote = fixture()
  remote.helper.open(question)
  remote.publish(auth(undefined, []))
  expect(remote.closes()).toBe(1)
  expect(remote.requests).toEqual([])
})

test("close before URL cancels exactly its question and ignores a late response", async () => {
  const pending = Promise.withResolvers<{ readonly kind: "browser"; readonly providerId: string; readonly operationId: string; readonly authorizeUri: string }>()
  const f = fixture(pending.promise)
  f.helper.open(question)
  f.helper.answer(true)
  f.helper.cancel()
  const nextQuestion = { ...question, questionId: "new-episode" }
  f.helper.open(nextQuestion)
  pending.resolve({ kind: "browser", providerId: question.providerId, operationId: "late", authorizeUri: "https://example.com/late" })
  await tick()
  expect(f.view()).toMatchObject({ kind: "login-question", question: nextQuestion })
  expect(f.requests.filter((request) => request.type === "auth.login.cancel")).toEqual([{ type: "auth.login.cancel", loginQuestionId: "episode" }])
})

test.each(["ignored", "failed"] as const)("a %s response closes without cancelling a settled flow", async (kind) => {
  const f = fixture(Promise.resolve(kind === "ignored" ? { kind, providerId: question.providerId } : { kind, providerId: question.providerId, message: "refused again" }))
  f.helper.open(question)
  f.helper.answer(true)
  await tick()
  expect(f.closes()).toBe(1)
  expect(f.toasts).toHaveLength(kind === "ignored" ? 0 : 1)
  expect(f.requests.filter((request) => request.type === "auth.login.cancel")).toEqual([])
})

test.each(["escape", "choice", "frame"] as const)("the modal's %s dismissal declines the asking episode once", async (route) => {
  await createRoot(async (dispose) => {
    const f = fixture()
    const { modal, modals } = createModal("default", () => auth(), { appService: { dispatch: f.dispatch, query: async () => { throw new Error("unexpected query") }, subscribe: () => () => {}, onLane: fakeLanes().onLane } })
    try {
      expect(modal.openLoginQuestion("episode")).toBe(true)
      expect(modal.authView()).toMatchObject({ choice: "login" })
      if (route === "choice") { modals.input({ name: "tab" }); modals.input({ name: "return" }) }
      else if (route === "escape") modals.input({ name: "escape" })
      else modals.dismiss()
      expect(f.requests).toEqual([{ type: "auth.login.decline", providerId: question.providerId, loginQuestionId: "episode" }])
      expect(modals.stack).toHaveLength(0)
    } finally { dispose() }
  })
})

test.each(["left", "replace", "dispose"] as const)("the modal's %s route cancels its runtime browser login", async (route) => {
  await createRoot(async (dispose) => {
    const f = fixture()
    const { modal, modals } = createModal("default", () => auth(), { appService: { dispatch: f.dispatch, query: async () => { throw new Error("unexpected query") }, subscribe: () => () => {}, onLane: fakeLanes().onLane } })
    try {
      modal.openLoginQuestion("episode")
      modals.input({ name: "return" })
      await tick()
      expect(modal.authView().kind).toBe("browser-auth")
      if (route === "left") modals.input({ name: "left" })
      else if (route === "replace") modal.openAuthModal()
      else dispose()
      expect(f.requests.filter((request) => request.type === "auth.login.cancel")).toEqual([{ type: "auth.login.cancel", loginQuestionId: "episode", operationId: "op" }])
      if (route === "left") expect(modals.stack).toHaveLength(0)
    } finally { dispose() }
  })
})

test("owner removal is silent across equivalent reactive publications and disposal removes observation", async () => {
  await createRoot(async (dispose) => {
    const f = fixture()
    const [published, setPublished] = createSignal<RuntimeAuthView | undefined>(auth())
    const { modal, modals } = createModal("default", published, { appService: { dispatch: f.dispatch, query: async () => { throw new Error("unexpected query") }, subscribe: () => () => {}, onLane: fakeLanes().onLane } })
    await tick()
    modal.openLoginQuestion("episode")
    setPublished({ ...auth() })
    await tick()
    expect(modal.authView().kind).toBe("login-question")
    setPublished(undefined)
    await tick()
    expect(modals.stack).toHaveLength(1)
    setPublished(auth(undefined, []))
    await tick()
    expect(modals.stack).toHaveLength(0)
    expect(f.requests).toEqual([])
    dispose()
    setPublished(auth())
    await tick()
    expect(modals.stack).toHaveLength(0)
  })
})

test.each(["dark", "light"] as const)("renders account, profile and project consequences with the login action focused in %s", async (mode) => {
  const [{ testRender }, { createComponent }, { ThemeProvider }, { AuthModal }, { resolveTheme }, { default: flywheelTheme }] = await Promise.all([
    import("@opentui/solid"), import("solid-js/web"), import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/modals/auth-modal.js"), import("../../../../src/tui/context/theme/resolve.js"),
    import("../../../../src/tui/context/theme/flywheel.json"),
  ])
  const [view, setView] = createSignal<AuthView>({ kind: "login-question", question, choice: "login" })
  const result = await testRender(() => createComponent(ThemeProvider, { mode, get children() {
    return createComponent(AuthModal, { get view() { return view() }, rows: [], cursor: 0, inputPresentation: { value: "", cursor: 0, selection: null, preferredVisualColumn: null }, onSelect: () => {}, onClose: () => {}, onAnswerLoginQuestion: () => {} })
  } }), { width: 80, height: 24 })
  try {
    await result.renderOnce()
    const frame = result.captureCharFrame()
    const prose = frame.split("\n").map((line) => line.replace(/[│╭╮╰╯─]/g, "").trim()).join(" ")
    expect(frame).toContain("Log in again?")
    expect(prose).toContain("personal@example.com in profile Personal")
    expect(prose).toContain("Later runs on this account also end until a new login.")
    expect(frame).toContain("> Log in again")
    expect(frame).toContain("End waiting runs")
    const theme = resolveTheme(flywheelTheme, mode)
    const spans = result.captureSpans().lines.flatMap((line) => line.spans)
    expect(spans.find((span) => span.text.includes("> Log in again"))?.fg.equals(theme.background)).toBe(true)
    expect(spans.find((span) => span.text.includes("> Log in again"))?.bg.equals(theme.primary)).toBe(true)
    setView({ kind: "login-question", question, choice: "login", submitting: true })
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("esc end waiting runs")
    setView({ kind: "browser-auth", providerId: question.providerId, label: question.providerDisplayName, url: "https://example.com/login", question })
    await result.renderOnce()
    const browser = result.captureCharFrame().replace(/[│\s]+/g, " ")
    expect(browser).toContain("Log in again?")
    expect(browser).toContain("personal@example.com in profile Personal")
    expect(browser).toContain("enter finish login")
    expect(browser).toContain("esc end waiting runs")
    expect(browser).not.toContain("← back")
  } finally { result.renderer.destroy() }
})

test.each(["auth.login", "auth.login.decline"] as const)("an undelivered %s permits the next publication to ask again", async (failedType) => {
  const previous = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "0"
  try {
    await createRoot(async (dispose) => {
      const [published, publish] = createSignal<RuntimeAuthView | undefined>(auth())
      const [occupied, setOccupied] = createSignal(false)
      let shown = 0
      const undelivered = async (): Promise<never> => { throw new Error("transport disconnected") }
      const dispatch = runtimeDispatch({
        "auth.login.decline": acknowledge, "auth.login.complete": acknowledge, "auth.login.cancel": acknowledge,
        ...(failedType === "auth.login" ? { "auth.login": undelivered } : { "auth.login.decline": undelivered }),
      })
      const helper = createAuthModalLoginQuestion({ auth: published, dispatch, signInPage: LOCAL_SIGN_IN, openSignInPage: () => {}, setView: () => {}, prepareInput: () => {}, showToast: () => {}, close: () => setOccupied(false) })
      useLoginQuestion({ auth: published, overlayOpen: occupied, open: (_id, retry) => { shown++; setOccupied(true); helper.open(question, retry); return true } })
      try {
        await tick()
        helper.answer(failedType === "auth.login")
        await tick()
        publish({ ...auth() })
        await tick()
        expect(shown).toBe(2)
      } finally { dispose() }
    })
  } finally {
    if (previous === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
    else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = previous
  }
})
