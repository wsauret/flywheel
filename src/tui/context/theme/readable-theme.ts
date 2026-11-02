import { RGBA } from "@opentui/core"
import { contrastRatio, correctContrast, TEXT_MINIMUM_CONTRAST } from "./color-contrast.js"
import { oklchToRgb, rgbToOklch } from "./oklch.js"
import type { TuiTheme } from "./resolve.js"

const UI_SURFACES = ["background", "backgroundRaised", "backgroundPanel", "backgroundElement", "backgroundMenu"] as const
const DIFF_SURFACES = ["diffAddedBg", "diffRemovedBg", "diffContextBg", "diffAddedLineNumberBg", "diffRemovedLineNumberBg"] as const
const BODY = ["text", "textBright", "markdownText", "markdownCodeBlock", "diffLineNumber"] as const
const LABELS = [
  "primary", "primaryBright", "secondary", "sessionMessage", "accent", "phaseName", "agentName", "error", "warning", "success", "info",
  "textMuted", "textSubtle", "selectedListItemText", "diffHunkHeader", "diffContext",
  "markdownHeading", "markdownLink", "markdownLinkText", "markdownCode", "markdownBlockQuote", "markdownEmph",
  "markdownStrong", "markdownHorizontalRule", "markdownListItem", "markdownListEnumeration", "markdownImage", "markdownImageText",
  "chatCodeComment", "chatCodeKeyword", "chatCodeFunction", "chatCodeVariable", "chatCodeString",
  "chatCodeNumber", "chatCodeType", "chatCodeOperator", "chatCodePunctuation",
] as const
// About the ground-to-element step of mercury and peach light, the subtlest bundled steps
// that still read as a highlight. Hover and landing highlights paint the element fill, so a
// theme below this step shows none.
const ELEMENT_MINIMUM_LIGHTNESS_STEP = 0.03
const MUTED = ["textMuted", "chatCodeComment", "chatCodePunctuation", "markdownBlockQuote", "markdownHorizontalRule", "diffContext", "diffLineNumber"] as const
const BODY_HIERARCHY = ["text", "markdownText", "markdownCodeBlock", "selectedListItemText"] as const

interface ReadabilityOptions {
  hueSources?: TuiTheme
  preserveReportedBody?: boolean
}

function perceptual(color: RGBA) {
  return rgbToOklch({ r: color.r * 255, g: color.g * 255, b: color.b * 255 })
}

function paint(source: ReturnType<typeof perceptual>, l: number): RGBA {
  const rgb = oklchToRgb({ ...source, l })
  return RGBA.fromInts(Math.round(rgb.r), Math.round(rgb.g), Math.round(rgb.b))
}

function opaqueOn(color: RGBA, background: RGBA): RGBA {
  if (color.a === 1) return color
  return RGBA.fromInts(
    Math.round((color.r * color.a + background.r * (1 - color.a)) * 255),
    Math.round((color.g * color.a + background.g * (1 - color.a)) * 255),
    Math.round((color.b * color.a + background.b * (1 - color.a)) * 255),
  )
}

function correct(color: RGBA, surfaces: readonly [RGBA, ...RGBA[]], pole: 0 | 1, minimum?: RGBA, hueSource: RGBA = color, minimumFactor: 1 | 1.15 = 1): RGBA {
  // Cursor supplies translucent muted text and Cursor/Mercury supply translucent diff fills.
  // Resolve these against their ground once so contrast describes the rendered opaque color.
  const ground = surfaces[0]
  const opaque = opaqueOn(color, ground)
  const source = perceptual(opaqueOn(hueSource, ground))
  return correctContrast(opaque, candidate => surfaces.every(surface =>
    contrastRatio(candidate, surface) >= Math.max(TEXT_MINIMUM_CONTRAST, minimum ? minimumFactor * contrastRatio(minimum, surface) : 0)),
  l => paint(source, l), perceptual(opaque).l, pole)
}

/** Moves a fill until the eye can tell it from the ground, keeping its hue. It steps toward the
 *  text pole, the usual direction of a hover, unless that would leave pole text unreadable on it. */
