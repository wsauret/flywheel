import { createEffect, createMemo, createRenderEffect, createSignal, For, Index, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"

import { fileDiffFiles, removedDirectoryGroups, removedDirectoryLabel, type FileChangeBody, type FileDiffFile, type FileWritePolicy } from "../../../src/protocol/client/file-change-body.js"
import { renderCode } from "./markdown.js"
import { patchMarkdownChildren } from "./markdown-dom.js"
import { writeSyntaxPresentation } from "./write-syntax.js"
import type { WriteSyntaxThemeId } from "../../../src/protocol/write-syntax-theme.js"
import type { MutationEvidenceHandle, MutationEvidenceReader, MutationFilesView, MutationPatchView } from "../../../src/protocol/client/mutation-evidence.js"

function languageFromPath(path?: string): string | undefined {
  const fileName = path?.split(/[\\/]/).at(-1)
  const dot = fileName?.lastIndexOf(".") ?? -1
  return dot > 0 ? fileName?.slice(dot + 1).toLowerCase() : undefined
}

export function renderFileDiffLine(text: string, path?: string, syntaxHighlight = false): string {
  return renderCode(text, syntaxHighlight ? languageFromPath(path) : undefined)
}

/** The rows of one file as static markup.
 *
 *  A row carries no behaviour, so one string the browser parses is the cheap
 *  form: expanding a thousand-line change costs one parse rather than a
 *  thousand reactive rows, each with its own memos and effects to build and to
 *  reconcile again on every later change. The mounted file owns its current
 *  markup; earlier streaming revisions are not retained. */
export function renderFileDiffRows(rows: FileDiffFile["rows"], path: string | undefined, syntaxHighlight: boolean): string {
  let html = ""
  let oldLine: number | undefined
  let newLine: number | undefined
  for (const row of rows) {
    const gap = Math.max(
      oldLine !== undefined && row.oldLine !== undefined ? row.oldLine - oldLine - 1 : 0,
      newLine !== undefined && row.newLine !== undefined ? row.newLine - newLine - 1 : 0,
    )
    if (gap > 0) {
      html += `<div class="diff-gap">${gap} unchanged ${gap === 1 ? "line" : "lines"}</div>`
      // Both counters cross the gap, even if its first row is a removal or addition.
      if (oldLine !== undefined) oldLine += gap
      if (newLine !== undefined) newLine += gap
    }
    if (row.oldLine !== undefined) oldLine = row.oldLine
    if (row.newLine !== undefined) newLine = row.newLine
    const kind = row.kind === "remove" ? "del" : row.kind
    const marker = row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "
    const text = renderFileDiffLine(row.text, path, syntaxHighlight)
    html += syntaxHighlight
      ? `<div class="diff-line"><span class="diff-line-number">${row.newLine ?? ""}</span><span${row.partial ? ' class="diff-partial"' : ""}>${text}</span></div>`
      : `<div class="diff-line diff-${kind}"><span class="diff-line-number">${row.oldLine ?? ""}</span><span class="diff-line-number">${row.newLine ?? ""}</span><span class="diff-marker">${marker}</span><span${row.partial ? ' class="diff-partial"' : ""}>${text}</span></div>`
  }
  return html
}

type FileDiffProps = {
  body: FileChangeBody
  evidenceReader?: MutationEvidenceReader | undefined
  evidenceOwner?: string
  /** A turn already holds the call's metadata, under `owner`, and discloses only this file. */
  evidenceFile?: { entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }>; owner: string; handle: MutationEvidenceHandle | undefined }
  onOpenFile?: (path: string) => void
  fileExpanded?: (file: Pick<FileDiffFile, "id" | "path">) => boolean
  onToggleFile?: (file: Pick<FileDiffFile, "id" | "path" | "expanded">) => void
  /** The caller draws its own path and action; only the rows render here. */
  hideHeading?: boolean
  /** A derived net patch can continue without a mutation manifest. */
  moreBytes?: boolean
} & (
  | { writes?: "none"; writeSyntaxTheme?: WriteSyntaxThemeId }
  | { writes: Exclude<FileWritePolicy, "none">; writeSyntaxTheme: WriteSyntaxThemeId }
)

