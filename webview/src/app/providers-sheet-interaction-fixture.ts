import { createComponent, createRoot, createSignal } from "solid-js"
import { Redacted } from "effect"

import type { FrontendMutation, MutationResult } from "../../../src/protocol/app-service-types.js"
import type { AuthProviderStatus, RuntimeAuthLoginQuestion, RuntimeAuthProfileView, RuntimeAuthView } from "../../../src/protocol/auth-status-protocol-types.js"
import type { RuntimeAuthLoginPrompt, RuntimeAuthLoginResult } from "../../../src/protocol/auth-login-protocol-types.js"
import type { SheetFocus } from "../../../src/protocol/client/host-contract.js"
import type { ConfirmRequest } from "./client-context.js"
import { fakeClient, fakeClientActions, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { ProvidersSheet } from "./sheets/providers-sheet.js"
import { ProfilesSheet } from "./sheets/profiles-sheet.js"
import type { RuntimeAuthProfileDeletionPreview, RuntimeAuthProfileMutationResult } from "../../../src/protocol/auth-profile-selection-protocol-types.js"
import type { SubscriptionSpendConsentMutationResult, SubscriptionSpendConsentView } from "../../../src/protocol/subscription-spend-consent-protocol-types.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { actionOwner } from "./action-owner-fixture.js"
import { BROWSER_LOGIN_COPY } from "../../../src/protocol/client/provider-account-copy.js"

const provider: AuthProviderStatus = {
  providerId: "chatgpt",
  kind: "subscription",
  source: "unconfigured",
  expired: false,
  modelCapable: true,
  loginMethod: "browser-auth",
  statusRank: 0,
  group: "model",
  accounts: [],
  displayName: "ChatGPT",
}

const initialAuth: RuntimeAuthView = {
  providers: [provider],
  warnings: [],
  profile: { id: "personal", displayName: "Personal", source: "default", availableProfiles: [] },
  subscriptionSpendConsent: { kind: "unavailable", profileId: "personal", message: "Flywheel could not read this profile's paid-use settings. Paid use is off until it can." },
}

const tick = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const DEVICE_CODE_URL = "https://accounts.x.ai/oauth2/device?user_code=ABCD-1234"

export function mountProfileDeletion(preview: RuntimeAuthProfileDeletionPreview, options: {
  readonly profile?: RuntimeAuthProfileView
  readonly dispatch?: (mutation: FrontendMutation) => Promise<RuntimeAuthProfileMutationResult>
} = {}) {
  return createRoot((dispose) => {
    const root = createElement("root")
    const mutations: FrontendMutation[] = []
    const reports: { severity: "info" | "warning"; message: string }[] = []
    const reported = Promise.withResolvers<void>()
    let fail = false
    let previewFailure = false
    const [profile, setProfile] = createSignal<RuntimeAuthProfileView>(options.profile ?? { ...initialAuth.profile, ...preview.source, availableProfiles: [preview.source] })
    Reflect.set(globalThis, "__flywheelProvidersSheetTestClient", {
      state: () => ({ authStatus: { auth: { ...initialAuth, profile: profile() } } }),
      connection: {
        query: async () => {
          if (previewFailure) throw new Error("preview unavailable")
          return preview
        },
        dispatch: async (mutation: FrontendMutation): Promise<RuntimeAuthProfileMutationResult> => {
          mutations.push(mutation)
          await Promise.resolve()
          if (options.dispatch) return options.dispatch(mutation)
          if (fail) return { ok: false, error: "cleanup failed" }
          return { id: preview.source.id }
        },
      },
      prompt: async () => "Created",
      report: (severity: "info" | "warning", message: string) => { reports.push({ severity, message }); reported.resolve() },
      closeSheet() {},
      sheetFocus: () => undefined,
      actions: actionOwner(),
    })
    insert(root, createComponent(ProfilesSheet, {}))
    const button = (label: string) => {
      const found = nodes(root).find((node) => node.tag === "button" && textContent(node).startsWith(label))
      if (!found) throw new Error(`Missing ${label}`)
      return found
    }
    return {
      dispose: () => { dispose(); Reflect.deleteProperty(globalThis, "__flywheelProvidersSheetTestClient") },
      ready: tick,
      text: () => textContent(root),
      buttonLabels: () => nodes(root).filter(node => node.tag === "button").map(textContent),
      mutations: () => mutations,
      reports: () => reports,
      elements: () => nodes(root),
      reported: reported.promise,
      fail: (value: boolean) => { fail = value },
      failPreview: (value: boolean) => { previewFailure = value },
      retireSource: () => setProfile({ ...profile(), id: "survivor", displayName: "Survivor", availableProfiles: [] }),
      disabled: (label: string) => button(label).properties.disabled === true,
      focused: (label: string) => button(label).properties.focused === true,
      /** Focus leaves the button, as when the person moves to another control. */
      blur: (label: string) => { button(label).properties.focused = false },
      click: (label: string) => {
        const handler = button(label).properties.onClick
        if (typeof handler === "function") handler({})
      },
      choose: (value: string) => {
        const handler = nodes(root).find((node) => node.tag === "select")?.properties.onChange
        if (typeof handler !== "function") throw new Error("Missing choice")
        handler({ currentTarget: { value } })
      },
    }
  })
}

/** Mounts the real shared Authentication sheet against an in-memory Solid host.
 *  Pass `deviceCode` to answer the login with a device-code step; its `userCode` is optional as on the wire.
 *  Pass `prompt` to answer the login first with that pre-flight question. */
export function mountProviderBrowserLogin(deviceCode?: { readonly userCode?: string }, providers?: readonly AuthProviderStatus[], recovery?: {
  readonly question: RuntimeAuthLoginQuestion
  readonly response?: Promise<RuntimeAuthLoginResult>
  readonly manualResponse?: Promise<RuntimeAuthLoginResult>
}, prompt?: RuntimeAuthLoginPrompt, paidUse?: {
  readonly consent: SubscriptionSpendConsentView
  readonly response: () => Promise<SubscriptionSpendConsentMutationResult>
}, renameResponse?: () => Promise<MutationResult<Extract<FrontendMutation, { readonly type: "auth.account.rename" }>>>) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [auth, setAuth] = createSignal({ ...initialAuth, ...(providers === undefined ? {} : { providers }), ...(paidUse === undefined ? {} : { subscriptionSpendConsent: paidUse.consent }) })
    const [focus, setFocus] = createSignal<SheetFocus | undefined>(recovery && !recovery.manualResponse ? { kind: "reconnect-account", question: recovery.question } : providers === undefined ? { kind: "connect-provider", providerId: "chatgpt" } : undefined)
    const mutations: FrontendMutation[] = []
    const opened: string[] = []
    const reports: { readonly severity: "info" | "warning"; readonly message: string }[] = []
    const completionInputs: string[] = []
    const confirmations: ConfirmRequest[] = []
    const retried: string[] = []
    const actions = fakeClientActions()
    let consentAction: Promise<boolean> | undefined
    const run: typeof actions.run = (key, work, onFailure) => {
      const pending = actions.run(key, work, onFailure)
      if (key.startsWith("provider-consent")) consentAction = pending
      return pending
    }
    const deviceCodeStep = (code: { readonly userCode?: string }): RuntimeAuthLoginResult => ({
      kind: "device_code", operationId: "device-operation", providerId: "chatgpt", verificationUri: DEVICE_CODE_URL, ...(code.userCode === undefined ? {} : { userCode: code.userCode }),
    })
    const idle = fakeViewState()
    const client = fakeClient({
      state: () => ({ ...idle, authStatus: { snapshotPosition: 1, auth: auth() } }),
      sheetFocus: focus,
      confirm: async (request) => { confirmations.push(request); return true },
      connection: fakeRuntimeConnection({
        onDispatch: (mutation) => { mutations.push(mutation) },
        mutations: {
          "subscription_spend_consent.save": () => {
            if (!paidUse) throw new Error("Unexpected mutation: subscription_spend_consent.save")
            return paidUse.response()
          },
          "auth.login.cancel": () => ({ ok: true }),
          "auth.login": (mutation) => {
            if (!mutation.loginQuestionId && recovery?.manualResponse) return recovery.manualResponse
            if (recovery?.response) return recovery.response
            if (prompt !== undefined) return { kind: "prompt", operationId: "device-operation", providerId: "chatgpt", prompt }
            if (deviceCode !== undefined) return deviceCodeStep(deviceCode)
            return { kind: "browser", operationId: "browser-operation", providerId: "chatgpt", authorizeUri: "https://provider.example/authorize" }
          },
          "auth.account.disconnect": () => ({ ok: true }),
          "auth.account.rename": () => renameResponse ? renameResponse() : { ok: true },
          "auth.login.answer": (mutation) => {
            if (mutation.answer === "confirm") return { kind: "completed", providerId: "chatgpt" }
            if (deviceCode !== undefined) return deviceCodeStep(deviceCode)
            throw new Error("Unexpected mutation: auth.login.answer")
          },
          "auth.login.complete": (mutation) => {
            completionInputs.push(Redacted.value(mutation.input))
            return { ok: true }
          },
        },
      }),
      actions: { ...actions, run, canOpenExternal: true, openExternal: (url) => { opened.push(url) } },
      report: (severity, message) => { reports.push({ severity, message }) },
      retryLoginQuestion: (id) => { retried.push(id) },
    })
    Reflect.set(globalThis, "__flywheelProvidersSheetTestClient", client)
    insert(root, createComponent(ProvidersSheet, {}))

    const find = (tag: string, label?: string) => {
      const found = nodes(root).find((node) => node.tag === tag && (label === undefined || node.properties["aria-label"] === label))
      if (found === undefined) throw new Error(`Missing ${tag}${label === undefined ? "" : ` ${label}`}`)
      return found
    }
    const finishButton = () => {
      const found = nodes(root).find((node) => node.tag === "button" && textContent(node) === "Finish login")
      if (found === undefined) throw new Error("Missing Finish login button")
      return found
    }
    const invoke = (node: ReturnType<typeof find>, property: string, event: unknown): void => {
      const handler = node.properties[property]
      if (typeof handler !== "function") throw new Error(`Missing ${property} handler`)
      handler(event)
    }

    return {
      dispose(): void {
        disposeRoot()
        Reflect.deleteProperty(globalThis, "__flywheelProvidersSheetTestClient")
      },
      ready: tick,
      switchToEmptyProfile: () => setAuth((current) => ({
        ...current,
        profile: { ...current.profile, id: "work", displayName: "Work" },
        providers: current.providers.map((entry) => ({ ...entry, accounts: [] })),
      })),
      consentSettled: async () => { await consentAction },
      publishConsent: (consent: SubscriptionSpendConsentView) => setAuth((current) => ({ ...current, subscriptionSpendConsent: consent })),
      checkboxes: () => nodes(root).filter((node) => node.tag === "input" && node.properties.type === "checkbox"),
      tickMode(index: number, checked: boolean): boolean {
        const input = nodes(root).filter((node) => node.tag === "input" && node.properties.type === "checkbox")[index]
        if (!input) throw new Error(`Missing checkbox ${index}`)
        const currentTarget = { checked }
        invoke(input, "onChange", { currentTarget })
        return currentTarget.checked
      },
      focus: setFocus,
      async settleSuccess(): Promise<void> {
        setAuth((current) => ({ ...current, settlement: { kind: "completed", operationId: "browser-operation", providerId: "chatgpt" } }))
        await tick()
      },
      text: () => textContent(root),
      buttonLabels: () => nodes(root).filter((node) => node.tag === "button").map(textContent),
      /** The class of the button labelled `label`, which states whether it is the step's primary action. */
      buttonClass: (label: string) => nodes(root).find((node) => node.tag === "button" && textContent(node) === label)?.properties.class,
      cards: () => nodes(root).filter((node) => node.tag === "section" && node.properties.class === "provider-card").map((node) => ({
        text: textContent(node),
        buttons: nodes(node).filter((child) => child.tag === "button").map(textContent),
      })),
      clickButton(label: string): void {
        const found = nodes(root).find((node) => node.tag === "button" && textContent(node) === label)
        if (found === undefined) throw new Error(`Missing ${label} button`)
        invoke(found, "onClick", {})
      },
      opened: () => opened,
      reports: () => reports,
      elements: () => nodes(root),
      mutations: () => mutations,
      confirmations: () => confirmations,
      retried: () => retried,
      completionInputs: () => completionInputs,
      inputLabel: () => find("input", BROWSER_LOGIN_COPY.placeholder).properties["aria-label"],
      finishDisabled: () => finishButton().properties.disabled === true,
      /** Types into the field of the login's pre-flight question, which is labelled by the question. */
      typePromptAnswer(value: string): void {
        invoke(find("input", prompt?.message), "onInput", { currentTarget: { value } })
      },
      typeCompletion(value: string): void {
        invoke(find("input", BROWSER_LOGIN_COPY.placeholder), "onInput", { currentTarget: { value } })
      },
      submit(): void {
        invoke(find("form"), "onSubmit", { preventDefault() {} })
      },
      /** The rendered card for one provider, by its display name. */
      card: (name: string) => nodes(root).find((node) => node.tag === "section" && node.properties.class === "provider-card" && textContent(node).startsWith(name)),
      /** Publishes an equal auth view built from new objects, as each runtime snapshot is. */
      async republishAuth(): Promise<void> {
        setAuth((current) => structuredClone(current))
        await tick()
      },
      /** Publishes the question that the runtime asks after sign-in, before it stores the account. */
      async ask(message: string): Promise<void> {
        setAuth((current) => ({ ...current, confirmation: { kind: "confirmation", operationId: "browser-operation", providerId: "chatgpt", message } }))
        await tick()
      },
      /** Ends the login with a failure; `refused` marks a rule that refused the account, whose message is complete. */
      async settleFailure(message: string, refused?: true): Promise<void> {
        setAuth((current) => ({ ...current, settlement: { kind: "failed", operationId: "browser-operation", providerId: "chatgpt", message, ...(refused === undefined ? {} : { refused }) } }))
        await tick()
      },
    }
  })
}
