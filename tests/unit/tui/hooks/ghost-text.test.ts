import { describe, it, expect } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { createGhostText } from "../../../../src/tui/hooks/create-ghost-text.js"

describe("createGhostText", () => {
  it("returns completion suffix for unique prefix match", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/hel")
      const ghost = createGhostText(input, () => ["help", "sessions", "exit"])
      expect(ghost()).toBe("p")
      dispose()
    })
  })

  it("returns empty string for no matches", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/xyz")
      const ghost = createGhostText(input, () => ["help", "sessions"])
      expect(ghost()).toBe("")
      dispose()
    })
  })

  it("returns first match from the list for multiple matches", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/s")
      const ghost = createGhostText(input, () => ["ship", "sessions"])
      expect(ghost()).toBe("hip")
      dispose()
    })
  })

  it("returns empty string when input contains a space", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/help me")
      const ghost = createGhostText(input, () => ["help"])
      expect(ghost()).toBe("")
      dispose()
    })
  })

  it("returns empty string for exact match", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/help")
      const ghost = createGhostText(input, () => ["help"])
      expect(ghost()).toBe("")
      dispose()
    })
  })

  it("case-insensitive matching", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/HEL")
      const ghost = createGhostText(input, () => ["help"])
      expect(ghost()).toBe("p")
      dispose()
    })
  })

  it("returns empty string for bare slash", () => {
    createRoot((dispose) => {
      const [input] = createSignal("/")
      const ghost = createGhostText(input, () => ["help", "sessions"])
      expect(ghost()).toBe("")
      dispose()
    })
  })

})
