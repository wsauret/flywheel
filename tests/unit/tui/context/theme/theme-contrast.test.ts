import { describe, expect, it } from "bun:test"
import { contrastRatio } from "../../../../../src/tui/context/theme/color-contrast.js"
import { resolveTheme, type TuiTheme, type ThemeJson } from "../../../../../src/tui/context/theme/resolve.js"
import { generateSystemTheme } from "../../../../../src/tui/context/theme/system-theme.js"
import { rgbToOklab, type RgbColor } from "../../../../../src/tui/context/theme/oklab.js"
import { RGBA } from "@opentui/core"
import { rgbToOklch } from "../../../../../src/tui/context/theme/oklch.js"
import { subduedTheme } from "../../../../../src/tui/context/theme/readable-theme.js"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import githubTheme from "../../../../../src/tui/context/theme/github.json" with { type: "json" }
import { THEMES } from "../../../../../src/tui/context/theme.js"

type ContrastPair = {
  foreground: keyof TuiTheme
  background: keyof TuiTheme
  minimum: number
}

const UI_SURFACES = ["background", "backgroundRaised", "backgroundPanel", "backgroundElement", "backgroundMenu"] as const
const DIFF_SURFACES = ["diffAddedBg", "diffRemovedBg", "diffContextBg", "diffAddedLineNumberBg", "diffRemovedLineNumberBg"] as const
const LABELS = [
  "primary", "primaryBright", "secondary", "sessionMessage", "accent", "error", "warning", "success", "info",
  "textMuted", "textSubtle", "selectedListItemText",
  "markdownHeading", "markdownLink", "markdownLinkText", "markdownCode", "markdownBlockQuote", "markdownEmph",
  "markdownStrong", "markdownHorizontalRule", "markdownListItem", "markdownListEnumeration", "markdownImage", "markdownImageText",
  "chatCodeComment", "chatCodeKeyword", "chatCodeFunction", "chatCodeVariable", "chatCodeString",
  "chatCodeNumber", "chatCodeType", "chatCodeOperator", "chatCodePunctuation", "diffHunkHeader",
] as const
const RENDERED_PAIRS: ContrastPair[] = [
  ...(["text", "textBright", "markdownText", "markdownCodeBlock", "diffLineNumber"] as const).flatMap(foreground =>
    [...UI_SURFACES, ...DIFF_SURFACES].map(background => ({ foreground, background, minimum: 4.5 }))),
  ...LABELS.flatMap(foreground => UI_SURFACES.map(background => ({ foreground, background, minimum: 4.5 }))),
  { foreground: "diffAdded", background: "diffAddedBg", minimum: 4.5 },
  { foreground: "diffRemoved", background: "diffRemovedBg", minimum: 4.5 },
  { foreground: "diffContext", background: "diffContextBg", minimum: 4.5 },
  { foreground: "background", background: "primary", minimum: 4.5 },
  { foreground: "background", background: "diffHighlightAdded", minimum: 4.5 },
  { foreground: "background", background: "diffHighlightRemoved", minimum: 4.5 },
  { foreground: "selectionForeground", background: "selectionBackground", minimum: 4.5 },
]

function originalColor(json: ThemeJson, key: "background" | "text" | "primary" | "error" | "chatCodeComment", mode: "dark" | "light"): RGBA {
  const colors: { [name: string]: ThemeJson["theme"][keyof ThemeJson["theme"]] } = json.theme
  let value = colors[key]
  while (!(value instanceof RGBA)) {
    if (value === undefined || typeof value === "number") throw new Error(`Invalid source color for ${key}`)
    if (typeof value !== "string") { value = value[mode]; continue }
    if (value.startsWith("#")) return RGBA.fromHex(value)
    value = json.defs?.[value] ?? colors[value]
  }
  return value
}

