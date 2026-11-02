import { StyledText, bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve"
import stringWidth from "string-width"
import { truncateToWidth } from "../utils/text.js"
import type { ModelAssignmentRow, ModelOptionRow, ModelSelectionEffort } from "../../protocol/model-assignment-protocol-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { isModelTierReference } from "../../protocol/model-tier-reference.js"
import { EFFORT_VALUES } from "../../infra/workflow-types.js"

export function modelAssignmentText(row: ModelAssignmentRow, selected: boolean, theme: TuiTheme, labelWidth: number, width: number, labelStyle: "plain" | "heading" = "plain", auth?: RuntimeAuthView): StyledText {
  const headingLabel = labelStyle === "heading"
  // Tiers are config vocabulary, never display vocabulary. A row that resolved
  // to a tier ref means no provider listing existed, so the row names the
  // missing precondition instead; effort and source suffixes would read as if
  // a real model were assigned, so they are suppressed with it.
  const unresolved = isModelTierReference(row.model)
  const sourceLabel = unresolved || !row.matchesInheritedPair ? "" : " ↳"
  const model = unresolved ? unresolvedAssignmentLabel(auth) : row.model
  const effortSuffix = unresolved ? "" : ` ${effortDisplayLabel(row.effort)}`
  // Exact model identity affects capability and cost, so the assignment label yields space first.
  const fixedWidth = (headingLabel ? 2 : 3) /* cursor and field separators */ + stringWidth(effortSuffix) + stringWidth(sourceLabel)
  const fieldsWidth = Math.max(0, width - fixedWidth)
  const renderedLabelWidth = Math.min(labelWidth + (headingLabel ? 1 : 0), Math.max(0, fieldsWidth - stringWidth(model)))
  const renderedLabel = truncateToWidth(row.label, renderedLabelWidth)
  const labelText = `${headingLabel ? "" : " "}${renderedLabel}${" ".repeat(renderedLabelWidth - stringWidth(renderedLabel))}`
  const modelLabel = truncateToWidth(model, fieldsWidth - renderedLabelWidth)
  const chunks: TextChunk[] = [
    stFg(selected ? theme.primary : theme.textMuted)(selected ? ">" : " "),
    headingLabel ? stBold(stFg(theme.text)(labelText)) : stFg(theme.text)(labelText),
    stFg(theme.textSubtle)(` ${modelLabel}${effortSuffix}`),
  ]
  if (sourceLabel) chunks.push(stFg(theme.primary)(sourceLabel))
  return new StyledText(chunks)
}

/** One meter cell per effort level a model can support. */
const METER_CELLS = EFFORT_VALUES.length
const EFFORT_WORD_CELLS = 6
const METER_GLYPH = "■"
const MIN_LABEL_CELLS = 12

/** The shared label column of one picker list: the widest label, and the
 *  widest marker run any row appends. Sizing the label cell against the widest
 *  markers, not each row's own, keeps every meter in the same column. */
export interface ModelLabelColumn {
  readonly labelWidth: number
  readonly markersWidth: number
}

export function modelLabelColumn(rows: readonly ModelOptionRow[]): ModelLabelColumn {
  return {
    labelWidth: Math.max(MIN_LABEL_CELLS, ...rows.map((row) => stringWidth(modelOptionLabel(row)))),
    markersWidth: Math.max(0, ...rows.map((row) => stringWidth(rowMarkers(row).map((marker) => marker.text).join("")))),
  }
}

function modelOptionLabel(row: ModelOptionRow): string {
  return row.inherit ? `${row.label}${inheritDetail(row)}` : row.label
}

interface RowMarker {
  readonly text: string
  readonly tone: "textMuted" | "primary"
}

function rowMarkers(row: ModelOptionRow): RowMarker[] {
  const markers: RowMarker[] = []
  if (row.roleDefault) markers.push({ text: " default", tone: "textMuted" })
  if (row.current) markers.push({ text: " current", tone: "primary" })
  return markers
}

/** A picker row: cursor, label column, effort meter and word, then markers.
 *  Narrow rows omit the meter and markers to retain the name and effort word.
 *  A row that cannot be selected shows its reason instead of effort.
 *  Picker rows name the model only: the access provider is resolved
 *  from the family chain at request time, so it is not part of the choice. */
export function modelText(
  row: ModelOptionRow,
  selected: boolean,
  theme: TuiTheme,
  width: number,
  column = modelLabelColumn([row]),
  pendingEffort?: ModelSelectionEffort,
): StyledText {
  const reason = !row.selectable && row.reason ? row.reason : undefined
  const showsEffort = reason === undefined && row.efforts.length > 0
  const effort = pendingEffort ?? row.effort
  const effortColumnsWidth = showsEffort ? 2 + METER_CELLS + 2 + EFFORT_WORD_CELLS : 0
  const fullLabelCell = Math.max(0, Math.min(column.labelWidth, width - 2 /* cursor and leading space */ - effortColumnsWidth - column.markersWidth))
  const compact = fullLabelCell < MIN_LABEL_CELLS
  const markers = compact ? [] : rowMarkers(row).map((marker) => stFg(theme[marker.tone])(marker.text))
  // The refusal must keep space beside the name even when the badges yield.
  const reasonWidth = compact && reason ? Math.min(stringWidth(reason) + 1, Math.max(0, width - 2 - MIN_LABEL_CELLS)) : 0
  const labelCell = compact
    ? Math.max(0, Math.min(column.labelWidth, width - 2 - (showsEffort ? 1 + EFFORT_WORD_CELLS : 0) - reasonWidth))
    : fullLabelCell
  const label = labelChunks(row, labelCell, theme)
  const labelPad = labelCell - label.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
  const chunks: TextChunk[] = [
    stFg(selected ? theme.primary : theme.textMuted)(selected ? ">" : " "),
    stFg(theme.text)(" "),
    ...label,
    stFg(theme.text)(" ".repeat(labelPad)),
  ]
  if (showsEffort) {
    // The inherit row's effort belongs to the parent role, so it never takes
    // the selected emphasis: the arrows do not act on it.
    const emphasized = selected && !row.inherit
    if (!compact) {
      chunks.push(stFg(theme.text)("  "))
      chunks.push(...effortMeter(row, effort, emphasized, theme))
    }
    chunks.push(stFg(emphasized ? theme.primary : theme.textMuted)(`${compact ? " " : "  "}${effortDisplayLabel(effort).padEnd(EFFORT_WORD_CELLS)}`))
  }
  chunks.push(...markers)
  if (reason) {
    const usedWidth = chunks.reduce((total, chunk) => total + stringWidth(chunk.text), 0)
    const reasonText = truncateToWidth(` ${reason}`, width - usedWidth)
    if (reasonText) chunks.push(stFg(theme.warning)(reasonText))
  }
  return new StyledText(chunks)
}

function labelChunks(row: ModelOptionRow, labelCell: number, theme: TuiTheme): TextChunk[] {
  const label = truncateToWidth(row.label, labelCell)
  if (!row.inherit) return [stFg(row.selectable ? theme.text : theme.textMuted)(label)]
  return [
    stFg(theme.primary)(label),
    stFg(theme.textSubtle)(truncateToWidth(inheritDetail(row), labelCell - stringWidth(label))),
  ]
}

function inheritDetail(row: ModelOptionRow): string {
  return ` · ${row.inheritModel ?? ""}`
}

/** Same glyph for every level; only color says which levels are in use, as
 *  in the reference design. Filled cells are the levels up to and including
 *  the effort in force. */
function effortMeter(row: ModelOptionRow, effort: ModelSelectionEffort, emphasized: boolean, theme: TuiTheme): TextChunk[] {
  const filled = row.efforts.indexOf(effort) + 1
  const filledColor = !row.selectable ? theme.textSubtle : emphasized ? theme.primary : theme.textMuted
  return [
    stFg(filledColor)(METER_GLYPH.repeat(filled)),
    stFg(theme.textSubtle)(METER_GLYPH.repeat(row.efforts.length - filled) + " ".repeat(METER_CELLS - row.efforts.length)),
  ]
}

const EFFORT_DISPLAY_LABELS = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-high",
  max: "Max",
  ultra: "Ultra",
} satisfies { readonly [effort in ModelSelectionEffort]: string }

