/** @jsxImportSource @opentui/solid */

import { TOOL_PREVIEW_LINE_LIMIT, type DiffOmission, type ProvisionalDiffFile } from "@infra/output-blocks"
import type { MutationDiff } from "@infra/mutation-diff.js"
import { diffOmittedLinesForFile } from "../../protocol/diff-omission.js"
import { RGBA, ScrollBoxRenderable, StyledText, bg as stBg, fg as stFg, type BoxRenderable, type TextChunk } from "@opentui/core"
import { renderHunk, renderTypedDiffRows, type DiffSyntaxHighlighter } from "@tui/adapters/color-diff"
import { parseUnifiedDiff, type Hunk, type TypedDiffRow } from "@tui/adapters/diff-parser"
import { fileDiffFiles, removedDirectoryGroups, removedDirectoryLabel, type FileChangeBody, type FileDiffFile, type FileWritePolicy } from "../../protocol/client/file-change-body.js"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import type { MutationEvidence } from "../../infra/mutation-evidence.js"
import { useMutationEvidence } from "@tui/context/mutation-evidence.js"
import { useRowGeometry } from "@tui/context/row-geometry.js"
import { useRenderer } from "@opentui/solid"
import { createHighlighter } from "@tui/adapters/syntax-highlight.js"
import { resolveSyntaxLanguage } from "@tui/adapters/syntax-language.js"
import { getFiletype } from "@infra/tools/filetype.js"
import { useTheme } from "@tui/context/theme"
import { type Accessor, batch, createEffect, createMemo, For, Index, Show, createSignal, mapArray, on, onCleanup, untrack } from "solid-js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { BlankVerticalBarBorder, VerticalBarBorder } from "@tui/utils/border.js"
import { bindSelectableStyledTextContent } from "@tui/utils/reactive-text.js"
import { Button } from "../components/button.js"
import { OVERSCAN_ROWS } from "../output-window/output-window-scroll.js"
import { PreviewViewport } from "./preview-viewport.js"

/** One unified patch a block discloses. `path` is the heading shown above its
 *  lines; an unnamed source (the legacy per-tool `diff`) renders bare, because
 *  the block header already names the file. */
interface UnifiedDiffSource {
  readonly id?: string
  readonly path?: string
  readonly action?: ProvisionalDiffFile["action"]
  readonly unifiedDiff: string
  readonly omittedLines?: number
  readonly hideHeading?: boolean
}

export type DiffSource = UnifiedDiffSource | ProvisionalDiffFile

/** One diff-bearing block's patches, parsed once for the state it discloses.
 *  Each file owns its rendered count and preview budget. */
export interface ParsedDiffs {
  readonly files: readonly {
    readonly path?: string
    readonly action?: ProvisionalDiffFile["action"]
    readonly presentation: "write" | "edit"
    readonly movePath?: string
    readonly visibleLines: number
    readonly hunks: readonly Hunk[]
    readonly rows: readonly TypedDiffRow[]
    readonly renderedLines: number
    readonly omittedLines: number
    readonly expanded: boolean
    readonly hideHeading: boolean
    readonly evidenceStatus?: FileDiffFile["evidenceStatus"]
    readonly omissionReason?: string
    readonly moreBytes?: boolean
  }[]
  readonly renderedLines: number
}

/** Parse each file against its own preview budget. A shared boolean preserves
 *  aggregate disclosure callers; a resolver enables independent file state. */
