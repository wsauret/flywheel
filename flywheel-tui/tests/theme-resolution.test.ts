import { describe, it, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveTheme, type Theme } from "../src/tui/shared/context/theme/resolve"
import flywheelTheme from "../src/tui/shared/context/theme/flywheel.json" with { type: "json" }

// All keys that must be present in Theme
const EXPECTED_KEYS: (keyof Theme)[] = [
  // Original tokens
  "primary",
  "secondary",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "background",
  "backgroundPanel",
  "backgroundElement",
  "border",
  "borderActive",
  "borderSubtle",
  // Accent
  "accent",
  // Diff tokens (hardcoded in resolve.ts, not in JSON)
  "diffAddedBg",
  "diffRemovedBg",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  // Diff token from JSON
  "diffLineNumber",
  // Markdown tokens
  "markdownText",
  "markdownHeading",
  "markdownLink",
  "markdownLinkText",
  "markdownCode",
  "markdownBlockQuote",
  "markdownEmph",
  "markdownStrong",
  "markdownHorizontalRule",
  "markdownListItem",
  "markdownListEnumeration",
  "markdownImage",
  "markdownImageText",
  "markdownCodeBlock",
  // Syntax tokens
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
]

describe("theme resolution", () => {
  it("resolves all tokens to valid RGBA in dark mode", () => {
    const theme = resolveTheme(flywheelTheme as any, "dark")
    for (const key of EXPECTED_KEYS) {
      expect(theme[key]).toBeInstanceOf(RGBA)
    }
  })

  it("resolves all tokens to valid RGBA in light mode", () => {
    const theme = resolveTheme(flywheelTheme as any, "light")
    for (const key of EXPECTED_KEYS) {
      expect(theme[key]).toBeInstanceOf(RGBA)
    }
  })

  it("has no undefined values in dark mode", () => {
    const theme = resolveTheme(flywheelTheme as any, "dark")
    const entries = Object.entries(theme)
    for (const [key, value] of entries) {
      expect(value).toBeDefined()
    }
  })

  it("has no undefined values in light mode", () => {
    const theme = resolveTheme(flywheelTheme as any, "light")
    const entries = Object.entries(theme)
    for (const [key, value] of entries) {
      expect(value).toBeDefined()
    }
  })

  it("resolved theme key count matches expected token count", () => {
    const theme = resolveTheme(flywheelTheme as any, "dark")
    const resolvedKeys = Object.keys(theme).sort()
    const expectedSorted = [...EXPECTED_KEYS].sort()
    expect(resolvedKeys).toEqual(expectedSorted)
  })

  it("JSON theme keys match expected token list (excluding hardcoded diff tokens)", () => {
    const jsonKeys = Object.keys(flywheelTheme.theme).sort()
    const hardcodedDiffKeys = new Set(["diffAddedBg", "diffRemovedBg", "diffHighlightAdded", "diffHighlightRemoved"])
    const expectedJsonKeys = [...EXPECTED_KEYS].filter(k => !hardcodedDiffKeys.has(k)).sort()
    expect(jsonKeys).toEqual(expectedJsonKeys)
  })

  it("accent resolves to valid RGBA in both modes", () => {
    const dark = resolveTheme(flywheelTheme as any, "dark")
    const light = resolveTheme(flywheelTheme as any, "light")
    expect(dark.accent).toBeInstanceOf(RGBA)
    expect(light.accent).toBeInstanceOf(RGBA)
  })
})
