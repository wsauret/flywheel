import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor, type JSX } from "solid-js"
import { sessionChangesRows, type SessionChangesRow } from "../../protocol/client/session-changes-copy.js"
import type { SessionChangeFile } from "../../protocol/session-changes-protocol-types.js"
import { createListModalKeys } from "../components/modal-list-keys.js"
import { createModalScrollController } from "../components/modal-scroll-controller.js"
import type { ModalContext, ModalHandle } from "../components/modal-stack.js"
import type { SessionChangesView } from "./create-session-changes.js"
import { patchScrollBoxLayoutHooks } from "../components/scrollbox-layout-hooks.js"

/** Modal navigation and disclosure only. Undo eligibility, confirmation, and dispatch belong to the shared session controller. */
export function useSessionChangesModal(deps: {
  readonly modal: Pick<ModalContext, "replace">
  readonly view: Accessor<SessionChangesView | undefined>
  readonly renderModal: () => JSX.Element
}) {
  const [cursor, writeCursor] = createSignal(0)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const listScroll = createModalScrollController()
  // Sections have variable height, so the cursor reveals its header by element, not by row.
  const headers = new Map<string, Renderable>()
  const sections = new Map<string, Renderable>()
  let selectedKey: string | undefined
  let previousLayoutRows: readonly SessionChangesRow[] = []
  let previousSelectionRows: readonly SessionChangesRow[] = []
  let handle: ModalHandle | undefined
  let stopViewport: (() => void) | undefined
  let scrollbox: ScrollBoxRenderable | undefined
  const snapshot = () => deps.view()?.snapshot()
  const files = createMemo<readonly SessionChangeFile[]>(() => {
    const list = snapshot()?.list
    return list && "data" in list && list.data ? list.data.files : []
  })
  /** The cursor moves over these: each file, and each removed folder's header. */
  const rows = createMemo(() => sessionChangesRows(files(), expanded()))
  const currentCursor = () => Math.min(cursor(), Math.max(0, rows().length - 1))
  const currentFile = (): SessionChangeFile | undefined => { const row = rows()[currentCursor()]; return row?.kind === "file" ? row.file : undefined }
  const isExpanded = (key: string): boolean => expanded().has(key)
  const close = (): void => { handle?.close() }
  const setCursor = (index: number, reveal = true): void => {
    writeCursor(index)
    const row = rows()[index]
    selectedKey = row?.key
    const header = row ? headers.get(row.key) : undefined
    if (header && reveal) listScroll.scrollIntoView(header)
    syncViewport()
  }
  function syncViewport(): void {
    const current = rows()
    const selected = currentFile()
    const shown = current.filter(row => {
      const section = sections.get(row.key)
      const viewport = scrollbox?.viewport
      return section && viewport && section.screenY < viewport.screenY + viewport.height && section.screenY + section.height > viewport.screenY
    })
    const shownFiles = shown.flatMap(row => row.kind === "file" ? [row.file] : [])
    const ids = new Set(shownFiles.map(file => file.fileId))
    if (selected) ids.add(selected.fileId)
    const controller = deps.view()?.controller
    controller?.setVisibleFiles([...ids])
    if (current.length > 0 && (currentCursor() >= current.length - 3 || shown.some(row => current.indexOf(row) >= current.length - 3))) void controller?.loadMoreFiles()
    for (const file of shownFiles) {
      const diff = snapshot()?.diffs.get(file.fileId)
      const section = sections.get(file.fileId)
      const viewport = scrollbox?.viewport
      if (isExpanded(file.fileId) && diff?.status === "ready" && !diff.complete && section && viewport
        && section.screenY + section.height <= viewport.screenY + viewport.height + 20) controller?.continueDiff(file.fileId, 100, viewport.width)
    }
  }
  const attachScroll = (scroll: ScrollBoxRenderable): void => {
    stopViewport?.()
    scrollbox = scroll
    listScroll.attach(scroll)
    stopViewport = patchScrollBoxLayoutHooks(scroll, { onFrame: syncViewport, onResize: syncViewport })
    syncViewport()
  }
  const registerHeader = (key: string, renderable: Renderable): (() => void) => {
    headers.set(key, renderable)
    return () => { if (headers.get(key) === renderable) headers.delete(key) }
  }
  const registerSection = (key: string, renderable: Renderable): (() => void) => {
    sections.set(key, renderable)
    return () => { if (sections.get(key) === renderable) sections.delete(key) }
  }
  /** Discloses a file's whole diff, or the files under a removed folder, by its row key. */
  const toggleExpanded = (key: string): void => {
    setExpanded(previous => {
      const next = new Set(previous)
      if (!next.delete(key)) next.add(key)
      return next
    })
    if (isExpanded(key)) deps.view()?.controller.continueDiff(key)
  }
  const requestUndo = (fileId = currentFile()?.fileId): void => {
    if (fileId !== undefined) deps.view()?.controller.requestUndo(fileId)
  }
  const toggleViewed = (file = currentFile()): void => {
    if (!file || file.review.status === "unknown") return
    void deps.view()?.controller.setViewed(file.fileId, file.review.status !== "viewed")
  }
  const confirmUndo = (): void => { void deps.view()?.controller.confirmUndo() }
  const cancelUndo = (): void => { deps.view()?.controller.cancelUndo() }
  const handleKey = createListModalKeys({
    rows, cursor: currentCursor, setCursor, selectable: () => true,
    onSelect: index => {
      const row = rows()[index]
      if (row?.kind === "folder") toggleExpanded(row.key)
      else if (row?.file.review.status === "viewed") toggleViewed(row.file)
      else if (row?.file.review.status === "unviewed") toggleExpanded(row.key)
    },
    onClose: close,
    extra: event => {
      const name = event.name.toLowerCase()
      if (event.ctrl || event.meta) return true
      const undo = snapshot()?.undo
      if (undo?.status === "confirming") {
        // The confirmation owns the keyboard until it is answered: no key moves
        // the cursor, expands a file, or scrolls while the question is open.
        if (name === "y") confirmUndo()
        else if (name === "escape" || name === "n") cancelUndo()
        else if (name === "u") requestUndo(undo.fileId)
      } else if (name === "pageup" || name === "pagedown") listScroll.pageBy(name === "pageup" ? -1 : 1)
      else if (name === "u") requestUndo()
      else if (name === "v") toggleViewed()
      else return false
      event.preventDefault?.()
      return true
    },
  })
  function openSessionChangesModal(): void {
    const owner = deps.view()
    if (!owner) return
    close()
    listScroll.reset()
    setCursor(0, false)
    void owner.controller.openReview()
    handle = deps.modal.replace(deps.renderModal, {
      onKey: handleKey,
      onClose: () => { stopViewport?.(); stopViewport = undefined; scrollbox = undefined; owner.controller.closeReview(); listScroll.detach() },
    })
  }
  createEffect(on(rows, next => {
    const nextIds = new Set(next.map(row => row.key))
    const priorSectionKeys = new Map<Renderable, string>()
    const priorSections = previousLayoutRows.flatMap(row => {
      const section = sections.get(row.key)
      if (section) priorSectionKeys.set(section, row.key)
      return section ? [section] : []
    })
    const visibleSection = listScroll.firstVisible(priorSections)
    const visibleKey = visibleSection ? priorSectionKeys.get(visibleSection) : undefined
    if (visibleKey) {
      const oldIndex = previousLayoutRows.findIndex(row => row.key === visibleKey)
      const surviving = nextIds.has(visibleKey) ? visibleKey
        : previousLayoutRows.slice(oldIndex + 1).find(row => nextIds.has(row.key))?.key
          ?? previousLayoutRows.slice(0, oldIndex).toReversed().find(row => nextIds.has(row.key))?.key
      const anchor = surviving ? sections.get(surviving) : undefined
      if (anchor) listScroll.preserveAnchor(anchor)
    }
    previousLayoutRows = next
  }))
  createEffect(on(rows, next => {
    const nextIndex = new Map(next.map((row, index) => [row.key, index]))
    const previousIndex = new Map(previousSelectionRows.map((row, index) => [row.key, index]))
    const oldIndex = selectedKey === undefined ? currentCursor() : previousIndex.get(selectedKey) ?? -1
    let index = selectedKey === undefined ? Math.min(currentCursor(), Math.max(0, next.length - 1)) : nextIndex.get(selectedKey) ?? -1
    if (index < 0 && oldIndex >= 0) {
      const surviving = previousSelectionRows.slice(oldIndex + 1).find(row => nextIndex.has(row.key))
        ?? previousSelectionRows.slice(0, oldIndex).toReversed().find(row => nextIndex.has(row.key))
      const survivingIndex = surviving ? nextIndex.get(surviving.key) : undefined
      index = survivingIndex ?? Math.min(oldIndex, Math.max(0, next.length - 1))
    }
    previousSelectionRows = next
    if (next.length > 0) setCursor(Math.max(0, index), false)
  }))
  createEffect(on(deps.view, () => close(), { defer: true }))
  onCleanup(close)
  return { openSessionChangesModal, close, snapshot, rows, cursor: currentCursor, setCursor, isExpanded, toggleExpanded, toggleViewed, registerHeader, registerSection, requestUndo, confirmUndo, cancelUndo, listScroll, attachScroll }
}

export type SessionChangesModalHook = ReturnType<typeof useSessionChangesModal>
