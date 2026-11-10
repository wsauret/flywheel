import { batch, createEffect, createMemo, createSignal, type Accessor, type JSX } from "solid-js"
import { createKeyedListSelection } from "./create-keyed-list-selection.js"
import { errorMessage } from "../../infra/error-message.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { BackgroundWorkRow, BackgroundWorkTarget } from "../../protocol/background-index-protocol-types.js"
import {
  backgroundIndexEntries,
  backgroundRowDetail,
  canStopBackgroundRow,
  stopBackgroundRow as dispatchStop,
  type BackgroundIndexEntry,
  type BackgroundIndexFilter,
  type BackgroundIndexState,
} from "../../protocol/client/background-index.js"
import type { ActiveBackgroundCommandView } from "../../protocol/status-protocol-types.js"
import { sessionServingSelection } from "../../protocol/role-protocol-types.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { flattenWithCategories } from "../components/modal-select-helpers.js"
import type { ModalSelectOption, FilteredResult } from "../components/modal-select-types.js"
import type { ModalContext } from "../components/modal-stack.js"
import type { ShellServices, ShellSignals } from "./shell-state.js"

/** Lines of live output shown for each expanded process. */
const TAIL_LINES = 12

interface BackgroundModalDeps {
  modal: ModalContext
  renderModal: () => JSX.Element
  signals: Pick<ShellSignals, "foregroundId" | "backgroundIndex" | "streamingToolText" | "roleView" | "ensureRoleViews">
  appService: Pick<RuntimeClient, "dispatch">
  showToast: ShellServices["showToast"]
  /** Lands the transcript on the card of a tool call, and loads older
   *  transcript when the card is not resident. */
  navigateToProcess: (toolUseId: string) => void
  openTarget: (target: BackgroundWorkTarget) => void | Promise<void>
}

/** The viewed session owns both its live output and transcript navigation. */
export interface BackgroundModalTarget {
  sessionId: string
  streamingToolText: ShellSignals["streamingToolText"]
  navigateToProcess: (toolUseId: string) => void
}

export interface BackgroundModalHook {
  backgroundModalResult: Accessor<FilteredResult<BackgroundIndexEntry>>
  backgroundModalCursor: Accessor<number>
  backgroundModalNavigationRevision: Accessor<number>
  backgroundModalFilter: Accessor<BackgroundIndexFilter>
  /** What the list says when it shows no row. */
  backgroundModalEmpty: Accessor<string>
  /** Undefined while collapsed; an empty tail means no output is available yet. */
  backgroundModalTail: (rowId: string) => readonly string[] | undefined
  /** Opens the target session's work, or the foreground chat when omitted. */
  openBackgroundModal: (target?: BackgroundModalTarget) => void
  /** A click: closes the list and lands on the row's card. */
  landBackgroundRow: (rowIndex: number) => void
  stopBackgroundRow: (rowIndex: number) => void
  setBackgroundFilter: (filter: BackgroundIndexFilter) => void
}

/** Never throws: the inline transcript stop affordance fire-and-forgets
 *  this. Stop is idempotent (a settled task is a no-op), so the only failure
 *  mode is a transport error; the stop affordance disappearing is the
 *  success feedback. */
export async function terminateBackgroundCommand(
  deps: Pick<BackgroundModalDeps, "appService" | "showToast">,
  sessionId: string,
  command: Pick<ActiveBackgroundCommandView, "toolUseId">,
): Promise<void> {
  try {
    await deps.appService.dispatch({ type: "background.terminate", sessionId, toolUseId: command.toolUseId })
  } catch (err) {
    deps.showToast({ message: errorMessage(err), variant: "error" })
  }
}

function isRunningCommand(row: BackgroundWorkRow): boolean {
  return row.kind === "command" && row.status === "running"
}

