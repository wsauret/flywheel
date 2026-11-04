/** @jsxImportSource @opentui/solid */

import type { ToolStreamingText } from "@infra/output-blocks"
import { blockIdentity } from "../../protocol/block-identity.js"
import { getToolDisplay } from "@infra/tools/tool-display-registry.js"
import { StyledText, bold as stBold, fg as stFg, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core"
import { displayWidth } from "@tui/utils/text.js"
import { highlightExecuteInputs, highlightToolDetail, linkifyChunks } from "@tui/adapters/tool-detail-highlight.js"
import { useNavigateUri } from "@tui/context/navigation.js"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { bindSelectableStyledTextContent, bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { hitsDrawnContent, hitsLabel } from "@tui/utils/content-hit.js"
import { hasSelectedCells } from "@tui/utils/selection.js"
import { stStrike } from "@tui/utils/text-attributes.js"
import { useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { useBlockDisclosure } from "@tui/context/block-disclosure.js"
import { useLandingBackground } from "@tui/context/landing-highlight.js"
import { useRenderer } from "@opentui/solid"
import { createEffect, createMemo, Show } from "solid-js"
import { chunkDisplayWidth, wrapToolRowChunks } from "./tool-row-wrap.js"
import { processControlChunks, processorWaitChunks, rowProcessControl, rowWaitsForProcessor, type RowProcessControl, type RowProcessControls } from "./stop-affordance.js"
import { LIVE_EXECUTION_OUTPUT_TAIL_LIMIT, tailExecutionOutputLines, type ToolRenderEntry } from "./tool-entry-helpers.js"
import { syntaxBodyStyledText } from "@tui/components/syntax-code.js"
import { fileChangeDetail, isShellMutationRunning, rowPresentation } from "../../protocol/client/file-change-body.js"
import { splitLines } from "./markdown/format-token.js"

const BULLET = "•"

type ToolRowOutput = {
  lines: string[]
  live: boolean
}

interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }
interface ToolRowProps {
  tool: ToolRenderEntry
  streamingToolText?: StreamingToolTextById
  interrupted?: boolean
  connector?: string
  // Rendered at the start of each wrapped continuation line (padded to the
  // prefix width) so multi-line rows stay visually attached to the tree rail.
  continuationConnector?: string
  // Width of the list container, measured once by the parent list so a newly
  // mounted row wraps correctly on its first frame (no per-row measurement,
  // no blank-then-reflow flicker while an active group's preview window rolls).
  availWidth: number
  // Left pad, in columns. Defaults to 1 (the bordered tool list insets one
  // column from its border). The flat explore list passes 0 so the connector
  // corner aligns under the first letter of the group header.
  padLeft?: number
  // Grouped children carry no success glyph; the heading owns the run status.
  hideStatusIcon?: boolean
  // Exec-group children omit the verb (the "Ran" heading carries it) and show
  // just the command.
  hideVerb?: boolean
  // Never expandable: subagent-group children stay compact one-line rows, so
  // command output (live or final) is not disclosed.
  hideOutput?: boolean
  /** Lazy full-body fetch for an exec row whose output the derived wire edge
   *  withheld (contentOmittedLines > 0): invoked with the row's durable block
   *  identity while the row is expanded. */
  onHydrateBody?: (blockId: string) => void
  rowControls?: RowProcessControls
  /** The call's process runs where this row offers no control of it, as in a
   *  subagent card that reads its child session's processes. */
  live?: boolean
}

export function ToolRow(props: ToolRowProps) {
  const themeCtx = useTheme()
  const { theme } = themeCtx
  const navigateUri = useNavigateUri()
  const renderer = useRenderer()
  const isInterrupted = () => props.tool.status === "interrupted" || (props.interrupted === true && props.tool.status !== "completed" && props.tool.status !== "error" && props.tool.status !== "blocked")

  const navigableLinkUri = () => props.tool.linkUri?.startsWith("flywheel://") ? props.tool.linkUri : undefined
  const action = createMemo(() => getToolDisplay(props.tool.name).action)
  const isWrite = () => props.tool.fileChangeKind === "create" || action() === "file_write"
  const activeProcessControl = () => rowProcessControl(props.rowControls, props.tool.id)
  const active = () => props.live === true || activeProcessControl() !== undefined
  const presentation = createMemo(() => rowPresentation(props.tool, active()))
  const runningLine = () => isShellMutationRunning(props.tool, active())
  const liveExecutionOutput = createMemo(() => {
    if (props.tool.status === "streaming") return undefined
    return props.streamingToolText?.[props.tool.id]?.content
  })
  const outputDisplay = createMemo<ToolRowOutput>(() => {
    const liveContent = liveExecutionOutput()
    const content = liveContent ?? props.tool.content
    const live = liveContent !== undefined
    return { lines: tailExecutionOutputLines(content, live ? LIVE_EXECUTION_OUTPUT_TAIL_LIMIT : undefined), live }
  })
  // Historical rows arrive without content: the derived wire edge strips
  // collapsed-by-default exec output and ships only its omitted-line count,
  // so the affordance keys off either the inline content or that count.
  const remoteContentOmitted = () => props.tool.contentOmittedLines ?? 0
  const remoteInvocationOmitted = () => props.tool.invocationBodyOmittedBytes ?? 0
  const hasInvocationBody = () => !props.hideOutput && props.tool.invocationBody !== undefined
  const hasDisclosureInvocationBody = () => props.tool.invocationBody?.presentation === "disclosure"
    || (props.tool.name === "message_session" && remoteInvocationOmitted() > 0)
  const hasInlineInvocationBody = () => hasInvocationBody() && !hasDisclosureInvocationBody()
  const hasExpandableOutput = createMemo(() => !props.hideOutput && (hasDisclosureInvocationBody() || ((action() === "shell_exec" || props.tool.runCategoryOverride === "execute") && (outputDisplay().lines.length > 0 || remoteContentOmitted() > 0))))
  // Disclosure lives in the transcript-scoped store (see block-disclosure.ts):
  // virtualization unmounts far rows, and a remounted row must restore the
  // output the user left disclosed.
  const disclosure = useBlockDisclosure()
  const landingBackground = useLandingBackground(() => [props.tool.id])
  const identity = () => props.tool.disclosureId ?? blockIdentity(props.tool)
  const outputKey = () => `${identity()}${hasDisclosureInvocationBody() ? "#body" : "#output"}`
  const outputExpanded = () => disclosure.disclosure(outputKey()) === true

  // Hydration keys off the disclosed state, not the expanding click: a repave
  // can strip an already-expanded row's body down to a wire-omitted count
  // (e.g. the tool completes and the durable view replaces the live block),
  // and an expanded row must always show its lines. setBlockBody clears the
  // count, so a successful fetch never refires; a failed one retries on the
  // next toggle.
  createEffect(() => {
    if (outputExpanded() && (remoteContentOmitted() > 0 || remoteInvocationOmitted() > 0)) props.onHydrateBody?.(identity())
  })

  const handleClick = () => {
    if (hasExpandableOutput()) {
      disclosure.setDisclosure(outputKey(), !outputExpanded())
      return
    }
    const uri = navigableLinkUri()
    if (uri && navigateUri) navigateUri(uri)
  }

  const isClickable = () => hasExpandableOutput() || navigableLinkUri() != null
  // One toggle target for the row and its expanded output, so the whole block
  // hovers and clicks as a single box. The hover cue is the rail, not a
  // background: the row's left edge becomes a bold accent bracket exactly
  // spanning the clickable unit.
  const toggle = useUnifiedToggle(isClickable, handleClick, () => hasExpandableOutput() && outputExpanded(), (event) => controlAt(event) !== undefined || hitsDrawnContent(event))
  // Hover swaps the light rail glyphs for their heavy twins: bold rarely
  // thickens box-drawing characters, so the weight change is a char swap.
  const railChunk = (text: string) =>
    toggle.hovered()
      ? stBold(stFg(theme.primary)(text.replace("│", "┃").replace("├", "┣").replace("└", "┗")))
      : stFg(theme.textMuted)(text)

  const compactMutationDetail = createMemo(() => {
    if (!props.hideOutput || props.tool.presentation.detail !== "") return undefined
    const mutationEvidence = props.tool.mutationEvidence
    if (mutationEvidence !== undefined) return fileChangeDetail({ kind: "actual", mutationEvidence })
    return undefined
  })

  const bodyChunks = createMemo(() => {
    const chunks = toolBodyChunks({ ...props.tool, presentation: presentation() }, theme, {
      interrupted: isInterrupted(),
      runningLine: runningLine(),
      // Inline invocation rows carry their chevron after the source body;
      // disclosure-only invocation rows use the ordinary header chevron.
      expandable: hasExpandableOutput() && !hasInlineInvocationBody(),
      expanded: outputExpanded(),
      hovered: toggle.hovered(),
      linkUri: navigableLinkUri(),
    }, compactMutationDetail())
    // Hover lights the plain-text chunks alongside the rail and chevron;
    // accent-colored chunks (errors, shell highlights) keep their meaning.
    const light = (parts: TextChunk[]) => toggle.hovered()
      ? parts.map((c) => c.fg === theme.text ? { ...c, fg: theme.textBright } : c)
      : parts
    return { detail: light(chunks.detail), suffix: light(chunks.suffix) }
  })

  // Gutter rendered on the first line only; its display width sets the hanging
  // indent so wrapped detail lines align under the start of the detail.
  const prefixChunks = createMemo<TextChunk[]>(() => {
    const displayName = presentation().name
    const chunks: TextChunk[] = []
    if (props.connector) chunks.push(railChunk(props.connector))
    // The heading owns run status, so child rows carry no glyph.
    const showIcon = !props.hideStatusIcon
    const head: TextChunk[] = []
    if (showIcon) head.push(stFg(theme.warning)(BULLET))
    if (!props.hideVerb && displayName) {
      const nameChunk = stFg(theme.chatCodeType)(displayName)
      head.push(isInterrupted() ? stStrike(nameChunk) : nameChunk)
    }
    for (const [idx, c] of head.entries()) {
      if (idx > 0) chunks.push(stFg(theme.text)(" "))
      chunks.push(c)
    }
    if (head.length > 0 && (bodyChunks().detail.length > 0 || bodyChunks().suffix.length > 0 || hasInlineInvocationBody())) chunks.push(stFg(theme.text)(" "))
    return chunks
  })

  // Wrap width is the parent list's laid-out width minus this row's paddingLeft.
  // Until the parent's first layout the width is unknown (availWidth stays 0);
  // render blank for that frame instead of an unwrapped line that visibly
  // re-wraps once measured.
  const continuationChunks = createMemo<TextChunk[]>(() => {
    // The last railed row has no resting continuation rail; on hover the bar
    // materializes into the blank indent column so every layout shows the same
    // full-height bracket. Rows without a connector (e.g. subagent-group
    // children) have no rail to extend and get none.
    const rail = props.continuationConnector ?? (props.connector && toggle.hovered() ? "│" : undefined)
    return rail ? [railChunk(rail)] : []
  })
  const rowChunks = createMemo(() => {
    const avail = Math.max(0, props.availWidth - (props.padLeft ?? 1))
    const body = bodyChunks()
    const suffix = [...body.suffix]
    if (!isInterrupted() && rowWaitsForProcessor(props.rowControls, props.tool)) suffix.push(...processorWaitChunks(theme))
    const control = activeProcessControl()
    if (control !== undefined) suffix.push(...processControlChunks(theme, control.label))
    if (avail === 0) return []
    const wrapped = wrapToolRowChunks(prefixChunks(), body.detail, avail, continuationChunks(), props.tool.runCategoryOverride === "execute" ? 2 : undefined, suffix)
    // When the hover rail continues below this row's first line (wrapped
    // continuation lines, or an expanded output body), a terminating corner
    // becomes a tee so the bracket stays connected. At rest the last row has
    // no rail below and keeps its corner.
    if (toggle.hovered() && props.connector?.includes("└")) {
      const railBelow = wrapped.some((c) => c.text.includes("\n")) || (hasExpandableOutput() && outputExpanded())
      const first = wrapped[0]
      if (railBelow && first?.text.includes("┗")) {
        wrapped[0] = { ...first, text: first.text.replace("┗", "┣") }
      }
    }
    return wrapped
  })
  const rowContent = createMemo(() => new StyledText(rowChunks()))
  let rowText: TextRenderable | undefined
  const prefixWidth = createMemo(() => chunkDisplayWidth(prefixChunks()))
  // Expanded output lines carry the tree rail (or plain indent) as text, so
  // the rail stays unbroken through the output and survives in copied text.
  const outputPrefixChunks = createMemo<TextChunk[]>(() => {
    const rail = continuationChunks()
    // Execute children show their full tool name in the prefix; hanging the
    // output under that name pushes it far right for long names. Hang at the
    // connector width instead, aligning output with the name's first column
    // (the same column bash children use, whose prefix is just the connector).
    const hangWidth = props.tool.runCategoryOverride === "execute" && props.connector
      ? displayWidth(props.connector)
      : prefixWidth()
    const pad = " ".repeat(Math.max(0, hangWidth - chunkDisplayWidth(rail)))
    return pad.length > 0 ? [...rail, stFg(theme.textMuted)(pad)] : [...rail]
  })
  // One renderable for the whole expanded body: per-line elements would be
  // torn down and rebuilt on every live update (the tail window slides, so
  // every line changes), which saturates layout at streaming rates.
  const outputContent = createMemo(() => {
    const disclosedInvocation = hasDisclosureInvocationBody() ? props.tool.invocationBody : undefined
    const lines = disclosedInvocation
      ? splitLines(syntaxBodyStyledText({ content: disclosedInvocation.content, filetype: disclosedInvocation.filetype, theme, colors: isWrite() ? themeCtx.writeSyntaxColors : undefined }).chunks)
      : outputDisplay().lines.map(line => line ? [stFg(theme.textMuted)(line)] : [])
    const avail = Math.max(0, props.availWidth - (props.padLeft ?? 1))
    const chunks: TextChunk[] = []
    for (const line of lines) {
      if (chunks.length > 0) chunks.push({ __isChunk: true, text: "\n" })
      // Clone the prefix per line: one TextChunk instance must not repeat in
      // a StyledText, and wrapToolRowChunks spreads the prefix uncloned.
      const prefix = outputPrefixChunks().map((chunk) => ({ ...chunk }))
      chunks.push(...wrapToolRowChunks(prefix, line, avail, continuationChunks()))
    }
    return new StyledText(chunks)
  })
  // An invocation body (a code script) folds into the row itself: the first
  // source line follows the label on the header line, continuation lines
  // carry the tree rail with a hanging indent so the run's rail never breaks,
  // and the disclosure chevron trails the last line so expanding reads as
  // "show this script's result". Each source line pre-wraps through
  // wrapToolRowChunks so soft-wrapped continuations also carry the rail;
  // the renderer's wrapMode never creates a rail-less line.
  const invocationRowContent = createMemo(() => {
    const body = props.tool.invocationBody
    if (body === undefined) return new StyledText([])
    const avail = Math.max(0, props.availWidth - (props.padLeft ?? 1))
    const styled = syntaxBodyStyledText({ content: body.content, filetype: body.filetype, theme, colors: isWrite() ? themeCtx.writeSyntaxColors : undefined })
    // Split the highlighted body into logical source lines so each line wraps
    // with its own rail prefix.
    const lines = splitLines(styled.chunks)
    const chunks: TextChunk[] = []
    for (const [idx, lineChunks] of lines.entries()) {
      const prefix = idx === 0
        ? [...prefixChunks(), ...bodyChunks().detail, ...bodyChunks().suffix, ...(bodyChunks().detail.length + bodyChunks().suffix.length > 0 ? [stFg(theme.text)(" ")] : [])]
        // Clone per line: one TextChunk instance must not repeat in a StyledText.
        : outputPrefixChunks().map((c) => ({ ...c }))
      if (idx > 0) chunks.push({ __isChunk: true, text: "\n" })
      chunks.push(...wrapToolRowChunks(prefix, lineChunks, avail, continuationChunks()))
    }
    if (hasExpandableOutput()) {
      const chevron = outputExpanded() ? "▾" : "▸"
      chunks.push(stFg(theme.text)(" "), toggle.hovered() ? stBold(stFg(theme.primaryBright)(chevron)) : stFg(theme.primary)(chevron))
    }
    // The hover rail continues below the first line, so a terminating corner
    // becomes a tee (same rule as rowChunks).
    if (toggle.hovered() && props.connector?.includes("└")) {
      const railBelow = chunks.some((c) => c.text.includes("\n")) || (hasExpandableOutput() && outputExpanded())
      const first = chunks[0]
      if (railBelow && first?.text.includes("┗")) {
        chunks[0] = { ...first, text: first.text.replace("┗", "┣") }
      }
    }
    return new StyledText(chunks)
  })

  function controlAt(event: MouseEvent): RowProcessControl | undefined {
    const control = activeProcessControl()
    return control !== undefined && hitsLabel(event, rowText, rowChunks().map((chunk) => chunk.text).join(""), control.label) ? control : undefined
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
  return (
    <box
      flexDirection="column"
      backgroundColor={landingBackground()}
      {...toggle.handlers}
      onMouseUp={handleMouseUp}
    >
      <Show
        when={hasInlineInvocationBody()}
        fallback={
          <box paddingLeft={props.padLeft ?? 1}>
            <text
              ref={(el) => { rowText = el; bindStyledTextContent(rowContent)(el) }}
              wrapMode="word"
            />
          </box>
        }
      >
        <box paddingLeft={props.padLeft ?? 1}>
          <text ref={bindSelectableStyledTextContent(invocationRowContent)} wrapMode="word" />
        </box>
      </Show>
      <Show when={hasExpandableOutput() && outputExpanded()}>
        <box ref={toggle.body} paddingLeft={props.padLeft ?? 1}>
          <text ref={bindStyledTextContent(outputContent)} wrapMode="word" />
        </box>
      </Show>
    </box>
  )
}

function toolBodyChunks(
  tool: ToolRenderEntry,
  theme: TuiTheme,
  state: { interrupted: boolean; runningLine: boolean; expandable: boolean; expanded: boolean; hovered: boolean; linkUri: string | undefined },
  detailFallback: string | undefined,
) {
  // A running shell mutation's detail is a status line, not a command to highlight.
  const detail = state.runningLine ? [stFg(theme.text)(tool.presentation.detail)] : toolDetailChunks(tool, theme, state.linkUri, detailFallback)
  const status: TextChunk[] = []
  appendToolExitAndError(status, tool, theme)
  const suffix = state.interrupted ? interruptedToolChunks(status, theme, state) : disclosureToolChunks(status, theme, state)
  if (suffix.length > 0 && detail.length > 0 && !suffix[0]?.text.startsWith(" ")) suffix.unshift(stFg(theme.text)(" "))
  return {
    detail: state.interrupted ? detail.map(stStrike) : detail,
    suffix,
  }
}

function toolDetailChunks(tool: ToolRenderEntry, theme: TuiTheme, linkUri: string | undefined, detailFallback: string | undefined): TextChunk[] {
  if (tool.detailSegments) {
    return tool.detailSegments.map((segment) =>
      stFg(segment.tone === "error" ? theme.error : theme.text)(segment.text)
    )
  }
  const detail = tool.presentation.detail || detailFallback
  if (!detail) return []
  // Nested Code Mode rows carry `[key=value, ...]` input summaries, not a
  // command line; route them by the row, not the (fallback) action.
  const styled = tool.runCategoryOverride === "execute"
    ? highlightExecuteInputs(detail.replace(/\s+/g, " "), theme)
    : highlightToolDetail(getToolDisplay(tool.name).action, detail, theme, tool.linkUri)
  return linkUri ? linkifyChunks(styled, linkUri) : styled
}

function appendToolExitAndError(chunks: TextChunk[], tool: ToolRenderEntry, theme: TuiTheme): void {
  if (tool.exitCode != null && tool.exitCode !== 0) chunks.push(stFg(theme.error)(` (exit ${tool.exitCode})`))
  if (tool.status === "error" && !tool.detailSegments) {
    if (chunks.length > 0) chunks.push(stFg(theme.text)(" "))
    chunks.push(stFg(theme.error)(tool.errorMessage))
  }
  if (tool.status === "blocked") {
    if (chunks.length > 0) chunks.push(stFg(theme.text)(" "))
    chunks.push(stFg(theme.warning)(tool.statusMessage))
  }
}

function interruptedToolChunks(chunks: TextChunk[], theme: TuiTheme, state: { expandable: boolean; expanded: boolean; hovered: boolean }): TextChunk[] {
  const interruptedChunks = chunks.map(stStrike)
  if (interruptedChunks.length > 0) interruptedChunks.push(stFg(theme.text)(" "))
  interruptedChunks.push(stFg(theme.error)("Interrupted"))
  return disclosureToolChunks(interruptedChunks, theme, state)
}

function disclosureToolChunks(chunks: TextChunk[], theme: TuiTheme, state: { expandable: boolean; expanded: boolean; hovered: boolean }): TextChunk[] {
  if (!state.expandable) return chunks
  chunks.push(stFg(theme.text)(" "))
  const chevron = state.expanded ? "▾" : "▸"
  chunks.push(state.hovered ? stBold(stFg(theme.primaryBright)(chevron)) : stFg(theme.primary)(chevron))
  return chunks
}
