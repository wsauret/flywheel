import { RGBA, StyledText, fg as stFg, type TextChunk } from "@opentui/core"
import { blendToward } from "../context/theme/color-contrast.js"
import type { TuiTheme } from "../context/theme/resolve.js"

export const MODEL_MODAL_COST_COLUMN_WIDTH = 17
const COST_MARKER = "●"
const COST_BAR_SEGMENT = "━"

export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
}

export function modelModalContentWidth(modalWidth: number): number {
  return Math.max(24, modalWidth - 14)
}

export function costGradient(theme: TuiTheme, width: number): RGBA[] {
  if (width <= 0) return []
  const stops = [theme.success, theme.info, theme.primary, theme.error] as const
  if (width === 1) return [stops[0]]
  return Array.from({ length: width }, (_, index) => {
    const position = index / (width - 1)
    if (position <= 1 / 3) return blendToward(stops[0], stops[1], position * 3)
    if (position <= 2 / 3) return blendToward(stops[1], stops[2], position * 3 - 1)
    return blendToward(stops[2], stops[3], position * 3 - 2)
  })
}

export function costMarker(value: number | undefined, minimum: number, maximum: number, width: number): number | undefined {
  if (value === undefined || value <= 0 || minimum <= 0 || maximum <= 0 || width <= 0) return undefined
  if (width === 1) return 0
  if (minimum === maximum) return Math.floor((width - 1) / 2)
  const position = (Math.log(value) - Math.log(minimum)) / (Math.log(maximum) - Math.log(minimum))
  return Math.round(Math.max(0, Math.min(1, position)) * (width - 1))
}

export function costBarText(value: number | undefined, prices: readonly number[], theme: TuiTheme, width: number): StyledText {
  const available = prices.filter((price) => Number.isFinite(price) && price > 0)
  if (available.length === 0 || width <= 0) return new StyledText([])
  const marker = costMarker(value, Math.min(...available), Math.max(...available), width)
  const colors = costGradient(theme, width)
  const white = RGBA.fromInts(255, 255, 255)
  return new StyledText(colors.map((color, index) =>
    stFg(index === marker ? white : color)(index === marker ? COST_MARKER : COST_BAR_SEGMENT),
  ))
}

export function priceHeaderText(theme: TuiTheme): StyledText {
  return styledColumns(["Input", "Cached input", "Output"], theme.textMuted)
}

export function priceValueText(cost: ModelPrice | undefined, theme: TuiTheme): StyledText {
  if (!cost) return new StyledText([stFg(theme.textMuted)("Pricing unavailable")])
  const values = [perMillion(cost.input), cost.cacheRead === undefined ? "n/a" : perMillion(cost.cacheRead), perMillion(cost.output)]
  return styledColumns(values, theme.text)
}

function perMillion(value: number): string {
  const dollars = value === 0 || Number.isInteger(value) ? `$${value}` : `$${value.toFixed(value < 0.01 ? 4 : 2)}`
  return `${dollars} / 1M`
}

function styledColumns(values: readonly string[], color: RGBA): StyledText {
  const chunks: TextChunk[] = values.map((value) => stFg(color)(value.padEnd(MODEL_MODAL_COST_COLUMN_WIDTH)))
  return new StyledText(chunks)
}
