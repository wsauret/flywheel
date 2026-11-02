/** Terminal-derived colors with surface-specific lightness and capped source chroma. */
import { RGBA } from "@opentui/core"
import { okhslToRgb, rgbToOkhsl, oklabToOkhslLightness, type RgbColor } from "./oklab.js"
import { rgbToOklch, oklchToRgb } from "./oklch.js"
import { contrastRatio, rgbContrastRatio as wcagContrast, correctContrast, TEXT_MINIMUM_CONTRAST } from "./color-contrast.js"
import { readableTheme } from "./readable-theme.js"
import { resolveTheme, type TuiTheme } from "./resolve.js"
import { workflowNameColors } from "./name-colors.js"
import fallback from "./flywheel.json" with { type: "json" }
import lightFallback from "./github.json" with { type: "json" }

type ThemeAppearance = "dark" | "light"
type OkhslChannels = ReturnType<typeof rgbToOkhsl>
interface Family {
  hue: number
  saturation: { min: number; max: number }
  /** ANSI palette slot the family takes its hue and saturation from. */
  slot: number
}
type FamilyName = "neutral" | "blue" | "green" | "red" | "yellow" | "violet" | "calamine"
type Families = { [Name in FamilyName]: Family }

const FAMILIES = {
  neutral: { hue: 231.49, saturation: { min: 0.02, max: 0.08 }, slot: 8 },
  blue: { hue: 231.49, saturation: { min: 0.1, max: 0.68 }, slot: 4 },
  green: { hue: 158.68, saturation: { min: 0.1, max: 0.76 }, slot: 2 },
  red: { hue: 20, saturation: { min: 0.1, max: 0.92 }, slot: 1 },
  yellow: { hue: 82.36, saturation: { min: 0.5, max: 1 }, slot: 3 },
  violet: { hue: 295, saturation: { min: 0.2, max: 0.6 }, slot: 5 },
  calamine: { hue: 202.43, saturation: { min: 0.1, max: 0.74 }, slot: 6 },
} satisfies Families

type ThemeToken = Exclude<keyof TuiTheme, "thinkingOpacity" | "background" | "textBright" | "selectionBackground" | "selectionForeground" | "phaseName" | "agentName">
type TokenFamilies = { [Token in ThemeToken]: FamilyName }
const TOKEN_FAMILIES = {
  backgroundRaised: "neutral",
  backgroundPanel: "neutral",
  backgroundElement: "blue",
  backgroundMenu: "neutral",
  diffAddedBg: "green",
  diffRemovedBg: "red",
  diffContextBg: "neutral",
  diffAddedLineNumberBg: "green",
  diffRemovedLineNumberBg: "red",
  primary: "blue",
  primaryBright: "blue",
  secondary: "violet",
  sessionMessage: "calamine",
  accent: "calamine",
  error: "red",
  warning: "yellow",
  success: "green",
  info: "blue",
  text: "neutral",
  textMuted: "neutral",
  textSubtle: "neutral",
  selectedListItemText: "neutral",
  border: "neutral",
  borderActive: "blue",
  borderSubtle: "neutral",
  diffAdded: "green",
  diffRemoved: "red",
  diffContext: "neutral",
  diffHunkHeader: "calamine",
  diffHighlightAdded: "green",
  diffHighlightRemoved: "red",
  diffLineNumber: "neutral",
  markdownText: "neutral",
  markdownHeading: "violet",
  markdownLink: "blue",
  markdownLinkText: "calamine",
  markdownCode: "green",
  markdownBlockQuote: "neutral",
  markdownEmph: "yellow",
  markdownStrong: "yellow",
  markdownHorizontalRule: "neutral",
  markdownListItem: "blue",
  markdownListEnumeration: "calamine",
  markdownImage: "blue",
  markdownImageText: "calamine",
  markdownCodeBlock: "neutral",
  chatCodeComment: "neutral",
  chatCodeKeyword: "violet",
  chatCodeFunction: "blue",
  chatCodeVariable: "red",
  chatCodeString: "green",
  chatCodeNumber: "yellow",
  chatCodeType: "yellow",
  chatCodeOperator: "calamine",
  chatCodePunctuation: "neutral",
} satisfies TokenFamilies
interface Curve { coefficients: number[]; reachable: [number, number] }
type Level = "panel" | "track" | "subtle" | "readable" | "emphasis" | "text"
type LevelCurves = { [Name in Level]: { [Appearance in ThemeAppearance]: Curve } }
const LEVELS = {
  panel: {
    dark: { coefficients: [0.29131, -0.39746, 2.33185, -0.85524, -1.2076, 0.86276], reachable: [0, 0.979] },
    light: { coefficients: [-3.74073, 27.94549, -78.44258, 112.6798, -79.60015, 22.11277], reachable: [0.348, 1] },
  },
  track: {
    dark: { coefficients: [0.39028, -0.23015, 0.83573, 2.43829, -4.38292, 2.01582], reachable: [0, 0.946] },
    light: { coefficients: [-5.24921, 38.37322, -107.28833, 152.10005, -106.17127, 29.18061], reachable: [0.368, 1] },
  },
  subtle: {
    dark: { coefficients: [0.56762, -0.02475, -0.5383, 5.12628, -7.10931, 3.17324], reachable: [0, 0.848] },
    light: {
      coefficients: [-232.85459, 1376.54473, -3249.11801, 3827.91186, -2248.29472, 526.55751],
      reachable: [0.657, 1],
    },
  },
  readable: {
    dark: { coefficients: [0.66937, 0.04704, -1.06871, 6.43941, -8.9332, 4.17229], reachable: [0, 0.77] },
    light: {
      coefficients: [-1554.52576, 8733.56817, -19604.93507, 21977.72696, -12300.99599, 2749.81288],
      reachable: [0.751, 1],
    },
  },
  emphasis: {
    dark: { coefficients: [0.7303, 0.07695, -1.31626, 7.1681, -10.14436, 4.92846], reachable: [0, 0.712] },
    light: {
      coefficients: [-4948.31942, 26870.91986, -58334.48399, 63280.17197, -34298.01053, 7430.30146],
      reachable: [0.811, 1],
    },
  },
  text: {
    dark: { coefficients: [0.89242, 0.02311, -0.44862, 2.34417, -0.06084, -2.63844], reachable: [0, 0.5] },
    light: {
      coefficients: [-2004.67048, 6664.47299, -6060.70202, -1792.61209, 5133.82359, -1939.85583],
      reachable: [0.894, 1],
    },
  },
} satisfies LevelCurves