export function FileDiff(props: FileDiffProps) {
  const files = createMemo(() => fileDiffFiles(props.body, props.fileExpanded ?? false, props.writes))
  const referenceBody = () => props.body.kind === "actual" ? props.body : undefined
  const omissions = () => props.body.kind === "net" ? props.body.diff.omissions : []

  return (
    <div class="file-diff">
      <Show when={referenceBody()}>{(body) => <Show when={props.evidenceFile} fallback={<EvidenceDiff {...props} body={body()} />}>{selection =>
        <SelectedEvidenceFile {...props} selection={selection()} />
      }</Show>}</Show>
      <Show when={props.body.kind === "proposed"}>
        <div class="tool-detail">Proposed changes</div>
      </Show>
      <Index each={files()}>{(file) => <DiffFile {...props} file={file()} />}</Index>
      <For each={omissions()}>{omission =>
        <div class="mutation-omitted">{omission.path} not shown ({omission.reason.replace(/_/g, " ")})</div>
      }</For>
    </div>
  )
}

/** Count the reader's publications for one owner, so another owner's bytes re-run nothing here. */
function ownerRevision(reader: () => MutationEvidenceReader | undefined, owner: () => string | undefined) {
  const [revision, setRevision] = createSignal(0)
  createEffect(() => {
    const source = reader()
    const id = owner()
    if (source && id !== undefined) onCleanup(source.onChange(owners => { if (owners === undefined || owners.has(id)) setRevision(value => value + 1) }))
  })
  return revision
}

/** Observe the browser's clipped viewport, including the transcript's scroll region. */
function visibleDiff(element: Element, change: (visible: boolean) => void): void {
  const observer = new IntersectionObserver(entries => change(entries.some(entry => entry.isIntersecting)))
  observer.observe(element)
  onCleanup(() => observer.disconnect())
}

function EvidenceDiff(props: FileDiffProps & { body: Extract<FileChangeBody, { mutationEvidence: object }> }) {
  const [actualStarted, setActualStarted] = createSignal(false)
  const reader = () => props.evidenceReader
  const identity = createMemo(() => ({
    reader: reader(), owner: props.evidenceOwner, manifest: props.body.mutationEvidence.manifest,
  }), undefined, { equals: (a, b) => a.reader === b.reader && a.owner === b.owner
    && a.manifest.root === b.manifest.root && a.manifest.version === b.manifest.version
    && a.manifest.bytes === b.manifest.bytes && a.manifest.entries === b.manifest.entries })
  const handle = createMemo(() => {
    const { reader: source, owner, manifest } = identity()
    if (source === undefined || owner === undefined) return undefined
    onCleanup(() => source.release(owner))
    return source.open(owner, manifest, { previews: true })
  })
  const revision = ownerRevision(reader, () => props.evidenceOwner)
  createEffect(on(identity, () => setActualStarted(false)))
  const files = createMemo(() => { revision(); return handle()?.files })
  const [visible, setVisible] = createSignal(false)
  let list!: HTMLDivElement
  onMount(() => visibleDiff(list, setVisible))
  createEffect(on([handle, visible], ([current, shown]) => {
    if (shown && current?.files.status === "idle") void current.loadFiles()
  }))
  const pending = () => !actualStarted() && !unavailable() ? props.body.pendingProposal : undefined
  const unavailable = () => handle() === undefined || files()?.status === "unavailable"
  type EvidenceEntry = Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }>
  const evidenceEntries = createMemo(() => (files()?.files ?? []).filter((entry): entry is EvidenceEntry => entry.kind === "applied" || entry.kind === "display"))
  // A removed directory shows once, collapsed, and its files show only under it.
  const groups = createMemo(() => removedDirectoryGroups(files()?.files ?? [], evidenceEntries().map(entry => entry.file)))
  const grouped = createMemo(() => new Set(groups().directories.flatMap(group => group.members.map(index => evidenceEntries()[index]))))
  const evidenceFile = (entry: EvidenceEntry) =>
    <EvidenceFile {...props} entry={entry} handle={handle()!} revision={revision()} pending={pending() !== undefined} onBytes={() => setActualStarted(true)} />
  return (
    <div ref={element => { list = element }} class="file-diff">
      <Show when={pending()}>{(body) => <FileDiff {...props} body={body()} />}</Show>
      <For each={files()?.files}>{entry => entry.kind === "applied" || entry.kind === "display"
        ? <Show when={!grouped().has(entry)}>{evidenceFile(entry)}</Show>
        : entry.kind === "removed_directory" ? <RemovedDirectory {...props} directory={entry} hidden={pending() !== undefined}
          members={() => groups().directories.find(group => group.directory === entry)?.members.map(index => evidenceEntries()[index]!) ?? []}
          renderFile={evidenceFile} />
        : <div class="mutation-omitted">{entry.kind === "omitted" ? `${entry.displayPath} not shown` : `${entry.path} not applied`} ({entry.reason.replace(/_/g, " ")})</div>
      }</For>
      <Show when={unavailable()}><div class="omitted">Change evidence is unavailable</div></Show>
      <Show when={files()?.status === "error"}><div class="omitted">Could not load change evidence. <button onClick={() => { void handle()?.loadFiles() }}>Retry</button></div></Show>
      <Show when={files()?.status === "idle" || files()?.status === "loading"}><div class="omitted">Loading...</div></Show>
      <Show when={files()?.status === "ready" && files()?.nextOffset !== null}>
        <DiffContinuation onContinue={() => { void handle()?.loadFiles() }} />
      </Show>
    </div>
  )
}