export function parseDiffs(sources: readonly DiffSource[], expanded: boolean | ((index: number) => boolean), writes: FileWritePolicy = "none"): ParsedDiffs {
  let renderedLines = 0
  const files = sources.map((source, index) => {
    const fileExpanded = typeof expanded === "function" ? expanded(index) : expanded
    if ("unifiedDiff" in source) {
      const parsed = parseUnifiedDiff(source.unifiedDiff, fileExpanded ? Infinity : TOOL_PREVIEW_LINE_LIMIT)
      const visibleLines = Math.min(parsed.renderedLines, fileExpanded ? Infinity : TOOL_PREVIEW_LINE_LIMIT)
      renderedLines += parsed.renderedLines
      return {
        ...(source.path !== undefined ? { path: source.path } : {}),
        ...(source.action !== undefined ? { action: source.action } : {}),
        presentation: writes === "all" || (writes === "added" && source.action === "add") ? "write" as const : "edit" as const,
        hunks: parsed.hunks,
        rows: [],
        visibleLines,
        renderedLines: parsed.renderedLines,
        omittedLines: source.omittedLines ?? 0,
        expanded: fileExpanded,
        hideHeading: source.hideHeading === true,
      }
    }
    // SAFETY: one supplied proposal maps to one file model.
    const model = fileDiffFiles({ kind: "proposed", proposedDiff: { files: [source] } }, fileExpanded, writes)[0]!
    renderedLines += model.renderedLines
    return {
      ...model,
      hunks: [],
      visibleLines: model.rows.length,
      omittedLines: model.sourceOmittedLines,
      expanded: fileExpanded,
      hideHeading: false,
    }
  })
  return { files, renderedLines }
}

// "standard" diff mode intentionally ignores the active theme: classic git
// red/green, enshrined as literals so no theme edit can change them.
const STANDARD_DIFF_COLORS = {
  text: RGBA.fromHex("#e5e9f0"),
  textMuted: RGBA.fromHex("#8b95a7"),
  addedBg: RGBA.fromHex("#225c2b"),
  removedBg: RGBA.fromHex("#7a2936"),
  highlightAdded: RGBA.fromHex("#38a660"),
  highlightRemoved: RGBA.fromHex("#b3596b"),
  highlightForeground: null,
  addedFg: RGBA.fromHex("#38a660"),
  removedFg: RGBA.fromHex("#b3596b"),
  lineNumber: RGBA.fromHex("#8b95a7"),
}
interface OmissionReasonText { [reason: string]: string }

const OMISSION_REASON_TEXT: OmissionReasonText = {
  sensitive: "sensitive",
  target_over_bound: "unavailable from an earlier version",
  collection_over_budget: "unavailable from an earlier version",
  // Legacy: only a diff persisted before project event stores were established
  // as user-local carries this reason.
  private_reach: "private to this reach",
}

interface PreviewLine {
  readonly kind: "line"
  readonly gutter: StyledText
  readonly styled: StyledText
  readonly lineBg: RGBA | undefined
}

type DiffFile = ParsedDiffs["files"][number]

interface DiffPreviewProps {
  /** Fully disclosed review evidence has no parent-owned expand/collapse action. */
  readOnly?: boolean
  /** Reports whether a file's collapsed preview hides content: lines it does not show, or wrapped
   *  rows past the preview budget. It reports once the file's first layout settles and again on
   *  every change. When the file view unmounts it runs the retraction that its last report
   *  returned, so the parent reads one current value per file. The retraction must read no
   *  reactive state, because it runs inside a teardown. */
  onTruncated?: (index: number, truncated: boolean) => (() => void) | undefined
  parsed: ParsedDiffs
  /** Patches the source declined to retain. Current writers omit only sensitive
   *  targets; legacy size omissions remain readable but cannot be recovered. */
  omissions?: MutationDiff["omissions"]
  /** Derived-history lines omitted from the disclosed diff body. */
  diffOmission?: DiffOmission
  /** Present only when each named file owns its disclosure state. The parent
   *  header owns a lone file's disclosure, so only files beside others carry
   *  a rail of their own. */
  onToggleFile?: (index: number) => void
  diffColors?: Accessor<DiffColorMode>
  onFileLayout?: (index: number, box: BoxRenderable) => void
  onBodyLayout?: (index: number, box: BoxRenderable) => void
  fileCount?: number
  onRetryFile?: (index: number) => void
}

