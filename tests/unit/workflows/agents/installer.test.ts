import { describe, expect, test } from "bun:test"

import { loadAgentDefaults } from "../../../../src/workflows/agents/installer.js"

describe("agent defaults", () => {
  test("preserves nested persona source paths for defaults publication", () => {
    const agents = loadAgentDefaults()

    expect(Object.keys(agents).length).toBeGreaterThan(0)
    expect(agents["explorer.md"]).toContain("name: explorer")
    expect(Object.keys(agents).every((path) => !path.startsWith("/"))).toBe(true)
  })
})
