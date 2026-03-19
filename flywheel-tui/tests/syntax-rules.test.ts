import { describe, it, expect } from "bun:test"
import { RGBA } from "@opentui/core"
import { getSyntaxRules } from "../src/tui/shared/context/syntax-rules"
import { resolveTheme } from "../src/tui/shared/context/theme/resolve"
import flywheelTheme from "../src/tui/shared/context/theme/flywheel.json" with { type: "json" }

const darkTheme = resolveTheme(flywheelTheme as any, "dark")
const lightTheme = resolveTheme(flywheelTheme as any, "light")

describe("getSyntaxRules", () => {
  it("returns a non-empty array for dark theme", () => {
    const rules = getSyntaxRules(darkTheme)
    expect(Array.isArray(rules)).toBe(true)
    expect(rules.length).toBeGreaterThan(0)
  })

  it("returns a non-empty array for light theme", () => {
    const rules = getSyntaxRules(lightTheme)
    expect(Array.isArray(rules)).toBe(true)
    expect(rules.length).toBeGreaterThan(0)
  })

  it("every rule has scope as string[] and style.foreground as RGBA", () => {
    const rules = getSyntaxRules(darkTheme)
    for (const rule of rules) {
      expect(Array.isArray(rule.scope)).toBe(true)
      expect(rule.scope.length).toBeGreaterThan(0)
      for (const s of rule.scope) {
        expect(typeof s).toBe("string")
      }
      expect(rule.style.foreground).toBeInstanceOf(RGBA)
    }
  })

  it("background values are RGBA when present", () => {
    const rules = getSyntaxRules(darkTheme)
    for (const rule of rules) {
      if (rule.style.background !== undefined) {
        expect(rule.style.background).toBeInstanceOf(RGBA)
      }
    }
  })

  it("includes expected core scopes", () => {
    const rules = getSyntaxRules(darkTheme)
    const allScopes = rules.flatMap((r) => r.scope)
    expect(allScopes).toContain("default")
    expect(allScopes).toContain("comment")
    expect(allScopes).toContain("string")
    expect(allScopes).toContain("keyword")
    expect(allScopes).toContain("type")
    expect(allScopes).toContain("markup.heading")
    expect(allScopes).toContain("diff.plus")
    expect(allScopes).toContain("diff.minus")
    expect(allScopes).toContain("error")
  })

  it("dark and light themes produce different foreground colors", () => {
    const darkRules = getSyntaxRules(darkTheme)
    const lightRules = getSyntaxRules(lightTheme)
    // Same number of rules
    expect(darkRules.length).toBe(lightRules.length)
    // At least some foreground colors should differ between dark and light
    let hasDifference = false
    for (let i = 0; i < darkRules.length; i++) {
      const df = darkRules[i].style.foreground
      const lf = lightRules[i].style.foreground
      if (!df.equals(lf)) {
        hasDifference = true
        break
      }
    }
    expect(hasDifference).toBe(true)
  })
})

// SyntaxStyle.fromTheme() requires OpenTUI's native runtime.
// Unit tests don't render OpenTUI, so we guard this test.
describe("SyntaxStyle integration", () => {
  it("SyntaxStyle.fromTheme() produces a non-null instance (requires native runtime)", () => {
    let SyntaxStyle: any
    try {
      SyntaxStyle = require("@opentui/core").SyntaxStyle
    } catch {
      console.log("  [skipped] SyntaxStyle not available in test environment")
      return
    }
    if (!SyntaxStyle || typeof SyntaxStyle.fromTheme !== "function") {
      console.log("  [skipped] SyntaxStyle.fromTheme not available")
      return
    }
    const rules = getSyntaxRules(darkTheme)
    let instance: any
    try {
      instance = SyntaxStyle.fromTheme(rules)
      expect(instance).toBeDefined()
      expect(instance).not.toBeNull()
    } finally {
      if (instance && typeof instance.destroy === "function") {
        instance.destroy()
      }
    }
  })
})