function styledSegments(segments: readonly { readonly text: string; readonly fg?: RGBA; readonly bg?: RGBA }[]): StyledText {
  return new StyledText(segments.map((segment) => {
    let chunk: TextChunk = { __isChunk: true, text: segment.text }
    if (segment.fg) chunk = stFg(segment.fg)(chunk)
    if (segment.bg) chunk = stBg(segment.bg)(chunk)
    return chunk
  }))
}

/** The one unified-diff renderer: legacy per-tool diffs, tool mutation
 *  artifacts, and review-notice mutations all disclose through it, so the
 *  preview budget, the truncation note, and the colors have one owner. */
export function DiffPreview(props: DiffPreviewProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const colors = createMemo(() => {
    if (props.diffColors?.() === "standard") return STANDARD_DIFF_COLORS
    return {
      text: theme.text,
      textMuted: theme.textMuted,
      addedBg: theme.diffAddedBg,
      removedBg: theme.diffRemovedBg,
      highlightAdded: theme.diffHighlightAdded,
      highlightRemoved: theme.diffHighlightRemoved,
      highlightForeground: theme.background,
      addedFg: theme.diffAdded,
      removedFg: theme.diffRemoved,
      lineNumber: theme.diffLineNumber,
    }
  })

  const fileRemoteOmittedLines = (index: number): number =>
    diffOmittedLinesForFile(props.diffOmission, index, props.parsed.files.length)

  const fileRows = (file: DiffFile, highlightSyntax: DiffSyntaxHighlighter | undefined, diffColors: ReturnType<typeof colors>): PreviewLine[] =>
    [
      ...file.hunks.flatMap(hunk => renderHunk(hunk, diffColors, highlightSyntax)),
      ...renderTypedDiffRows(file.rows, diffColors, highlightSyntax, file.presentation === "write" ? file.renderedLines : 0),
    ].map(line => ({ kind: "line", gutter: styledSegments(line.gutter), styled: styledSegments(line.segments), lineBg: line.lineBg }))

  const DiffFilePreview = (fileProps: { file: DiffFile; index: number }) => {
    // Collapsed rows wrap and clip at the preview budget; rows past it offer the toggle.
    const [overflow, setOverflow] = createSignal(false)
    // Wrap overflow is known only after layout, so the row records no height before the
    // first frame laid out with the truncation note it decides.
    const [measured, setMeasured] = createSignal(false)
    // eslint-disable-next-line solid/reactivity -- the row reads the hold in its own geometry memo
    useRowGeometry().hold(measured)
    const measureOverflow = (next: boolean) => batch(() => {
      setOverflow(next)
      setMeasured(true)
    })
    const syntaxColors = () => fileProps.file.presentation === "write" ? themeCtx.writeSyntaxColors : undefined
    const highlighter = createMemo(() => {
      const palette = syntaxColors()
      return palette === undefined ? undefined : createHighlighter(palette, true)
    })
    const language = createMemo(() => {
      if (syntaxColors() === undefined) return undefined
      const path = fileProps.file.path
      return resolveSyntaxLanguage(path === undefined ? undefined : getFiletype(path))?.highlightJs
    })
    const renderRows = createMemo(() => {
      const syntaxLanguage = language()
      const fileSyntaxColors = syntaxColors()
      const highlight = highlighter()
      const diffColors = colors()
      let previous = new Map<string, ReturnType<DiffSyntaxHighlighter>>()
      return (file: DiffFile) => {
        const current = new Map<string, ReturnType<DiffSyntaxHighlighter>>()
        const syntax: DiffSyntaxHighlighter | undefined = fileSyntaxColors === undefined || highlight === undefined ? undefined : (code) => {
          const chunks = previous.get(code) ?? highlight(code, syntaxLanguage)[0] ?? [{ text: code, color: fileSyntaxColors.text }]
          current.set(code, chunks)
          return chunks
        }
        const rows = fileRows(file, syntax, diffColors)
        previous = current
        return rows
      }
    })
    const remoteOmitted = () => fileRemoteOmittedLines(fileProps.index)
    const retainedOmitted = () => fileProps.file.renderedLines - fileProps.file.visibleLines
    const sourceOmitted = () => fileProps.file.omittedLines
    const collapsedOmitted = () => retainedOmitted() + sourceOmitted() + remoteOmitted()
    // The one owner of whether the collapsed file hides content: its note, its heading toggle,
    // and the parent header all read this value.
    const truncated = createMemo(() => collapsedOmitted() > 0 || overflow())
    // Solid answers a read of a pending memo by first running the memo's stale owners, and during
    // a teardown one of them can be the owner that is disposing this view. So the cleanup reads no
    // props: it runs the plain retraction that the last report returned.
    let retract: (() => void) | undefined
    createEffect(() => {
      if (measured()) retract = props.onTruncated?.(fileProps.index, truncated())
    })
    onCleanup(() => retract?.())
    const hasExpandedNote = () => sourceOmitted() > 0 || remoteOmitted() > 0 || (!props.readOnly && (props.onToggleFile !== undefined || fileProps.file.renderedLines > TOOL_PREVIEW_LINE_LIMIT))
    const canToggle = () => props.onToggleFile !== undefined
      && fileProps.file.evidenceStatus !== "omitted"
      && fileProps.file.evidenceStatus !== "unavailable"
      && fileProps.file.evidenceStatus !== "error"
      && (truncated() || fileProps.file.expanded || fileProps.file.moreBytes === true)
    const toggle = useUnifiedToggle(
      canToggle,
      () => props.onToggleFile?.(fileProps.index),
      () => props.onToggleFile !== undefined,
    )
    const ownsFileRail = () => props.onToggleFile !== undefined && (props.fileCount ?? props.parsed.files.length) > 1
    // The heading and the body each draw their part of the rail: the heading is
    // a header that takes only its text, and the body takes every cell.
    const rail = () => ownsFileRail()
      ? { border: ["left" as const], borderColor: theme.primary, customBorderChars: toggle.hovered() ? VerticalBarBorder : BlankVerticalBarBorder }
      : {}
    const note = () => props.readOnly
      ? `  ... +${collapsedOmitted()} lines (not retained)`
      : fileProps.file.expanded
      ? sourceOmitted() > 0
        ? `  ... +${sourceOmitted()} lines (truncated, click to collapse)`
        : "  (click to collapse)"
      : overflow() ? "  ... more content (click to expand)" : `  ... +${collapsedOmitted()} lines (click to expand)`
    const heading = () => {
      if (fileProps.file.hideHeading || fileProps.file.evidenceStatus === "omitted") return undefined
      const label = fileProps.file.action === undefined
        ? fileProps.file.path
        : `${fileProps.file.path ?? "file"} (${fileProps.file.action})${fileProps.file.movePath === undefined ? "" : ` to ${fileProps.file.movePath}`}`
      if (label === undefined) return undefined
      if (!canToggle()) return `  ${label}`
      return `  ${label} ${fileProps.file.expanded ? "▾" : "▸"}`
    }
    const rows = createMemo(() => renderRows()(fileProps.file))
    // Only an expanded file reads its patch, so `moreBytes` means its bytes are incomplete. More are
    // expected until a read ends in a final error or unavailable state, whose message shows instead.
    const loading = () => fileProps.file.moreBytes === true
      && fileProps.file.evidenceStatus !== "error" && fileProps.file.evidenceStatus !== "unavailable"

    return (
      <box
        ref={(box: BoxRenderable) => props.onFileLayout?.(fileProps.index, box)}
        flexDirection="column"
        flexShrink={0}
        marginTop={fileProps.index > 0 ? 1 : 0}
        {...toggle.handlers}
      >
        {heading() !== undefined ? <box flexShrink={0} {...rail()}><text fg={theme.textMuted}>{heading()}</text></box> : null}
        <box ref={toggle.body} flexDirection="column" flexShrink={0} {...rail()}>
          <PreviewViewport expanded={fileProps.file.expanded} onOverflow={measureOverflow}>
            <box ref={(box: BoxRenderable) => props.onBodyLayout?.(fileProps.index, box)} flexDirection="column" flexShrink={0} width="100%">
              <Index each={rows()}>
                {(row) => {
                  // eslint-disable-next-line solid/reactivity -- the binding tracks the row in its own effect
                  const bindGutter = bindSelectableStyledTextContent(() => row().gutter)
                  // eslint-disable-next-line solid/reactivity -- the binding tracks the row in its own effect
                  const bindCode = bindSelectableStyledTextContent(() => row().styled)
                  // The gutter keeps its width, so a wrapped line continues under its code.
                  return (
                    <box width="100%" flexDirection="row" flexShrink={0} backgroundColor={row().lineBg}>
                      <text ref={bindGutter} flexShrink={0} />
                      <text ref={bindCode} flexGrow={1} flexShrink={1} minWidth={0} wrapMode="word" />
                    </box>
                  )
                }}
              </Index>
            </box>
          </PreviewViewport>
          {loading() ? <text fg={theme.textMuted}>{"  Loading..."}</text> : null}
          {fileProps.file.evidenceStatus === "omitted"
            ? <text fg={theme.textMuted}>{`  ${fileProps.file.path}  (diff omitted: ${OMISSION_REASON_TEXT[fileProps.file.omissionReason ?? ""]})`}</text>
            : fileProps.file.evidenceStatus === "unavailable"
            ? <text fg={theme.textMuted}>{"  Change evidence is unavailable"}</text>
            : fileProps.file.evidenceStatus === "error"
            ? <box flexDirection="row" paddingLeft={2}><text fg={theme.textMuted}>Could not load change evidence.</text><Button label="Retry" onPress={() => props.onRetryFile?.(fileProps.index)} /></box>
            : fileProps.file.expanded ? (hasExpandedNote() ? <text selectable={false} fg={theme.textMuted}>{note()}</text> : null) : (truncated() ? <text selectable={false} fg={theme.textMuted}>{note()}</text> : null)}
        </box>
      </box>
    )
  }

  // A box root, not a fragment: OpenTUI rejects a text node whose parent is not
  // a <text>, so every row mounts under its own explicit parent.
  return (
    <box flexDirection="column" flexShrink={0}>
      <Index each={props.parsed.files}>
        {(file, index) => <DiffFilePreview file={file()} index={index} />}
      </Index>
      {(props.omissions?.length ?? 0) > 0 ? (
        <For each={props.omissions}>
          {(omission) => (
            <text fg={theme.textMuted}>{`  ${omission.path}  (diff omitted: ${OMISSION_REASON_TEXT[omission.reason]})`}</text>
          )}
        </For>
      ) : null}

    </box>
  )
}

