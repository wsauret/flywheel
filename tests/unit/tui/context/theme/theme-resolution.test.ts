import { describe, it, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import { resolveTheme, resolveStyles, type ThemeJson, type TuiTheme } from "../../../../../src/tui/context/theme/resolve"
import flywheelTheme from "../../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import twilightTheme from "../../../../../src/tui/context/theme/twilight.json" with { type: "json" }
import charcoalTheme from "../../../../../src/tui/context/theme/charcoal.json" with { type: "json" }
import githubTheme from "../../../../../src/tui/context/theme/github.json" with { type: "json" }
import { rgbToOklch } from "../../../../../src/tui/context/theme/oklch"
import { THEMES } from "../../../../../src/tui/context/theme.js"

/** A theme with the default theme's colors and only `styles` of its own,
 *  for style resolution, which reads nothing else. */
function styledTheme(styles?: ThemeJson["styles"]): ThemeJson {
  return { theme: flywheelTheme.theme, ...(styles === undefined ? {} : { styles }) }
}

const EXPECTED_KEYS: (keyof TuiTheme)[] = [
  "primary",
  "primaryBright",
  "textBright",
  "secondary",
  "sessionMessage",
  "accent",
  "phaseName",
  "agentName",
  "error",
  "warning",
  "success",
  "info",
  "text",
  "textMuted",
  "textSubtle",
  "selectedListItemText",
  "selectionBackground",
  "selectionForeground",
  "background",
  "backgroundRaised",
  "backgroundPanel",
  "backgroundElement",
  "backgroundMenu",
  "border",
  "borderActive",
  "borderSubtle",
  "diffAdded",
  "diffRemoved",
  "diffContext",
  "diffHunkHeader",
  "diffHighlightAdded",
  "diffHighlightRemoved",
  "diffAddedBg",
  "diffRemovedBg",
  "diffContextBg",
  "diffLineNumber",
  "diffAddedLineNumberBg",
  "diffRemovedLineNumberBg",
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
  "chatCodeComment",
  "chatCodeKeyword",
  "chatCodeFunction",
  "chatCodeVariable",
  "chatCodeString",
  "chatCodeNumber",
  "chatCodeType",
  "chatCodeOperator",
  "chatCodePunctuation",
  "thinkingOpacity",
]

describe("theme resolution", () => {
  it("uses the sampled reference green for Flywheel success states", () => {
    const theme = resolveTheme(flywheelTheme, "dark")
    const rgb = (color: RGBA) => [
      Math.round(color.r * 255),
      Math.round(color.g * 255),
      Math.round(color.b * 255),
    ]
    expect(rgb(theme.success)).toEqual([108, 184, 110])
    expect(rgb(theme.markdownCode)).toEqual([169, 207, 164])
    expect(rgb(theme.chatCodeString)).toEqual([169, 207, 164])
  })

  it("resolves all color tokens to valid RGBA in dark mode", () => {
    const theme = resolveTheme(flywheelTheme, "dark")
    for (const key of EXPECTED_KEYS) {
      if (key === "thinkingOpacity") continue
      expect(theme[key]).toBeInstanceOf(RGBA)
    }
  })

  it("resolves all color tokens to valid RGBA in light mode", () => {
    const theme = resolveTheme(flywheelTheme, "light")
    for (const key of EXPECTED_KEYS) {
      if (key === "thinkingOpacity") continue
      expect(theme[key]).toBeInstanceOf(RGBA)
    }
  })

  it("resolved theme key count matches expected token count", () => {
    const theme = resolveTheme(flywheelTheme, "dark")
    const resolvedKeys = Object.keys(theme).sort()
    const expectedSorted = [...EXPECTED_KEYS].sort()
    expect(resolvedKeys).toEqual(expectedSorted)
  })

  it("JSON theme keys match expected token list (excluding computed + optional tokens)", () => {
    // Resolver-owned (computed) keys are absent from theme JSON; optional keys may be present.
    const optional = new Set<string>(["thinkingOpacity", "selectedListItemText", "backgroundMenu"])
    const jsonKeys = Object.keys(flywheelTheme.theme).filter(k => !optional.has(k)).sort()
    const computed = new Set<string>(["primaryBright", "textBright", "backgroundRaised", "selectionBackground", "selectionForeground", "sessionMessage", "phaseName", "agentName", ...optional])
    const expectedJsonKeys = [...EXPECTED_KEYS].filter(k => !computed.has(k)).sort()
    expect(jsonKeys).toEqual(expectedJsonKeys)
  })

  it("marks a message from another session in info, or in another color where info matches the person's bar", () => {
    for (const mode of ["dark", "light"] as const) {
      const flywheel = resolveTheme(flywheelTheme, mode)
      expect(flywheel.sessionMessage).toEqual(flywheel.info)
      // Charcoal's info and secondary are one color, so the derived color moves off it.
      const charcoal = resolveTheme(charcoalTheme, mode)
      expect(charcoal.info).toEqual(charcoal.secondary)
      expect(charcoal.sessionMessage).not.toEqual(charcoal.secondary)
    }
  })

  it("names a workflow's phases and agents in two colours that no state of an agent uses, in every bundled theme", () => {
    const hue = (color: RGBA) => {
      const { c, h } = rgbToOklch({ r: color.r * 255, g: color.g * 255, b: color.b * 255 })
      return c < 0.03 ? undefined : h
    }
    const gap = (a: RGBA, b: RGBA) => {
      const [ha, hb] = [hue(a), hue(b)]
      return ha === undefined || hb === undefined ? 180 : Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb))
    }
    for (const [id, json] of Object.entries(THEMES)) {
      if (json === "system") continue
      for (const mode of ["dark", "light"] as const) {
        const theme = resolveTheme(json, mode)
        // Running, done, failed, and interrupted.
        for (const state of [theme.primary, theme.success, theme.error, theme.warning]) {
          expect({ id, mode, phase: gap(theme.phaseName, state) >= 40, agent: gap(theme.agentName, state) >= 40 }).toEqual({ id, mode, phase: true, agent: true })
        }
        expect({ id, mode, apart: gap(theme.phaseName, theme.agentName) >= 40 }).toEqual({ id, mode, apart: true })
      }
    }
    // The default theme's secondary is a light red beside its failed red, so
    // its phases read violet, as the web client's do; its teal accent
    // already reads apart from every state.
    const flywheel = resolveTheme(flywheelTheme, "dark")
    expect(hue(flywheel.phaseName)).toBeGreaterThan(280)
    expect(hue(flywheel.phaseName)).toBeLessThan(330)
    expect(flywheel.agentName).toEqual(flywheel.accent)
    // A theme whose secondary and accent read apart from every state keeps them.
    const github = resolveTheme(githubTheme, "dark")
    expect([github.phaseName, github.agentName]).toEqual([github.secondary, github.accent])
  })

  it("uses global chrome border colors by mode across themes", () => {
    const darkBorder = RGBA.fromHex("#e5e9f0")
    const darkBorderSubtle = RGBA.fromHex("#8b95a7")
    const lightBorder = RGBA.fromHex("#2e3440")
    const lightBorderSubtle = RGBA.fromHex("#4c566a")

    expect(resolveTheme(flywheelTheme, "dark").border).toEqual(darkBorder)
    expect(resolveTheme(flywheelTheme, "dark").borderSubtle).toEqual(darkBorderSubtle)
    expect(resolveTheme(flywheelTheme, "light").border).toEqual(lightBorder)
    expect(resolveTheme(flywheelTheme, "light").borderSubtle).toEqual(lightBorderSubtle)
    expect(resolveTheme(twilightTheme, "dark").border).toEqual(darkBorder)
    expect(resolveTheme(twilightTheme, "dark").borderSubtle).toEqual(darkBorderSubtle)
  })
})

