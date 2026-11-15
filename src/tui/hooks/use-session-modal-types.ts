import type { Accessor, JSX } from "solid-js"
import type { SessionCatalogError, SessionCatalogRow, RuntimeClient } from "../../protocol/app-service-types.js"
import type { PickerRow, SelectablePickerRow } from "../session-picker/picker-types.js"
import type { ModalContext } from "../components/modal-stack.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"
import type { SessionActivationResult } from "./session-activation.js"
import type { Clipboard } from "../utils/clipboard.js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"

export interface SessionModalDeps {
  modal: ModalContext
  renderModal: () => JSX.Element
  signals: ShellSignals
  appService: Pick<RuntimeClient, "dispatch">
  showToast: ShellServices["showToast"]
  clipboard: Clipboard
  /** The rows the list shows (`ShellSignals.listedSessions`). */
  sessions: Accessor<readonly SessionCatalogRow[]>
  sessionCatalogErrors: Accessor<readonly SessionCatalogError[]>
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  activateSessionById: (sessionId: string) => Promise<void>
  /** Close chat, which also removes the tab that shows the chat. */
  closeChat: (sessionId: string) => Promise<void>
  deleteActiveSession: (sessionId: string) => Promise<void>
  navigation: SessionNavigation
}

/** What modules change in the Sessions list (`moduleSessionNavigation`). */
export interface SessionNavigation {
  /** The sessions that the list does not show, also to a search. */
  readonly hidden: () => ReadonlySet<string>
  /** Opens a chosen session instead of its tab while `foregroundId` is in front; undefined for a tab that keeps the
   *  ordinary open. */
  readonly openOver: (foregroundId: string | undefined) => ((sessionId: string) => void) | undefined
}

export interface SessionPickerResult {
  readonly rows: readonly PickerRow[]
  readonly totalMatches: number
  readonly capped: boolean
  readonly effectiveHighlightQuery: string
  readonly timeAgoWidth: number
}

export interface SessionModalAction {
  readonly key: string
  readonly label: string
  /** An open action, which the footer shows on a line of its own. */
  readonly opens?: true
  onTrigger(): void
}

export interface SessionRenameState {
  readonly sessionId: string
  readonly title: string
  readonly shortTitle: string
  readonly originalTitle: string
  readonly originalShortTitle: string
  readonly field: "title" | "shortTitle"
}

export interface SessionModalHook {
  modalCursor: Accessor<number>
  modalNavigationRevision: Accessor<number>
  modalConfirmDelete: Accessor<string | undefined>
  sessionModalResult: Accessor<SessionPickerResult>
  /** The minute clock the picker rows were built against; row time labels must render from it. */
  pickerNow: Accessor<number>
  sessionModalActions: Accessor<readonly SessionModalAction[]>
  /** How many sessions the list shows without a search. */
  sessionCount: Accessor<number>
  openSessionsModal(): void
  closeSessionsModal(): void
  selectModalItem(rowIndex: number): void
  /** A click on a row: it selects the row, and opens it where the tab in front opens sessions over itself. */
  clickRow(rowIndex: number): void
  openSessionRow(row: SelectablePickerRow): void
  handleSessionFilter(query: string): void
  filterQuery: Accessor<string>
  renameState: Accessor<SessionRenameState | undefined>
  inputPresentation: Accessor<TextEditorPresentation>
  renamePresentation(field: "title" | "shortTitle"): TextEditorPresentation
}
