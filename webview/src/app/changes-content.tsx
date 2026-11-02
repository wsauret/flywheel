import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import type { ChangesUndoState, SessionChangesController } from "../../../src/protocol/client/session-changes.js"
import { pathInside, sessionChangeFolderLabel, sessionChangeNamesPath, sessionChangeDiffStatusLine, sessionChangePathLabel, sessionChangesRows, sessionChangeWritersLabel, undoResultLine, type SessionChangesRow } from "../../../src/protocol/client/session-changes-copy.js"
import type { SessionChangeFile, SessionChangesResult } from "../../../src/protocol/session-changes-protocol-types.js"
import type { ChangesReviewTarget } from "../../../src/protocol/client/host-contract.js"
import { changesLabel } from "../client/changes-label.js"
import { FileDiff } from "./file-diff.js"
import { Icon, ICONS } from "./icons.js"
import { preserveReaderAnchor, survivingReaderAnchor } from "./transcript-scroll.js"

/** The one line under a file's header while its Undo is in flight or settled.
 *  A transport failure is an unknown outcome, never a refusal. */
function undoStateLine(undo: ChangesUndoState): string | undefined {
  switch (undo.status) {
    case "confirming": return undefined
    case "submitting": return "Undoing..."
    case "unknown": return "Undo outcome unknown; refreshing"
    case "result": return undoResultLine(undo.result)
  }
}

/** Shared sheet and editor-area content: every net-changed file with its
 *  header, collapsed net diff, and Undo. The controller owns proof and Undo. */
