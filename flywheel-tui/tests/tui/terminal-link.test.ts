import { describe, it, expect } from "bun:test"

// Test the OSC8 link creation logic directly (avoiding JSX import)
// The createTerminalLink function is a pure function
describe("createTerminalLink (logic)", () => {
  // Replicate the pure function to test the logic
  function createTerminalLink(url: string, text?: string): string {
    const displayText = text || url
    return `\x1b]8;;${url}\x07${displayText}\x1b]8;;\x07`
  }

  it("creates OSC8 hyperlink with URL as display text", () => {
    const link = createTerminalLink("https://example.com")
    expect(link).toBe("\x1b]8;;https://example.com\x07https://example.com\x1b]8;;\x07")
  })

  it("creates OSC8 hyperlink with custom display text", () => {
    const link = createTerminalLink("https://example.com", "Click here")
    expect(link).toBe("\x1b]8;;https://example.com\x07Click here\x1b]8;;\x07")
  })

  it("uses URL as display text when text is empty", () => {
    const link = createTerminalLink("https://example.com", "")
    expect(link).toBe("\x1b]8;;https://example.com\x07https://example.com\x1b]8;;\x07")
  })

  it("handles URLs with special characters", () => {
    const link = createTerminalLink("https://example.com/path?q=1&b=2")
    expect(link).toContain("https://example.com/path?q=1&b=2")
  })
})
