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
  background: RGBA
  backgroundPanel: RGBA
  backgroundElement: RGBA
  border: RGBA
  borderActive: RGBA
  borderSubtle: RGBA
  accent: RGBA
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

export type ThemeJson = {
  $schema?: string
  defs?: Record<string, HexColor | RefName>
  theme: Record<keyof Theme, ColorValue>
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

  return Object.fromEntries(
    Object.entries(theme.theme).map(([key, value]) => {
      return [key, resolveColor(value)]
    }),
  ) as Theme
}