function distinctFrom(ground: RGBA, fill: RGBA, pole: RGBA, direction: 0 | 1): RGBA {
  const groundLightness = perceptual(ground).l
  const source = perceptual(fill)
  const distinct = (candidate: RGBA) => Math.abs(perceptual(candidate).l - groundLightness) >= ELEMENT_MINIMUM_LIGHTNESS_STEP
  const towardPole = correctContrast(fill, distinct, l => paint(source, l), source.l, direction)
  if (contrastRatio(pole, towardPole) >= TEXT_MINIMUM_CONTRAST) return towardPole
  return correctContrast(fill, distinct, l => paint(source, l), source.l, direction === 1 ? 0 : 1)
}

/** The highest-contrast pole follows the rendered ground, not the mode label. */
export function textPole(background: RGBA): RGBA {
  const black = RGBA.fromInts(0, 0, 0)
  const white = RGBA.fromInts(255, 255, 255)
  return contrastRatio(white, background) >= contrastRatio(black, background) ? white : black
}

/**
 * Correct text on its rendered fills, preserving readable colors and the main ground.
 * Secondary fills move only when the text pole cannot reach the shared contrast floor;
 * the element fill also moves when it is too close to the ground to show a highlight.
 * Lightness corrections retain source hue and never increase source chroma.
 * Subdued construction uses the normal palette as its hue source to avoid repeated byte-rounding drift.
 * Body roles target 1.15 times semantic muted contrast. A readable terminal-reported body
 * takes priority over that preferred gap; preserving it never bypasses the contrast floor.
 */
export function readableTheme(original: TuiTheme, { hueSources = original, preserveReportedBody = false }: ReadabilityOptions = {}): TuiTheme {
  const theme = { ...original }
  const pole = textPole(theme.background)
  const direction = pole.r === 1 ? 1 : 0
  for (const key of [...UI_SURFACES, ...DIFF_SURFACES]) {
    if (key !== "background") theme[key] = correct(opaqueOn(theme[key], theme.background), [pole], direction === 1 ? 0 : 1)
  }
  theme.backgroundElement = distinctFrom(theme.background, theme.backgroundElement, pole, direction)
  const ui: [RGBA, ...RGBA[]] = [theme.background, ...UI_SURFACES.slice(1).map(key => theme[key])]
  const all: [RGBA, ...RGBA[]] = [...ui, ...DIFF_SURFACES.map(key => theme[key])]
  for (const key of BODY) theme[key] = correct(theme[key], all, direction, undefined, hueSources[key])
  for (const key of LABELS) theme[key] = correct(theme[key], ui, direction, undefined, hueSources[key])
  theme.diffContext = correct(theme.diffContext, [...ui, theme.diffContextBg], direction)
  theme.diffAdded = correct(theme.diffAdded, [theme.diffAddedBg], direction)
  theme.diffRemoved = correct(theme.diffRemoved, [theme.diffRemovedBg], direction)
  for (const key of ["diffHighlightAdded", "diffHighlightRemoved"] as const) {
    theme[key] = correct(theme[key], [theme.background], direction)
  }
  // Byte RGB can place two nearest readable steps in the wrong hierarchy.
  theme.textSubtle = correct(theme.textSubtle, ui, direction, theme.textMuted, hueSources.textSubtle)
  for (const key of [...MUTED, "textSubtle"] as const) {
    for (const body of BODY_HIERARCHY) {
      theme[body] = correct(theme[body], all, direction, theme[key], hueSources[body])
    }
  }
  if (!preserveReportedBody) {
    for (const body of BODY_HIERARCHY) {
      theme[body] = correct(theme[body], ui, direction, theme.textMuted, hueSources[body], 1.15)
    }
  }
  return theme
}

/** An opaque, readable subdued view. Fills and non-text decoration remain unchanged. */
export function subduedTheme(theme: TuiTheme): Readonly<TuiTheme> {
  const subdued = { ...theme }
  const ground = perceptual(theme.background).l
  for (const key of [...BODY, ...LABELS, "diffAdded", "diffRemoved"] as const) {
    const source = perceptual(theme[key])
    subdued[key] = paint(source, ground + (source.l - ground) * theme.thinkingOpacity)
  }
  return readableTheme(subdued, { hueSources: theme })
}