describe("built-in theme contrast", () => {
  it("keeps core interface text readable across every built-in theme", () => {
    const failures: string[] = []

    for (const [themeName, themeJson] of Object.entries(THEMES)) {
      if (themeJson === "system") continue
      for (const mode of ["dark", "light"] as const) {
        const normal = resolveTheme(themeJson, mode)
        for (const [view, theme] of [["normal", normal], ["subdued", subduedTheme(normal)]] as const) {
          expect(theme.background).toEqual(originalColor(themeJson, "background", mode))
          for (const role of ["text", "primary", "error", "chatCodeComment"] as const) {
            const source = rgbToOklch(channels(originalColor(themeJson, role, mode)))
            const result = rgbToOklch(channels(theme[role]))
            expect(result.c, `${themeName}/${mode}/${view}/${role} chroma`).toBeLessThanOrEqual(source.c + 0.005)
            if (source.c > 0.02 && result.c > 0.02) {
              const gap = Math.abs(source.h - result.h)
              expect(Math.min(gap, 360 - gap), `${themeName}/${mode}/${view}/${role} hue`).toBeLessThan(5)
            }
          }
          expect(highlightStep(theme), `${themeName}/${mode}/${view} highlight fill step`).toBeGreaterThanOrEqual(0.03)
          for (const surface of UI_SURFACES) {
            for (const role of ["text", "markdownText", "markdownCodeBlock", "selectedListItemText"] as const) {
              expect(contrastRatio(theme[role], theme[surface]), `${themeName}/${mode}/${view}/${role} preferred hierarchy`)
                .toBeGreaterThanOrEqual(1.15 * contrastRatio(theme.textMuted, theme[surface]))
            }
            expect(contrastRatio(theme.text, theme[surface]), `${themeName}/${mode}/${view} body hierarchy`)
              .toBeGreaterThanOrEqual(contrastRatio(theme.textSubtle, theme[surface]))
            expect(contrastRatio(theme.textSubtle, theme[surface]), `${themeName}/${mode}/${view} muted hierarchy`)
              .toBeGreaterThanOrEqual(contrastRatio(theme.textMuted, theme[surface]))
          }
          for (const pair of RENDERED_PAIRS) {
            const foreground = theme[pair.foreground]
            const background = theme[pair.background]
            if (typeof foreground === "number" || typeof background === "number") throw new Error("Text pairs must be colors")
            expect(foreground.a).toBe(1)
            const ratio = contrastRatio(foreground, background)
            if (ratio < pair.minimum) {
              failures.push(`${themeName}/${mode}/${view}: ${pair.foreground} on ${pair.background} = ${ratio.toFixed(2)} < ${pair.minimum}`)
            }
          }
        }
      }
    }

    expect(failures).toEqual([])
  })
})

const rgb = (hex: string): RgbColor => {
  const color = RGBA.fromHex(hex)
  return { r: Math.round(color.r * 255), g: Math.round(color.g * 255), b: Math.round(color.b * 255) }
}
function channels(color: RGBA): RgbColor {
  return { r: color.r * 255, g: color.g * 255, b: color.b * 255 }
}
/** How far hover and landing highlights, which paint the element fill, stand from the ground. */
function highlightStep(theme: TuiTheme): number {
  return Math.abs(rgbToOklch(channels(theme.backgroundElement)).l - rgbToOklch(channels(theme.background)).l)
}
const FRAPPE = [
  "#51576d", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#b5bfe2",
  "#626880", "#e78284", "#a6d189", "#e5c890", "#8caaee", "#f4b8e4", "#81c8be", "#c6d0f5",
].map(rgb)
const SOLARIZED = [
  "#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5",
  "#002b36", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3",
].map(rgb)
const SYSTEM_SURFACES = [
  "background", "backgroundPanel", "backgroundRaised", "backgroundElement", "backgroundMenu",
  "diffAddedBg", "diffRemovedBg", "diffContextBg", "diffAddedLineNumberBg", "diffRemovedLineNumberBg",
] as const
const SYSTEM_TEXT = [
  "text", "textBright", "textMuted", "textSubtle", "selectedListItemText",
  "primary", "primaryBright", "secondary", "accent", "sessionMessage", "error", "warning", "success", "info",
  "diffAdded", "diffRemoved", "diffContext", "diffHunkHeader", "diffHighlightAdded", "diffHighlightRemoved", "diffLineNumber",
  "markdownText", "markdownHeading", "markdownLink", "markdownLinkText", "markdownCode", "markdownBlockQuote",
  "markdownEmph", "markdownStrong", "markdownHorizontalRule", "markdownListItem", "markdownListEnumeration",
  "markdownImage", "markdownImageText", "markdownCodeBlock",
  "chatCodeComment", "chatCodeKeyword", "chatCodeFunction", "chatCodeVariable", "chatCodeString",
  "chatCodeNumber", "chatCodeType", "chatCodeOperator", "chatCodePunctuation",
] as const