function effortDisplayLabel(effort: ModelSelectionEffort): string {
  return EFFORT_DISPLAY_LABELS[effort]
}

function unresolvedAssignmentLabel(auth: RuntimeAuthView | undefined): string {
  if (auth === undefined) return "checking provider models"
  const configured = auth.providers.filter((provider) => provider.group === "model" && provider.modelCapable && provider.configured)
  if (configured.length === 0) return "no provider connected"
  if (configured.some((provider) => provider.catalog === undefined)) return "checking provider models"
  if (configured.some((provider) => provider.catalog?.kind === "unavailable" && provider.catalog.reason === "authentication-invalid")) return "reconnect provider"
  return "provider models unavailable"
}

/** The highlighted model's providers by full name in resolution order, with the one that would serve now in the
 *  accent color. With no provider listed it says so. */
export function providerChainText(providers: ModelOptionRow["providers"], theme: TuiTheme): StyledText {
  const muted = stFg(theme.textMuted)
  if (providers.length === 0) return new StyledText([muted("Providers: None available")])
  return new StyledText([
    muted("Providers: "),
    ...providers.flatMap((provider, index) => [
      ...(index === 0 ? [] : [muted(" → ")]),
      (provider.serving ? stFg(theme.accent) : muted)(provider.name),
    ]),
  ])
}
