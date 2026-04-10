import { RGBA } from "@opentui/core"

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
  // Diff colors — canonical constants, not theme-controlled (see DIFF_COLORS below)
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
//
// Values are taken from Claude Code's dark/light theme (rgb values from
// their theme.ts), which are well-balanced and widely tested in terminals.
const DIFF_COLORS = {
  dark: {
    diffAddedBg:          RGBA.fromHex("#1a3d2b"), // deep forest green line bg
    diffRemovedBg:        RGBA.fromHex("#3d1a22"), // deep burgundy line bg
    diffHighlightAdded:   RGBA.fromHex("#2a7a48"), // muted green word highlight
    diffHighlightRemoved: RGBA.fromHex("#8a4455"), // muted rose word highlight
    diffAddedFg:          RGBA.fromHex("#3a9a5c"), // bright green for + marker & line numbers
    diffRemovedFg:        RGBA.fromHex("#c06070"), // bright rose for - marker & line numbers
  },
  light: {
    diffAddedBg:          RGBA.fromHex("#c7e1cb"), // soft green line bg
    diffRemovedBg:        RGBA.fromHex("#fdd2d8"), // soft pink line bg
    diffHighlightAdded:   RGBA.fromHex("#4a8a5a"), // muted green word highlight
    diffHighlightRemoved: RGBA.fromHex("#b06070"), // muted red word highlight
    diffAddedFg:          RGBA.fromHex("#2e7040"), // darker green for + marker & line numbers
    diffRemovedFg:        RGBA.fromHex("#a04050"), // darker red for - marker & line numbers
  },
}

export type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Record<Exclude<keyof Theme, "diffAddedBg" | "diffRemovedBg" | "diffHighlightAdded" | "diffHighlightRemoved" | "diffAddedFg" | "diffRemovedFg">, ColorValue>
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
  ) as Omit<Theme, "diffAddedBg" | "diffRemovedBg" | "diffHighlightAdded" | "diffHighlightRemoved">

  return {
    ...resolved,
    ...DIFF_COLORS[mode],
  }
}
