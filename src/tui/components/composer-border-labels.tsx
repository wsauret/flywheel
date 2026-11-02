import { RGBA, fg as stFg, type TextChunk } from "@opentui/core"
import { useSpinnerFrame } from "@tui/hooks/use-spinner-frame"
import type { TuiTheme } from "@tui/context/theme/resolve"
import { chunksLength } from "@tui/utils/text-attributes.js"
import type { Accessor } from "solid-js"
import { createMemo } from "solid-js"
import { keyHintPlainText, keyHintSeparatorBefore } from "./key-hint-row-state.js"
import type { ModuleRowAction } from "../../protocol/protocol-module.js"
import type { ComposerBorderLayout } from "./composer-border-layout.js"
import { statusLineParts, type SpinnerStatus } from "../hooks/spinner-status-animation.js"

function lerpRgba(a: RGBA, b: RGBA, t: number): RGBA {
  const s = 1 - t
  return RGBA.fromInts(
    Math.round(a.r * 255 * s + b.r * 255 * t),
    Math.round(a.g * 255 * s + b.g * 255 * t),
    Math.round(a.b * 255 * s + b.b * 255 * t),
  )
}

interface PromptStatusChunksProps {
  theme: TuiTheme
  status: Accessor<SpinnerStatus | null>
  idle: Accessor<boolean>
  maxWidth: Accessor<number>
}

interface PromptBorderChunksDeps {
  theme: TuiTheme
  layout: Accessor<ComposerBorderLayout>
  lineWidth: Accessor<number>
  status: Accessor<SpinnerStatus | null>
  idle: Accessor<boolean>
}

export type ComposerControlAction = "update" | "changes" | "model" | "sessions" | "new" | "close" | "switch" | "background" | "resume"
export type ComposerControlLabel = "topRight" | "bottomLeft" | "bottomRight"

export interface ComposerBorderControl {
  readonly action: ComposerControlAction | ModuleRowAction
  readonly label: ComposerControlLabel
  readonly offset: number
  readonly chunks: readonly TextChunk[]
}

function createPromptStatusDisplay(props: PromptStatusChunksProps) {
  const spinnerFrame = useSpinnerFrame(() => props.status()?.indicator === "spinner")

  const verbColor = createMemo((): RGBA => {
    const s = props.status()
    const base = props.theme.text
    if (!s || s.colorMode === "normal") return base
    const target = s.colorMode === "stalled" ? props.theme.error : props.theme.warning
    return lerpRgba(base, target, s.intensity)
  })

  const partColor = (part: { tone: "status" | "metadata" | "muted" | "border" }): RGBA => {
    if (part.tone === "status") return verbColor()
    if (part.tone === "metadata") return props.theme.textSubtle
    if (part.tone === "border") return props.theme.border
    return props.theme.textMuted
  }

  const display = createMemo(() => {
    const maxWidth = props.maxWidth()
    if (maxWidth <= 0) return { chunks: [], controls: [] }
    const status = props.status() ?? (props.idle()
      ? {
          verb: "Idle",
          segments: [],
          colorMode: "normal",
          indicator: "circle",
          intensity: 0,
        } satisfies SpinnerStatus
      : null)
    if (!status) return { chunks: [], controls: [] }

    let parts = statusLineParts(status)
    while (parts.length > 3 && 2 + parts.reduce((sum, part) => sum + part.text.length, 0) > maxWidth) {
      parts = parts.slice(0, -2)
    }

    const textChunks: TextChunk[] = [
      stFg(props.theme.textMuted)(" "),
      stFg(verbColor())(status.indicator === "circle" ? "◌" : spinnerFrame()),
    ]
    const controls: ComposerBorderControl[] = []
    let offset = 2
    for (const part of parts) {
      const chunk = stFg(partColor(part))(part.text)
      textChunks.push(chunk)
      if (part.action) {
        const text = part.text.trim()
        controls.push({
          action: part.action,
          label: "bottomLeft",
          offset: offset + part.text.indexOf(text),
          chunks: [stFg(partColor(part))(text)],
        })
      }
      offset += chunksLength([chunk])
    }

    return chunksLength(textChunks) <= maxWidth
      ? { chunks: textChunks, controls }
      : { chunks: [], controls: [] }
  })
  return display
}

