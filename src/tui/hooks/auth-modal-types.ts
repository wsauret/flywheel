import type { Accessor, JSX } from "solid-js"
import type { RuntimeAuthProfileView, RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import type { ExternalUrlOpener } from "../../infra/open-external-url.js"
import type { ModalContext } from "../components/modal-stack.js"
import type { Clipboard } from "../utils/clipboard.js"
import type { ShellServices } from "./shell-state.js"
import type { AuthProfileSelection } from "./auth-profile-selection.js"
import type { AuthRow, AuthView, ProviderOption } from "./auth-modal-options.js"
import type { DisconnectConfirmation, DisconnectTarget } from "./auth-modal-disconnect.js"
import type { SubscriptionSpendConsentControl } from "./use-subscription-spend-consent-control.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
import type { SignInPage } from "../terminal-attach.js"

/** What the auth modal needs. Every credential write it starts is a runtime
 *  mutation on `appService`, so the runtime that serves the session owns it. */
export interface AuthModalDeps {
  auth: Accessor<RuntimeAuthView | undefined>
  authProfileSelection?: AuthProfileSelection
  modal: ModalContext
  renderModal: () => JSX.Element
  showToast: ShellServices["showToast"]
  appService: Pick<AttachedRuntimeClient, "dispatch" | "query" | "subscribe" | "onLane">
  openBrowser: ExternalUrlOpener
  /** Who opens a login's sign-in page, as this terminal's attach decides. */
  signInPage: SignInPage
  clipboard: Clipboard
}

export interface AuthModalState {
  view: AuthView
  /** A Disconnect that waits on the person's answer. It covers the view without replacing it, so Cancel returns to
   *  the same list row or settings page. */
  disconnect: DisconnectTarget | undefined
  cursor: number
  providers: ProviderOption[]
  apiKeyDraft: string
  textDraft: string
  profileScope: "tab" | "defaults"
  attemptId: number
  attemptKind: "provider" | "profile" | undefined
  policyOverride: boolean | undefined
  policyProfileId: string | undefined
  policyRevision: number | undefined
  policyChanging: boolean
  policyFeedback: string | undefined
}

export interface AuthModalHook {
  authView: Accessor<AuthView>
  disconnectConfirmation: Accessor<DisconnectConfirmation | undefined>
  confirmDisconnect: () => void
  cancelDisconnect: () => void
  profileAttemptPending: Accessor<boolean>
  authRows: Accessor<AuthRow[]>
  authModalCursor: Accessor<number>
  apiKeyDraft: Accessor<string>
  authInputPresentation: Accessor<TextEditorPresentation>
  profile: Accessor<RuntimeAuthProfileView | undefined>
  openAuthModal: () => void
  /** Opens a current project-wide login episode; returns false when it is no longer asking. */
  openLoginQuestion: (questionId: string, onUndelivered?: () => void) => boolean
  answerLoginQuestion: (login: boolean) => void
  /** Answers the runtime's question before a new paid account replaces free-plan accounts: true replaces them. */
  answerLoginConfirmation: (replace: boolean) => void
  openAuthAccountDetail: (auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string, focusEnvelopeId?: string) => boolean
  /** Opens the paid-use question for one account; closing it records an answer. */
  openPaidUseQuestion: (auth: RuntimeAuthView, snapshotPosition: number, providerId: string, accountCorrelationId: string) => boolean
  closeAuthModal: () => void
  finishRename: () => void
  selectProvider: (index: number) => void
  focusProvider: (providerId: string) => boolean
  selectProviderModel: (index: number) => void
  recheckProviderModels: () => void
  openAccountModels: () => void
  toggleFreeRoutes: () => void
  subscriptionSpendConsent: SubscriptionSpendConsentControl
}