describe("system theme contrast", () => {
  for (const [name, background, foreground, palette] of [
    ["dark", "#181818", "#ffffff", FRAPPE],
    ["light", "#f5f5f5", "#000000", FRAPPE],
    ["pastel", "#303446", "#c6d0f5", FRAPPE],
    ["background only", "#282c35", undefined, undefined],
    ["mid-gray", "#777777", "#ffffff", FRAPPE],
    ["Solarized dark", "#002b36", "#839496", SOLARIZED],
    ["Solarized light", "#fdf6e3", "#657b83", SOLARIZED],
    ["unreadable report", "#1e1e1e", "#7a7a7a", FRAPPE],
  ] as const) {
    it(`keeps text readable on ${name} terminal surfaces`, () => {
      const { theme, mode } = generateSystemTheme({
        background: rgb(background), foreground: foreground ? rgb(foreground) : undefined, palette,
      })
      expect(theme.background).toEqual(RGBA.fromHex(background))
      expect(mode).toBe(name === "light" || name === "mid-gray" || name === "Solarized light" ? "light" : "dark")
      for (const role of SYSTEM_TEXT) {
        for (const surface of SYSTEM_SURFACES) {
          expect(contrastRatio(theme[role], theme[surface]), `${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(contrastRatio(theme.selectionForeground, theme.selectionBackground)).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.background, theme.primary)).toBeGreaterThanOrEqual(4.5)
      expect(highlightStep(theme), "highlight fill step").toBeGreaterThanOrEqual(0.03)
      for (const view of [theme, subduedTheme(theme)]) {
        for (const pair of RENDERED_PAIRS) {
          const foregroundColor = view[pair.foreground]
          const backgroundColor = view[pair.background]
          if (typeof foregroundColor === "number" || typeof backgroundColor === "number") throw new Error("Text pairs must be colors")
          expect(foregroundColor.a).toBe(1)
          expect(contrastRatio(foregroundColor, backgroundColor), `${name}: ${pair.foreground} on ${pair.background}`).toBeGreaterThanOrEqual(4.5)
        }
      }
      expect(contrastRatio(theme.border, theme.background)).toBeLessThan(contrastRatio(theme.text, theme.background))
      for (const role of ["markdownText", "markdownCodeBlock", "selectedListItemText"] as const) {
        expect(theme[role]).toEqual(theme.text)
      }
      for (const surface of SYSTEM_SURFACES) {
        const body = contrastRatio(theme.text, theme[surface])
        const subtle = contrastRatio(theme.textSubtle, theme[surface])
        const muted = contrastRatio(theme.textMuted, theme[surface])
        expect(body, `body >= subtle on ${surface}`).toBeGreaterThanOrEqual(subtle)
        expect(subtle, `subtle >= muted on ${surface}`).toBeGreaterThanOrEqual(muted)
        for (const role of [
          "textMuted", "chatCodeComment", "diffContext", "diffLineNumber",
          "markdownBlockQuote", "markdownHorizontalRule", "chatCodePunctuation",
        ] as const) {
          expect(body, `body >= ${role} on ${surface}`).toBeGreaterThanOrEqual(contrastRatio(theme[role], theme[surface]))
        }
      }
      if (name === "pastel") {
        expect(contrastRatio(theme.text, theme.background)).toBeGreaterThan(contrastRatio(theme.textSubtle, theme.background))
        expect(contrastRatio(theme.textSubtle, theme.background)).toBeGreaterThan(contrastRatio(theme.textMuted, theme.background))
      }
    })
  }

  it("preserves a readable reported foreground and the pastel palette's hue and chroma", () => {
    const { theme } = generateSystemTheme({ background: rgb("#303446"), foreground: rgb("#ffffff"), palette: FRAPPE })
    expect(theme.text).toEqual(RGBA.fromHex("#ffffff"))
    const nearFloor = generateSystemTheme({
      background: rgb("#1e1e1e"), foreground: rgb("#9c9c9c"), palette: FRAPPE,
    }).theme
    for (const role of ["text", "markdownText", "markdownCodeBlock", "selectedListItemText"] as const) {
      expect(nearFloor[role]).toEqual(RGBA.fromHex("#9c9c9c"))
      for (const surface of SYSTEM_SURFACES) {
        expect(contrastRatio(nearFloor[role], nearFloor[surface])).toBeGreaterThanOrEqual(4.5)
      }
    }
    for (const background of ["#303446", "#f5f5f5"]) {
      const generated = generateSystemTheme({
        background: rgb(background), foreground: rgb("#f4b8e4"), palette: FRAPPE,
      }).theme
      for (const role of ["text", "secondary", "textMuted", "textSubtle", "chatCodeComment"] as const) {
        const [, sourceA, sourceB] = rgbToOklab(rgb(role === "text" || role === "secondary" ? "#f4b8e4" : "#626880"))
        const value = generated[role]
        const [, generatedA, generatedB] = rgbToOklab({
          r: Math.round(value.r * 255), g: Math.round(value.g * 255), b: Math.round(value.b * 255),
        })
        expect(Math.hypot(generatedA, generatedB)).toBeLessThanOrEqual(Math.hypot(sourceA, sourceB) + 0.002)
        expect(Math.abs(Math.atan2(generatedB, generatedA) - Math.atan2(sourceB, sourceA))).toBeLessThan(0.05)
        for (const surface of SYSTEM_SURFACES) {
          expect(contrastRatio(value, generated[surface])).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it("uses the existing named fallback when no background was reported", () => {
    for (const mode of ["dark", "light"] as const) {
      const json = mode === "light" ? githubTheme : flywheelTheme
      expect(generateSystemTheme({ appearanceHint: mode })).toEqual({ theme: resolveTheme(json, mode), mode })
      expect(generateSystemTheme({ foreground: rgb("#000000"), palette: FRAPPE, appearanceHint: mode }))
        .toEqual({ theme: resolveTheme(json, mode), mode })
    }
    expect(generateSystemTheme({}).mode).toBe("dark")
  })
})

