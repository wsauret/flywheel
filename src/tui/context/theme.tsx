/** @jsxImportSource solid-js */

import { RGBA, type SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { createContext, createMemo, onCleanup, type JSX, useContext } from "solid-js"
import { generateSyntax } from "./syntax-rules.js"
import { subduedTheme } from "./theme/readable-theme.js"
import { baseSurfacesUseDefaultBackground } from "../utils/terminal-capabilities.js"
import type { RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"
import { DEFAULT_WRITE_SYNTAX_THEME_ID, getWriteSyntaxColors } from "../../protocol/write-syntax-theme.js"
import { chatSyntaxColors, type SyntaxColors } from "../adapters/syntax-highlight.js"
import auraTheme from "./theme/aura.json" with { type: "json" }
import ayuTheme from "./theme/ayu.json" with { type: "json" }
import azureTheme from "./theme/azure.json" with { type: "json" }
import carbonfoxTheme from "./theme/carbonfox.json" with { type: "json" }
import catppuccinTheme from "./theme/catppuccin.json" with { type: "json" }
import catppuccinFrappeTheme from "./theme/catppuccin-frappe.json" with { type: "json" }
import catppuccinMacchiatoTheme from "./theme/catppuccin-macchiato.json" with { type: "json" }
import charcoalTheme from "./theme/charcoal.json" with { type: "json" }
import cobalt2Theme from "./theme/cobalt2.json" with { type: "json" }
import draculaTheme from "./theme/dracula.json" with { type: "json" }
import everforestTheme from "./theme/everforest.json" with { type: "json" }
import flexokiTheme from "./theme/flexoki.json" with { type: "json" }
// ── Built-in themes ──
import flywheelTheme from "./theme/flywheel.json" with { type: "json" }
import gitlabDarkGreyTheme from "./theme/gitlab-dark-grey.json" with { type: "json" }
import githubTheme from "./theme/github.json" with { type: "json" }
import grokTheme from "./theme/grok.json" with { type: "json" }
import gruvboxTheme from "./theme/gruvbox.json" with { type: "json" }
import kanagawaTheme from "./theme/kanagawa.json" with { type: "json" }
import materialTheme from "./theme/material.json" with { type: "json" }
import melangeDarkTheme from "./theme/melange-dark.json" with { type: "json" }
import matrixTheme from "./theme/matrix.json" with { type: "json" }
import mercuryTheme from "./theme/mercury.json" with { type: "json" }
import monokaiTheme from "./theme/monokai.json" with { type: "json" }
import nightowlTheme from "./theme/nightowl.json" with { type: "json" }
import nordTheme from "./theme/nord.json" with { type: "json" }
import nordWaveTheme from "./theme/nord-wave.json" with { type: "json" }
import oneDarkTheme from "./theme/one-dark.json" with { type: "json" }
import orngTheme from "./theme/orng.json" with { type: "json" }
import osakaJadeTheme from "./theme/osaka-jade.json" with { type: "json" }
import palenightTheme from "./theme/palenight.json" with { type: "json" }
import peachTheme from "./theme/peach.json" with { type: "json" }
import { resolveStyles, resolveTheme, type TuiTheme, type ThemeJson } from "./theme/resolve.js"
import rosepineTheme from "./theme/rosepine.json" with { type: "json" }
import solarizedTheme from "./theme/solarized.json" with { type: "json" }
import subliminalTheme from "./theme/subliminal.json" with { type: "json" }
import synthwave84Theme from "./theme/synthwave84.json" with { type: "json" }
import tokyonightTheme from "./theme/tokyonight.json" with { type: "json" }
import twilightTheme from "./theme/twilight.json" with { type: "json" }
import vercelTheme from "./theme/vercel.json" with { type: "json" }
import vesperTheme from "./theme/vesper.json" with { type: "json" }
import zenburnTheme from "./theme/zenburn.json" with { type: "json" }
import { generateSystemTheme } from "./theme/system-theme.js"
import { createTerminalPalette } from "../hooks/create-terminal-palette.js"

interface ThemesByName { [name: string]: ThemeJson | "system" }
/** Every built-in theme by id, with "system" for the theme that follows the terminal. */
export const THEMES: Readonly<ThemesByName> = {
  flywheel: flywheelTheme,
  twilight: twilightTheme,
  aura: auraTheme,
  ayu: ayuTheme,
  azure: azureTheme,
  carbonfox: carbonfoxTheme,
  catppuccin: catppuccinTheme,
  "catppuccin-frappe": catppuccinFrappeTheme,
  "catppuccin-macchiato": catppuccinMacchiatoTheme,
  charcoal: charcoalTheme,
  cobalt2: cobalt2Theme,
  dracula: draculaTheme,
  everforest: everforestTheme,
  flexoki: flexokiTheme,
  "gitlab-dark-grey": gitlabDarkGreyTheme,
  github: githubTheme,
  grok: grokTheme,
  gruvbox: gruvboxTheme,
  kanagawa: kanagawaTheme,
  material: materialTheme,
  "melange-dark": melangeDarkTheme,
  matrix: matrixTheme,
  mercury: mercuryTheme,
  monokai: monokaiTheme,
  nightowl: nightowlTheme,
  nord: nordTheme,
  "nord-wave": nordWaveTheme,
  "one-dark": oneDarkTheme,
  orng: orngTheme,
  "osaka-jade": osakaJadeTheme,
  palenight: palenightTheme,
  peach: peachTheme,
  rosepine: rosepineTheme,
  solarized: solarizedTheme,
  subliminal: subliminalTheme,
  synthwave84: synthwave84Theme,
  tokyonight: tokyonightTheme,
  vercel: vercelTheme,
  vesper: vesperTheme,
  zenburn: zenburnTheme,
  system: "system",
}

export const THEME_NAMES: readonly string[] = Object.keys(THEMES)

/** Releases before 2026-10-27 saved four themes under other ids, and a saved
 *  config can still hold one. Each old id reads as its renamed theme until
 *  the person picks a theme again. Remove this map after 2027-01-27. */
export const RENAMED_THEME_IDS: ReadonlyMap<string, string> = new Map([["amp", "azure"], ["codex", "twilight"], ["cursor", "charcoal"], ["opencode", "peach"]])

type ThemeMode = "dark" | "light"

interface ThemeContextValue {
  theme: TuiTheme
  get subtleTheme(): Readonly<TuiTheme>
  /** Background base surfaces paint: undefined where cells stay on the
   *  terminal default background (compatible rendering), the theme
   *  background elsewhere. One derivation for the shell root, overlay
   *  clears, and the OSC 11 hook. */
  get baseBackground(): RGBA | undefined
  get syntax(): SyntaxStyle
  get subtleSyntax(): SyntaxStyle
  get chatSyntaxColors(): SyntaxColors
  get writeSyntaxColors(): SyntaxColors
  get themeName(): string
  mode: ThemeMode
  /** Named theme OSC 11 writes wait for the original terminal report, not rendering. */
  get terminalColorsReady(): boolean
  /** The terminal's own cursor colour. OpenTUI always writes a cursor colour, so
   *  writing the reported one keeps the terminal default; a terminal that does
   *  not report one gets the theme's primary colour. */
  get cursorColor(): RGBA
}

const ThemeContext = createContext<ThemeContextValue>()

interface ThemeProviderProps {
  mode: ThemeMode
  themeName?: string
  compatibleRendering?: () => "auto" | "on" | "off"
  config?: () => RuntimeConfigView | undefined
  renderer?: Parameters<typeof createTerminalPalette>[0]
  children: JSX.Element
}

function normalizeThemeName(name: string | undefined): string {
  if (!name || name === "default") return "flywheel"
  const id = RENAMED_THEME_IDS.get(name) ?? name
  return THEMES[id] ? id : "flywheel"
}

export function ThemeProvider(props: ThemeProviderProps): JSX.Element {
  const syntaxOwner = useRenderer().nativeScene
  const themeName = createMemo(() =>
    normalizeThemeName(props.config?.()?.values.theme ?? props.themeName),
  )
  // oxlint-disable-next-line solid/reactivity -- boundary: renderer identity belongs to the OpenTUI root's lifetime, not theme selection
  const terminal = createTerminalPalette(props.renderer, () => themeName() === "system", () => props.mode)
  const themeJson = createMemo(() => {
    const entry = THEMES[themeName()]
    return entry && entry !== "system" ? entry : flywheelTheme
  })
  const system = createMemo(() => {
    if (themeName() !== "system") return undefined
    const input = terminal.input()
    return { ...generateSystemTheme(input), reportedBackground: input.background !== undefined }
  })
  const mode = createMemo(() => system()?.mode ?? props.mode)
  const values = createMemo(() => system()?.theme ?? resolveTheme(themeJson(), props.mode))
  const subdued = createMemo(() => subduedTheme(values()))

  const styles = createMemo(() => resolveStyles(themeJson()))
  const resolvedChatSyntaxColors = createMemo<SyntaxColors>(() => chatSyntaxColors(values()))
  const writeSyntaxColors = createMemo<SyntaxColors>(() => {
    const colors = getWriteSyntaxColors(
      props.config?.()?.values.writeSyntaxTheme ?? DEFAULT_WRITE_SYNTAX_THEME_ID,
      mode(),
    )
    return {
      text: RGBA.fromHex(colors.text),
      comment: RGBA.fromHex(colors.comment),
      keyword: RGBA.fromHex(colors.keyword),
      function: RGBA.fromHex(colors.function),
      variable: RGBA.fromHex(colors.variable),
      string: RGBA.fromHex(colors.string),
      number: RGBA.fromHex(colors.number),
      type: RGBA.fromHex(colors.type),
      operator: RGBA.fromHex(colors.operator),
      punctuation: RGBA.fromHex(colors.punctuation),
    }
  })

  const syntax = createMemo<SyntaxStyle>((prev) => {
    prev?.destroy()
    return generateSyntax(values(), styles(), syntaxOwner)
  })
  const subtleSyntax = createMemo<SyntaxStyle>((prev) => {
    prev?.destroy()
    return generateSyntax(subdued(), styles(), syntaxOwner)
  })
  onCleanup(() => {
    syntax().destroy()
    subtleSyntax().destroy()
  })

  // SAFETY: the Proxy's get-trap forwards every key to the current values()
  // Theme, so it satisfies the Theme contract while staying reactive; the trap
  // indexes that Theme by an arbitrary prop, which requires the record view.
  // eslint-disable-next-line solid/reactivity -- Proxy target is intentional; reads go through the getter which calls values()
  const reactiveTheme: TuiTheme = new Proxy(values(), {
    get(_target, prop) {
      // SAFETY: indexing the resolved Theme by the trap's arbitrary prop key.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Proxy traps receive arbitrary property keys from the JavaScript runtime
      return (values() as { readonly [key: string | symbol]: unknown })[prop]
    },
  })

  const transparentBase = () => {
    const rendering = props.config?.()?.values.compatibleRendering ?? props.compatibleRendering?.() ?? "auto"
    return rendering === "auto" ? baseSurfacesUseDefaultBackground() : rendering === "on"
  }

  const context: ThemeContextValue = {
    theme: reactiveTheme,
    get subtleTheme() { return subdued() },
    get baseBackground(): RGBA | undefined {
      if (!terminal.ready()) return values().background
      return transparentBase() && system()?.reportedBackground !== false ? undefined : values().background
    },
    get syntax() { return syntax() },
    get subtleSyntax() { return subtleSyntax() },
    get chatSyntaxColors() { return resolvedChatSyntaxColors() },
    get writeSyntaxColors() { return writeSyntaxColors() },
    get themeName() { return themeName() },
    get mode() { return mode() },
    get terminalColorsReady() { return terminal.ready() },
    get cursorColor() { return terminal.cursorColor() ?? values().primary },
  }

  return <ThemeContext.Provider value={context}>{props.children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (!context) throw new Error("Theme context is missing")
  return context
}
