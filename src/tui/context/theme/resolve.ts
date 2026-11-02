import { RGBA } from "@opentui/core"
import { Log } from "../../../infra/log.js"
import { blendToward, contrastRatio } from "./color-contrast.js"
import { workflowNameColors } from "./name-colors.js"
import { readableTheme, textPole } from "./readable-theme.js"

type ComputedKeys = "primaryBright" | "textBright" | "backgroundRaised" | "selectionBackground" | "selectionForeground" | "sessionMessage" | "phaseName" | "agentName"
type OptionalKeys = "textSubtle" | "selectedListItemText" | "backgroundMenu"

export type TuiTheme = {
  primary: RGBA
  /** Hover-state step of `primary`: blended toward the ground's salient pole so
   *  glyph affordances (chevrons) visibly light up, since bold alone is
   *  invisible on symbols in most terminal fonts. */
  primaryBright: RGBA
  /** Hover-state step of `text`: the ground's full-contrast pole (white on dark,
   *  black on light), used to light up clickable header text under the mouse. */
  textBright: RGBA
  secondary: RGBA
  /** Resolver-derived bar and header color of a message that another
   *  session sent. The person's own messages use `secondary`, so this color
   *  must read as a different hue: `info`, or, where a theme's `info` is
   *  close in hue to its `secondary`, the farther of `accent` and `primary`. */
  sessionMessage: RGBA
  accent: RGBA
  /** Resolver-derived colour of a phase's name on every workflow surface,
   *  from {@link workflowNameColors}: `secondary`, unless its hue reads as a
   *  state of an agent. */
  phaseName: RGBA
  /** Resolver-derived colour of an agent's name on every workflow surface:
   *  `accent`, unless its hue reads as a state or as `phaseName`. */
  agentName: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  textSubtle: RGBA
  selectedListItemText: RGBA
  selectionBackground: RGBA
  selectionForeground: RGBA
  background: RGBA
  /** Resolver-derived elevated surface: `background` lifted a few percent
   *  toward `text`, so raised input surfaces (question dock, slash popup)
   *  read as subtly elevated in every theme. `backgroundPanel` varies too
   *  much across theme files to serve this role. */
  backgroundRaised: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  backgroundMenu: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  diffAdded: RGBA
  diffRemoved: RGBA
  diffContext: RGBA
  diffHunkHeader: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffContextBg: RGBA
  diffLineNumber: RGBA
  diffAddedLineNumberBg: RGBA
  diffRemovedLineNumberBg: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  chatCodeComment: RGBA
  chatCodeKeyword: RGBA
  chatCodeFunction: RGBA
  chatCodeVariable: RGBA
  chatCodeString: RGBA
  chatCodeNumber: RGBA
  chatCodeType: RGBA
  chatCodeOperator: RGBA
  chatCodePunctuation: RGBA
  thinkingOpacity: number
}

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA

const log = Log.create({ service: "theme" })

// App chrome borders are resolver-owned so low-contrast theme files cannot make
// prompt frames, separators, or dividers disappear.
const GLOBAL_BORDER = {
  dark: RGBA.fromHex("#e5e9f0"),
  light: RGBA.fromHex("#2e3440"),
}
const GLOBAL_BORDER_SUBTLE = {
  dark: RGBA.fromHex("#8b95a7"),
  light: RGBA.fromHex("#4c566a"),
}


// ── Style modifiers ──
// Per-element text modifiers that themes can override. Keys with a parent in
// STYLE_INHERITANCE inherit the parent's override when not set individually.

type StyleModifiers = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strikethrough?: boolean
}

const STYLE_KEYS = [
  "heading", "heading1", "heading2", "heading3", "heading4", "heading5", "heading6",
  "strong", "emphasis", "blockquote",
  "link", "linkLabel", "inlineCode", "strikethrough",
  "chatCodeComment", "chatCodeKeyword", "chatCodeKeywordType",
] as const

type StyleKey = (typeof STYLE_KEYS)[number]
export type ThemeStyles = { [K in StyleKey]: StyleModifiers }

const STYLE_INHERITANCE = {
  heading1: "heading",
  heading2: "heading",
  heading3: "heading",
  heading4: "heading",
  heading5: "heading",
  heading6: "heading",
  chatCodeKeywordType: "chatCodeKeyword",
  linkLabel: "link",
} satisfies { [K in StyleKey]?: StyleKey }

const DEFAULT_STYLES: ThemeStyles = {
  heading:  { bold: true },
  heading1: { bold: true },
  heading2: { bold: true },
  heading3: { bold: true },
  heading4: { bold: true },
  heading5: { bold: true },
  heading6: { bold: true },
  strong:   { bold: true },
  emphasis: { italic: true },
  blockquote: { italic: true },
  link:      { underline: true },
  linkLabel: { underline: true },
  inlineCode: {},
  strikethrough: {},
  chatCodeComment:  { italic: true },
  chatCodeKeyword:  { italic: true },
  chatCodeKeywordType: { bold: true, italic: true },
}

export function resolveStyles(json: ThemeJson): ThemeStyles {
  const overrides = json.styles
  if (!overrides) return { ...DEFAULT_STYLES }

  const result = { ...DEFAULT_STYLES }
  for (const key of STYLE_KEYS) {
    if (overrides[key] !== undefined) {
      result[key] = overrides[key]
    } else {
      const parent = Object.entries(STYLE_INHERITANCE).find(([style]) => style === key)?.[1]
      if (parent && overrides[parent] !== undefined) {
        result[key] = overrides[parent]
      }
    }
  }
  return result
}

