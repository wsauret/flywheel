/**
 * Tests for session title generation.
 *
 * Tests the synchronous fallback behavior of generateSessionTitle —
 * the immediate callback fires with first-5-words before the async LLM call.
 * The LLM call itself isn't tested here (requires subprocess).
 */

import { describe, it, expect, mock } from "bun:test"
import { generateSessionTitle } from "../src/orchestration/session-title.js"

describe("generateSessionTitle — immediate fallback", () => {
  it("calls onTitle immediately with a short message as-is", () => {
    const titles: string[] = []
    generateSessionTitle("fix bug", (t) => titles.push(t))
    // Synchronous callback should have fired
    expect(titles.length).toBeGreaterThanOrEqual(1)
    expect(titles[0]).toBe("fix bug")
  })

  it("truncates to first 5 words", () => {
    const titles: string[] = []
    generateSessionTitle("What is the meaning of life and everything", (t) => titles.push(t))
    expect(titles[0]).toBe("What is the meaning of...")
  })

  it("adds ellipsis when word count exceeds 5", () => {
    const titles: string[] = []
    generateSessionTitle("one two three four five six", (t) => titles.push(t))
    expect(titles[0]).toBe("one two three four five...")
  })

  it("no ellipsis when exactly 5 words", () => {
    const titles: string[] = []
    generateSessionTitle("one two three four five", (t) => titles.push(t))
    expect(titles[0]).toBe("one two three four five")
  })

  it("truncates long words to 40 chars", () => {
    const titles: string[] = []
    generateSessionTitle("superlongword anotherlongword yetanotherlongword etc morestuff", (t) => titles.push(t))
    expect(titles[0].length).toBeLessThanOrEqual(40)
    expect(titles[0]).toEndWith("...")
  })

  it("trims whitespace", () => {
    const titles: string[] = []
    generateSessionTitle("  hello world  ", (t) => titles.push(t))
    expect(titles[0]).toBe("hello world")
  })

  it("single word returned as-is", () => {
    const titles: string[] = []
    generateSessionTitle("refactor", (t) => titles.push(t))
    expect(titles[0]).toBe("refactor")
  })
})
