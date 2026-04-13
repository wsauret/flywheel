/** @jsxImportSource solid-js */
import { createMemo, createSignal, onCleanup } from "solid-js"
import { createSimpleContext } from "./helper"
import { resolveTheme, type ThemeJson } from "./theme/resolve"
import { generateSyntax, generateSubtleSyntax } from "./syntax-rules"

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
    const [mode, setMode] = createSignal(props.mode)
    const [themeName, setThemeName] = createSignal(props.themeName ?? "flywheel")

    const themeJson = createMemo(() => THEMES[themeName()] ?? asTheme(defaultTheme))
    const theme = createMemo(() => resolveTheme(themeJson(), mode()))
    const syntax = createMemo(() => {
      const s = generateSyntax(theme())
      onCleanup(() => s.destroy())
      return s
    })
    const subtleSyntax = createMemo(() => {
      const s = generateSubtleSyntax(theme())
      onCleanup(() => s.destroy())
      return s
    })

    return {
      get theme() {
        return theme()
      },
      get mode() {
        return mode()
      },
      get syntax() {
        return syntax()
      },
      get subtleSyntax() {
        return subtleSyntax()
      },
      get themeName() {
        return themeName()
      },
      get availableThemes() {
        return Object.keys(THEMES)
      },
      setMode,
      setTheme: setThemeName,
    }
  },
})
