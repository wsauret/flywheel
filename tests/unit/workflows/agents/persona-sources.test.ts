import { describe, expect, test } from "bun:test"

import { loadPersonaSources } from "../../../../src/workflows/agents/persona-sources.js"

describe("persona sources", () => {
  test("preserves nested persona source paths for defaults publication", () => {
    const agents = loadPersonaSources()

    expect(Object.keys(agents).length).toBeGreaterThan(0)
    expect(agents["explorer.md"]).toContain("name: explorer")
    expect(Object.keys(agents).every((path) => !path.startsWith("/"))).toBe(true)
  })
})