type Surface = ThemeToken | "background"
interface Rule { token: ThemeToken; on: Surface[]; level: Level }
const PANELS: ThemeToken[] = ["backgroundRaised", "backgroundPanel", "backgroundElement", "backgroundMenu", "diffAddedBg", "diffRemovedBg", "diffContextBg", "diffAddedLineNumberBg", "diffRemovedLineNumberBg"]
const TEXT_SURFACES: Surface[] = ["background", ...PANELS]
const BORDER_TOKENS: ThemeToken[] = ["border", "borderActive", "borderSubtle"]
const FOREGROUND_TOKENS: ThemeToken[] = ["text", "markdownText", "markdownCodeBlock", "selectedListItemText"]
const MUTED_TOKENS: ThemeToken[] = ["textMuted", "chatCodeComment", "diffContext", "diffLineNumber", "markdownBlockQuote", "markdownHorizontalRule", "chatCodePunctuation"]
const each = (tokens: ThemeToken[], on: Surface[], level: Level): Rule[] => tokens.map(token => ({ token, on, level }))
const RULES: Rule[] = [
 ...each(PANELS, ["background"], "panel"),
 ...each(BORDER_TOKENS, ["background"], "track"),
 ...each(FOREGROUND_TOKENS, TEXT_SURFACES, "text"),
 ...each(["textSubtle", "chatCodeComment"], TEXT_SURFACES, "subtle"),
 ...each(["primaryBright"], TEXT_SURFACES, "emphasis"),
 ...each(["primary","secondary","sessionMessage","accent","error","warning","success","info","textMuted","diffAdded","diffRemoved","diffContext","diffHunkHeader","diffHighlightAdded","diffHighlightRemoved","diffLineNumber","markdownHeading","markdownLink","markdownLinkText","markdownCode","markdownBlockQuote","markdownEmph","markdownStrong","markdownHorizontalRule","markdownListItem","markdownListEnumeration","markdownImage","markdownImageText","chatCodeKeyword","chatCodeFunction","chatCodeVariable","chatCodeString","chatCodeNumber","chatCodeType","chatCodeOperator","chatCodePunctuation"], TEXT_SURFACES, "readable"),
]
const READABLE_FLOOR = { dark: "readable", light: "subtle" } satisfies { [Appearance in ThemeAppearance]: Level }
const SOLVE_ORDER: ThemeToken[] = (() => {
  const order: ThemeToken[] = []
  const visit = (token: ThemeToken): void => {
    if (order.includes(token)) return
    for (const rule of RULES) {
      if (rule.token !== token) continue
      for (const surface of rule.on) if (surface !== "background") visit(surface)
    }
    order.push(token)
  }
  for (const rule of RULES) visit(rule.token)
  return order
})()