/** Update alert, module labels and Changes, then the model: the alert leads because it asks
 *  for an action, and the model sits at the corner where the eye settles. */
function promptTopRightLabel(theme: TuiTheme, layout: ComposerBorderLayout) {
  const { update, modelLabel, composerStatus, changesLabel } = layout
  const segments: { action?: ComposerControlAction | ModuleRowAction; chunks: TextChunk[] }[] = []
  if (update) segments.push({ action: "update", chunks: [stFg(theme[update.tone])(update.label)] })
  const toneColor = (tone: "warning" | "success" | undefined) => tone === "warning" ? theme.warning : tone === "success" ? theme.success : theme.textMuted
  for (const label of composerStatus ?? []) {
    const chunks = [stFg(toneColor(label.tone))(label.text)]
    if (label.suffix) chunks.push(stFg(theme.textMuted)(" "), stFg(toneColor(label.suffix.tone))(label.suffix.text))
    segments.push({ ...(label.action ? { action: label.action } : {}), chunks })
  }
  if (changesLabel) segments.push({ action: "changes", chunks: [stFg(theme.textMuted)(changesLabel)] })
  if (modelLabel) segments.push({ action: "model", chunks: [stFg(theme.textMuted)(modelLabel)] })
  if (segments.length === 0) return { chunks: [], controls: [] }
  const joined: TextChunk[] = [stFg(theme.border)(" ")]
  const controls: ComposerBorderControl[] = []
  let offset = 1
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      joined.push(stFg(theme.border)(" · "))
      offset += 3
    }
    if (segment.action) controls.push({ action: segment.action, label: "topRight", offset, chunks: segment.chunks })
    joined.push(...segment.chunks)
    offset += chunksLength(segment.chunks)
  }
  joined.push(stFg(theme.border)(" "))
  return { chunks: joined, controls }
}

function promptHintsDisplay(theme: TuiTheme, layout: ComposerBorderLayout) {
  if (layout.hints.length === 0) return { chunks: [], controls: [] }
  const chunks: TextChunk[] = [stFg(theme.border)(" ")]
  const controls: ComposerBorderControl[] = []
  let offset = 1
  for (const [index, hint] of layout.hints.entries()) {
    const separator = keyHintSeparatorBefore(layout.hints, index)
    if (separator) {
      const separatorChunk = stFg(theme.border)(separator)
      chunks.push(separatorChunk)
      offset += chunksLength([separatorChunk])
    }
    const text = keyHintPlainText([hint])
    const hintChunks = [stFg(theme.textMuted)(text)]
    const action = hint === layout.sessionsClickHint
      ? "sessions"
      : hint.label === "new"
        ? "new"
        : hint.label === "close tab"
          ? "close"
          : hint.label === "switch"
            ? "switch"
            : hint.label === "resume"
              ? "resume"
              : undefined
    if (action) controls.push({ action, label: "bottomRight", offset, chunks: hintChunks })
    chunks.push(...hintChunks)
    offset += chunksLength(hintChunks)
  }
  chunks.push(stFg(theme.border)(" "))
  return { chunks, controls }
}

export function createPromptBorderChunks(deps: PromptBorderChunksDeps) {
  const topRight = createMemo(() => promptTopRightLabel(deps.theme, deps.layout()))
  const bottomRightPlainText = createMemo(() => keyHintPlainText(deps.layout().hints))
  const bottomRightLabelWidth = createMemo(() => bottomRightPlainText() ? bottomRightPlainText().length + 2 : 0)
  const statusMaxWidth = createMemo(() => Math.max(0, deps.lineWidth() - bottomRightLabelWidth() - 4))
  const topRightChunks = () => topRight().chunks
  const bottomLeft = createPromptStatusDisplay({ theme: deps.theme, status: deps.status, idle: deps.idle, maxWidth: statusMaxWidth })
  const bottomLeftChunks = () => bottomLeft().chunks
  const bottomRight = createMemo(() => promptHintsDisplay(deps.theme, deps.layout()))
  const bottomRightChunks = () => bottomRight().chunks
  const controls = createMemo(() => [...topRight().controls, ...bottomLeft().controls, ...bottomRight().controls])
  return {
    topRightChunks,
    bottomLeftChunks,
    bottomRightChunks,
    controls,
  }
}
