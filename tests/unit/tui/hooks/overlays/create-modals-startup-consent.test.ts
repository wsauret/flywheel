import { afterEach, expect, mock, spyOn, test } from "bun:test"
import { createRoot, createSignal, type Accessor } from "solid-js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import type { RuntimeClient, RuntimeQuery } from "../../../../../src/protocol/app-service-types.js"
import type { RuntimeAuthLoginQuestion, RuntimeAuthView } from "../../../../../src/protocol/auth-status-protocol-types.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { createModalModals, inspectActiveProfileConsent } from "../../../../../src/tui/hooks/overlays/create-modals.js"
import { createShellState } from "../../../../../src/tui/hooks/state/shell-state.js"
import { useLoginQuestion } from "../../../../../src/tui/hooks/overlays/questions/use-login-question.js"
import { kernelModalControllers } from "../../../../../src/tui/modals/lazy-modal-registry.js"
import { signInPage } from "../../../../../src/tui/terminal-attach.js"
import { testDirectories } from "../../../../helpers/directories.js"
import { fakeLanes } from "../../../../helpers/fake-lanes.js"
import { runtimeDispatch, runtimeQuery } from "../../../../helpers/runtime-dispatch.js"

const accountCorrelationId = "account-correlation"
const originalDialogPolicy = process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
afterEach(() => {
  mock.restore()
  if (originalDialogPolicy === undefined) delete process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS
  else process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = originalDialogPolicy
})
const auth: RuntimeAuthView = {
  profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }] },
  providers: [],
  warnings: [],
  subscriptionSpendConsent: {
    kind: "available",
    profileId: "default",
    usageGeneration: 1,
    authorityIncarnation: "authority",
    authorityRevision: 1,
    accounts: [{
      providerId: "chatgpt",
      providerDisplayName: "ChatGPT",
      accountCorrelationId,
      providerStatus: "ok",
      modes: [{ mode: "prepaid", envelopeId: "subscription", evidence: { kind: "prepaid", availability: "available" }, decision: "unreviewed" }],
    }],
  },
}

/** A runtime query that records each request and answers it with the auth snapshot at position 17, the only query this hook makes. */
function snapshotQuery(record: (request: RuntimeQuery) => void): RuntimeClient["query"] {
  return runtimeQuery({ authStatusSnapshot: async (request) => {
    record(request)
    return { auth, snapshotPosition: 17 }
  } })
}

test("startup asks the paid-use question from the cached consent snapshot without joining auth refresh", async () => {
  const requests: Array<{ kind: "query" | "dispatch"; type: string }> = []
  const opened: unknown[][] = []
  const appService = {
    query: snapshotQuery((request) => { requests.push({ kind: "query", type: request.type }) }),
    dispatch: (request) => {
      requests.push({ kind: "dispatch", type: request.type })
      return new Promise<never>(() => {})
    },
  } satisfies Pick<RuntimeClient, "query" | "dispatch">

  await inspectActiveProfileConsent({
    appService,
    auth: () => auth,
    authScope: () => ({ kind: "session", sessionId: "session-1" }),
    agentState: () => "idle",
    showRefreshFailure: () => {},
    openPaidUseQuestion: async (...args) => { opened.push(args); return true },
  }, false)

  expect(requests).toEqual([{ kind: "query", type: "authStatusSnapshot" }])
  expect(opened).toEqual([[auth, 17, expect.objectContaining({ providerId: "chatgpt", accountCorrelationId })]])
})

test.each(["1", "0"])("automatic profile review preserves refresh with suppression %s", async (flag) => {
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = flag
  const requests: string[] = []
  const opened: unknown[][] = []
  const appService = {
    dispatch: runtimeDispatch({ "auth.refresh": async (request) => { requests.push(request.type); return { ok: true } } }),
    query: snapshotQuery((request) => { requests.push(request.type) }),
  } satisfies Pick<RuntimeClient, "query" | "dispatch">

  await inspectActiveProfileConsent({
    appService, auth: () => auth, authScope: () => ({ kind: "session", sessionId: "session-1" }),
    agentState: () => "idle", showRefreshFailure: () => {},
    openPaidUseQuestion: async (...args) => { opened.push(args); return true },
  }, true, true)

  expect(requests).toEqual(["auth.refresh", "authStatusSnapshot"])
  expect(opened).toEqual(flag === "1" ? [] : [[auth, 17, expect.objectContaining({ providerId: "chatgpt", accountCorrelationId })]])
})

const refuse = async (): Promise<never> => { throw new Error("not reached in this test") }
const launcher: LauncherScope = {
  spawnOwned: () => { throw new Error("no process launch in this test") },
  adoptOwned: () => { throw new Error("no command adoption in this test") },
  open: () => launcher,
  close: async () => ({ settled: true, terminated: 0, remaining: 0 }),
}
const fontStatus = { installed: true, installedFiles: [], missingFiles: [], sourceDir: "/scratch/fonts-source", targetDir: "/scratch/fonts", installable: false }

/** Spies on every kernel controller module load; each spy still loads the real module. */
function spyOnControllerLoads() {
  const isController = (key: string): key is keyof typeof kernelModalControllers => Object.hasOwn(kernelModalControllers, key)
  return Object.fromEntries(Object.keys(kernelModalControllers).filter(isController).map((key) => [key, spyOn(kernelModalControllers, key)]))
}

