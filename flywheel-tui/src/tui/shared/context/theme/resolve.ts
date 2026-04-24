import { RGBA } from "@opentui/core"

type ComputedKeys = "backdrop" | "successMuted" | "diffAddedBg" | "diffRemovedBg" | "diffHighlightAdded" | "diffHighlightRemoved" | "diffAddedFg" | "diffRemovedFg"

export type Theme = {
  primary: RGBA
  secondary: RGBA
  error: RGBA
  warning: RGBA
  success: RGBA
  info: RGBA
  text: RGBA
  textMuted: RGBA
  textSubtle: RGBA
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  accent: RGBA
  backdrop: RGBA
  successMuted: RGBA
  diffAddedBg: RGBA
  diffRemovedBg: RGBA
  diffHighlightAdded: RGBA
  diffHighlightRemoved: RGBA
  diffAddedFg: RGBA
  diffRemovedFg: RGBA
  diffLineNumber: RGBA
  markdownText: RGBA
  markdownHeading: RGBA
  markdownLink: RGBA
  markdownLinkText: RGBA
  markdownCode: RGBA
  markdownCodeBg: RGBA
  markdownBlockQuote: RGBA
  markdownEmph: RGBA
  markdownStrong: RGBA
  markdownHorizontalRule: RGBA
  markdownListItem: RGBA
  markdownListEnumeration: RGBA
  markdownImage: RGBA
  markdownImageText: RGBA
  markdownCodeBlock: RGBA
  syntaxComment: RGBA
  syntaxKeyword: RGBA
  syntaxFunction: RGBA
  syntaxVariable: RGBA
  syntaxString: RGBA
  syntaxNumber: RGBA
  syntaxType: RGBA
  syntaxOperator: RGBA
  syntaxPunctuation: RGBA
}

type HexColor = `#${string}`
type RefName = string
type Variant = {
  dark: HexColor | RefName
  light: HexColor | RefName
}
type ColorValue = HexColor | RefName | Variant | RGBA

// Diff colors are semantic — they communicate "added" / "removed" regardless
// of which theme or color mode the user has chosen. Keeping them constant
// means the user always knows what green-bg means vs red-bg, and we never
// accidentally ship a theme where the word-diff highlight is neon lime.
const DIFF_COLORS = {
  dark: {
    diffAddedBg:          RGBA.fromHex("#1a3d2b"),
    diffRemovedBg:        RGBA.fromHex("#3d1a22"),
    diffHighlightAdded:   RGBA.fromHex("#2a7a48"),
    diffHighlightRemoved: RGBA.fromHex("#8a4455"),
    diffAddedFg:          RGBA.fromHex("#3a9a5c"),
    diffRemovedFg:        RGBA.fromHex("#c06070"),
  },
  light: {
    diffAddedBg:          RGBA.fromHex("#c7e1cb"),
    diffRemovedBg:        RGBA.fromHex("#fdd2d8"),
    diffHighlightAdded:   RGBA.fromHex("#4a8a5a"),
    diffHighlightRemoved: RGBA.fromHex("#b06070"),
    diffAddedFg:          RGBA.fromHex("#2e7040"),
    diffRemovedFg:        RGBA.fromHex("#a04050"),
  },
}

// UI colors derived from the resolved theme — consistent across all themes.
// backdrop: semi-transparent overlay for modals (dark scrim)
// successMuted: dimmed success for completed-but-not-highlighted items (tool checkmarks)
const UI_COLORS = {
  dark: {
    backdrop: RGBA.fromInts(0, 0, 0, 144),
    successMuted: RGBA.fromHex("#6a8a6a"),
  },
  light: {
    backdrop: RGBA.fromInts(0, 0, 0, 100),
    successMuted: RGBA.fromHex("#5a7a5a"),
  },
}

export type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Record<Exclude<keyof Theme, ComputedKeys>, ColorValue>
}

export function resolveTheme(theme: ThemeJson, mode: "dark" | "light"): Theme {
  const defs = theme.defs ?? {}

  function resolveColor(c: ColorValue): RGBA {
    if (c instanceof RGBA) return c
    if (typeof c === "string") {
      return c.startsWith("#") ? RGBA.fromHex(c) : resolveColor(defs[c])
    }
    return resolveColor(c[mode])
  }

  const resolved = Object.fromEntries(
    Object.entries(theme.theme).map(([key, value]) => {
      return [key, resolveColor(value)]
    }),
  ) as Omit<Theme, ComputedKeys>

  return {
    ...resolved,
    ...DIFF_COLORS[mode],
    ...UI_COLORS[mode],
  }
}