type RequiredThemeKeys = Exclude<keyof TuiTheme, ComputedKeys | OptionalKeys | "thinkingOpacity">
interface ThemeDefinitions { [name: string]: HexColor | RefName }
type RequiredThemeColors = { [K in RequiredThemeKeys]: ColorValue }
type ResolvedThemeColors = { [K in RequiredThemeKeys]: RGBA }
interface ThemeColorLookup { [name: string]: ColorValue | number | undefined }

export type ThemeJson = {
  defs?: ThemeDefinitions
  theme: RequiredThemeColors & {
    textSubtle?: ColorValue
    selectedListItemText?: ColorValue
    backgroundMenu?: ColorValue
    thinkingOpacity?: number
  }
  styles?: { [K in StyleKey]?: StyleModifiers }
}

function midpointColor(a: RGBA, b: RGBA): RGBA {
  return RGBA.fromInts(
    Math.round((a.r * 255 + b.r * 255) / 2),
    Math.round((a.g * 255 + b.g * 255) / 2),
    Math.round((a.b * 255 + b.b * 255) / 2),
  )
}
/** The hue of `color` in degrees, or nothing for a gray. */
function hueOf(color: RGBA): number | undefined {
  const max = Math.max(color.r, color.g, color.b)
  const chroma = max - Math.min(color.r, color.g, color.b)
  if (chroma < 0.08) return undefined
  const sector = max === color.r ? ((color.g - color.b) / chroma) % 6 : max === color.g ? (color.b - color.r) / chroma + 2 : (color.r - color.g) / chroma + 4
  return (sector * 60 + 360) % 360
}

/** The distance between two hues in degrees. A gray is a full quarter turn
 *  from every color, so a gray and a hue never count as the same color. */
function hueGap(a: RGBA, b: RGBA): number {
  const ha = hueOf(a)
  const hb = hueOf(b)
  if (ha === undefined || hb === undefined) return 90
  const gap = Math.abs(ha - hb)
  return Math.min(gap, 360 - gap)
}

/** Below this hue gap, two bars read as one color at a glance. */
const DISTINCT_HUE_GAP = 40

function sessionMessageColor(personBar: RGBA, info: RGBA, accent: RGBA, primary: RGBA): RGBA {
  if (hueGap(info, personBar) >= DISTINCT_HUE_GAP) return info
  return [info, accent, primary].reduce((best, candidate) => hueGap(candidate, personBar) > hueGap(best, personBar) ? candidate : best)
}
export function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): TuiTheme {
  const defs = theme.defs ?? {}

  function resolveColor(c: ColorValue, key?: string): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      if (c.startsWith("#")) return RGBA.fromHex(c)
      if (c === "transparent") return RGBA.fromInts(0, 0, 0, 0)
      // SAFETY: `c` is a color-ref name from theme JSON; indexing theme.theme by it
      // is a runtime lookup of an arbitrary string key, and a miss is an `undefined`
      // value the guard below catches. The non-color `thinkingOpacity` key is never
      // referenced as a color, so a hit is always a ColorValue.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: theme color references are dynamic keys from external JSON
      const themeRef = (theme.theme as ThemeColorLookup)[c]
      const ref = defs[c] ?? (typeof themeRef === "number" ? undefined : themeRef)
      if (ref === undefined) {
        log.warn("unresolved color ref", { ref: c, key })
        return RGBA.fromHex("#ff00ff")
      }
      return resolveColor(ref, key ?? c)
    }
    return resolveColor(c[mode], key)
  }

  const optionalKeys = new Set<string>(["textSubtle", "selectedListItemText", "backgroundMenu", "thinkingOpacity"])
  const resolvedEntries = Object.entries(theme.theme).flatMap(([key, value]) =>
    optionalKeys.has(key) || typeof value === "number" ? [] : [[key, resolveColor(value)] as const],
  )
  // SAFETY: Validated theme JSON contains every required theme key, while Object.fromEntries erases that completeness.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Object.fromEntries erases the complete required theme-key set from validated JSON
  const resolved = Object.fromEntries(resolvedEntries) as ResolvedThemeColors

  // Optional color keys with defaults
  const textSubtle = theme.theme.textSubtle
    ? resolveColor(theme.theme.textSubtle)
    : midpointColor(resolved.text, resolved.textMuted)

  const backgroundMenu = theme.theme.backgroundMenu
    ? resolveColor(theme.theme.backgroundMenu)
    : resolved.backgroundElement

  const selectedListItemText = theme.theme.selectedListItemText
    ? resolveColor(theme.theme.selectedListItemText)
    : resolved.text
  const pole = textPole(resolved.background)
  const readable = readableTheme({
    ...resolved,
    primaryBright: resolved.primary,
    textBright: pole,
    sessionMessage: resolved.info,
    textSubtle,
    selectedListItemText,
    selectionBackground: resolved.primary,
    selectionForeground: pole,
    backgroundMenu,
    border: GLOBAL_BORDER[mode],
    borderSubtle: GLOBAL_BORDER_SUBTLE[mode],
    backgroundRaised: blendToward(resolved.background, resolved.text, 0.06),
    ...workflowNameColors(resolved),
    thinkingOpacity: theme.theme.thinkingOpacity ?? 0.6,
  })
  const black = RGBA.fromInts(0, 0, 0)
  const white = RGBA.fromInts(255, 255, 255)
  return {
    ...readable,
    primaryBright: blendToward(readable.primary, pole, 0.35),
    sessionMessage: sessionMessageColor(readable.secondary, readable.info, readable.accent, readable.primary),
    selectionBackground: readable.primary,
    selectionForeground: contrastRatio(black, readable.primary) >= contrastRatio(white, readable.primary) ? black : white,
  }
}
