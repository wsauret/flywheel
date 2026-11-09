import type { Accessor, JSX } from "solid-js"
import { createSignal } from "solid-js"
import { errorMessage } from "../../infra/error-message.js"
import { formatCostSplit, formatTokens } from "../../protocol/client/format.js"
import { describeUpdateStatus } from "../../protocol/client/update-status-copy.js"
import type { BudgetView } from "../../protocol/budget-protocol-types.js"
import type { UpdateAutoInstall, UpdateStatusView } from "../../protocol/update-protocol-types.js"
import type { SessionLifecycleState } from "../../orchestration/session/types.js"
import type { ModuleRowAction } from "../../protocol/protocol-module.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import type { ShellServices } from "./shell-state.js"

export interface StatusRow {
  label: string
  value: string
  /** Clipboard payload when the row is highlighted; defaults to value. */
  copy?: string
  hint?: string
  tone?: "warning"
  /** Enter and a click run this instead of copying the row. */
  action?: ModuleRowAction
}

export interface StatusRowsInput {
  sessionId?: string
  sessionKind: "chat" | "subagent" | "workflow-agent" | null
  sessionState: SessionLifecycleState | null
  modelLabel?: string
  budget?: BudgetView
  activeSessionCount: number
  sessionCount: number
  appVersion: string
  /** Directory that owns this project's durable state (ARCH-DIRECTORIES-001, ARCH-DIRECTORIES-011). Project
   *  identity only: it never restricts where tools run. */
  projectRoot: string
  /** Execution directory of the selected session, null when no session is
   *  selected. Read from session metadata, so an inactive or historical session
   *  reports the directory it actually ran in. */
  executionCwd: string | null
  /** The runtime's published update view, undefined until the update
   *  projection hydrates. Unknown is reported as no row rather than as off. */
  update: UpdateStatusView | undefined
}

/** The policy in one line. An override is named, because a row that reported
 *  the durable value alone would contradict what the runtime is doing. */
function autoInstallSummary(policy: UpdateAutoInstall): string {
  if (policy.forcedOff) return "Automatic updates on, held off for this run"
  return `Automatic updates ${policy.effective ? "on" : "off"}`
}

/** The Updates row. A build that does not update itself says so alone, since
 *  no policy applies to it. A release or a checkout's source that could not start on
 *  this machine is named first, in the words every client uses, because no
 *  notice names it (PI-UPDATES-008, PI-UPDATES-009). For every other state the row shows the policy alone; the
 *  composer border names a release to take or to restart into. */
function updatesSummary(update: UpdateStatusView): string {
  const policy = autoInstallSummary(update.autoInstall)
  if (update.status.kind === "no-repository") return describeUpdateStatus(update.status)
  return update.status.kind === "refused" || update.status.kind === "source-refused" ? `${describeUpdateStatus(update.status)} · ${policy}` : policy
}

/** Diagnostics for the foreground session: identity, model, context pressure,
 * spend, and the `events search` invocation for deeper debugging. */
export function statusRows(input: StatusRowsInput): readonly StatusRow[] {
  const rows: StatusRow[] = []
  rows.push({
    label: "Session",
    value: input.sessionId
      ? `${input.sessionId} · ${input.sessionKind ?? "unknown"} · ${input.sessionState ?? "unknown"}`
      : "none",
    copy: input.sessionId,
  })
  if (input.modelLabel) rows.push({ label: "Model", value: input.modelLabel })
  const budget = input.budget
  rows.push({
    label: "Context",
    value: budget?.totalsLoading ? "totals loading"
      : budget && budget.contextPromptTokens > 0
      ? `${Math.min(100, Math.round(budget.contextPercent))}% of window · ${formatTokens(budget.contextPromptTokens)} prompt tokens`
      : "no usage yet",
  }, {
    label: "Usage",
    value: budget?.totalsLoading ? "totals loading"
      : budget && budget.tokens > 0
      ? `${formatTokens(budget.tokens)} tokens · ${formatCostSplit(budget.cost, budget.billedCost)}${budget.priceUnavailable ? " · price unavailable" : ""}`
      : "no usage yet",
  }, { label: "Sessions", value: `${input.activeSessionCount} open · ${input.sessionCount} total` }, { label: "Project Root", value: input.projectRoot })
  if (input.executionCwd) rows.push({ label: "Working Directory", value: input.executionCwd })
  rows.push({ label: "Version", value: `Flywheel ${input.appVersion} · Bun ${Bun.version}` })
  if (input.update !== undefined) rows.push({ label: "Updates", value: updatesSummary(input.update) })
  if (input.sessionId) rows.push({ label: "Debug", value: `flywheel events search --session ${input.sessionId} --errors` })
  return rows
}