/** Canonical sRGB channels are 0..255. When supplied, the trusted palette contains all 16 ANSI slots. */
export interface SystemThemeInput {
  foreground?: RgbColor
  background?: RgbColor
  palette?: readonly RgbColor[]
  appearanceHint?: ThemeAppearance
}
interface SystemThemeResult { theme: TuiTheme; mode: ThemeAppearance }
/** OKLab lightness of an sRGB color, 0-1. */
function oklabLightness(color: RgbColor): number {
  return rgbToOklch(color).l
}

/**
 * Whether a terminal is dark or light, from its reported colors: the direction of its own foreground
 * when text can be readable that way, otherwise dark when white text has more contrast on the
 * background than black text.
 */
function terminalAppearance(background: RgbColor, foreground?: RgbColor): ThemeAppearance {
  const white = { r: 255, g: 255, b: 255 }
  const black = { r: 0, g: 0, b: 0 }
  const whiteContrast = wcagContrast(white, background)
  const blackContrast = wcagContrast(black, background)
  if (foreground) {
    const foregroundL = oklabLightness(foreground)
    const backgroundL = oklabLightness(background)
    if (Math.abs(foregroundL - backgroundL) > 0.05) {
      const appearance = foregroundL > backgroundL ? "dark" : "light"
      const best = appearance === "dark" ? whiteContrast : blackContrast
      if (best >= TEXT_MINIMUM_CONTRAST) return appearance
    }
  }
  return whiteContrast >= blackContrast ? "dark" : "light"
}

/** Saturation weight at a lightness: a Gaussian (center 0.5, sigma 0.25), 0 at black and white, 1 in the middle. */
function bellWeight(lightness: number): number {
  const gaussian = (x: number): number => Math.exp(-((x - 0.5) ** 2) / (2 * 0.25 ** 2))
  return (gaussian(lightness) - gaussian(0)) / (1 - gaussian(0))
}

/** A family's saturation curve relative to its maximum: 1 at mid lightness, `min / max` at black and white. */
function saturationCurve({ saturation: { min, max } }: Family, lightness: number): number {
  const floor = max > 0 ? min / max : 1
  return floor + (1 - floor) * bellWeight(lightness)
}

/** The target lightness for a level on a surface, or undefined where the level cannot be reached. */
function levelTarget(level: Level, appearance: ThemeAppearance, surfaceL: number): number | undefined {
  const curve: Curve = LEVELS[level][appearance]
  if (surfaceL < curve.reachable[0] || surfaceL > curve.reachable[1]) return undefined
  return curve.coefficients.reduce((sum, coefficient, power) => sum + coefficient * surfaceL ** power, 0)
}

/** Resolve synchronously without terminal I/O. Missing background uses the existing named fallback and hint.
 * Generated text reaches nominal 4.5:1 on its surfaces; deliberate terminal dimming is outside this guarantee.
 * A readable reported foreground is unchanged. Neutral secondary text cannot outrank the corrected body.
 */
