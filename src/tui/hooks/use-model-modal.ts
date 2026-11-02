import { createEffect, createMemo, createSignal, onCleanup, untrack, type Accessor, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { errorMessage } from "../../infra/error-message.js"
import type {
  ModelAssignmentRow,
  ModelOptionRow,
  ModelSelectionEffort,
  ModelSelectionSlot,
  RuntimeModelAssignmentScope,
  RuntimeModelAssignmentWriteScope,
} from "../../protocol/model-assignment-protocol-types.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { observeModelCatalog } from "./observe-model-catalog.js"
import { defaultRoleSlots, sameSlot, roleSlot } from "../../orchestration/config/role-selection.js"
import { isProfileModelRole } from "../../protocol/brief-role-id.js"
import { buildModelModalItems, isSelectableItem } from "../modals/model-modal-helpers.js"
import type { ModelAssignmentItem, ModelModalState, ModelModalView } from "../modals/model-modal-types.js"
import { createModalDisclosureState, modalDisclosureAction } from "../components/modal-disclosure.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import type { ShellServices } from "./shell-state.js"
import { scopeSaveToast, type ModelModalScope } from "./use-model-modal-scope.js"
import { createControlledTextEditor, SINGLE_LINE_TEXT_ENTRY_POLICY } from "../keymap/text-entry.js"

interface ModelModalDeps {
  /** The settings-tree child context: every entry point seats the settings
   *  root underneath, so the left arrow at the root returns to settings.
   *  clear() dismisses the whole stack, settings root included. */
  modal: ModalContext
  renderModal: () => JSX.Element
  showToast: ShellServices["showToast"]
  appService: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  foregroundSessionId?: Accessor<string | undefined>
  /** The title of the foreground chat, which Model and effort names when
   *  the chat is the transcript in view (PI-INTERACTION-019). */
  foregroundTitle?: Accessor<string | undefined>
  /** Fires after any successful model/effort save. The shell uses it to
   *  resolve an action-needed provider notice whose offered option was
   *  /model: taking the offered action clears the notice. */
  onModelSaved?: () => void
}

// One coherent modal state domain: a single store write replaces the
// batch()-wrapped multi-signal updates, so intermediate states are
// unrepresentable by construction.
interface ModalState {
  nested: boolean
  sessionId: string | undefined
  scope: ModelModalScope
  view: ModelModalView
  cursor: number
  assignments: readonly ModelAssignmentRow[]
  modelOptions: readonly ModelOptionRow[]
  query: string
  pendingEfforts: ReadonlyMap<string, ModelSelectionEffort>
  activeSlot: ModelSelectionSlot | undefined
  operation: ModalOperation
  confirmReset: boolean
  expandedGroups: readonly string[]
}

/** Everything the cursor can traverse across the modal's three views. The
 *  assignment items discriminate on `kind`; the model option rows
 *  have no `kind`, which is how cursorRowSelectable tells them apart. */
type CursorRow = ModelAssignmentItem | ModelOptionRow

// Every async RPC is an identity-bearing operation in the store: a completion
// may install rows, clear loading, navigate, or toast only while its operation
// is still current. Changing scope, view, or slot - or closing the modal --
// invalidates the operation, so a late response cannot mutate a newer view.
type ModalOperation =
  | { kind: "idle" }
  | {
      kind: "loading_assignments" | "loading_models" | "saving" | "resetting"
      operationId: number
    }

interface ModelPickerTarget {
  sessionId: string
  /** The runtime's session-local serving edit target. */
  slot: ModelSelectionSlot
  /** The agent's name, which the picker and its save toast show: the seat
   *  of an agent's session belongs to that agent, never to its parent chat. */
  label: string
}

interface ModelModalOpening {
  handle: ModalHandle
  assignmentsLoaded: Promise<void>
}

export interface ModelModalHook {
  modelModalState: Accessor<ModelModalState>
  openModelsModal: () => Promise<void>
  openActiveModelPicker: (target?: ModelPickerTarget) => Promise<void>
  closeModelModal: () => void
  selectModelItem: (index: number) => void
}

export function useModelModal(deps: ModelModalDeps): ModelModalHook {
  const [state, setState] = createStore<ModalState>({
    nested: false,
    sessionId: undefined,
    scope: "defaults",
    view: { kind: "assignments" },
    cursor: 0,
    assignments: [],
    modelOptions: [],
    query: "",
    pendingEfforts: new Map(),
    activeSlot: undefined,
    operation: { kind: "idle" },
    confirmReset: false,
    expandedGroups: [],
  })
  const disclosures = createModalDisclosureState({
    expandedIds: () => state.expandedGroups,
    setExpandedIds: (ids) => setState("expandedGroups", ids),
  })
  const searchEditor = createControlledTextEditor({
    value: () => state.query,
    setValue: (query) => setState({ query, cursor: 0 }),
    policy: SINGLE_LINE_TEXT_ENTRY_POLICY,
  })
  let operationCounter = 0
  let entry: ModalHandle | undefined
  let stopCatalog: (() => void) | undefined
  let catalogReady = Promise.resolve()
  const [auth, setAuth] = createSignal<RuntimeAuthView>()
  const [catalogRevision, setCatalogRevision] = createSignal(0)
  let loadedRevision = 0
  let backgroundRead = 0
  onCleanup(() => stopCatalog?.())

  function beginOperation(kind: Exclude<ModalOperation, { kind: "idle" }>["kind"]): number {
    const operationId = ++operationCounter
    setState("operation", { kind, operationId })
    return operationId
  }

  function operationCurrent(operationId: number): boolean {
    const op = state.operation
    return op.kind !== "idle" && op.operationId === operationId
  }

  /** Accept an operation's completion: true only while it is still current.
   *  Every post-await store mutation, toast, and navigation gates on this. */
  function settleOperation(operationId: number): boolean {
    if (!operationCurrent(operationId)) return false
    setState("operation", { kind: "idle" })
    return true
  }

  function invalidateOperation(): void {
    operationCounter++
    if (state.operation.kind !== "idle") setState("operation", { kind: "idle" })
  }
  const profileOwned = createMemo(() => state.view.kind === "models" && state.activeSlot !== undefined && isProfileModelRole(state.activeSlot.roleId))
  const scopeToggleAvailable = createMemo(() => !state.nested && state.sessionId !== undefined && !profileOwned())

  const assignmentItems = createMemo(() => buildModelModalItems(state.assignments, new Set(state.expandedGroups)))
  const filteredModelOptions = createMemo(() => filterModelOptions(state.modelOptions))

  function filterModelOptions(options: readonly ModelOptionRow[]): readonly ModelOptionRow[] {
    const query = state.query.trim().toLowerCase()
    return query ? options.filter((option) => option.label.toLowerCase().includes(query) || option.model?.toLowerCase().includes(query)) : options
  }

  const modelModalState = createMemo<ModelModalState>(() => ({
    view: state.view,
    scope: state.scope,
    profileOwned: profileOwned(),
    savedModel: state.view.kind === "models" ? state.assignments.find((row) => row.slot.roleId === state.activeSlot?.roleId)?.savedModel : undefined,
    subagent: state.nested,
    scopeToggleAvailable: scopeToggleAvailable(),
    assignmentItems: assignmentItems(),
    modelOptions: filteredModelOptions(),
    query: state.query,
    pendingEfforts: state.pendingEfforts,
    cursor: state.cursor,
    loading: state.operation.kind !== "idle"
      && !(state.operation.kind === "loading_assignments" && state.assignments.length > 0)
      && !(state.operation.kind === "loading_models" && state.modelOptions.length > 0),
    confirmReset: state.confirmReset,
    auth: auth(),
  }))

  const selectionSlots = defaultRoleSlots()

  function watchCatalog(clearAuth = true): void {
    stopCatalog?.()
    if (clearAuth) setAuth(undefined)
    const observer = observeModelCatalog(deps.appService, currentScope(), (published) => {
      setAuth(published)
      setCatalogRevision((revision) => revision + 1)
    })
    stopCatalog = observer.dispose
    catalogReady = observer.ready
    void deps.appService.dispatch({ type: "auth.catalog.refresh", scope: currentScope() }).catch(() => {})
  }

  async function reloadAssignments(): Promise<void> {
    const op = beginOperation("loading_assignments")
    try {
      await catalogReady
      if (!operationCurrent(op)) return
      loadedRevision = catalogRevision()
      const rows = await deps.appService.query({ type: "modelAssignments", scope: currentScope(), slots: selectionSlots })
      if (!settleOperation(op)) return
      setState("assignments", rows)
      normalizeCursor()
    } catch (err) {
      if (!settleOperation(op)) return
      deps.showToast({ message: `Could not list models: ${errorMessage(err)}`, variant: "error" })
    }
  }

  async function reloadCatalogRows(): Promise<void> {
    const generation = operationCounter
    const read = ++backgroundRead
    const handle = entry
    const viewKind = state.view.kind
    const slot = state.view.kind === "models" ? state.activeSlot : undefined
    const current = () => entry === handle && handle?.isOpen() && generation === operationCounter && read === backgroundRead && state.operation.kind === "idle" && state.view.kind === viewKind
    try {
      if (slot === undefined) {
        const rows = await deps.appService.query({ type: "modelAssignments", scope: currentScope(), slots: selectionSlots })
        if (!current()) return
        setState("assignments", rows)
        normalizeCursor()
      } else {
        const options = await deps.appService.query({ type: "modelOptions", scope: currentScope(), slot })
        if (!current()) return
        const selected = filteredModelOptions()[state.cursor]
        const filtered = filterModelOptions(options)
        const cursor = filtered.findIndex((option) => option.model === selected?.model)
        const pendingEfforts = new Map([...state.pendingEfforts].filter(([model, effort]) => options.some((option) => option.model === model && option.efforts.includes(effort))))
        setState({ modelOptions: options, pendingEfforts, cursor: cursor < 0 ? Math.min(state.cursor, Math.max(0, filtered.length - 1)) : cursor })
      }
    } catch {
      // A failed background read does not replace the saved rows or interrupt input.
    }
  }

  createEffect(() => {
    const revision = catalogRevision()
    const idle = state.operation.kind === "idle"
    untrack(() => {
      if (!idle || revision === loadedRevision || !entry?.isOpen()) return
      loadedRevision = revision
      void reloadCatalogRows()
    })
  })

  /** Headings and spacers are not selectable; when a fresh item list leaves
   *  the cursor on one, move it to the first selectable row. */
  function normalizeCursor(): void {
    if (cursorIndexIsSelectable(state.cursor)) return
    const index = cursorRows().findIndex(cursorRowSelectable)
    if (index >= 0) setState("cursor", index)
  }

  function beginModelsModal(target?: ModelPickerTarget): ModelModalOpening {
    disclosures.reset()
    const sessionId = target?.sessionId ?? deps.foregroundSessionId?.()
    const scope = sessionId ? "session" : "defaults"
    const sameScope = state.scope === scope && state.sessionId === sessionId
    setState({
      nested: target !== undefined,
      sessionId,
      scope,
      ...(sameScope ? {} : { assignments: [], modelOptions: [] }),
      view: { kind: "assignments" },
      query: "",
      pendingEfforts: new Map(),
      cursor: 0,
      confirmReset: false,
    })
    const handle = (target ? deps.modal.push : deps.modal.replace)(deps.renderModal, {
      onKey: handleKey,
      onPaste: (text) => { if (state.view.kind === "models") searchEditor.handlePaste(text) },
      onClose: () => {
        invalidateOperation()
        stopCatalog?.()
        stopCatalog = undefined
        setState({ query: "", pendingEfforts: new Map() })
      },
    })
    entry = handle
    watchCatalog(!sameScope)
    const assignmentsLoaded = reloadAssignments()
    return { handle, assignmentsLoaded }
  }

  function openModelsModal(): Promise<void> {
    return beginModelsModal().assignmentsLoaded
  }

  /** The seat a picker opens: an agent's serving seat under the agent's
   *  name, or the foreground chat's own seat under the chat's title. With no
   *  chat in front it edits the defaults of the chat role, under its name. */
  function displayedSeat(target?: ModelPickerTarget): Pick<ModelPickerTarget, "slot" | "label"> {
    if (target !== undefined) return target
    const slot = roleSlot("chat")
    const title = deps.foregroundSessionId?.() === undefined ? undefined : deps.foregroundTitle?.()
    return { slot, label: title ?? state.assignments.find((row) => sameSlot(row.slot, slot))?.label ?? "Chat" }
  }

  /** Opens Model and effort of one session: an agent's serving seat when a
   *  target names it, pushed over its viewer, or the foreground chat's own
   *  seat. The runtime target is captured before any request. The row in
   *  force is selected, and an inherited choice selects the model it
   *  inherits, so the arrows adjust its effort at once. Each continuation
   *  after an await re-checks that this modal is still open, so an escape or
   *  another modal opening abandons stale work. */
  async function openActiveModelPicker(target?: ModelPickerTarget): Promise<void> {
    const opening = beginModelsModal(target)
    await opening.assignmentsLoaded
    if (!opening.handle.isOpen()) return
    const seat = displayedSeat(target)
    await openModelPicker(seat.slot, seat.label, true)
    if (!opening.handle.isOpen()) return
    const options = filteredModelOptions()
    const current = options.find((option) => option.selectable && option.current)
    const selected = current?.inherit
      ? options.find((option) => option.selectable && !option.inherit && option.model === current.inheritModel)
      : current
    if (selected) setState("cursor", options.indexOf(selected))
  }

  /** Detach only this entry: with the settings root underneath, the left
   *  arrow at the root lands back on settings. */
  function close(): void {
    entry?.close()
  }

  function closeModelModal(): void {
    if (state.nested) close()
    else deps.modal.clear()
  }

  /** Mouse clicks select the row; disclosure-only and navigational rows also
   *  activate because they have no separate primary action. */
  function selectModelItem(index: number): void {
    if (!cursorIndexIsSelectable(index)) return
    setState({ cursor: index, confirmReset: false })
    const current = state.view
    if (current.kind !== "assignments") return
    const items = assignmentItems()
    const item = items[index]
    if (item?.disclosure !== undefined && modalDisclosureAction(item.disclosure, "pointer") === "toggle") activateFromList(items)
  }

  async function openModelPicker(slot: ModelSelectionSlot, displayLabel: string, direct = false): Promise<void> {
    setState({
      activeSlot: slot,
      modelOptions: [],
      query: "",
      pendingEfforts: new Map(),
      cursor: 0,
      view: { kind: "models", displayLabel, ...(direct ? { direct: true } : {}) },
      confirmReset: false,
    })
    searchEditor.resetEphemeralState()
    const op = beginOperation("loading_models")
    try {
      loadedRevision = catalogRevision()
      const assigned = state.assignments.find((row) => sameSlot(row.slot, slot))
      const [options, assignment] = await Promise.all([
        deps.appService.query({ type: "modelOptions", scope: currentScope(), slot }),
        assigned ? Promise.resolve(assigned) : deps.appService.query({ type: "modelAssignments", scope: currentScope(), slots: [slot] }).then((rows) => rows[0]),
      ])
      if (!settleOperation(op)) return
      const currentIndex = filterModelOptions(options).findIndex((o) => o.current)
      setState({
        modelOptions: options,
        ...(assignment && !assigned ? { assignments: [...state.assignments, assignment] } : {}),
        ...(currentIndex >= 0 ? { cursor: currentIndex } : {}),
      })
    } catch (err) {
      if (!settleOperation(op)) return
      deps.showToast({ message: `Could not list models: ${errorMessage(err)}`, variant: "error" })
      setState("view", { kind: "assignments" })
    }
  }

  function adjustEffort(delta: -1 | 1): void {
    const option = filteredModelOptions()[state.cursor]
    if (!option?.selectable || option.inherit || option.model === null || option.efforts.length === 0) return
    const model = option.model
    const current = state.pendingEfforts.get(model) ?? option.effort
    const index = option.efforts.indexOf(current)
    const nextIndex = Math.max(0, Math.min(option.efforts.length - 1, index + delta))
    const effort = option.efforts[nextIndex]
    if (!effort || effort === current) return
    const pendingEfforts = new Map(state.pendingEfforts)
    pendingEfforts.set(model, effort)
    setState("pendingEfforts", pendingEfforts)
  }

  async function saveModel(option: ModelOptionRow): Promise<void> {
    if (!option.selectable) return
    const slot = state.activeSlot
    if (!slot) return
    const model = option.inherit ? null : option.model
    const effort = option.inherit || model === null ? null : state.pendingEfforts.get(model) ?? option.effort
    // eslint-disable-next-line solid/reactivity -- snapshot the scope for the save that starts below; later store changes must not alter this operation
    const { scope } = state
    const view = state.view.kind === "models" ? state.view : undefined
    const displayLabel = view?.displayLabel
    const op = beginOperation("saving")
    try {
      const result = await deps.appService.dispatch({ type: "model.save_effort", scope: writeScope(), slot, model, effort })
      const mirrored = result.mirrored ?? false
      deps.onModelSaved?.()
      if (!settleOperation(op)) return
      deps.showToast({
        message: result.warning ?? (isProfileModelRole(slot.roleId)
          ? `Updated ${displayLabel ?? result.label} for this auth profile`
          : state.nested ? `Updated ${displayLabel ?? result.label} for this subagent` : scopeSaveToast(scope, displayLabel ?? result.label, mirrored)),
        variant: result.warning ? "warning" : "success",
        duration: result.warning ? 8000 : undefined,
      })
      if (view?.direct) {
        // Model and effort ends here: saving dismisses the surface instead of
        // landing on the Models list the person did not open.
        closeModelModal()
        return
      }
      setState({ view: { kind: "assignments" }, cursor: indexOfSlot(slot), query: "", pendingEfforts: new Map() })
      await reloadAssignments()
    } catch (err) {
      if (!settleOperation(op)) return
      deps.showToast({ message: `Model selection failed: ${errorMessage(err)}`, variant: "error" })
    }
  }

  async function resetAssignments(): Promise<void> {
    const scope = writeScope()
    const op = beginOperation("resetting")
    try {
      const result = await deps.appService.dispatch({ type: "model.reset_assignments", scope, slots: selectionSlots })
      const mirrored = result.mirrored ?? false
      if (!settleOperation(op)) return
      setState({ assignments: result.rows, view: { kind: "assignments" }, cursor: 0, confirmReset: false })
      deps.showToast({
        message: result.warning ?? (mirrored ? "Reset model assignments for new sessions and this tab" : "Reset model assignments"),
        variant: result.warning ? "warning" : "success",
        duration: result.warning ? 8000 : undefined,
      })
    } catch (err) {
      if (!settleOperation(op)) return
      deps.showToast({ message: `Reset failed: ${errorMessage(err)}`, variant: "error" })
    }
  }

  function indexOfSlot(slot: ModelSelectionSlot): number {
    const currentItems = assignmentItems()
    const index = currentItems.findIndex((item) => item.kind === "assignment" && sameSlot(item.row.slot, slot))
    return index >= 0 ? index : 0
  }

  function currentScope(): RuntimeModelAssignmentScope {
    const sessionId = state.sessionId
    return state.scope === "session" && sessionId ? { kind: "session", sessionId } : { kind: "defaults" }
  }

  /** Scope for writes. A defaults-scope write with an open tab becomes the
   *  compound scope: orchestration applies the default and mirrors it into
   *  the foreground session in one operation. */
  function writeScope(): RuntimeModelAssignmentWriteScope {
    const sessionId = state.sessionId
    if (state.scope === "session" && sessionId) return { kind: "session", sessionId }
    return sessionId ? { kind: "defaults-and-session", sessionId } : { kind: "defaults" }
  }

  function activateFromList(items: readonly ModelAssignmentItem[]): void {
    const item = items[state.cursor]
    if (!isSelectableItem(item)) return
    if (item.disclosure !== undefined) {
      const action = modalDisclosureAction(item.disclosure, "enter")
      if (action === "toggle") {
        disclosures.toggle(item.disclosure.id)
        return
      }
    }
    void openModelPicker(item.row.slot, item.row.label)
  }

  function activateCurrent(): void {
    const current = state.view
    if (current.kind === "assignments") { activateFromList(assignmentItems()); return }
    if (current.kind === "models") {
      const option = filteredModelOptions()[state.cursor]
      if (!option) return
      void saveModel(option)
      return
    }
  }

  function goBack(): void {
    const current = state.view
    if (current.kind === "assignments") { close(); return }
    invalidateOperation()
    const slot = state.activeSlot
    setState({
      view: { kind: "assignments" },
      cursor: slot ? indexOfSlot(slot) : 0,
      query: "",
      pendingEfforts: new Map(),
    })
  }

  function toggleScope(): void {
    if (!scopeToggleAvailable()) return
    setState({
      scope: state.scope === "session" ? "defaults" : "session",
      assignments: [],
      modelOptions: [],
      query: "",
      pendingEfforts: new Map(),
      view: { kind: "assignments" },
      cursor: 0,
      confirmReset: false,
    })
    watchCatalog()
    void reloadAssignments()
  }

  const handleKey = createListModalKeys<CursorRow>({
    rows: cursorRows,
    cursor: () => state.cursor,
    setCursor: (index) => setState({ cursor: index, confirmReset: false }),
    selectable: cursorRowSelectable,
    onSelect: activateCurrent,
    onClose: closeModelModal,
    extra: (evt) => {
      if (evt.name === "space") {
        const row = cursorRows()[state.cursor]
        if (row && "kind" in row && row.disclosure !== undefined && modalDisclosureAction(row.disclosure, "space") === "toggle") {
          evt.preventDefault?.()
          disclosures.toggle(row.disclosure.id)
          return true
        }
      }
      if (evt.ctrl && evt.name === "r" && resetAllowed(state.view)) {
        evt.preventDefault?.()
        if (state.confirmReset) void resetAssignments()
        else setState("confirmReset", true)
        return true
      }
      if (evt.name === "g" && (evt.ctrl || state.view.kind !== "models")) { evt.preventDefault?.(); toggleScope(); return true }
      if (state.view.kind === "models") {
        if (evt.name === "left") { evt.preventDefault?.(); adjustEffort(-1); return true }
        if (evt.name === "right") { evt.preventDefault?.(); adjustEffort(1); return true }
        if (["home", "end", "pageup", "pagedown"].includes(evt.name)) {
          evt.preventDefault?.()
          const last = Math.max(0, filteredModelOptions().length - 1)
          const cursor = evt.name === "home" ? 0 : evt.name === "end" ? last : state.cursor + (evt.name === "pageup" ? -10 : 10)
          setState("cursor", Math.max(0, Math.min(last, cursor)))
          return true
        }
        if (evt.name === "backspace" && !state.query) { evt.preventDefault?.(); goBack(); return true }
        return searchEditor.handleKey(evt) === "handled"
      } else if (evt.name === "left" || evt.name === "h") {
        evt.preventDefault?.()
        goBack()
        return true
      }
      return false
    },
  })

  function resetAllowed(current: ModelModalView): boolean {
    return current.kind === "assignments"
  }

  /** The rows under the cursor for the current view. Assignment lists carry
   *  non-selectable spacers; the model picker keeps every row reachable
   *  so an unselectable option can still show its reason. */
  function cursorRows(): readonly CursorRow[] {
    const current = state.view
    if (current.kind === "assignments") return assignmentItems()
    return filteredModelOptions()
  }

  function cursorRowSelectable(row: CursorRow): boolean {
    return "kind" in row ? isSelectableItem(row) : true
  }

  function cursorIndexIsSelectable(index: number): boolean {
    const row = cursorRows()[index]
    return row !== undefined && cursorRowSelectable(row)
  }

  return {
    modelModalState,
    openModelsModal,
    openActiveModelPicker,
    closeModelModal,
    selectModelItem,
  }
}
