import { describe, it, expect } from "bun:test"
import { parseCommand as parseHomeCommand } from "../src/tui/utils/command-parser"

describe("parseHomeCommand", () => {
  it('parses "/work path/to/plan.md" correctly', () => {
    const result = parseHomeCommand("/work path/to/plan.md")
    expect(result).toEqual({
      workflow: "work",
      args: { planPath: "path/to/plan.md" },
    })
  })

  it('parses "/plan create a new feature" correctly', () => {
    const result = parseHomeCommand("/plan create a new feature")
    expect(result).toEqual({
      workflow: "plan",
      args: { description: "create a new feature" },
    })
  })

  it('parses "/review" correctly', () => {
    const result = parseHomeCommand("/review")
    expect(result).toEqual({ workflow: "review", args: {} })
  })

  it('parses "/ship" correctly', () => {
    const result = parseHomeCommand("/ship")
    expect(result).toEqual({ workflow: "ship", args: {} })
  })

  it('parses "/debug fix failing test" correctly', () => {
    const result = parseHomeCommand("/debug fix failing test")
    expect(result).toEqual({
      workflow: "debug",
      args: { description: "fix failing test" },
    })
  })

  it('parses "/research how does auth work" correctly', () => {
    const result = parseHomeCommand("/research how does auth work")
    expect(result).toEqual({
      workflow: "research",
      args: { topic: "how does auth work" },
    })
  })

  it('parses "/exit" correctly', () => {
    const result = parseHomeCommand("/exit")
    expect(result).toEqual({ workflow: "exit", args: {} })
  })

  it('parses "/help" correctly', () => {
    const result = parseHomeCommand("/help")
    expect(result).toEqual({ workflow: "help", args: {} })
  })

  it('parses "/config" correctly', () => {
    const result = parseHomeCommand("/config")
    expect(result).toEqual({ workflow: "config", args: {} })
  })

  it("returns null for bare text (must use slash command)", () => {
    const result = parseHomeCommand("path/to/file.md")
    expect(result).toBeNull()
  })

  it("returns null for unknown /command", () => {
    const result = parseHomeCommand("/unknown")
    expect(result).toBeNull()
  })

  it("returns null for empty string", () => {
    const result = parseHomeCommand("")
    expect(result).toBeNull()
  })

  it("returns null for whitespace-only string", () => {
    const result = parseHomeCommand("   ")
    expect(result).toBeNull()
  })

  it("is case-insensitive for commands", () => {
    const result = parseHomeCommand("/WORK my-plan.md")
    expect(result).toEqual({
      workflow: "work",
      args: { planPath: "my-plan.md" },
    })
  })

  it("trims whitespace around input", () => {
    const result = parseHomeCommand("  /review  ")
    expect(result).toEqual({ workflow: "review", args: {} })
  })

  it('parses "/work" with no args as empty args', () => {
    const result = parseHomeCommand("/work")
    expect(result).toEqual({ workflow: "work", args: {} })
  })

  it('parses "/plan" with no args as empty args', () => {
    const result = parseHomeCommand("/plan")
    expect(result).toEqual({ workflow: "plan", args: {} })
  })

  it('parses "/debug" with no args as empty args', () => {
    const result = parseHomeCommand("/debug")
    expect(result).toEqual({ workflow: "debug", args: {} })
  })

  it('parses "/research" with no args as empty args', () => {
    const result = parseHomeCommand("/research")
    expect(result).toEqual({ workflow: "research", args: {} })
  })

  it('parses "/new" correctly', () => {
    const result = parseHomeCommand("/new")
    expect(result).toEqual({ workflow: "new", args: {} })
  })

  it("derives valid commands from COMMANDS array (sync check)", () => {
    // All COMMANDS entries should be parseable
    const { COMMANDS } = require("../src/tui/config/commands")
    for (const cmd of COMMANDS) {
      const name = cmd.name // e.g., "/work"
      const result = parseHomeCommand(name)
      expect(result).not.toBeNull()
      expect(result!.workflow).toBe(name.slice(1))
    }
  })
})