/** One removed directory as a collapsed row; its files mount only while it is expanded. */
function RemovedDirectory(props: FileDiffProps & {
  directory: Extract<MutationFilesView["files"][number], { kind: "removed_directory" }>
  hidden: boolean
  members: () => readonly Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }>[]
  renderFile: (entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }>) => JSX.Element
}) {
  const key = () => ({ id: `directory:${props.directory.path}`, path: `${props.directory.displayPath}/` })
  const expanded = () => props.fileExpanded?.(key()) ?? false
  return <Show when={!props.hidden}>
    <section class="removed-directory">
      <button class="diff-file-path" aria-expanded={expanded()} disabled={props.onToggleFile === undefined}
        onClick={() => props.onToggleFile?.({ ...key(), expanded: expanded() })}>
        {`${removedDirectoryLabel(props.directory)} ${expanded() ? "▾" : "▸"}`}
      </button>
      <Show when={expanded()}><For each={props.members()}>{entry => props.renderFile(entry)}</For></Show>
    </section>
  </Show>
}

function SelectedEvidenceFile(props: FileDiffProps & { selection: NonNullable<FileDiffProps["evidenceFile"]> }) {
  const revision = ownerRevision(() => props.evidenceReader, () => props.selection.owner)
  return <Show when={props.selection.handle} fallback={<div class="omitted">Change evidence is unavailable</div>}>{handle =>
    <EvidenceFile {...props} entry={props.selection.entry} handle={handle()} revision={revision()} pending={false} onBytes={() => {}} />
  }</Show>
}

function EvidenceFile(props: FileDiffProps & {
  entry: Extract<MutationFilesView["files"][number], { kind: "applied" | "display" }>
  handle: MutationEvidenceHandle
  revision: number
  pending: boolean
  onBytes: () => void
}) {
  const patch = createMemo(() => props.handle.patch(props.entry))
  onCleanup(() => patch()?.release())
  const view = createMemo(on([() => props.revision, patch], ([, current]) => current?.view))
  createEffect(on(view, current => {
    if (props.entry.preview !== undefined || current?.text || current?.status === "unavailable" || current?.status === "error" || props.entry.file.patch.kind !== "retained") props.onBytes()
  }))
  const file = createMemo(() => fileDiffFiles(props.body, props.fileExpanded ?? false, props.writes, {
    files: { status: "ready", offset: 0, files: [props.entry], nextOffset: null },
    patch: view(),
  })[0]!)
  let section!: HTMLElement
  // A collapsed file renders its page preview; only an expanded file reads its patch.
  onMount(() => {
    visibleDiff(section, visible => {
      if (visible && file().expanded && patch()?.view.status === "idle") void patch()?.continue(20, 120)
    })
  })
  return <DiffFile {...props} file={file()} hidden={props.pending} sectionRef={element => { section = element }}
    patch={view()} onContinue={() => { void patch()?.continue(20, 120) }} />
}