describe("style resolution", () => {
  it("returns defaults when theme has no styles section", () => {
    const styles = resolveStyles(styledTheme())
    expect(styles.heading).toEqual({ bold: true })
    expect(styles.chatCodeComment).toEqual({ italic: true })
    expect(styles.chatCodeKeyword).toEqual({ italic: true })
    expect(styles.chatCodeKeywordType).toEqual({ bold: true, italic: true })
    expect(styles.blockquote).toEqual({ italic: true })
    expect(styles.link).toEqual({ underline: true })
  })

  it("minimal dark theme suppresses italic on comments and keywords", () => {
    const styles = resolveStyles(twilightTheme)
    expect(styles.chatCodeComment).toEqual({})
    expect(styles.chatCodeKeyword).toEqual({})
    expect(styles.chatCodeKeywordType).toEqual({ bold: true })
  })

  it("minimal dark theme removes blockquote italic", () => {
    const styles = resolveStyles(twilightTheme)
    expect(styles.blockquote).toEqual({})
  })

  it("minimal dark theme differentiates heading levels", () => {
    const styles = resolveStyles(twilightTheme)
    expect(styles.heading).toEqual({})
    expect(styles.heading1).toEqual({ bold: true, underline: true })
    expect(styles.heading2).toEqual({ bold: true })
    expect(styles.heading3).toEqual({ bold: true, italic: true })
    expect(styles.heading4).toEqual({ italic: true })
    expect(styles.heading5).toEqual({ italic: true })
    expect(styles.heading6).toEqual({ italic: true })
  })

  it("heading inheritance: individual headings inherit from heading override", () => {
    const styles = resolveStyles(styledTheme({ heading: { italic: true } }))
    expect(styles.heading1).toEqual({ italic: true })
    expect(styles.heading6).toEqual({ italic: true })
  })

  it("heading inheritance: individual override wins over heading base", () => {
    const styles = resolveStyles(styledTheme({ heading: {}, heading3: { bold: true } }))
    expect(styles.heading1).toEqual({})
    expect(styles.heading3).toEqual({ bold: true })
  })

  it("chat code keyword type inherits from the chat code keyword override", () => {
    const styles = resolveStyles(styledTheme({ chatCodeKeyword: {} }))
    expect(styles.chatCodeKeywordType).toEqual({})
  })

  it("explicit chat code keyword type wins over the chat code keyword base", () => {
    const styles = resolveStyles(styledTheme({ chatCodeKeyword: {}, chatCodeKeywordType: { bold: true } }))
    expect(styles.chatCodeKeyword).toEqual({})
    expect(styles.chatCodeKeywordType).toEqual({ bold: true })
  })

  it("link inheritance: linkLabel inherits from link override", () => {
    const styles = resolveStyles(styledTheme({ link: {} }))
    expect(styles.linkLabel).toEqual({})
  })

  it("minimal dark theme adds strikethrough modifier", () => {
    const styles = resolveStyles(twilightTheme)
    expect(styles.strikethrough).toEqual({ strikethrough: true })
  })
})