export function generateSystemTheme(input: SystemThemeInput): SystemThemeResult {
  const { background, foreground } = input
  if (!background) {
    const mode = input.appearanceHint ?? "dark"
    return { theme: resolveTheme(mode === "light" ? lightFallback : fallback, mode), mode }
  }
  const palette = input.palette?.map(sourceOf)

  const appearance = terminalAppearance(background, foreground)
  const lighter = appearance === "dark"
  const extreme = lighter ? 1 : 0

  /**
   * A token's color at an OKLab lightness. With a palette, the palette color's saturation applies at its
   * own lightness and falls off toward black and white along the family's curve, never rising above it.
   */
  const paint = (token: ThemeToken, oklabL: number): RgbColor => {
    const lightness = oklabToOkhslLightness(oklabL)
    const family: Family = FAMILIES[TOKEN_FAMILIES[token]]
    if (!palette) {
      const { min, max } = family.saturation
      return okhslToRgb(family.hue, min + (max - min) * bellWeight(lightness), lightness)
    }
    const source = palette[family.slot]
    // SAFETY: The canonical palette has 16 slots; every family slot is within 0..15.
    return anchored(source!, family, lightness)
  }

  /**
   * The lightness a rule needs on a surface, relaxed by `t`: from 0 to 1, levels stronger than the readable
   * floor move toward it; from 1 to 2, all levels move toward the surface itself.
   */
  const target = (level: Level, surfaceL: number, t: number): number | undefined => {
    const reached = levelTarget(level, appearance, surfaceL)
    if (reached === undefined && t === 0) return undefined
    const distance = (reached ?? extreme) - surfaceL
    const floor = (levelTarget(READABLE_FLOOR[appearance], appearance, surfaceL) ?? extreme) - surfaceL
    const compressed =
      Math.abs(distance) > Math.abs(floor) ? distance - (distance - floor) * Math.min(t, 1) : distance
    return surfaceL + compressed * (1 - Math.max(0, t - 1))
  }

  /**
   * Keep a panel light enough (or dark enough) that white (or black) text still reaches the body text
   * minimum on it. This only matters for backgrounds near mid-gray, where it barely does on the background.
   */
  const extremeText = lighter ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 }
  const readable = (color: RgbColor) => wcagContrast(extremeText, color) >= TEXT_MINIMUM_CONTRAST
  const limitPanel = (token: ThemeToken, l: number): RgbColor => {
    const color = paint(token, l)
    if (readable(color)) return color
    // A palette hue at the ground's OKLab lightness can have less WCAG contrast than the ground.
    // Start at the ground pole so the readable endpoint remains valid for every palette hue.
    let [low, high] = [lighter ? 0 : 1, l]
    for (let index = 0; index < 20; index++) {
      const middle = (low + high) / 2
      if (readable(paint(token, middle))) low = middle
      else high = middle
    }
    return paint(token, low)
  }

  const solve = (t: number): Map<Surface | ThemeToken, RgbColor> | undefined => {
    const colors = new Map<Surface | ThemeToken, RgbColor>([["background", background]])
    for (const token of SOLVE_ORDER) {
      const targets: number[] = []
      for (const rule of RULES) {
        if (rule.token !== token) continue
        for (const surface of rule.on) {
          // SAFETY: SOLVE_ORDER visits each rule's surfaces first; background is seeded above.
          const value = target(rule.level, oklabLightness(colors.get(surface)!), t)
          if (value === undefined || value < 0 || value > 1) return undefined
          targets.push(value)
        }
      }
      const l = lighter ? Math.max(...targets) : Math.min(...targets)
      colors.set(token, PANELS.includes(token) ? limitPanel(token, l) : paint(token, l))
    }
    return colors
  }

  let colors = solve(0)
  if (!colors) {
    // Mid-gray backgrounds cannot fit every level: relax as little as possible. Full relaxation always fits.
    let [low, high] = [0, 2]
    colors = solve(high)
    for (let index = 0; index < 20; index++) {
      const middle = (low + high) / 2
      const attempt = solve(middle)
      if (attempt) [high, colors] = [middle, attempt]
      else low = middle
    }
  }
  // SAFETY: solve(2) targets each seeded or dependency-ordered surface's own lightness, which is within 0..1.
  const solved = colors!
  const surfacesOf = (token: ThemeToken) =>
    RULES.filter((rule) => rule.token === token).flatMap((rule) =>
      rule.on.map((surface) => {
        // SAFETY: SOLVE_ORDER has populated every rule surface in the completed solve.
        return solved.get(surface)!
      }),
    )

  for (const token of SOLVE_ORDER) {
    const surfaces = surfacesOf(token)
    const family = FAMILIES[TOKEN_FAMILIES[token]]
    // SAFETY: The completed solve populates every token in SOLVE_ORDER.
    let color = solved.get(token)!
    const source = FOREGROUND_TOKENS.includes(token) && foreground ? sourceOf(foreground) : palette?.[family.slot]
    if (FOREGROUND_TOKENS.includes(token) && foreground) color = foreground
    if (!PANELS.includes(token) && !BORDER_TOKENS.includes(token)) {
      color = withTextContrast(color, surfaces, lighter, source, family)
    }
    solved.set(token, color)
  }
  // SAFETY: text is in SOLVE_ORDER and has received its final all-surface contrast correction.
  let body = solved.get("text")!
  // SAFETY: textMuted is in SOLVE_ORDER and has received its all-surface contrast correction.
  const neutralSource = palette?.[FAMILIES.neutral.slot] ?? sourceOf(solved.get("textMuted")!)
  const minimumNeutral = withTextContrast(
    anchored(neutralSource, FAMILIES.neutral, lighter ? 0 : 1),
    surfacesOf("textMuted"), lighter, neutralSource, FAMILIES.neutral,
  )
  const bodySurfaces = surfacesOf("text")
  const reportedForegroundIsReadable = foreground &&
    bodySurfaces.every(surface => wcagContrast(foreground, surface) >= TEXT_MINIMUM_CONTRAST)
  if (!reportedForegroundIsReadable) {
    // Solarized's least valid neutral RGB step can exceed the corrected body's luminance.
    // Only an already-unreadable foreground can receive this additional minimum correction.
    body = withTextContrast(
      body, bodySurfaces, lighter, foreground ? sourceOf(foreground) : palette?.[FAMILIES.neutral.slot],
      FAMILIES.neutral, minimumNeutral,
    )
    for (const token of FOREGROUND_TOKENS) solved.set(token, body)
  }
  const boundNeutral = (token: ThemeToken, candidate: RgbColor): RgbColor => {
    const surfaces = surfacesOf(token)
    const belowBody = (value: RgbColor) =>
      surfaces.every(surface => wcagContrast(value, surface) <= wcagContrast(body, surface))
    if (belowBody(candidate)) return candidate
    const family = FAMILIES[TOKEN_FAMILIES[token]]
    // Solarized's readable reported foreground can be weaker than the neutral level curve.
    // Find a readable lower endpoint, then retain as much of the muted target as body contrast permits.
    let color = minimumNeutral
    let low = rgbToOkhsl(color).l
    let high = rgbToOkhsl(candidate).l
    for (let index = 0; index < 20; index++) {
      const middle = (low + high) / 2
      const value = anchored(neutralSource, family, middle)
      if (belowBody(value)) {
        low = middle
        color = value
      } else high = middle
    }
    return color
  }
  for (const token of MUTED_TOKENS) {
    // SAFETY: Every MUTED_TOKENS entry is solved and contrast-corrected by SOLVE_ORDER.
    solved.set(token, boundNeutral(token, solved.get(token)!))
  }
  // SAFETY: textMuted is a solved token, and its bounded correction is complete.
  const muted = solved.get("textMuted")!
  const subtle = paint("textSubtle", (oklabLightness(body) + oklabLightness(muted)) / 2)
  solved.set("textSubtle", boundNeutral("textSubtle", withTextContrast(
    subtle, surfacesOf("textSubtle"), lighter, palette?.[FAMILIES.neutral.slot], FAMILIES.neutral,
  )))
  const color = (token: ThemeToken): RGBA => {
    // SAFETY: TOKEN_FAMILIES and RULES cover every ThemeToken in the completed solve.
    const value = solved.get(token)!
    return RGBA.fromInts(value.r, value.g, value.b)
  }
  const primary = color("primary")
  const black = RGBA.fromInts(0, 0, 0)
  const white = RGBA.fromInts(255, 255, 255)
  const selectionForeground = contrastRatio(black, primary) >= TEXT_MINIMUM_CONTRAST ? black : white
  return { mode: appearance, theme: readableTheme({
      backgroundRaised: color("backgroundRaised"),
      backgroundPanel: color("backgroundPanel"),
      backgroundElement: color("backgroundElement"),
      backgroundMenu: color("backgroundMenu"),
      diffAddedBg: color("diffAddedBg"),
      diffRemovedBg: color("diffRemovedBg"),
      diffContextBg: color("diffContextBg"),
      diffAddedLineNumberBg: color("diffAddedLineNumberBg"),
      diffRemovedLineNumberBg: color("diffRemovedLineNumberBg"),
      primaryBright: color("primaryBright"),
      secondary: color("secondary"),
      sessionMessage: color("sessionMessage"),
      accent: color("accent"),
      ...workflowNameColors({ secondary: color("secondary"), accent: color("accent"), primary, success: color("success"), error: color("error"), warning: color("warning") }),
      error: color("error"),
      warning: color("warning"),
      success: color("success"),
      info: color("info"),
      text: color("text"),
      textMuted: color("textMuted"),
      textSubtle: color("textSubtle"),
      selectedListItemText: color("selectedListItemText"),
      border: color("border"),
      borderActive: color("borderActive"),
      borderSubtle: color("borderSubtle"),
      diffAdded: color("diffAdded"),
      diffRemoved: color("diffRemoved"),
      diffContext: color("diffContext"),
      diffHunkHeader: color("diffHunkHeader"),
      diffHighlightAdded: color("diffHighlightAdded"),
      diffHighlightRemoved: color("diffHighlightRemoved"),
      diffLineNumber: color("diffLineNumber"),
      markdownText: color("markdownText"),
      markdownHeading: color("markdownHeading"),
      markdownLink: color("markdownLink"),
      markdownLinkText: color("markdownLinkText"),
      markdownCode: color("markdownCode"),
      markdownBlockQuote: color("markdownBlockQuote"),
      markdownEmph: color("markdownEmph"),
      markdownStrong: color("markdownStrong"),
      markdownHorizontalRule: color("markdownHorizontalRule"),
      markdownListItem: color("markdownListItem"),
      markdownListEnumeration: color("markdownListEnumeration"),
      markdownImage: color("markdownImage"),
      markdownImageText: color("markdownImageText"),
      markdownCodeBlock: color("markdownCodeBlock"),
      chatCodeComment: color("chatCodeComment"),
      chatCodeKeyword: color("chatCodeKeyword"),
      chatCodeFunction: color("chatCodeFunction"),
      chatCodeVariable: color("chatCodeVariable"),
      chatCodeString: color("chatCodeString"),
      chatCodeNumber: color("chatCodeNumber"),
      chatCodeType: color("chatCodeType"),
      chatCodeOperator: color("chatCodeOperator"),
      chatCodePunctuation: color("chatCodePunctuation"),
    primary,
    background: RGBA.fromInts(background.r, background.g, background.b),
    textBright: lighter ? white : black,
    selectionBackground: primary,
    selectionForeground,
    thinkingOpacity: 0.6,
 }, { preserveReportedBody: Boolean(reportedForegroundIsReadable) }) }
}

