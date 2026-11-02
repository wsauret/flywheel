import { batch, createMemo, createSignal } from "solid-js"
import fuzzysort from "fuzzysort"
import { errorDetail, errorMessage as extractErrorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { isSessionId } from "../../infra/session-id.js"
import { effectiveSessionShortTitle, isActiveActivity, SHORT_TITLE_MAX_CHARS, type SessionCatalogError, type SessionCatalogRow } from "../../protocol/app-service-types.js"
import { dispatchInterrupt, isInterruptible, offeredSessionControls, resumeMutationType } from "../../protocol/client/session-controls.js"
import { createListModalKeys, type ListModalKeyEvent } from "../components/modal-list-keys.js"
import { createControlledTextEditor, normalizedPrintableText, SINGLE_LINE_TEXT_ENTRY_POLICY, type ControlledTextEditor, type TextEditorPresentation } from "../keymap/text-entry.js"
import { firstSelectableRow, matchAction, MAX_RENDERED_ROWS } from "../components/modal-select-helpers.js"
import { flattenSessionRows, formatCompactTimeAgo, parseSessionIdQuery, timeAgoColumnWidth } from "../session-picker/picker-helpers.js"
import type { PickerCorruptRow, PickerRow, PickerSessionRow, SelectablePickerRow } from "../session-picker/picker-types.js"
import type { ModalHandle } from "../components/modal-stack.js"
import type { SessionModalAction, SessionModalDeps, SessionModalHook, SessionPickerResult, SessionRenameState } from "./use-session-modal-types.js"
import { createKeyedListSelection } from "./create-keyed-list-selection.js"

const log = Log.create({ service: "session-modal" })
const defaultShortcutDelayMs = 120

/** Name a session in durable feedback: its title, or its id when untitled. */
function sessionSubject(session: SessionCatalogRow): string {
  return session.title || session.shortTitle || session.id
}

export function useSessionModal(deps: SessionModalDeps, shortcutDelayMs = defaultShortcutDelayMs): SessionModalHook {
  const { signals, showToast } = deps

  const [modalConfirmDelete, setModalConfirmDelete] = createSignal<string | undefined>()
  const [filterQuery, setFilterQuery] = createSignal("")
  const [renameState, setRenameState] = createSignal<SessionRenameState | undefined>()
  const filterEditor = createControlledTextEditor({ value: filterQuery, setValue: handleSessionFilter, policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const titleEditor = createControlledTextEditor({ value: () => renameState()?.title ?? "", setValue: (title) => setRenameState((state) => state ? { ...state, title } : state), policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const shortTitleEditor = createControlledTextEditor({ value: () => renameState()?.shortTitle ?? "", setValue: (shortTitle) => setRenameState((state) => state ? { ...state, shortTitle: shortTitle.slice(0, SHORT_TITLE_MAX_CHARS) } : state), policy: SINGLE_LINE_TEXT_ENTRY_POLICY })
  const renameEditor = () => renameState()?.field === "title" ? titleEditor : shortTitleEditor
  let pendingShortcut: { key: string; action: SessionModalAction; timer: ReturnType<typeof setTimeout> } | undefined
  // The modal entry of the currently open Sessions modal. Every asynchronous
  // action captures it, so a late completion can only touch its own modal.
  let entry: ModalHandle | undefined

  function clearPendingShortcut(): void {
    if (!pendingShortcut) return
    clearTimeout(pendingShortcut.timer)
    pendingShortcut = undefined
  }

  function runEditor(editor: ControlledTextEditor, evt: ListModalKeyEvent): ReturnType<ControlledTextEditor["handleKey"]> {
    return editor.handleKey(evt)
  }

  function triggerAction(action: SessionModalAction): void {
    action.onTrigger()
  }

  function scheduleShortcut(key: string, action: SessionModalAction): void {
    clearPendingShortcut()
    const timer = setTimeout(() => {
      const pending = pendingShortcut
      if (!pending || pending.timer !== timer) return
      pendingShortcut = undefined
      triggerAction(pending.action)
    }, shortcutDelayMs)
    pendingShortcut = { key, action, timer }
  }

  // Minute-quantized clock: rows need `now` only for date-group headers and
  // the time-ago column width, which move at minute granularity. Tracking the
  // 1-second ticker here rebuilt every picker row object every second for the
  // modal's whole lifetime.
  const nowMinute = createMemo(() => Math.floor(signals.now() / 60_000) * 60_000)
  const fullResult = createMemo<PickerRowsResult>(() => {
    if (!deps.modal.stack.some((modal) => modal.element === deps.renderModal)) {
      return { rows: [], totalMatches: 0, capped: false, effectiveHighlightQuery: "" }
    }
    return pickerRowsFor(deps.sessions(), deps.sessionCatalogErrors(), filterQuery(), nowMinute())
  })
  const selection = createKeyedListSelection(() => fullResult().rows.map((row) => isSelectablePickerRow(row) ? rowSessionId(row) : undefined))
  const currentResult = createMemo<SessionPickerResult>(() => {
    const result = fullResult()
    const selected = selection.key()
    const rows = capSelectableRows(result.rows, MAX_RENDERED_ROWS, selected)
    const labels = rows.filter((row): row is PickerSessionRow => row.kind === "session")
      .map((row) => formatCompactTimeAgo(nowMinute(), new Date(row.session.lastUpdated).getTime()))
    return { ...result, rows, timeAgoWidth: timeAgoColumnWidth(labels) }
  })
  const modalCursor = createMemo((): number => {
    const selected = selection.key()
    return Math.max(0, currentResult().rows.findIndex((row) => isSelectablePickerRow(row) && rowSessionId(row) === selected))
  })
  const setModalCursor = (index: number): void => {
    const row = currentResult().rows[index]
    selection.choose(isSelectablePickerRow(row) ? rowSessionId(row) : undefined)
  }

  function pickerRowForIndex(rowIndex: number): PickerRow | undefined {
    return currentResult().rows[rowIndex]
  }

  function selectedPickerRow(): SelectablePickerRow | undefined {
    const row = pickerRowForIndex(modalCursor())
    return isSelectablePickerRow(row) ? row : undefined
  }

  function clearModalState(): void {
    clearPendingShortcut()
    setModalConfirmDelete(undefined)
    setRenameState(undefined)
    filterEditor.resetEphemeralState({ cursor: 0 })
    titleEditor.resetEphemeralState({ cursor: 0 })
    shortTitleEditor.resetEphemeralState({ cursor: 0 })
  }

  function openSessionsModal(): void {
    batch(() => {
      setFilterQuery("")
      selection.choose(undefined)
      setModalConfirmDelete(undefined)
      entry = deps.modal.replace(deps.renderModal, { onKey: handleKey, onPaste: handlePaste, onClose: clearModalState, route: { kind: "sessions" } })
      const activeId = signals.foregroundId()
      const rows = currentResult().rows
      const activeIndex = activeId ? rows.findIndex((row) => row.kind === "session" && row.session.id === activeId) : -1
      setModalCursor(activeIndex >= 0 ? activeIndex : firstSelectableRow(rows, isSelectablePickerRow))
    })
    filterEditor.resetEphemeralState({ cursor: 0 })
    titleEditor.resetEphemeralState({ cursor: 0 })
    shortTitleEditor.resetEphemeralState({ cursor: 0 })
  }

  /** Close the Sessions modal this hook opened; `onClose` clears modal state. */
  function close(): void {
    entry?.close()
  }

  function selectModalItem(rowIndex: number): void {
    clearPendingShortcut()
    batch(() => {
      setModalCursor(rowIndex)
      setModalConfirmDelete(undefined)
      setRenameState(undefined)
    })
  }

  async function handleSessionView(session: SessionCatalogRow, opened: ModalHandle | undefined): Promise<void> {
    const result = await deps.activateSession(session)
    if (!result.ok) {
      if (result.error && opened?.isOpen()) showToast({ message: `Open failed for ${sessionSubject(session)}: ${result.error}`, variant: "error" })
      return
    }
    // A modal that is no longer this one owns the screen: close nothing and
    // report nothing, since the warning belongs to this view alone.
    if (!opened?.close()) return
    const detailWarning = sessionDetailWarning(deps.sessionCatalogErrors(), session.id)
    if (detailWarning) showToast({ message: detailWarning, variant: "warning" })
  }

  function openSession(session: SessionCatalogRow): void {
    clearPendingShortcut()
    const opened = entry
    const subject = sessionSubject(session)
    void handleSessionView(session, opened).catch((err) => {
      if (opened?.isOpen()) showToast({ message: `Open failed for ${subject}: ${extractErrorMessage(err)}`, variant: "error" })
    })
  }

  function openSessionRow(row: SelectablePickerRow): void {
    clearPendingShortcut()
    if (row.kind === "corrupt") return
    openSession(row.session)
  }

  function resumeSession(session: SessionCatalogRow): void {
    const subject = sessionSubject(session)
    openSession(session)
    void deps.appService.dispatch({ type: resumeMutationType(session.kind), sessionId: session.id })
      .then((result) => {
        if (!result.ok) showToast({ message: `Resume failed for ${subject}: ${result.error}`, variant: "error" })
      })
      .catch((err) => {
        showToast({ message: `Resume failed for ${subject}: ${extractErrorMessage(err)}`, variant: "error" })
      })
  }

  function interruptSession(session: SessionCatalogRow): void {
    const subject = sessionSubject(session)
    close()
    void dispatchInterrupt(deps.appService, session).then((refusal) => {
      if (refusal) showToast({ message: `Interrupt failed for ${subject}: ${refusal.reason}`, variant: refusal.variant })
    })
  }

  /** The delete itself is durable, so its outcome is always reported and names
   *  its subject. Only the cursor move belongs to the modal that asked. */
  async function deleteSessionRow(subject: string, deleteSession: () => Promise<void>): Promise<void> {
    const opened = entry
    const oldRows = currentResult().rows
    const oldRow = oldRows[modalCursor()]
    const oldSelectables = oldRows.filter(isSelectablePickerRow)
    const oldSelectableIndex = isSelectablePickerRow(oldRow) ? oldSelectables.indexOf(oldRow) : 0
    try {
      await deleteSession()
      if (opened?.isOpen()) {
        const newRows = currentResult().rows
        const newSelectables = newRows.filter(isSelectablePickerRow)
        if (newSelectables.length === 0) {
          setModalCursor(firstSelectableRow(newRows, isSelectablePickerRow))
        } else {
          const clamped = Math.min(Math.max(0, oldSelectableIndex), newSelectables.length - 1)
          const target = newSelectables[clamped]
          setModalCursor(target ? rowIndexOf(newRows, target) : firstSelectableRow(newRows, isSelectablePickerRow))
        }
      }
      showToast({ message: `Session deleted: ${subject}`, variant: "info" })
    } catch (err) {
      showToast({ message: `Delete failed for ${subject}: ${extractErrorMessage(err)}`, variant: "error" })
    }
  }

  function dispatchDelete(sessionId: string): Promise<void> {
    return deps.appService.dispatch({ type: "session.delete", sessionId }).then((result) => {
      if (!result.ok) throw new Error(result.error)
    })
  }

  function triggerDelete(session: SessionCatalogRow): void {
    if (modalConfirmDelete() !== session.id) {
      setModalConfirmDelete(session.id)
      return
    }
    setModalConfirmDelete(undefined)
    const subject = sessionSubject(session)
    if (session.id === signals.foregroundId()) {
      void deleteSessionRow(subject, () => deps.deleteActiveSession(session.id))
      return
    }
    void deleteSessionRow(subject, () => dispatchDelete(session.id))
  }

  function triggerCorruptDelete(row: PickerCorruptRow): void {
    if (modalConfirmDelete() !== row.sessionId) {
      setModalConfirmDelete(row.sessionId)
      return
    }
    setModalConfirmDelete(undefined)
    void deleteSessionRow(row.sessionId, () => dispatchDelete(row.sessionId))
  }

  function copySessionId(sessionId: string): void {
    const opened = entry
    void deps.clipboard.copy(sessionId)
      .then(() => { if (opened?.isOpen()) showToast({ message: `Copied: ${sessionId}`, variant: "info" }) })
      .catch((err) => {
        log.info("session id clipboard copy failed", { sessionId, error: extractErrorMessage(err), errorDetail: errorDetail(err) })
        if (opened?.isOpen()) showToast({ message: `Copy failed for ${sessionId}`, variant: "error" })
      })
  }

  function commitRename(): void {
    const state = renameState()
    setRenameState(undefined)
    if (!state) return
    const title = state.title.trim()
    const shortTitle = state.shortTitle.trim()
    const patch = {
      ...(state.title !== state.originalTitle ? { title } : {}),
      ...(state.shortTitle !== state.originalShortTitle ? { shortTitle } : {}),
    }
    if ((patch.title === undefined && patch.shortTitle === undefined) || patch.title === "" || patch.shortTitle === "") return
    void deps.appService.dispatch({ type: "session.rename", sessionId: state.sessionId, ...patch })
      .then((result) => {
        if (!result.ok) throw new Error(result.error)
      })
      .catch((err) => {
        showToast({ message: `Rename failed for ${state.sessionId}: ${extractErrorMessage(err)}`, variant: "error" })
      })
  }

  function beginRename(session: SessionCatalogRow): void {
    setModalConfirmDelete(undefined)
    const title = session.title
    const shortTitle = effectiveSessionShortTitle(title, session.shortTitle)
    setRenameState({ sessionId: session.id, title, shortTitle, originalTitle: title, originalShortTitle: shortTitle, field: "shortTitle" })
    titleEditor.resetEphemeralState({ cursor: title.length })
    shortTitleEditor.resetEphemeralState({ cursor: shortTitle.length })
  }

  function actionsForSession(session: SessionCatalogRow): SessionModalAction[] {
    const actions: SessionModalAction[] = [
      { key: "d", label: "delete", onTrigger: () => triggerDelete(session) },
      { key: "n", label: "rename", onTrigger: () => beginRename(session) },
      { key: "c", label: "copy session ID", onTrigger: () => copySessionId(session.id) },
    ]
    // The row's admitted actions and its live activity decide the controls
    // by the same rule as the prompt hint and the phase line; Resume also opens
    // the session so the person watches it continue. A held status also
    // says whether the session waits on background work, which the row's
    // activity alone does not.
    const status = signals.statusView(session.id)
    const offered = offeredSessionControls(session, status ? isInterruptible(status) : isActiveActivity(session.activity))
    if (offered.primary === "resume") actions.push({ key: "r", label: "resume", onTrigger: () => resumeSession(session) })
    if (offered.primary === "interrupt") actions.push({ key: "i", label: "interrupt", onTrigger: () => interruptSession(session) })
    return actions
  }

  function actionsForCorrupt(row: PickerCorruptRow): SessionModalAction[] {
    return [
      { key: "d", label: "delete", onTrigger: () => triggerCorruptDelete(row) },
      { key: "c", label: "copy session ID", onTrigger: () => copySessionId(row.sessionId) },
    ]
  }

  function actionsForRow(row: SelectablePickerRow): SessionModalAction[] {
    if (row.kind === "session") return actionsForSession(row.session)
    if (row.kind === "corrupt") return actionsForCorrupt(row)
    return []
  }

  const sessionModalActions = (): readonly SessionModalAction[] => {
    if (filterQuery() !== "" || renameState() !== undefined) return []
    const row = selectedPickerRow()
    return row ? actionsForRow(row) : []
  }

  function handleTypedTextKey(evt: ListModalKeyEvent, row: SelectablePickerRow): boolean {
    const text = normalizedPrintableText(evt)
    const rawAction = text && text.length === 1 ? matchAction(text, actionsForRow(row)) : undefined
    if (!text) return false

    if (pendingShortcut) {
      evt.preventDefault?.()
      const pending = pendingShortcut
      clearPendingShortcut()
      if (text === pending.key) triggerAction(pending.action)
      else filterEditor.handlePaste(pending.key + text)
      return true
    }

    if (rawAction && filterQuery() === "") {
      evt.preventDefault?.()
      const confirmTarget = rowSessionId(row)
      if (text === "d" && confirmTarget !== undefined && modalConfirmDelete() === confirmTarget) triggerAction(rawAction)
      else scheduleShortcut(text, rawAction)
      return true
    }

    return runEditor(filterEditor, evt) !== "unhandled"
  }

  function handleActionKey(evt: ListModalKeyEvent, row: SelectablePickerRow): void {
    // The footer advertises no actions while filtering; keep non-printable
    // shortcuts (e.g. ctrl+d) consistent with that.
    if (filterQuery() !== "") return
    const action = matchAction(evt.name.toLowerCase(), actionsForRow(row))
    if (!action) return
    clearPendingShortcut()
    evt.preventDefault?.()
    triggerAction(action)
  }

  function currentSelectableRow(): SelectablePickerRow | undefined {
    const rows = currentResult().rows
    const row = selectedPickerRow() ?? rows[firstSelectableRow(rows, isSelectablePickerRow)]
    return isSelectablePickerRow(row) ? row : undefined
  }

  const handleKey = createListModalKeys({
    rows: () => currentResult().rows,
    cursor: modalCursor,
    setCursor: (index) => {
      clearPendingShortcut()
      setModalCursor(index)
      setModalConfirmDelete(undefined)
    },
    selectable: isSelectablePickerRow,
    onSelect: () => {
      const row = currentSelectableRow()
      if (row) openSessionRow(row)
      else {
        // Only text shaped like a session id is read through detail, so an
        // unlisted child opens by its id and a search with no match stays a
        // search.
        const id = filterQuery().trim().toLowerCase()
        if (!isSessionId(id)) return
        const opened = entry
        void deps.activateSessionById(id).catch((err) => {
          if (opened?.isOpen()) showToast({ message: `Open failed for ${id}: ${extractErrorMessage(err)}`, variant: "error" })
        })
      }
    },
    onClose: close,
    extra: (evt) => {
      const name = evt.name.toLowerCase()
      if (renameState()) {
        if (name === "tab") {
          evt.preventDefault?.()
          setRenameState((state) => state ? { ...state, field: state.field === "title" ? "shortTitle" : "title" } : state)
          return true
        }
        const result = runEditor(renameEditor(), evt)
        if (result === "cancel") setRenameState(undefined)
        else if (result === "submit") commitRename()
        return true
      }
      if (evt.super && (name === "up" || name === "down")) {
        evt.preventDefault?.()
        const rows = currentResult().rows
        const index = name === "up"
          ? firstSelectableRow(rows, isSelectablePickerRow)
          : Math.max(0, rows.findLastIndex(isSelectablePickerRow))
        selectModalItem(index)
        return true
      }
      if (evt.ctrl && name === "s") {
        evt.preventDefault?.()
        close()
        return true
      }
      return false
    },
    textInput: (evt) => {
      const row = currentSelectableRow()
      if (!row) {
        runEditor(filterEditor, evt)
        return
      }
      if (handleTypedTextKey(evt, row)) return
      handleActionKey(evt, row)
    },
  })

  function handlePaste(text: string): void {
    clearPendingShortcut()
    const editor = renameState() ? renameEditor() : filterEditor
    editor.handlePaste(text)
  }

  function handleSessionFilter(query: string): void {
    clearPendingShortcut()
    batch(() => {
      setFilterQuery(query)
      setModalCursor(firstSelectableRow(currentResult().rows, isSelectablePickerRow))
      setModalConfirmDelete(undefined)
    })
  }

  function inputPresentation(): TextEditorPresentation {
    return (renameState() ? renameEditor() : filterEditor).presentation()
  }

  return {
    modalCursor,
    modalNavigationRevision: selection.revision,
    modalConfirmDelete,
    sessionModalResult: currentResult,
    // The clock the picker rows were built against; row labels must render
    // from the same clock or the time column can misalign for up to a minute.
    pickerNow: nowMinute,
    sessionModalActions,
    openSessionsModal,
    closeSessionsModal: close,
    selectModalItem,
    openSessionRow,
    handleSessionFilter,
    filterQuery,
    renameState,
    inputPresentation,
    renamePresentation: (field) => (field === "title" ? titleEditor : shortTitleEditor).presentation(),
  }
}

interface PickerRowsResult {
  readonly rows: readonly PickerRow[]
  readonly totalMatches: number
  readonly capped: boolean
  readonly effectiveHighlightQuery: string
}

interface SessionSearchCandidate {
  readonly row: PickerSessionRow | PickerCorruptRow
  readonly title: string
  readonly id: string
}

function pickerRowsFor(
  sessionList: readonly SessionCatalogRow[],
  errors: readonly SessionCatalogError[],
  query: string,
  now: number,
): PickerRowsResult {
  const corrupt = corruptPickerRows(errors)
  const sessionRows = allSessionRows(sessionList, now)
  const knownIds = new Set([...sessionRows.map((row) => row.session.id), ...corrupt.map((row) => row.sessionId)])
  const exactId = parseSessionIdQuery(query, knownIds)
  if (exactId) {
    const row = sessionRows.find((candidate) => candidate.session.id === exactId)
      ?? corrupt.find((candidate) => candidate.sessionId === exactId)
    const rows = row ? [row] : []
    return { rows, totalMatches: rows.length, capped: false, effectiveHighlightQuery: "" }
  }

  const activeQuery = query.trim()
  if (activeQuery) return fuzzyRowsFor(sessionRows, corrupt, activeQuery)

  const rows = withCorruptRows(flattenSessionRows(sessionList, now), corrupt)
  const totalMatches = rows.filter(isSelectablePickerRow).length
  const capped = totalMatches > MAX_RENDERED_ROWS
  return {
    rows,
    totalMatches,
    capped,
    effectiveHighlightQuery: "",
  }
}

function corruptPickerRows(errors: readonly SessionCatalogError[]): PickerCorruptRow[] {
  return errors
    .filter((error) => error.scope === "metadata")
    .map((error) => ({ kind: "corrupt" as const, id: `corrupt:${error.sessionId}`, sessionId: error.sessionId, reason: error.reason }))
}

function withCorruptRows(rows: PickerRow[], corrupt: readonly PickerCorruptRow[]): PickerRow[] {
  if (corrupt.length === 0) return rows
  const combined: PickerRow[] = [...rows]
  if (combined.length > 0) combined.push({ kind: "header", id: "spacer:unreadable", label: "" })
  combined.push({ kind: "header", id: "header:unreadable", label: "Unreadable" })
  combined.push(...corrupt)
  return combined
}

function rowSessionId(row: SelectablePickerRow): string | undefined {
  if (row.kind === "session") return row.session.id
  if (row.kind === "corrupt") return row.sessionId
  return undefined
}

function fuzzyRowsFor(sessionRows: readonly PickerSessionRow[], corrupt: readonly PickerCorruptRow[], query: string): PickerRowsResult {
  const candidates: SessionSearchCandidate[] = [
    ...sessionRows.map((row) => ({
      row,
      title: row.session.title || row.session.shortTitle || row.session.id,
      id: row.session.id,
    })),
    ...corrupt.map((row) => ({ row, title: row.sessionId, id: row.sessionId })),
  ]
  const matches = fuzzysort.go(query.toLowerCase(), candidates, {
    keys: ["title", "id"],
    scoreFn: (result) => Math.max(result[0]?.score ?? -Infinity, result[1]?.score ?? -Infinity),
  })
  const capped = matches.length > MAX_RENDERED_ROWS
  return {
    rows: matches.map((match) => match.obj.row),
    totalMatches: matches.length,
    capped,
    effectiveHighlightQuery: query,
  }
}

function allSessionRows(sessionList: readonly SessionCatalogRow[], now: number): PickerSessionRow[] {
  return flattenSessionRows(sessionList, now)
    .filter((row): row is PickerSessionRow => row.kind === "session")
}

function capSelectableRows(rows: readonly PickerRow[], maxRows: number, selected?: string): PickerRow[] {
  const selectables = rows.filter(isSelectablePickerRow)
  if (selectables.length <= maxRows) return [...rows]
  const retained = selectables.findIndex((row) => rowSessionId(row) === selected)
  const reserved = retained >= maxRows ? selectables[retained] : undefined
  const capped: PickerRow[] = []
  let selectableCount = 0
  for (const row of rows) {
    if (row.kind === "header") {
      if (selectableCount < maxRows || reserved !== undefined) capped.push(row)
      continue
    }
    if (selectableCount < maxRows - (reserved ? 1 : 0) || row === reserved) capped.push(row)
    selectableCount += 1
  }
  // A reserved row keeps its source-order heading, not empty groups skipped by the cap.
  return capped.filter((row, index) => row.kind !== "header" || capped[index + 1]?.kind !== "header" && index < capped.length - 1)
}

function isSelectablePickerRow(row: PickerRow | undefined): row is SelectablePickerRow {
  return row?.kind === "session" || row?.kind === "corrupt"
}

function rowIndexOf(rows: readonly PickerRow[], target: PickerRow): number {
  const index = rows.indexOf(target)
  return index >= 0 ? index : firstSelectableRow(rows, isSelectablePickerRow)
}

/** Per-session complaint shown when the user opens a session whose list
 *  enrichment (budget, queue, fork) failed; empty when nothing is degraded.
 *  Metadata-scope errors never reach this path: those sessions surface as
 *  corrupt picker rows, which cannot be opened. */
export function sessionDetailWarning(errors: readonly SessionCatalogError[], sessionId: string): string {
  return errors.some((error) => error.sessionId === sessionId)
    ? "Some details for this session couldn't be loaded"
    : ""
}

