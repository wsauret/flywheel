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
  /** Immediate client-cache overlay of a command result's fresh catalog row. */
  seedSessionCatalogRow: (row: SessionCatalogRow) => void
  clipboard: Clipboard
  /** The rows the list shows (`ShellSignals.listedSessions`). */
  sessions: Accessor<readonly SessionCatalogRow[]>
  sessionCatalogErrors: Accessor<readonly SessionCatalogError[]>
  activateSession: (session: SessionCatalogRow) => Promise<SessionActivationResult>
  activateSessionById: (sessionId: string) => Promise<void>
  deleteActiveSession: (sessionId: string) => Promise<void>
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
