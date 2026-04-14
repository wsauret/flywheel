/** @jsxImportSource solid-js */
import { onCleanup } from "solid-js"
import { createSimpleContext } from "./helper.js"
import { resolveTheme, type ThemeJson } from "./theme/resolve.js"
import { generateSyntax, generateSubtleSyntax } from "./syntax-rules.js"

// ── Built-in themes ──
import defaultTheme from "./theme/flywheel.json" with { type: "json" }
import tokyonightTheme from "./theme/tokyonight.json" with { type: "json" }
import draculaTheme from "./theme/dracula.json" with { type: "json" }
import catppuccinTheme from "./theme/catppuccin.json" with { type: "json" }
import nordTheme from "./theme/nord.json" with { type: "json" }
import gruvboxTheme from "./theme/gruvbox.json" with { type: "json" }

// JSON imports have inferred types (string instead of HexColor template literals).
// Single boundary cast — theme validation happens in resolveTheme().
const asTheme = (json: unknown): ThemeJson => json as ThemeJson

const THEMES: Record<string, ThemeJson> = {
  default: asTheme(defaultTheme),
  flywheel: asTheme(defaultTheme),
  tokyonight: asTheme(tokyonightTheme),
  dracula: asTheme(draculaTheme),
  catppuccin: asTheme(catppuccinTheme),
  nord: asTheme(nordTheme),
  gruvbox: asTheme(gruvboxTheme),
}

export const { use: useTheme, provider: ThemeProvider } = createSimpleContext({
  name: "Theme",
  init: (props: { mode: "dark" | "light"; themeName?: string }) => {
    const mode = props.mode
    const themeName = props.themeName ?? "flywheel"

    const themeJson = THEMES[themeName] ?? asTheme(defaultTheme)
    const theme = resolveTheme(themeJson, mode)
    const syntax = generateSyntax(theme)
    const subtleSyntax = generateSubtleSyntax(theme)
    onCleanup(() => { syntax.destroy(); subtleSyntax.destroy() })

    return { theme, mode, syntax, subtleSyntax, themeName }
  },
})