/** A resident reader owns metadata, previews, and byte prefixes. A mounted preview acquires its
 * first metadata page, whose previews give collapsed files their rows; layout acquires bytes of
 * expanded files within the viewport margin, and the tail sentinel advances metadata in that band. */
export function MutationEvidencePreview(props: {
  ownerId: string
  evidence: MutationEvidence
  expanded: boolean | ((index: number) => boolean)
  writes?: FileWritePolicy
  onToggleFile?: (index: number) => void
  diffColors?: Accessor<DiffColorMode>
  onTruncated?: (index: number, truncated: boolean) => (() => void) | undefined
  pendingProposal?: Extract<FileChangeBody, { kind: "proposed" }>
  hideSingleHeading?: boolean
  showActions?: boolean
}) {
  const openEvidence = useMutationEvidence()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const handle = () => openEvidence(props.ownerId, props.evidence.manifest)
  const files = () => handle()?.files
  // File headings and collapsed rows come from the metadata page and its previews, so the row's
  // height is final once that page has settled. Expanded patch bytes never hold it.
  const metadataSettled = createMemo(() => files()?.status !== "idle" && files()?.status !== "loading")
  // eslint-disable-next-line solid/reactivity -- the row reads the hold in its own geometry memo
  useRowGeometry().hold(metadataSettled)
  const fileBoxes = new Map<number, BoxRenderable>()
  const bodyBoxes = new Map<number, BoxRenderable>()
  let root: BoxRenderable | undefined
  let tail: BoxRenderable | undefined
  // Byte publications keep the handle and its metadata view, and replace only the changed file's patch view.
  const metadata = createMemo(() => files())
  const entries = createMemo(() => metadata()?.files.filter(entry => entry.kind === "applied" || entry.kind === "display") ?? [])
  // The one owned read of `props.expanded`. A caller's conditional prop creates a memo on each
  // read, so the frame callback below reads only this cache; a read there would leak one per frame.
  const expandedFlags = createMemo(() => entries().map((_, index) => typeof props.expanded === "function" ? props.expanded(index) : props.expanded))
  const evidenceBody = () => ({ kind: "actual", mutationEvidence: props.evidence } as const)
  /** The shown lines of one file model whose rows `text` holds: an edit renders its whole rows
   * as parsed hunks, and the partial last row of loading bytes stays a row. */
  const shownLines = (model: Pick<FileDiffFile, "presentation" | "rows">, text: string | undefined) => {
    const completeRows = model.presentation === "edit" ? model.rows.filter(row => !row.partial).length : 0
    const hunks = completeRows > 0 && text ? parseUnifiedDiff(text, completeRows).hunks : []
    return { hunks, rows: hunks.length > 0 ? model.rows.filter(row => row.partial) : model.rows }
  }
  // One model per file. An owner publication reads each file's patch-view identity, and only a
  // file whose view changed rebuilds its model; the aggregate below still visits every model.
  const fileModels = mapArray(entries, (entry, index) => {
    const expanded = createMemo(() => expandedFlags()[index()] === true)
    // Only an expanded file reads its patch; a collapsed file shows its page preview.
    const patch = createMemo(() => {
      const current = handle()
      return current === undefined || !expanded() ? undefined : untrack(() => current.patch(entry))?.view
    })
    // The page preview is the patch text from its first hunk header, cut to the collapsed line
    // and byte bounds, so its last line can be a cut prefix. An expanded file shows it until the
    // loaded bytes cover it: expanding never shrinks the row, and the bytes only add rows below.
    // It is parsed once per expansion, not again on each byte publication.
    const preview = createMemo(() => {
      const view = metadata()
      if (view === undefined || !expanded()) return undefined
      const model = fileDiffFiles(evidenceBody(), false, props.writes, { files: { ...view, files: [entry] } })[0]
      return model && shownLines(model, entry.preview)
    })
    const fileModel = createMemo(() => {
      const view = metadata()
      if (view === undefined) return []
      const fileExpanded = expanded()
      const patchView = patch()
      const shownPreview = preview()
      return fileDiffFiles(evidenceBody(), fileExpanded, props.writes, {
        files: { ...view, files: [entry] }, ...(patchView === undefined ? {} : { patch: patchView }),
      }).map(({ action, ...model }) => {
        // The preview is a prefix of the loaded text from the same first hunk header, so a loaded
        // slice at least as long holds every preview line, the cut last line at least as long.
        const hunkStart = patchView?.text.search(/^@@/m) ?? -1
        const covered = patchView !== undefined && hunkStart >= 0 && patchView.text.length - hunkStart >= (entry.preview?.length ?? 0)
        const shown = shownPreview !== undefined && !covered ? shownPreview : shownLines(model, !fileExpanded ? entry.preview
          : patchView && (patchView.complete ? patchView.text : patchView.text.slice(0, patchView.text.lastIndexOf("\n") + 1)))
        return {
          ...model, ...(props.showActions === true ? { action } : {}), ...shown,
          visibleLines: fileExpanded ? model.renderedLines : model.rows.length,
          omittedLines: model.sourceOmittedLines,
          hideHeading: props.hideSingleHeading === true && props.evidence.applied === 1 && props.evidence.removedDirectories === undefined,
          moreBytes: patchView !== undefined && !patchView.complete,
        }
      })
    })
    return fileModel
  })
  const parsedOf = (indexes: readonly number[]): ParsedDiffs => {
    const models = indexes.flatMap(index => fileModels()[index]?.() ?? [])
    return { files: models, renderedLines: models.reduce((sum, file) => sum + file.renderedLines, 0) }
  }
  // A removed directory shows once, collapsed, and its files show only under it.
  const groups = createMemo(() => removedDirectoryGroups(metadata()?.files ?? [], entries().map(entry => entry.file)))
  const parsed = createMemo(() => parsedOf(groups().ungrouped))
  const omissions = createMemo(() => files()?.files.flatMap(entry => entry.kind === "omitted" ? [{ path: entry.displayPath, reason: entry.reason }] : []) ?? [])
  const disclosure = useBlockDisclosure()
  const directoryKey = (path: string) => `${props.ownerId}#directory:${path}`
  const pending = () => props.pendingProposal !== undefined
    && parsedOf(entries().map((_, index) => index)).files.every(file => file.rows.length === 0 && file.hunks.length === 0 && file.evidenceStatus !== "omitted"
      && file.evidenceStatus !== "unavailable" && file.evidenceStatus !== "error")
    && files()?.status !== "unavailable" && files()?.status !== "error"
    && handle() !== undefined
  const acquireNearby = () => untrack(() => {
    const current = handle()
    if (!current || !tail || !root) return
    let top = 0
    let bottom = renderer.height
    for (let parent = root.parent; parent; parent = parent.parent) {
      if (parent instanceof ScrollBoxRenderable) {
        top = Math.max(top, parent.viewport.screenY)
        bottom = Math.min(bottom, parent.viewport.screenY + parent.viewport.height)
      }
    }
    const nearby = (box: BoxRenderable) => box.screenY < bottom + OVERSCAN_ROWS && box.screenY + Math.max(1, box.height) > top - OVERSCAN_ROWS
    const expanded = expandedFlags()
    for (const [index, entry] of entries().entries()) {
      const box = fileBoxes.get(index)
      const body = bodyBoxes.get(index)
      if (expanded[index] !== true || !box || !body || !nearby(box)) continue
      const patch = current.patch(entry)
      if (!patch || (patch.view.status !== "idle" && patch.view.status !== "ready") || patch.view.complete) continue
      const budget = Math.max(TOOL_PREVIEW_LINE_LIMIT, bottom - body.screenY)
      if (patch.view.text.length === 0 || body.height < budget) {
        const rows = patch.view.text.length === 0 ? budget : budget - body.height
        void patch.continue(Math.min(TOOL_PREVIEW_LINE_LIMIT, Math.max(1, rows)), Math.max(1, body.width - 6))
      }
    }
    if (current.files.status === "ready" && current.files.nextOffset !== null && nearby(tail)) void current.loadFiles()
  })
  // A mounted preview requests its file list at once, so its headings and collapsed rows
  // are measured at their final height before it nears the viewport. Bytes stay near it.
  const opened = createMemo(handle)
  createEffect(on(opened, current => { if (current?.files.status === "idle") void current.loadFiles() }))
  renderer.addPostProcessFn(acquireNearby)
  onCleanup(() => renderer.removePostProcessFn(acquireNearby))
  /** The files at `indexes` of the entries, with each per-file callback mapped back to its entry index. */
  const EntryDiffs = (entryProps: { indexes: readonly number[]; omissions?: MutationDiff["omissions"] }) => {
    const entryIndex = (index: number) => entryProps.indexes[index] ?? index
    return <DiffPreview parsed={parsedOf(entryProps.indexes)} omissions={entryProps.omissions}
      onToggleFile={props.onToggleFile && (index => props.onToggleFile?.(entryIndex(index)))}
      onTruncated={props.onTruncated && ((index, truncated) => props.onTruncated?.(entryIndex(index), truncated))}
      diffColors={props.diffColors} fileCount={props.evidence.applied}
      onRetryFile={index => {
        const current = handle()
        const target = entries()[entryIndex(index)]
        if (current && target) void current.patch(target)?.continue(TOOL_PREVIEW_LINE_LIMIT, 120)
      }}
      onFileLayout={(index, box) => fileBoxes.set(entryIndex(index), box)}
      onBodyLayout={(index, box) => bodyBoxes.set(entryIndex(index), box)} />
  }
  return (
    <box ref={(box: BoxRenderable) => { root = box }} flexDirection="column" flexShrink={0}>
      {pending() ? <text fg={theme.textMuted} selectable={false}>Proposed changes</text> : null}
      <Show when={!pending()}>
        <Index each={groups().directories}>{(group, index) => {
          const expanded = () => disclosure.disclosure(directoryKey(group().directory.path)) === true
          const toggle = useUnifiedToggle(() => true, () => disclosure.setDisclosure(directoryKey(group().directory.path), !expanded()), () => false)
          return <box flexDirection="column" flexShrink={0} marginTop={index > 0 ? 1 : 0}>
            <box flexShrink={0} {...toggle.handlers}>
              <text fg={toggle.hovered() ? theme.text : theme.textMuted}>{`   ${removedDirectoryLabel(group().directory)} ${expanded() ? "▾" : "▸"}`}</text>
            </box>
            <Show when={expanded()}><box flexDirection="column" flexShrink={0} paddingLeft={2}><EntryDiffs indexes={group().members} /></box></Show>
          </box>
        }}</Index>
      </Show>
      <Show when={pending() || parsed().files.length > 0 || omissions().length > 0}>
        <Show when={pending()} fallback={<box flexDirection="column" flexShrink={0} marginTop={groups().directories.length > 0 ? 1 : 0}><EntryDiffs indexes={groups().ungrouped} omissions={omissions()} /></box>}>
          <DiffPreview parsed={parseDiffs(props.pendingProposal?.proposedDiff.files ?? [], props.expanded, props.writes)} omissions={omissions()}
            onToggleFile={props.onToggleFile} onTruncated={props.onTruncated} diffColors={props.diffColors} fileCount={props.evidence.applied} />
        </Show>
      </Show>
      <For each={files()?.files.filter(entry => entry.kind === "not_applied")}>{entry =>
        <text fg={theme.textMuted}>{`  ${entry.path} not applied (${entry.reason})`}</text>
      }</For>
      <box ref={(box: BoxRenderable) => { tail = box }} flexDirection="column" flexShrink={0}
        minHeight={files()?.nextOffset == null ? 0 : 1}>
        {handle() === undefined || files()?.status === "unavailable"
          ? <text fg={theme.textMuted}>{"  Change evidence is unavailable"}</text>
          : files()?.status === "error"
          ? <box paddingLeft={2} flexDirection="row"><text fg={theme.textMuted}>Could not load change evidence.</text><Button label="Retry" onPress={() => { void handle()?.loadFiles() }} /></box>
          : !pending() && (files()?.status === "idle" || files()?.status === "loading")
          ? <text fg={theme.textMuted}>{"  Loading..."}</text>
          : files()?.status === "ready" && files()?.nextOffset !== null
          ? <text fg={theme.textMuted}>{"  More files..."}</text> : null}
      </box>
    </box>
  )
}
