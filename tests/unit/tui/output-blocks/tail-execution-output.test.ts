import { describe, expect, it } from "bun:test"
import { tailExecutionOutputLines } from "@tui/output-blocks/tool-entry-helpers.js"

describe("tailExecutionOutputLines", () => {
  it("returns all lines under the bound", () => {
    const content = Array.from({ length: 1000 }, (_, i) => `line-${i + 1}`).join("\n")
    expect(tailExecutionOutputLines(content)).toHaveLength(1000)
  })

  it("silently keeps only the last 1000 lines past the bound", () => {
    const content = Array.from({ length: 1250 }, (_, i) => `line-${i + 1}`).join("\n")
    const lines = tailExecutionOutputLines(content)
    expect(lines).toHaveLength(1000)
    expect(lines[0]).toBe("line-251")
    expect(lines.at(-1)).toBe("line-1250")
  })

  it("returns no lines for missing content", () => {
    expect(tailExecutionOutputLines(undefined)).toEqual([])
    expect(tailExecutionOutputLines("")).toEqual([])
  })
})