export function ChangesContent(props: {
  controller: SessionChangesController
  target?: ChangesReviewTarget
  onOpenFile?: (path: string, executionCwd: string) => void
}) {
  const controller = props.controller
  const [state, setState] = createSignal(controller.snapshot)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const sections = new Map<string, HTMLElement>()
  let root: HTMLDivElement | undefined
  let pendingRestore: number | undefined
  /** The file a host target named, held at the top of the view until the
   *  person acts. The list arrives before any diff, so every earlier file
   *  still reads "Loading..." when the target first scrolls, and each diff
   *  that loads after it would push the target out of view. */
  let pinned: string | undefined
  interface Anchor { readonly fileId: string; readonly offsets: ReadonlyMap<string, number>; readonly previousIds: readonly string[] }
  const scrollOwner = (): HTMLElement | undefined => {
    return root?.closest<HTMLElement>(".sheet-body, .changes-editor") ?? undefined
  }
  const captureAnchor = (): Anchor | undefined => {
    const owner = scrollOwner()
    if (!owner) return
    const ownerTop = owner.getBoundingClientRect().top
    const ordered = files()
    const anchor = ordered.map(file => sections.get(file.fileId)).find(section => section && section.getBoundingClientRect().bottom > ownerTop)
    if (!anchor) return
    const fileId = ordered.find(file => sections.get(file.fileId) === anchor)?.fileId
    const offsets = new Map(ordered.flatMap(file => {
      const section = sections.get(file.fileId)
      return section ? [[file.fileId, section.getBoundingClientRect().top - ownerTop] as const] : []
    }))
    return fileId ? { fileId, offsets, previousIds: ordered.map(file => file.fileId) } : undefined
  }
  const restoreAnchor = (anchor: Anchor | undefined): void => {
    if (!anchor) return
    const owner = scrollOwner()
    if (!owner) return
    const filesNow = files()
    const fileId = survivingReaderAnchor(anchor.previousIds, filesNow.map(file => file.fileId), anchor.fileId)
    const section = fileId ? sections.get(fileId) : undefined
    const priorOffset = fileId ? anchor.offsets.get(fileId) : undefined
    if (section && priorOffset !== undefined) owner.scrollTop = preserveReaderAnchor(owner.scrollTop, section.getBoundingClientRect().top - owner.getBoundingClientRect().top, priorOffset)
  }
  const restoreAfterLayout = (anchor: Anchor | undefined): void => {
    const window = root!.ownerDocument.defaultView!
    if (pendingRestore !== undefined) window.cancelAnimationFrame(pendingRestore)
    pendingRestore = window.requestAnimationFrame(() => {
      pendingRestore = undefined
      restoreAnchor(anchor)
      syncViewport()
    })
  }
  const revealPinnedAfterLayout = (): void => {
    const window = root!.ownerDocument.defaultView!
    if (pendingRestore !== undefined) window.cancelAnimationFrame(pendingRestore)
    pendingRestore = window.requestAnimationFrame(() => {
      pendingRestore = undefined
      if (pinned !== undefined) sections.get(pinned)?.scrollIntoView({ block: "start" })
      syncViewport()
    })
  }
  const changeState = (): void => {
    if (pinned !== undefined) {
      setState(controller.snapshot)
      revealPinnedAfterLayout()
      return
    }
    const anchor = captureAnchor()
    setState(controller.snapshot)
    restoreAfterLayout(anchor)
  }
  const syncViewport = (): void => {
    const owner = scrollOwner()
    if (!owner) return
    const viewport = owner.getBoundingClientRect()
    const visible: string[] = []
    for (const [fileId, section] of sections) {
      const bounds = section.getBoundingClientRect()
      if (bounds.bottom <= viewport.top || bounds.top >= viewport.bottom) continue
      visible.push(fileId)
      const diff = state().diffs.get(fileId)
      if (expanded().has(fileId) && diff?.status === "ready" && !diff.complete && bounds.bottom <= viewport.bottom + 400) controller.continueDiff(fileId, 100)
    }
    if (pinned && !visible.includes(pinned)) visible.push(pinned)
    controller.setVisibleFiles(visible)
    if (owner.scrollHeight - owner.scrollTop - owner.clientHeight < 400) void controller.loadMoreFiles()
  }
  onCleanup(controller.onChange(changeState))
  onCleanup(() => {
    if (pendingRestore !== undefined) root!.ownerDocument.defaultView!.cancelAnimationFrame(pendingRestore)
    controller.closeReview()
  })
  onMount(() => {
    const owner = scrollOwner()
    const cancelPendingRestore = () => {
      // The pinned target scrolls the view itself, so only the person's own
      // input, below, lets it go.
      if (pendingRestore === undefined || pinned !== undefined) return
      root!.ownerDocument.defaultView!.cancelAnimationFrame(pendingRestore)
      pendingRestore = undefined
    }
    const release = () => { pinned = undefined }
    const personal = ["wheel", "pointerdown", "keydown", "touchstart"] as const
    const scroll = () => { cancelPendingRestore(); syncViewport() }
    owner?.addEventListener("scroll", scroll, { passive: true })
    const resize = new (root!.ownerDocument.defaultView!).ResizeObserver(syncViewport)
    if (root) resize.observe(root)
    if (owner) resize.observe(owner)
    for (const type of personal) owner?.addEventListener(type, release, { passive: true })
    onCleanup(() => {
      owner?.removeEventListener("scroll", scroll)
      resize.disconnect()
      for (const type of personal) owner?.removeEventListener(type, release)
    })
    void controller.openReview(props.target?.path)
    void controller.start()
  })

  const listData = (): SessionChangesResult | undefined => { const list = state().list; return "data" in list ? list.data : undefined }
  const files = () => listData()?.files ?? []
  const gaps = () => listData()?.unknownFileMutationGaps ?? 0
  const summaryError = () => { const summary = state().summary; return summary.status === "error" ? summary.error : undefined }
  const listError = () => { const list = state().list; return list.status === "error" ? list.error : undefined }
  /** Discloses a file's whole diff, or the files under a removed folder, by its row key. */
  const toggle = (key: string) => {
    pinned = undefined
    const anchor = captureAnchor()
    setExpanded(current => {
    const next = new Set(current)
    if (!next.delete(key)) next.add(key)
    return next
    })
    if (expanded().has(key)) controller.continueDiff(key)
    restoreAfterLayout(anchor)
  }

  // A host target lands once: the first list that carries the path expands
  // that file and brings its header to the top of the view, where it stays
  // while the diffs above it load.
  let targetPath = props.target?.path
  createEffect(on(listData, data => {
    if (targetPath === undefined || !data) return
    const target = targetPath
    const file = data.files.find(entry => sessionChangeNamesPath(target, data.executionCwd, entry.path))
    if (!file) return
    targetPath = undefined
    pinned = file.fileId
    setExpanded(current => new Set([...current, file.fileId, ...(file.folder ? [`folder:${file.folder.path}`] : [])]))
    sections.get(file.fileId)?.scrollIntoView({ block: "start" })
  }))

  const FolderSection = (row: Accessor<Extract<SessionChangesRow, { kind: "folder" }>>, executionCwd: () => string) =>
    <section class="changes-file">
      <header class="changes-file-header" tabIndex={0} aria-expanded={expanded().has(row().key)} onClick={() => toggle(row().key)}
        onKeyDown={event => { if (event.key === "Enter") toggle(row().key) }}>
        <span class="changes-file-change changes-file-change-removed" role="img" aria-label="removed" title="removed">−</span>
        <span class="changes-file-path" title={row().path}>{sessionChangeFolderLabel(row(), executionCwd())}</span>
        <span class="changes-folder-chevron" aria-hidden="true">{expanded().has(row().key) ? "▾" : "▸"}</span>
      </header>
    </section>

  const FileSection = (file: Accessor<SessionChangeFile>, executionCwd: () => string) => {
    const fileId = () => file().fileId
    const currentFile = () => files().find(candidate => candidate.fileId === fileId()) ?? file()
    const label = () => sessionChangePathLabel(currentFile().path, executionCwd())
    const diff = () => state().diffs.get(fileId())
    const mutation = () => { const current = diff(); return current?.status === "ready" ? current.diff : undefined }
    const moreBytes = () => { const current = diff(); return current?.status === "ready" && !current.complete }
    const lineCounts = () => { const current = diff(); return current?.status === "ready" ? current.lineCounts : undefined }
    const pathParts = createMemo(() => { const path = label(); const split = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1; return { directory: path.slice(0, split), name: path.slice(split) } })
    const statusLine = () => { const current = diff(); return current?.status === "ready" ? undefined : sessionChangeDiffStatusLine(current) }
    const undo = () => { const current = state().undo; return current?.fileId === fileId() ? current : undefined }
    const resultLine = () => { const current = undo(); return current ? undoStateLine(current) : undefined }
    const canUndo = () => { state(); return controller.canUndo(fileId()) }
    const canConfirmUndo = () => { state(); return controller.canConfirmUndo() }
    const undoUnavailableReason = () => { state(); return controller.undoUnavailableReason(fileId()) }
    const viewedMutation = () => { const current = state().viewed; return current?.fileId === fileId() ? current : undefined }
    const viewedMessage = () => {
      const current = viewedMutation()
      if (current?.status === "refused") return `Viewed refused: ${current.error}`
      if (current?.status === "unknown") return "Viewed outcome unknown; refreshing"
    }
    const viewed = () => currentFile().review.status === "viewed"
    const activateHeader = () => {
      if (viewed()) void controller.setViewed(fileId(), false)
      else if (currentFile().review.status === "unviewed") toggle(fileId())
    }
    onCleanup(() => sections.delete(fileId()))
    return <section class="changes-file" classList={{ "changes-folder-file": currentFile().folder !== undefined }} ref={element => sections.set(fileId(), element)}>
      <header class="changes-file-header" tabIndex={0} onClick={activateHeader}
        onKeyDown={event => { if (event.key === "Enter") activateHeader() }}>
        <span class={`changes-file-change changes-file-change-${currentFile().change}`} role="img" aria-label={currentFile().change} title={currentFile().change}>{currentFile().change === "added" ? "+" : currentFile().change === "removed" ? "−" : "~"}</span>
        <span class="changes-file-path" title={currentFile().path}
          onCopy={event => { event.clipboardData?.setData("text/plain", label()); event.preventDefault() }}>
          <span class="changes-file-directory"><bdi>{pathParts().directory}</bdi></span><span class="changes-file-name">{pathParts().name}</span>
        </span>
        <Show when={sessionChangeWritersLabel(currentFile())}>{writers => <span class="changes-file-writers" title={currentFile().writers.map(writer => writer.title).join(", ")}>{writers()}</span>}</Show>
        <Show when={lineCounts()}>{counts => <span class="changes-file-counts"><span class="changes-file-change-added">+{counts().added}</span><span class="changes-file-change-removed">-{counts().removed}</span></span>}</Show>
        {/* The controller owns the one Viewed write in flight, here and in the
            editor's review, which has no actions layer; the tapped file's
            label shows that it works until the runtime answers. */}
        <label class="changes-file-viewed" aria-busy={viewedMutation()?.status === "submitting" || undefined} onClick={event => event.stopPropagation()}>
          <input type="checkbox" checked={viewed()} disabled={!controller.canSetViewed(fileId())}
            onChange={event => { event.stopPropagation(); void controller.setViewed(fileId(), event.currentTarget.checked) }} />
          <span>{currentFile().review.status === "unknown" ? "Review unknown" : "Viewed"}</span>
        </label>
        <button class="changes-file-undo" disabled={!canUndo()} onClick={event => { event.stopPropagation(); controller.requestUndo(fileId()) }}>Undo</button>
        <Show when={!canUndo() && undoUnavailableReason()}>{reason => <span class="changes-file-status">{reason()}</span>}</Show>
        <Show when={pathInside(currentFile().path, executionCwd()) === undefined ? undefined : props.onOpenFile}>
          {open => <button class="changes-file-open" aria-label={`Open ${label()} in editor`} onClick={event => { event.stopPropagation(); open()(currentFile().path, executionCwd()) }} title="Open in editor"><Icon path={ICONS.arrowUpRight} /></button>}
        </Show>
      </header>
      <Show when={viewedMessage()}>{message => <p class="changes-file-status" role="status">{message()}</p>}</Show>
      <Show when={undo()?.status === "confirming"}>
        <div class="changes-file-confirm" role="alertdialog" aria-label="Confirm Undo">
          <span>Undo all changes to {label()}?</span>
          <button aria-disabled={!canConfirmUndo() || undefined} onClick={() => { if (canConfirmUndo()) void controller.confirmUndo() }}>Confirm</button>
          <button onClick={() => controller.cancelUndo()}>Cancel</button>
          <Show when={!canConfirmUndo()}><span role="status">{undoUnavailableReason()}</span></Show>
        </div>
      </Show>
      <Show when={resultLine()}>{line => <p class="changes-file-status" role="status">{line()}</p>}</Show>
      <Show when={!viewed()}>
      <Show when={mutation()} fallback={<p class="changes-file-status" role="status">{statusLine()}</p>}>
        {value => <div class="changes-file-body">
          <FileDiff body={{ kind: "net", diff: value() }} moreBytes={moreBytes()} hideHeading fileExpanded={() => expanded().has(fileId())} onToggleFile={() => toggle(fileId())} />
        </div>}
      </Show>
      </Show>
    </section>
  }

  return <div class="changes-content" ref={element => { root = element }}>
    <div class="changes-controls">
      <button onClick={() => void controller.refresh()}>Refresh</button>
      <span role="status">{changesLabel(state().summary)}</span>
    </div>
    <Show when={summaryError()}>{error => <p role="alert">Changes unavailable: {error()}</p>}</Show>
    <Show when={listError()}>{error => <p role="alert">Changes unavailable: {error()}</p>}</Show>
    <Show when={gaps() > 0}><p class="changes-warning" role="status">Incomplete history: some file changes are unknown; Undo unavailable.</p></Show>
    <Show when={state().list.status === "loading" && listData() === undefined}><p class="changes-file-status" role="status">Loading...</p></Show>
    <Show when={state().list.status === "ready" && files().length === 0}>
      <p>{listData()!.excludedFileCount > 0
        ? listData()!.excludedFileCount === 1
          ? "1 file is not shown because it changed or was removed after this session's last recorded write."
          : `${listData()!.excludedFileCount} files are not shown because they changed or were removed after this session's last recorded write.`
        : "No file changes in this session."}</p>
    </Show>
    <Show when={listData()}>{data => <Key each={sessionChangesRows(data().files, expanded())} by={row => row.key}>{row => {
      const current = row()
      // A row's key fixes its kind, so each accessor keeps the latest row of the kind it mounted.
      return current.kind === "folder" ? FolderSection(() => { const latest = row(); return latest.kind === "folder" ? latest : current }, () => data().executionCwd)
        : FileSection(() => { const latest = row(); return latest.kind === "file" ? latest.file : current.file }, () => data().executionCwd)
    }}</Key>}</Show>
  </div>
}
