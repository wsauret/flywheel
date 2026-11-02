import { signInPage } from "../../../../src/tui/terminal-attach.js"
import { mock } from "bun:test"
import { createSignal } from "solid-js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeAuthLoginResult } from "../../../../src/protocol/auth-login-protocol-types.js"
import type { AuthOperationNotice, AuthOperationSettlement, AuthProviderStatus, RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { useAuthModal } from "../../../../src/tui/hooks/use-auth-modal.js"
import type { AuthModalDeps, AuthModalHook } from "../../../../src/tui/hooks/auth-modal-types.js"
import type { ProviderModelView } from "../../../../src/protocol/provider-model-preference-protocol-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { recordedDispatch, runtimeDispatch, runtimeQuery, type DispatchAnswer, type DispatchAnswers, type QueryAnswer, type QueryAnswers } from "../../../helpers/runtime-dispatch.js"

/** A terminal on the runtime's own machine, whose runtime opens each sign-in page. */
export const LOCAL_SIGN_IN = signInPage({ kind: "local" })

type MockAuthStatus = Pick<AuthProviderStatus, "providerId" | "source"> & Partial<Omit<AuthProviderStatus, "providerId" | "source">>
type LoginRequest = Extract<FrontendMutation, { type: "auth.login" }>
type AnswerRequest = Extract<FrontendMutation, { type: "auth.login.answer" }>

let mockAuthStatuses: readonly AuthProviderStatus[] = []
/** The question the Copilot flow asks before it starts, as the runtime reports it. */
export const COPILOT_PROMPT = { message: "GitHub Enterprise URL/domain (blank for github.com)", placeholder: "company.ghe.com", allowEmpty: true } as const

/** How the fake runtime answers `auth.login`, by the flow each shipped provider declares. */
function defaultLogin(request: LoginRequest): RuntimeAuthLoginResult {
  if (request.providerId === "chatgpt") return { kind: "browser", operationId: "chatgpt-operation", providerId: "chatgpt", authorizeUri: "https://auth.openai.com/test" }
  if (request.providerId === "github_copilot") return { kind: "prompt", operationId: "copilot-operation", providerId: "github_copilot", prompt: COPILOT_PROMPT }
  if (request.providerId === "supergrok") return { kind: "device_code", operationId: "supergrok-operation", providerId: "supergrok", verificationUri: "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234" }
  return { kind: "completed", providerId: request.providerId }
}

/** How the fake runtime answers `auth.login.answer`: the Copilot flow shows its device code next. */
function defaultAnswer(request: AnswerRequest): RuntimeAuthLoginResult {
  return { kind: "device_code", operationId: request.operationId, providerId: request.providerId, userCode: "COPI-LOT1", verificationUri: "https://github.com/login/device" }
}

export const runtimeLogin = mock(async (request: LoginRequest): Promise<RuntimeAuthLoginResult> => defaultLogin(request))
export const runtimeAnswer = mock(async (request: AnswerRequest): Promise<RuntimeAuthLoginResult> => defaultAnswer(request))

export const providerModelView: ProviderModelView = {
  profileId: "default",
  eligibilityRevision: 7,
  target: { kind: "singleton", providerId: "anthropic_api" },
  providerDisplayName: "Anthropic API Key",
  catalog: { kind: "available", provenance: "first-party", liveOutcome: "valid" },
  rows: [{ modelId: "claude-opus-4-1", checked: false, optInAvailable: true, configured: false }, { modelId: "claude-sonnet-4", checked: true, optInAvailable: true, configured: false }],
}

const defaultAuthStatuses: AuthProviderStatus[] = [
  { providerId: "anthropic_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 10, group: "model", displayName: "Anthropic API Key", accounts: [] },
  { providerId: "openai_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 20, group: "model", displayName: "OpenAI API Key", accounts: [] },
  { providerId: "opencode_go", kind: "subscription", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 30, group: "model", displayName: "OpenCode Go Subscription", accounts: [] },
  { providerId: "openrouter", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 40, group: "model", displayName: "OpenRouter API Key", accounts: [] },
  { providerId: "google_api", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 50, group: "model", displayName: "Google API Key", accounts: [] },
  { providerId: "google_vertex", kind: "singleton", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "api-key", statusRank: 50, group: "model", displayName: "Google Vertex", accounts: [] },
  { providerId: "chatgpt", kind: "subscription", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "browser-auth", statusRank: 60, group: "model", displayName: "ChatGPT Subscription", accounts: [] },
  { providerId: "github_copilot", kind: "subscription", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "device-code", statusRank: 70, group: "model", displayName: "Copilot Subscription", accounts: [] },
  { providerId: "supergrok", kind: "subscription", source: "unconfigured", expired: false, modelCapable: true, loginMethod: "device-code", statusRank: 80, group: "model", displayName: "SuperGrok Subscription", accounts: [] },
  { providerId: "exa", kind: "connect", source: "unconfigured", expired: false, modelCapable: false, loginMethod: "api-key", statusRank: 0, group: "web", displayName: "Exa API Key", accounts: [] },
]

export function setAuthStatuses(...statuses: MockAuthStatus[]): void {
  mockAuthStatuses = defaultAuthStatuses.map((defaultStatus) => {
    const override = statuses.find((status) => status.providerId === defaultStatus.providerId)
    return override === undefined ? defaultStatus : { ...defaultStatus, ...override }
  })
}

export function currentAuthStatuses(): readonly AuthProviderStatus[] {
  return mockAuthStatuses
}

export function providerOptions(modal: AuthModalHook) {
  return modal.authRows().flatMap((row) => (row.kind === "provider" ? [row.option] : []))
}

export function rowIndexOf(modal: AuthModalHook, id: string): number {
  return modal.authRows().findIndex((row) => row.kind === "provider" && row.option.id === id)
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Bun.sleep(0)
}

export async function clearMocks(): Promise<void> {
  runtimeLogin.mockReset()
  runtimeLogin.mockImplementation(async (request) => defaultLogin(request))
  runtimeAnswer.mockReset()
  runtimeAnswer.mockImplementation(async (request) => defaultAnswer(request))
  setAuthStatuses()
}

function noticeFields(notice: AuthOperationNotice | undefined): Pick<RuntimeAuthView, "settlement" | "progress" | "confirmation"> {
  if (notice === undefined) return {}
  return notice.kind === "progress" ? { progress: notice } : notice.kind === "confirmation" ? { confirmation: notice } : { settlement: notice }
}

/** The fake runtime's answer to each mutation kind the auth modal sends, one
 *  mock per kind, so a test rescripts a kind with an answer of its own type. */
function runtimeAnswers() {
  return {
    "auth.login": runtimeLogin,
    "auth.login.answer": runtimeAnswer,
    "auth.login.cancel": mock<DispatchAnswer<"auth.login.cancel">>(async () => ({ ok: true })),
    "auth.login.complete": mock<DispatchAnswer<"auth.login.complete">>(async () => ({ ok: true })),
    "auth.login.decline": mock<DispatchAnswer<"auth.login.decline">>(async () => ({ ok: true })),
    "auth.account.rename": mock<DispatchAnswer<"auth.account.rename">>(async () => ({ ok: true })),
    "auth.account.disconnect": mock<DispatchAnswer<"auth.account.disconnect">>(async () => ({ ok: true })),
    "auth.refresh": mock<DispatchAnswer<"auth.refresh">>(async () => ({ ok: true })),
    "auth.catalog.refresh": mock<DispatchAnswer<"auth.catalog.refresh">>(async () => ({ ok: true })),
    "auth.profile.rename": mock<DispatchAnswer<"auth.profile.rename">>(async (request) => ({ id: request.id, displayName: request.displayName })),
    "auth.profile.select": mock<DispatchAnswer<"auth.profile.select">>(async (request) => ({ id: request.id })),
    "auth.profile.delete": mock<DispatchAnswer<"auth.profile.delete">>(async (request) => ({ id: request.id })),
    "subscription_spend_consent.save": mock<DispatchAnswer<"subscription_spend_consent.save">>(async () => { throw new Error("No scripted answer for the subscription_spend_consent.save mutation") }),
  } satisfies DispatchAnswers
}

/** The fake runtime's answer to each query kind the auth modal makes, one
 *  mock per kind: the provider's model list, and the auth status of `auth`. */
function queryAnswers(auth: AuthModalDeps["auth"]) {
  return {
    "provider_models.query": mock<QueryAnswer<"provider_models.query">>(async () => providerModelView),
    "authStatusSnapshot": mock<QueryAnswer<"authStatusSnapshot">>(async () => {
      const view = auth()
      if (view === undefined) throw new Error("The auth status has no view to answer with")
      return { auth: view, snapshotPosition: 0 }
    }),
  } satisfies QueryAnswers
}

/** Mounts the auth modal against a fake runtime. `dispatch` records every
 *  request, `runtime` answers each mutation kind, and `queries` each query
 *  kind; `settle` and `progress` publish a
 *  login's end or progress message on the auth view, as the runtime does
 *  while a long flow runs. */
export function createModal(profileId: "default" | "work" = "default", authOverride?: AuthModalDeps["auth"], overrides?: Partial<Pick<AuthModalDeps, "appService" | "openBrowser" | "signInPage">>) {
  const modals = createModalStack()
  const showToast = mock((_toast: Parameters<AuthModalDeps["showToast"]>[0]) => {})
  const dispatch = mock((_request: FrontendMutation) => {})
  const runtime = runtimeAnswers()
  const dispatchRuntime = recordedDispatch(dispatch, runtimeDispatch(runtime))
  const clipboard = { copy: mock(async () => {}), readImage: mock(async () => null) }
  const [notice, setNotice] = createSignal<AuthOperationNotice | undefined>()
  const auth = authOverride ?? (() => ({ providers: mockAuthStatuses, warnings: [], authFilePath: "/scratch/auth/auth.json", profile: { id: profileId, displayName: profileId === "default" ? "Default" : "Work", source: profileId === "default" ? "default" as const : "sticky" as const, availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] }, subscriptionSpendConsent: { kind: "available" as const, profileId, usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] }, ...noticeFields(notice()) }))
  const queries = queryAnswers(auth)
  const queryRuntime = runtimeQuery(queries)
  const modal = useAuthModal({
    auth,
    modal: modals,
    renderModal: () => "mock-auth-modal",
    showToast,
    appService: overrides?.appService ?? { dispatch: dispatchRuntime, query: queryRuntime, subscribe: () => () => {}, onLane: fakeLanes().onLane },
    openBrowser: overrides?.openBrowser ?? mock(async () => true),
    signInPage: overrides?.signInPage ?? LOCAL_SIGN_IN,
    clipboard,
  } satisfies AuthModalDeps)
  /** The requests of one type the modal sent to the runtime. */
  const sent = <Type extends FrontendMutation["type"]>(type: Type) =>
    dispatch.mock.calls.map(([request]) => request).filter((request): request is Extract<FrontendMutation, { type: Type }> => request.type === type)
  const settle = (settlement: AuthOperationSettlement) => setNotice(settlement)
  const progress = (update: Extract<AuthOperationNotice, { kind: "progress" }>) => setNotice(update)
  const ask = (question: Extract<AuthOperationNotice, { kind: "confirmation" }>) => setNotice(question)
  return { modal, modals, showToast, dispatch, runtime, runtimeDispatch: dispatchRuntime, queries, runtimeQuery: queryRuntime, sent, clipboard, settle, progress, ask }
}