function DiffContinuation(props: { onContinue: () => void }) {
  let element!: HTMLDivElement
  onMount(() => visibleDiff(element, visible => { if (visible) untrack(props.onContinue) }))
  return <div ref={mounted => { element = mounted }} class="omitted">Loading...</div>
}

function DiffFile(props: FileDiffProps & {
  file: FileDiffFile
  hidden?: boolean
  sectionRef?: (element: HTMLElement) => void
  patch?: MutationPatchView
  onContinue?: () => void
}) {
  const file = () => props.file
  const rows = createMemo(() => file().rows, [], {
    equals: (previous, next) => previous.length === next.length && previous.every((row, index) => {
      const other = next[index]!
      return row.text === other.text && row.kind === other.kind
        && row.oldLine === other.oldLine && row.newLine === other.newLine && row.partial === other.partial
    }),
  })
  const filePath = createMemo(() => file().path)
  const writesSource = createMemo(() => file().presentation === "write")
  // A Write row scopes its whole body; only an added file among a shell
  // mutation's edits needs its own palette scope.
  const writeSyntax = createMemo(() => props.writes === "added" && writesSource()
    ? writeSyntaxPresentation("create", props.writeSyntaxTheme)
    : { class: undefined, style: undefined })
  const html = createMemo(() => renderFileDiffRows(rows(), filePath(), writesSource()))
  const unavailable = () => file().evidenceStatus === "unavailable"
  const canExpand = () => props.onToggleFile !== undefined && !unavailable() && file().evidenceStatus !== "error"
    && (file().renderedLines > file().rows.length || file().expanded || props.moreBytes === true || (props.patch !== undefined && !props.patch.complete))
    && (file().evidence === undefined || file().evidence?.patch.kind === "retained")
  return (
    <section ref={props.sectionRef} class="diff-file" classList={{ "write-syntax": writeSyntax().class !== undefined }} style={writeSyntax().style}>
      <Show when={!props.hidden}>
        <Show when={!props.hideHeading}><header class="diff-file-header">
          <span class={`diff-file-action diff-file-action-${file().action}`}>{file().action}</span>
          <Show when={file().path} fallback={<span class="diff-file-path">Unnamed file</span>}>
            {(path) => (
              <button class="diff-file-path" disabled={props.onOpenFile === undefined} onClick={() => props.onOpenFile?.(file().evidence?.path ?? path())}>
                {path()}
              </button>
            )}
          </Show>
          <Show when={file().movePath}>{(movePath) => <><span class="diff-file-move">to</span><span class="diff-file-path">{movePath()}</span></>}</Show>
        </header></Show>
        <div class="diff" ref={element => {
          const template = element.ownerDocument.createElement("template")
          createRenderEffect(() => {
            template.innerHTML = html()
            patchMarkdownChildren(element, [...template.content.childNodes])
          })
        }} />
        <Show when={file().omittedLines > 0}>
          <div class="omitted">{file().omittedLines} more diff lines</div>
        </Show>
        <Show when={canExpand()}>
          <button aria-expanded={file().expanded} onClick={() => {
            const expanded = file().expanded
            props.onToggleFile?.(file())
            if (!expanded) props.onContinue?.()
          }}>
            {file().expanded ? "Collapse diff" : "Expand diff"}
          </button>
        </Show>
        <Show when={file().evidenceStatus === "idle" || file().evidenceStatus === "loading"}><div class="omitted">Loading...</div></Show>
      </Show>
      <Show when={unavailable()}><div class="omitted">Change evidence is unavailable</div></Show>
      <Show when={file().evidenceStatus === "error"}><div class="omitted">Could not load change evidence. <button onClick={() => props.onContinue?.()}>Retry</button></div></Show>
      <Show when={file().evidenceStatus === "omitted"}><div class="mutation-omitted">{file().path} not shown ({file().omissionReason?.replace(/_/g, " ")})</div></Show>
      <Show when={file().expanded && props.patch?.status === "ready" && !props.patch.complete}>
        <DiffContinuation onContinue={() => props.onContinue?.()} />
      </Show>
    </section>
  )
}