/** The kernel modals over a shell state whose runtime answers nothing, as at startup. */
function startModals(published: Accessor<RuntimeAuthView | undefined>) {
  const appService = {
    query: async () => { throw new Error("no runtime query in this test") },
    dispatch: async () => { throw new Error("no runtime mutation in this test") },
    subscribe: () => () => {},
    ...fakeLanes().client,
  }
  const runtimeConfig = { view: () => undefined, settlePublication: async () => false }
  const { signals, services } = createShellState({ appService, runtimeConfig, now: () => 0, projectRoot: "/scratch/flywheel-test", setTerminalTitle: () => {}, showToast: () => {} })
  const modal = createModalStack()
  const modals = createModalModals({
    directories: testDirectories(process.cwd()), launcher, clipboard: { copy: async () => {}, readImage: async () => null }, modal,
    signals: { ...signals, auth: published }, services, appService,
    tabs: () => [], activeSessionCount: () => 0, appVersion: "test", currentThemeName: () => "flywheel",
    startChat: refuse, switchForeground: refuse, activateSession: refuse, activateSessionById: refuse, closeSessionTab: () => {}, closeChat: refuse,
    settings: services.settings, runtimeConfig, settingsOperations: { getFontStatus: () => fontStatus, installBundledFont: refuse, fontInstallSummary: () => "" },
    signInPage: signInPage({ kind: "local" }), onPaletteActivate: () => {}, commands: () => [],
    moduleStatusRows: () => [], refreshModuleStatus: () => {}, moduleSettingsRows: () => [], activateModuleRow: () => {},
    navigateToProcess: () => {}, openTarget: refuse,
  })
  return { modal, modals }
}

test("startup loads no kernel modal controller, and the first sessions open loads and creates its controller once", async () => {
  const loadSessions = kernelModalControllers.sessions
  const loads = spyOnControllerLoads()
  let created = 0
  loads.sessions?.mockImplementation(async () => {
    const loaded = await loadSessions()
    return { ...loaded, useSessionModal: (...args: Parameters<typeof loaded.useSessionModal>) => { created += 1; return loaded.useSessionModal(...args) } }
  })
  await createRoot(async (dispose) => {
    const { modal, modals } = startModals(() => undefined)
    expect(Object.values(loads).map((load) => load.mock.calls.length)).toEqual(Object.keys(loads).map(() => 0))

    await modals.openSessionsModal()
    await modals.openSessionsModal()

    expect(created).toBe(1)
    expect(Object.entries(loads).filter(([, load]) => load.mock.calls.length > 0).map(([key, load]) => [key, load.mock.calls.length])).toEqual([["sessions", 1]])
    expect(modal.stack).toHaveLength(1)
    expect(modals.opening()).toBe(false)
    dispose()
  })
})

test("a first open whose controller still loads does not present after a later open or a withdrawn command", async () => {
  const loadSessions = kernelModalControllers.sessions
  const loads = spyOnControllerLoads()
  await createRoot(async (dispose) => {
    const { modal, modals } = startModals(() => undefined)
    const sessionsGate = Promise.withResolvers<void>()
    loads.sessions?.mockImplementation(async () => { await sessionsGate.promise; return loadSessions() })

    // The person asks for Sessions, then for the shortcuts while Sessions still loads.
    const overtaken = modals.surfaces.sessions({})
    await modals.surfaces["keyboard-shortcuts"]({})
    sessionsGate.resolve()
    await overtaken
    // Of the two, only the sessions modal records a route.
    expect(modal.stack.map((entry) => entry.route === undefined ? "shortcuts" : "sessions")).toEqual(["shortcuts"])

    // A command whose presentation is withdrawn while its controller loads opens nothing.
    modal.clear()
    let current = true
    const withdrawn = modals.surfaces.status({ isCurrent: () => current })
    current = false
    await withdrawn
    expect(modal.stack).toHaveLength(0)
    expect(modals.opening()).toBe(false)
    dispose()
  })
})

test("an automatic login question still opens at startup through the lazily loaded auth controller", async () => {
  process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS = "0"
  const question: RuntimeAuthLoginQuestion = { questionId: "episode", providerId: "claude_agent_sdk", instanceId: "account", profileId: "default", profileDisplayName: "Default", providerDisplayName: "Anthropic Subscription", accountDisplayName: "personal@example.com" }
  const loadAuth = kernelModalControllers.auth
  const loads = spyOnControllerLoads()
  const authViews: Array<() => { readonly kind: string }> = []
  const authCreated = Promise.withResolvers<void>()
  loads.auth?.mockImplementation(async () => {
    const loaded = await loadAuth()
    return { ...loaded, useAuthModal: (...args: Parameters<typeof loaded.useAuthModal>) => {
      const controller = loaded.useAuthModal(...args)
      authViews.push(controller.authView)
      authCreated.resolve()
      return controller
    } }
  })
  await createRoot(async (dispose) => {
    const [published] = createSignal<RuntimeAuthView | undefined>({ ...auth, loginQuestions: [question] })
    const { modal, modals } = startModals(published)
    const undelivered: string[] = []
    useLoginQuestion({ auth: published, overlayOpen: () => modal.stack.length > 0 || modals.opening(), open: (questionId, onUndelivered) => modals.openLoginQuestion(questionId, () => { undelivered.push(questionId); onUndelivered() }) })

    await Promise.resolve()
    // While the controller loads, the screen counts as occupied for the other automatic questions.
    expect(modals.opening()).toBe(true)
    await authCreated.promise
    await Bun.sleep(0)

    expect(undelivered).toEqual([])
    expect(loads.auth?.mock.calls).toHaveLength(1)
    expect(authViews.map((view) => view().kind)).toEqual(["login-question"])
    // The settings root sits under the question, so the left arrow returns there.
    expect(modal.stack).toHaveLength(2)
    dispose()
  })
})
