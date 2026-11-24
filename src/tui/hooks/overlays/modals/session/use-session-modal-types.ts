import type { Accessor, JSX } from "solid-js"
import type { SessionCatalogError, SessionCatalogRow, RuntimeClient } from "../../../../../protocol/app-service-types.js"
import type { SelectablePickerRow, SessionPickerResult } from "../../../../modals/session-picker/picker-types.js"
import type { ModalContext } from "../../../../components/modal-stack.js"
import type { ShellServices, ShellSignals } from "../../../state/shell-state.js"
import type { SessionActivationResult } from "../../../foreground/session-activation.js"
import type { Clipboard } from "../../../../terminal/clipboard.js"
import type { TextEditorPresentation } from "../../../../terminal/keymap/text-entry.js"

export interface SessionModalDeps {
  modal: ModalContext
  renderModal: () => JSX.Element
  signals: ShellSignals
  appService: Pick<RuntimeClient, "dispatch" | "query">
  showToast: ShellServices["showToast"]
  clipboard: Clipboard
  /** The rows the list shows (`ShellSignals.listedSessions`). */
  sessions: Accessor<readonly SessionCatalogRow[]>
  sessionCatalogErrors: Accessor<readonly SessionCatalogError[]>
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  activateSessionById: (sessionId: string) => Promise<void>
  /** Land the foreground transcript on an entry and mark it briefly. */
  landOnEntry: (entryId: string) => void
  /** Close chat, which also removes the tab that shows the chat. */
  closeChat: (sessionId: string) => Promise<void>
  deleteActiveSession: (sessionId: string) => Promise<void>
}

export interface SessionModalAction {
  readonly key: string
  readonly label: string
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
  openSessionsModal(): void
  closeSessionsModal(): void
  selectModalItem(rowIndex: number): void
  openSessionRow(row: SelectablePickerRow): void
  handleSessionFilter(query: string): void
  filterQuery: Accessor<string>
  renameState: Accessor<SessionRenameState | undefined>
  inputPresentation: Accessor<TextEditorPresentation>
  renamePresentation(field: "title" | "shortTitle"): TextEditorPresentation
}
