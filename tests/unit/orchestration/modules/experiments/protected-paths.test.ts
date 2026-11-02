import { describe, expect, it } from "bun:test"
import { isCharterPathMatch, charterPathConflict } from "../../../../../src/orchestration/modules/experiments/protected-paths.js"

describe("experiment charter paths", () => {
  const root = "/repo/work"
  it("matches exact, directory, prefix, glob, and absolute-contained paths", () => {
    expect(isCharterPathMatch("tests/a.ts", ["tests/**"], root)).toBe(true)
    expect(isCharterPathMatch("docs", ["docs"], root)).toBe(true)
    expect(isCharterPathMatch("docs/a.md", ["docs"], root)).toBe(true)
    expect(isCharterPathMatch("fixture-a/x", ["fixture-*"], root)).toBe(true)
    expect(isCharterPathMatch("/repo/work/tests/a.ts", ["tests/**"], root)).toBe(true)
    expect(isCharterPathMatch("/repo/other/tests/a.ts", ["tests/**"], root)).toBe(false)
  })
  it("detects sealed traversal but permits a disjoint root", () => {
    expect(charterPathConflict(".", ["secrets/**"], root)).toBe("secrets/**")
    expect(charterPathConflict("src", ["secrets/**"], root)).toBeNull()
  })
})