interface StatusModalDeps {
  readonly onOpen?: () => void
  modal: Pick<ModalContext, "replace">
  renderModal: () => JSX.Element
  rows: () => readonly StatusRow[]
  /** Clipboard writer (Clipboard.copy in production; injected for tests). */
  copy: (text: string) => Promise<void>
  /** Runs a row's action once the modal has closed. */
  activate: (action: ModuleRowAction) => void
  showToast: ShellServices["showToast"]
}

export interface StatusModalHook {
  openStatusModal: () => void
  closeStatusModal: () => void
  statusCursor: Accessor<number>
  /** Click handler: highlight a row and copy its payload to the clipboard. */
  selectStatusRow: (rowIndex: number) => void
}

export function useStatusModal(deps: StatusModalDeps): StatusModalHook {
  const [cursor, setCursor] = createSignal(-1)
  // Serialize copies so rapid input cannot land an earlier row's payload
  // on the clipboard after a later one.
  let copyChain: Promise<void> = Promise.resolve()
  let entry: ModalHandle | undefined

  function closeStatusModal(): void { entry?.close() }

  /** The clipboard write always completes; only its feedback is view-local, so
   *  a modal that closed before the copy settled reports nothing. */
  function copyRow(rowIndex: number): void {
    const row = deps.rows()[rowIndex]
    if (!row) return
    const owner = entry
    copyChain = copyChain
      .then(() => deps.copy(row.copy ?? row.value))
      .then(() => { if (owner?.isOpen()) deps.showToast({ message: `${row.label} copied to clipboard`, variant: "info" }) })
      .catch((err) => { if (owner?.isOpen()) deps.showToast({ message: `Copy failed: ${errorMessage(err)}`, variant: "error" }) })
  }

  /** A row with an action runs it in place of the copy; the modal closes
   *  first so what the action opens is not replaced by it. */
  function activateRow(rowIndex: number): void {
    const action = deps.rows()[rowIndex]?.action
    if (!action) {
      copyRow(rowIndex)
      return
    }
    closeStatusModal()
    deps.activate(action)
  }

  function selectStatusRow(rowIndex: number): void {
    if (!deps.rows()[rowIndex]) return
    setCursor(rowIndex)
    activateRow(rowIndex)
  }

  // The modal opens with no highlight (cursor -1): return closes until an
  // arrow key highlights a row, after which return copies like "c" does, or
  // runs the row's action when it has one.
  const handleKey = createListModalKeys({
    rows: deps.rows,
    cursor,
    setCursor,
    selectable: () => true,
    onSelect: (index) => {
      if (index >= 0) activateRow(index)
      else closeStatusModal()
    },
    onClose: closeStatusModal,
    extra: (evt) => {
      if (evt.name !== "c") return false
      evt.preventDefault?.()
      copyRow(cursor())
      return true
    },
  })

  return {
    openStatusModal: () => {
      deps.onOpen?.()
      setCursor(-1)
      entry = deps.modal.replace(deps.renderModal, { onKey: handleKey })
    },
    closeStatusModal,
    statusCursor: cursor,
    selectStatusRow,
  }
}