/** A terminal color's OKHSL channels and its OKLCH chroma. */
interface SourceColor extends OkhslChannels {
  chroma: number
}

function sourceOf(color: RgbColor): SourceColor {
  return { ...rgbToOkhsl(color), chroma: rgbToOklch(color).c }
}

/**
 * A source color's hue at another OKHSL lightness. Its saturation applies at its own lightness and falls off
 * toward black and white along the family's saturation curve, never rising above it.
 *
 * OKHSL saturation is relative to the most chroma sRGB allows at a lightness, so the same saturation can mean
 * more chroma elsewhere: Catppuccin Frappe's pink #f4b8e4 (chroma 0.089) would become #eb76d1 (0.180) at the
 * lightness the accent needs. Chroma is therefore also capped at the source's, with the same falloff.
 */
function anchored(source: SourceColor, family: Family, lightness: number): RgbColor {
  const anchor = saturationCurve(family, source.l)
  const falloff = anchor > 0 ? Math.min(1, saturationCurve(family, lightness) / anchor) : 1
  const color = okhslToRgb(source.h, source.s * falloff, lightness)
  const cap = source.chroma * falloff
  const { l, c } = rgbToOklch(color)
  return c <= cap ? color : oklchToRgb({ l, c: cap, h: source.h })
}

/** Move toward white or black until every surface meets 4.5:1 and, when supplied, the minimum reference contrast. */
function withTextContrast(color: RgbColor, surfaces: RgbColor[], lighter: boolean, source: SourceColor | undefined, family: Family, minimum?: RgbColor): RgbColor {
  const meets = (candidate: RgbColor) =>
    surfaces.every((surface) => wcagContrast(candidate, surface) >= Math.max(
      TEXT_MINIMUM_CONTRAST, minimum ? wcagContrast(minimum, surface) : TEXT_MINIMUM_CONTRAST,
    ))
  const { l } = rgbToOkhsl(color)
  // WCAG correction must retain the same source cap as the curve solver.
  const anchor = source ?? sourceOf(color)
  const at = (lightness: number) => anchored(anchor, family, lightness)
  const extreme = lighter ? 1 : 0
  return correctContrast(color, meets, at, l, extreme)
}

