/** @jsxImportSource @opentui/solid */

import { TOOL_PREVIEW_LINE_LIMIT, type ToolEntry as ToolEntryType, type ToolStreamingText } from "@infra/output-blocks"
import { blockIdentity } from "../../protocol/block-identity.js"
import { toolActivity } from "../../protocol/client/transcript-model.js"
import { conflictMarkersNotice, isShellMutationEntry, isShellMutationRunning, notAppliedNotice, presentsAsFileChange, rowPresentation, rowWritePolicy, selectFileChangeBody, shellMutationFiles, showsShellMutationOutput } from "../../protocol/client/file-change-body.js"
import { totalDiffOmittedLines } from "../../protocol/diff-omission.js"
import { getToolDisplay } from "@infra/tools/tool-display-registry.js"
import { StyledText, bold as stBold, fg as stFg, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core"
import { highlightExecuteInputs, highlightToolDetail, linkifyChunks } from "@tui/adapters/tool-detail-highlight.js"
import { CollapsibleBox } from "@tui/components/collapsible-box"
import { SyntaxCode, syntaxBodyStyledText } from "@tui/components/syntax-code.js"
import { useNavigateUri } from "@tui/context/navigation.js"
import { useTheme } from "@tui/context/theme"
import { useMutationEvidence } from "@tui/context/mutation-evidence.js"
import { useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { bindSelectableStyledTextContent, bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { hitsDrawnContent, hitsLabel } from "@tui/utils/content-hit.js"
import { hasSelectedCells } from "@tui/utils/selection.js"
import { stStrike } from "@tui/utils/text-attributes.js"
import { BlankVerticalBarBorder, VerticalBarBorder } from "@tui/utils/border"
import { useRenderer } from "@opentui/solid"
import { type Accessor, batch, createEffect, createMemo, createSignal, Show } from "solid-js"
import { fileDisclosureKey, useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { useLandingBackground } from "@tui/context/landing-highlight.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "./block-frame.js"
import { useRowWidth } from "@tui/context/row-width.js"
import { DiffPreview, MutationEvidencePreview, parseDiffs, type DiffSource } from "./diff-preview.js"
import {
  getToolContentPreview,
  nextToolEntryToggleState,
  LIVE_EXECUTION_OUTPUT_TAIL_LIMIT,
  tailExecutionOutputLines,
} from "./tool-entry-helpers.js"
import { wrapToolRowChunks } from "./tool-row-wrap.js"
import { processControlChunks, processorWaitChunks, rowProcessControl, rowWaitsForProcessor, type RowProcessControl, type RowProcessControls } from "./stop-affordance.js"
import { markToolResultMounted } from "../../infra/render-probe.js"
import { PreviewViewport } from "./preview-viewport.js"


type ContentPresentation = "preview" | "collapsed-full"

interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }
interface ToolEntryProps {
  block: ToolEntryType
  /** Live partial tool-input text keyed by toolUseId; delivered by the output
   *  sync so per-token deltas bypass the block tree entirely. */
  streamingToolText?: StreamingToolTextById
  interrupted?: boolean
  diffColors?: Accessor<DiffColorMode>
  /** Lazy full-body fetch for a wire-truncated block: invoked with the block's
   *  durable identity while a disclosed body has remote-omitted lines. */
  onHydrateBody?: (blockId: string) => void
  rowControls?: RowProcessControls
  /** Renders inside a group-owned frame while retaining this entry's single
   *  header, disclosure state, and body implementation. */
  embedded?: boolean
  /** Non-tool client views retain their own block identity and do not mark a tool result as mounted. */
  disclosureId?: string
}

export function ToolEntry(props: ToolEntryProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const navigateUri = useNavigateUri()
  const renderer = useRenderer()
  const openEvidence = useMutationEvidence()
  const evidence = () => props.block.mutationEvidence

  const rowWidth = useRowWidth()
  const measured = createMeasuredWidth(() => rowWidth.width() - BLOCK_GUTTER_WIDTH)
  const hasError = () => props.block.status === "error"
  const disclosure = useBlockDisclosure()
  const landingBackground = useLandingBackground(() => [props.block.id])
  const identity = () => props.disclosureId ?? blockIdentity(props.block)
  // Byte publications keep the metadata view, so they leave the file list and its dependents alone.
  const evidenceMetadata = createMemo(() => {
    const manifest = evidence()?.manifest
    return manifest === undefined ? undefined : openEvidence(identity(), manifest)?.files
  })
  const evidenceFiles = createMemo(() => evidenceMetadata()?.files.filter(entry => entry.kind === "applied" || entry.kind === "display") ?? [])
  const bodyKey = () => `${identity()}#body`
  const contentKey = () => `${identity()}#content`
  const toolAction = () => getToolDisplay(props.block.name).action
  const isWrite = () => props.block.fileChangeKind === "create" || toolAction() === "file_write"
  const isFileChange = () => props.block.fileChangeKind !== undefined
  const presentsDiff = () => isFileChange() || toolAction() !== "file_write"
  const isShellMutation = () => isShellMutationEntry(props.block)
  const showsSettledShellOutput = () => showsShellMutationOutput(props.block, activeProcessControl() !== undefined)
  const presentsEdit = () => presentsAsFileChange(props.block)
  const previewsMutation = () => presentsEdit() || toolAction() === "file_edit"
  const legacyDiffSources = createMemo((): DiffSource[] => {
    if (hasError() || !presentsDiff()) return []
    return props.block.diff === undefined ? [] : [{ unifiedDiff: props.block.diff }]
  })
  const hasDiff = () => diffSources().length > 0 || (evidence()?.applied ?? 0) > 0 || (evidence()?.omissions ?? 0) > 0 || (evidence()?.notApplied ?? 0) > 0
  const fileCount = () => evidence()?.applied ?? diffSources().length
  const hasFileDiffDisclosure = () => {
    const retained = evidence()
    return previewsMutation() && (retained === undefined ? diffSources().length > 0 : retained.retainedFiles > 0)
  }
  const isLearningMutationTool = () => props.block.name === "memory" || props.block.name === "skill_manage"
  const isMutationArtifact = () => presentsDiff()
    && !previewsMutation()
    && (props.block.mutationEvidence !== undefined || (isLearningMutationTool() && props.block.diff !== undefined))
  // File writes expose a preview because content is the artifact. Other tool
  // output remains collapsed until the user discloses it.
  const contentPresentation = (): ContentPresentation => toolAction() === "handoff_write" ? "collapsed-full" : "preview"
  const isAtomicInvocation = () => props.block.invocationBody !== undefined || (props.block.invocationBodyOmittedBytes ?? 0) > 0
  const disclosedInvocation = () => props.block.invocationBody?.presentation === "disclosure"
  const messageOutcome = () => props.block.name === "message_session"
  const hasOutcome = () => messageOutcome() && (props.block.status === "error" || props.block.status === "blocked")
  const hidesMessageOutput = () => messageOutcome() && (isAtomicInvocation() || hasOutcome())
  const isArtifactContent = () => toolAction() === "file_write" || contentPresentation() === "collapsed-full"
  const hasContent = () => (!presentsEdit() || showsSettledShellOutput()) && !hidesMessageOutput() && !!props.block.content
  const streamingText = () => {
    if (props.block.status !== "streaming" || props.block.id === undefined) return undefined
    return props.streamingToolText?.[props.block.id]
  }
  const selectedFileBody = createMemo(() => selectFileChangeBody(props.block, streamingText()))
  const advisoryBody = createMemo(() => {
    const body = selectedFileBody()
    return body.kind === "advisory" ? body : undefined
  })
  const suppressesFileBody = () => isFileChange()
    && (props.block.status === "error" || selectedFileBody().kind === "advisory")
  const diffSources = createMemo((): DiffSource[] => {
    if (!presentsEdit()) return legacyDiffSources()
    const selected = selectedFileBody()
    if (selected.kind === "actual") {
      return evidenceFiles().map(entry => ({
        id: entry.file.path, path: entry.file.displayPath, unifiedDiff: "",
      }))
    }
    return selected.kind === "proposed" ? [...selected.proposedDiff.files] : []
  })
  const activeProcessControl = () => rowProcessControl(props.rowControls, props.block.id)
  const isActive = () => !isInterrupted() && toolActivity(props.block, {
    held: false,
    managed: props.block.id !== undefined && (props.rowControls?.activeManagedProcessToolCallIds().has(props.block.id) ?? false),
  }).active
  const executionOutput = () => {
    if (props.block.id === undefined) return undefined
    if (props.block.status === "streaming") return undefined
    return props.streamingToolText?.[props.block.id]
  }
  const hasStreamingContent = () => !presentsEdit() && !!streamingText()?.content
  const hasExecutionOutput = () => (!presentsEdit() || showsSettledShellOutput()) && !!executionOutput()?.content
  // Lines the derived-history wire edge omitted from this block; the full body
  // is fetched lazily on expand (onHydrateBody).
  const remoteDiffOmitted = () => presentsDiff() && !suppressesFileBody() ? totalDiffOmittedLines(props.block.diffOmission) : 0
  const remoteContentOmitted = () => suppressesFileBody() || (isShellMutation() && !showsSettledShellOutput()) || hidesMessageOutput() ? 0 : props.block.contentOmittedLines ?? 0
  const hasRemoteBody = () => remoteDiffOmitted() > 0 || remoteContentOmitted() > 0 || (props.block.invocationBodyOmittedBytes ?? 0) > 0
  const hasExpandable = () => hasDiff() || hasContent() || hasStreamingContent() || hasExecutionOutput() || hasRemoteBody() || disclosedInvocation() || hasOutcome()
  const isInterrupted = () => props.block.status === "interrupted" || (props.interrupted === true && props.block.status !== "completed" && props.block.status !== "error" && props.block.status !== "blocked")

  createEffect(() => {
    const block = props.block
    if (props.disclosureId === undefined && block.status !== "pending" && block.status !== "streaming") markToolResultMounted(block.id)
  })

  // Disclosure lives in the transcript-scoped store, keyed by durable block
  // identity. Virtualization can unmount rows, so every file facet must restore.
  const fileDiffKey = (index: number) => {
    // A single-file header can be disclosed before its first metadata page.
    const samplePath = evidence()?.samples[index]?.path
    const source: { readonly id?: string; readonly path?: string } = diffSources()[index] ?? { id: samplePath ?? "file", ...(samplePath === undefined ? {} : { path: samplePath }) }
    return fileDisclosureKey(disclosure, blockIdentity(props.block), {
      id: source.id ?? source.path ?? "file",
      ...(source.path !== undefined ? { path: source.path } : {}),
    }, props.block.fileChangeKind === "create" || props.block.fileChangeKind === "replace")
  }
  const fileDiffExpanded = (index: number) => disclosure.disclosure(fileDiffKey(index)) === true
  const setFileDiffExpanded = (index: number, expanded: boolean) => disclosure.setDisclosure(fileDiffKey(index), expanded)
  const bodyExpanded = () => disclosure.disclosure(bodyKey()) === true
  const setBodyExpanded = (expanded: boolean) => disclosure.setDisclosure(bodyKey(), expanded)
  const contentExpanded = () => disclosure.disclosure(contentKey()) === true
  const setContentExpanded = (expanded: boolean) => disclosure.setDisclosure(contentKey(), expanded)
  // Mutation artifacts have no collapsed preview. Their existing body toggle
  // parses the complete diff when the user discloses it.
  const diffExpanded = () => contentExpanded() || (isMutationArtifact() && bodyExpanded())
  const parsedDiff = createMemo(() => parseDiffs(
    diffSources(),
    hasFileDiffDisclosure() ? fileDiffExpanded : diffExpanded(),
    rowWritePolicy(props.block),
  ))

  const [contentOverflow, setContentOverflow] = createSignal(false)
  // Each diff file view owns whether its collapsed preview hides content and reports it here.
  const [diffTruncation, setDiffTruncation] = createSignal<readonly boolean[]>([])
  const setFileTruncated = (index: number, truncated: boolean) => setDiffTruncation(previous => {
    if ((previous[index] === true) === truncated) return previous
    const next = [...previous]
    next[index] = truncated
    return next
  })
  const reportDiffTruncated = (index: number, truncated: boolean) => {
    setFileTruncated(index, truncated)
    return () => { setFileTruncated(index, false) }
  }
  const fileDiffTruncated = (index: number) => diffTruncation()[index] === true
  const diffTruncated = () => diffTruncation().some(Boolean)
  const anyFileDiffExpanded = () => diffSources().some((_, index) => fileDiffExpanded(index))

  const contentPreview = createMemo(() =>
    getToolContentPreview(props.block.content, TOOL_PREVIEW_LINE_LIMIT)
  )
  const contentLineNumberDigits = createMemo(() => Math.max(1, String(contentPreview().totalLines).length))
  const rendersFullContent = () => contentExpanded() || contentPresentation() === "collapsed-full"

  const renderedContent = createMemo(() =>
    isAtomicInvocation() ? props.block.content ?? "" : rendersFullContent() ? props.block.content ?? "" : contentPreview().content
  )

  const executionOutputLines = createMemo(() => tailExecutionOutputLines(executionOutput()?.content, LIVE_EXECUTION_OUTPUT_TAIL_LIMIT))

  // Live execution output and settled plain content share ONE renderable and
  // ONE StyledText memo: at completion the element's content is overwritten in
  // place. Two <Show> branches would unmount the live text and mount the final
  // body a frame later - a visible remove-and-replace flicker.
  const showsPlainContent = () => hasContent() && !hasExecutionOutput()
  const outputBodyVisible = () => hasExecutionOutput() || showsPlainContent()
  const outputBodyContent = createMemo<StyledText>(() => {
    if (hasExecutionOutput()) return new StyledText([stFg(theme.textMuted)(executionOutputLines().join("\n"))])
    if (isAtomicInvocation()) return new StyledText([stFg(theme.textMuted)(renderedContent())])
    return syntaxBodyStyledText({
      content: renderedContent(),
      filetype: props.block.filetype,
      theme,
      colors: isWrite() ? themeCtx.writeSyntaxColors : undefined,
      lineNumbers: true,
      lineNumberWidth: contentLineNumberDigits(),
    })
  })
  const invocationBodyContent = createMemo(() => syntaxBodyStyledText({
    content: props.block.invocationBody?.content ?? "",
    filetype: props.block.invocationBody?.filetype,
    theme,
    colors: isWrite() ? themeCtx.writeSyntaxColors : undefined,
  }))

  const keepsPreviewVisible = () => !messageOutcome() && !isAtomicInvocation() && !isMutationArtifact() && (hasDiff() || (isArtifactContent() && hasContent() && !hasExecutionOutput() && contentPresentation() === "preview") || hasStreamingContent())
  const contentTruncated = () => !isAtomicInvocation() && (contentPreview().truncated || remoteContentOmitted() > 0 || contentOverflow())
  // Mutation artifacts use one body toggle: hidden, then complete. Other preview
  // content keeps the existing truncated-preview expansion behavior.
  const previewExpandable = () => !isMutationArtifact()
    && !hasFileDiffDisclosure()
    && (contentExpanded() || diffTruncated() || (contentTruncated() && contentPresentation() === "preview"))
  const showsBody = () => keepsPreviewVisible() || bodyExpanded()

  const headerChevron = createMemo(() => {
    if (hasFileDiffDisclosure() && fileCount() === 1 && (fileDiffTruncated(0) || fileDiffExpanded(0))) {
      return fileDiffExpanded(0) ? "▾" : "▸"
    }
    if (keepsPreviewVisible() && previewExpandable()) return contentExpanded() ? "▾" : "▸"
    if (!keepsPreviewVisible() && hasExpandable()) return bodyExpanded() ? "▾" : "▸"
    return null
  })

  // Hydration keys off the disclosed state, not the expanding click: a repave
  // can strip an already-expanded entry's body down to wire-omitted counts
  // (e.g. the tool completes and the durable view replaces the live block),
  // and a disclosed body must always show its lines. The condition mirrors
  // where omitted lines would render: an expanded preview, or an open body
  // whose preview is not already visible. setBlockBody clears the counts, so a
  // successful fetch never refires; a failed one retries on the next toggle.
  createEffect(() => {
    const revealed = hasFileDiffDisclosure()
      ? anyFileDiffExpanded()
      : contentExpanded() || (bodyExpanded() && !keepsPreviewVisible())
    if (revealed && hasRemoteBody()) props.onHydrateBody?.(identity())
  })

  const toggleHeader = () => {
    if (hasFileDiffDisclosure() && fileCount() === 1) {
      setFileDiffExpanded(0, !fileDiffExpanded(0))
      return
    }
    const next = nextToolEntryToggleState(
      { bodyExpanded: bodyExpanded(), previewExpanded: contentExpanded() },
      { keepsPreviewVisible: keepsPreviewVisible(), previewExpandable: previewExpandable() },
    )
    // One notification for both disclosure writes: the hydration effect must
    // observe only the settled toggle state, never the intermediate one.
    batch(() => {
      setBodyExpanded(next.bodyExpanded)
      setContentExpanded(next.previewExpanded)
    })
  }

  const canToggleHeader = () => headerChevron() !== null
  const navigableLinkUri = () => props.block.linkUri?.startsWith("flywheel://") ? props.block.linkUri : undefined

  const handleHeaderClick = () => {
    if (canToggleHeader()) {
      toggleHeader()
      return
    }
    const uri = navigableLinkUri()
    if (uri && navigateUri) navigateUri(uri)
  }

  const headerClickable = () => canToggleHeader() || navigableLinkUri() != null

  // One toggle target for the header and its expanded body,
  // so the whole entry hovers and clicks as a single box. Clicks are
  // selection-guarded (drag-to-copy never toggles, see useUnifiedToggle). The
  // hover cue is the accent chevron going bold, not a background fill.
  const toggle = useUnifiedToggle(headerClickable, handleHeaderClick, () => hasExpandable() && showsBody(), (event) => controlAt(event) !== undefined || hitsDrawnContent(event))

  const headerChunks = createMemo(() => {
    // The gutter dot is the only run marker; a failure still surfaces as red
    // error text after the call.
    const hovered = toggle.hovered()
    const headerText = hovered ? theme.textBright : theme.text
    const active = activeProcessControl() !== undefined
    const presentation = rowPresentation(props.block, active)
    // A shell mutation's detail names its files once they land, so it highlights
    // as a file tool's does; while it runs it is a plain status line.
    const runningLine = isShellMutationRunning(props.block, active)
    const detailAction = isShellMutation() && shellMutationFiles(props.block) !== undefined ? getToolDisplay("edit").action : toolAction()
    const label = presentation.name
    const prefix: TextChunk[] = []
    if (label) {
      const nameChunk = stBold(stFg(headerText)(label))
      prefix.push(isInterrupted() ? stStrike(nameChunk) : nameChunk)
    }

    const chunks: TextChunk[] = []
    const detail = presentation.detail
    if (detail) {
      if (prefix.length > 0) prefix.push(stFg(theme.text)(" "))
      const uri = navigableLinkUri()
      // Nested Code Mode rows carry `[key=value, ...]` input summaries, not a
      // command line; route them by the row, not the (fallback) action.
      const highlighted = runningLine
        ? [stFg(theme.text)(detail)]
        : props.block.runCategoryOverride === "execute" && !isShellMutation()
          ? highlightExecuteInputs(detail.replace(/\s+/g, " "), theme)
          : highlightToolDetail(detailAction, detail, theme, props.block.linkUri)
      const styled = uri ? linkifyChunks(highlighted, uri) : highlighted
      // Hover lights the plain-text detail chunks; accent-colored chunks keep
      // their meaning.
      const lit = hovered ? styled.map((c) => c.fg === theme.text ? { ...c, fg: theme.textBright } : c) : styled
      chunks.push(...lit.map((c) => isInterrupted() ? stStrike(c) : c))
    }

    const suffix: TextChunk[] = []
    if (props.block.exitCode != null && props.block.exitCode !== 0) {
      suffix.push(stFg(theme.error)(` (exit ${props.block.exitCode})`))
    }

    if (props.block.status === "error" && !messageOutcome()) {
      suffix.push(stFg(theme.text)(" "))
      suffix.push(stFg(theme.error)(props.block.errorMessage))
    }

    if (props.block.status === "blocked" && !messageOutcome()) {
      suffix.push(stFg(theme.text)(" "))
      suffix.push(stFg(theme.warning)(props.block.statusMessage))
    }

    const chevron = headerChevron()
    if (chevron) {
      suffix.push(stFg(theme.text)(" "))
      suffix.push(hovered
        ? stBold(stFg(theme.primaryBright)(chevron))
        : stFg(theme.primary)(chevron))
    }
    return { prefix, detail: chunks, suffix }
  })
  const visibleHeaderChunks = createMemo(() => {
    const { prefix, detail, suffix } = headerChunks()
    const control = activeProcessControl()
    const waiting = !isInterrupted() && rowWaitsForProcessor(props.rowControls, props.block)
    return wrapToolRowChunks(prefix, detail, measured.width(), [], props.block.runCategoryOverride === "execute" ? 2 : undefined,
      [...suffix, ...(waiting ? processorWaitChunks(theme) : []), ...(control === undefined ? [] : processControlChunks(theme, control.label))])
  })
  const headerContent = createMemo(() => new StyledText(visibleHeaderChunks()))
  let headerText: TextRenderable | undefined

  // The whole body is the toggle target, so the note doubles
  // as the affordance hint in both directions.
  const contentTruncationNote = createMemo(() =>
    new StyledText([stFg(theme.textMuted)(
      contentExpanded() ? "  (click to collapse)" : contentOverflow()
        ? "  ... more content (click to expand)"
        : `  ... ${contentPreview().omitted + remoteContentOmitted()} more lines (click to expand)`,
    )])
  )


  function controlAt(event: MouseEvent): RowProcessControl | undefined {
    const control = activeProcessControl()
    return control !== undefined && hitsLabel(event, headerText, visibleHeaderChunks().map((chunk) => chunk.text).join(""), control.label) ? control : undefined
  }

  function handleMouseUp(event: MouseEvent): void {
    const control = controlAt(event)
    if (control === undefined) {
      toggle.handlers.onMouseUp(event)
      return
    }
    if (hasSelectedCells(renderer.getSelection())) return
    event.stopPropagation()
    control.dispatch()
  }

  const header = () => (
    <box selectable={false}>
      <text
        ref={(el) => { headerText = el; bindStyledTextContent(headerContent)(el) }}
        overflow="hidden"
        wrapMode="none"
      />
    </box>
  )

  const body = () => (
    <box
      ref={measured.ref}
      flexDirection="column"
      backgroundColor={landingBackground()}
      {...toggle.handlers}
      onMouseUp={handleMouseUp}
    >
      {header()}
      <Show when={props.block.invocationBody !== undefined && !disclosedInvocation() && !suppressesFileBody()}>
        <box paddingLeft={2} flexDirection="column">
          <text ref={bindSelectableStyledTextContent(invocationBodyContent)} wrapMode="word" />
        </box>
      </Show>
      <Show when={advisoryBody()}>
        {(advisory) => (
          <box paddingLeft={2}>
            <text fg={theme.textMuted} wrapMode="word">Preview check: {advisory().message}</text>
          </box>
        )}
      </Show>
      <Show when={(evidence()?.conflictMarkers ?? 0) > 0 ? evidence() : undefined}>
        {(summary) => (
          <box paddingLeft={2}>
            <text fg={theme.warning} wrapMode="word">{conflictMarkersNotice(summary())}</text>
          </box>
        )}
      </Show>
      <Show when={(evidence()?.notApplied ?? 0) > 0 ? evidence() : undefined}>
        {(summary) => (
          <box paddingLeft={2}>
            <text fg={theme.warning} wrapMode="word">{notAppliedNotice(summary())}</text>
          </box>
        )}
      </Show>
      <Show when={hasExpandable()}>
        <CollapsibleBox
          ref={toggle.body}
          expanded={showsBody()}
          border={["left"]}
          borderColor={theme.primary}
          customBorderChars={toggle.hovered() ? VerticalBarBorder : BlankVerticalBarBorder}
          paddingTop={1}
          paddingBottom={1}
          paddingLeft={1}
          paddingRight={1}
        >
          <Show when={disclosedInvocation() && props.block.invocationBody !== undefined}>
            <text ref={bindSelectableStyledTextContent(invocationBodyContent)} wrapMode="word" />
          </Show>
          <Show when={messageOutcome() && props.block.status === "error" ? props.block.errorMessage : undefined}>
            {(message) => <text fg={theme.error} wrapMode="word">{message()}</text>}
          </Show>
          <Show when={messageOutcome() && props.block.status === "blocked" ? props.block.statusMessage : undefined}>
            {(message) => <text fg={theme.warning} wrapMode="word">{message()}</text>}
          </Show>
          <Show when={evidence() === undefined && selectedFileBody().kind === "proposed"}>
            <text fg={theme.textMuted} selectable={false}>Proposed changes</text>
          </Show>
          <Show when={hasDiff() && evidence() === undefined}>
            <DiffPreview
              parsed={parsedDiff()}
              diffOmission={props.block.diffOmission}
              onToggleFile={hasFileDiffDisclosure()
                ? (index) => setFileDiffExpanded(index, !fileDiffExpanded(index))
                : undefined}
              diffColors={props.diffColors}
              onTruncated={reportDiffTruncated}
            />
          </Show>
          <Show when={evidence()}>
            {(manifest) => <MutationEvidencePreview
              ownerId={identity()}
              evidence={manifest()}
              expanded={hasFileDiffDisclosure() ? fileDiffExpanded : diffExpanded()}
              writes={rowWritePolicy(props.block)}
              hideSingleHeading={previewsMutation()}
              showActions={presentsEdit()}
              pendingProposal={(() => {
                const selected = selectedFileBody()
                return selected.kind === "actual" ? selected.pendingProposal : undefined
              })()}
              onToggleFile={hasFileDiffDisclosure() ? (index) => setFileDiffExpanded(index, !fileDiffExpanded(index)) : undefined}
              diffColors={props.diffColors}
              onTruncated={reportDiffTruncated}
            />}
          </Show>
          <PreviewViewport
            expanded={rendersFullContent() || isAtomicInvocation() || hasExecutionOutput()}
            onOverflow={setContentOverflow}
          >
            <Show when={hasStreamingContent() && !hasContent()}>
              <SyntaxCode
                content={streamingText()?.content ?? ""}
                filetype={streamingText()?.filetype ?? props.block.filetype}
                lineNumbers
                streaming
                colors={isWrite() ? themeCtx.writeSyntaxColors : undefined}
              />
            </Show>
            <Show when={outputBodyVisible()}>
              <text ref={bindSelectableStyledTextContent(outputBodyContent)} wrapMode="word" />
            </Show>
          </PreviewViewport>
          <Show when={(hasContent() || hasStreamingContent()) && !hasExecutionOutput()}>
            <Show when={(contentExpanded() || contentTruncated()) && contentPresentation() === "preview"}>
              <text selectable={false} ref={bindStyledTextContent(contentTruncationNote)} />
            </Show>
          </Show>
        </CollapsibleBox>
      </Show>
    </box>
  )
  return <Show when={props.embedded === true} fallback={<BlockFrame active={isActive}>{body()}</BlockFrame>}>{body()}</Show>
}