export function useBackgroundModal(deps: BackgroundModalDeps): BackgroundModalHook {
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [target, setTarget] = createSignal<BackgroundModalTarget>()
  // A convenience for this terminal only, kept for the life of its process.
  const [filter, setFilter] = createSignal<BackgroundIndexFilter>("active")
  const index = deps.signals.backgroundIndex

  const indexState = createMemo<BackgroundIndexState | undefined>(() => {
    const sessionId = target()?.sessionId
    return sessionId === undefined ? undefined : index.state(sessionId)
  })
  const allRows = createMemo<readonly BackgroundWorkRow[]>(() => {
    const state = indexState()
    return state !== undefined && "rows" in state ? state.rows ?? [] : []
  })

  createEffect(() => {
    deps.signals.ensureRoleViews(allRows().flatMap((row) => row.roleSessionId === undefined ? [] : [row.roleSessionId]))
  })

  const result = createMemo<FilteredResult<BackgroundIndexEntry>>(() => {
    const options: ModalSelectOption<BackgroundIndexEntry>[] = backgroundIndexEntries(allRows(), filter()).map((entry) => {
      const role = entry.row.roleSessionId === undefined ? undefined : sessionServingSelection(deps.signals.roleView(entry.row.roleSessionId))
      const row = role === undefined ? entry.row : { ...entry.row, model: role.model, ...(role.effort === undefined ? {} : { effort: role.effort }) }
      return { id: row.id, title: row.title, rightDetail: backgroundRowDetail(row), value: { ...entry, row } }
    })
    return flattenWithCategories(options, false)
  })

  const empty = createMemo(() => {
    const state = indexState()
    if (state?.status === "error") return `Could not read background work: ${state.error}`
    if (allRows().length === 0) return state?.status === "loading" ? "Reading background work…" : "No background work in this session"
    return "No active background work · a shows all"
  })

  const selection = createKeyedListSelection(() => result().rows.map((row) => row.kind === "option" ? row.option.id : undefined))
  const clampedCursor = selection.cursor
  const setCursor = selection.select

  function rowAt(rowIndex: number): BackgroundWorkRow | undefined {
    const row = result().rows[rowIndex]
    return row?.kind === "option" ? row.option.value.row : undefined
  }

  function tail(rowId: string): readonly string[] | undefined {
    if (!expanded().has(rowId)) return undefined
    const content = target()?.streamingToolText()[rowId]?.content
    if (!content) return []
    return content.replace(/\r?\n$/, "").split(/\r?\n/).slice(-TAIL_LINES)
  }

  function stopBackgroundRow(rowIndex: number): void {
    const row = rowAt(rowIndex)
    if (!row || !canStopBackgroundRow(row)) return
    setCursor(rowIndex)
    void dispatchStop(deps.appService, row).catch((err: unknown) => { deps.showToast({ message: errorMessage(err), variant: "error" }) })
  }

  function landBackgroundRow(rowIndex: number): void {
    const row = rowAt(rowIndex)
    if (!row) return
    // Read before clear: closing the modal releases its target.
    const navigateToProcess = target()?.navigateToProcess
    deps.modal.clear()
    navigateToProcess?.(row.cardToolUseId)
  }

  /** Enter opens the producer's typed place, or lands on a command without one. */
  function openBackgroundRow(rowIndex: number): void {
    const row = rowAt(rowIndex)
    if (row?.target === undefined) {
      landBackgroundRow(rowIndex)
      return
    }
    deps.modal.clear()
    void Promise.resolve(deps.openTarget(row.target)).catch((err: unknown) => deps.showToast({ message: errorMessage(err), variant: "error" }))
  }

  function setBackgroundFilter(next: BackgroundIndexFilter): void {
    batch(() => {
      setFilter(next)
      setCursor(0)
    })
  }

  const handleKey = createListModalKeys({
    rows: () => result().rows,
    cursor: clampedCursor,
    setCursor,
    onSelect: openBackgroundRow,
    onClose: () => deps.modal.clear(),
    extra: (event) => {
      if (event.name === "x") {
        event.preventDefault?.()
        stopBackgroundRow(clampedCursor())
        return true
      }
      if (event.name === "a") {
        event.preventDefault?.()
        setBackgroundFilter(filter() === "active" ? "all" : "active")
        return true
      }
      if (event.name !== "space") return false
      event.preventDefault?.()
      const row = rowAt(clampedCursor())
      // Only a running command has live output; a finished one's card holds its settled output.
      if (row && isRunningCommand(row)) {
        setExpanded((current) => {
          const next = new Set(current)
          if (next.has(row.id)) next.delete(row.id)
          else next.add(row.id)
          return next
        })
      }
      return true
    },
  })

  function openBackgroundModal(nextTarget?: BackgroundModalTarget): void {
    const foregroundId = deps.signals.foregroundId()
    const opened = nextTarget ?? (foregroundId === undefined ? undefined
      : { sessionId: foregroundId, streamingToolText: deps.signals.streamingToolText, navigateToProcess: deps.navigateToProcess })
    if (opened === undefined) return
    setCursor(0)
    setExpanded(new Set<string>())
    // Replace first: it closes the previous entry, whose onClose releases
    // the target that this open sets. The foreground or the child viewer
    // that opens the list follows its index, so the list reads nothing.
    deps.modal.replace(deps.renderModal, { onKey: handleKey, onClose: () => setTarget(undefined) })
    setTarget(opened)
  }

  return {
    backgroundModalResult: result,
    backgroundModalCursor: clampedCursor,
    backgroundModalNavigationRevision: selection.revision,
    backgroundModalFilter: filter,
    backgroundModalEmpty: empty,
    backgroundModalTail: tail,
    openBackgroundModal,
    landBackgroundRow,
    stopBackgroundRow,
    setBackgroundFilter,
  }
}
