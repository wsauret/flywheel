import type {
  ModelAssignmentRow,
  ModelOptionRow,
  ModelSelectionEffort,
} from "../../protocol/model-assignment-protocol-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { ModalDisclosureItem } from "../components/modal-disclosure.js"

export type ModelAssignmentContent =
  | { kind: "assignment"; row: ModelAssignmentRow }
  | { kind: "spacer" }
  | { kind: "heading"; title: string }

export type ModelAssignmentItem = ModalDisclosureItem<ModelAssignmentContent>

export type ModelModalView =
  | { kind: "assignments" }
  /** `direct` marks the Model and effort surface of one session, which a
   *  person opens without the Models list: its heading names the session's
   *  agent, and a save closes it. */
  | { kind: "models"; displayLabel?: string; direct?: boolean }

export interface ModelModalState {
  view: ModelModalView
  scope: "session" | "defaults"
  profileOwned?: boolean
  savedModel?: string
  subagent?: boolean
  scopeToggleAvailable: boolean
  assignmentItems: readonly ModelAssignmentItem[]
  modelOptions: readonly ModelOptionRow[]
  query: string
  pendingEfforts: ReadonlyMap<string, ModelSelectionEffort>
  cursor: number
  loading: boolean
  confirmReset: boolean
  auth?: RuntimeAuthView
}
