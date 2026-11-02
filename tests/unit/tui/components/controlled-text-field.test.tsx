/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { createTextAttributes, RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { ControlledTextField } from "../../../../src/tui/components/controlled-text-field.js"

describe("ControlledTextField", () => {
  it("renders one line from caller-owned value and marks the focused cursor", async () => {
    const result = await testRender(() => (
      <ControlledTextField presentation={{ value: "abc", cursor: 1, selection: null, preferredVisualColumn: null }} focused placeholder="Search" width={8} />
    ), { width: 8, height: 1 })

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("abc")
      expect(result.captureCharFrame()).not.toContain("Search")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a placeholder without storing text", async () => {
    const result = await testRender(() => (
      <ControlledTextField presentation={{ value: "", cursor: 0, selection: null, preferredVisualColumn: null }} focused={false} placeholder="Search" width={8} />
    ), { width: 8, height: 1 })

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Search")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a caret when an empty field is focused", async () => {
    const result = await testRender(() => (
      <ControlledTextField presentation={{ value: "", cursor: 0, selection: null, preferredVisualColumn: null }} focused placeholder="Search" width={8} />
    ), { width: 8, height: 1 })

    try {
      await result.renderOnce()
      const inverse = createTextAttributes({ inverse: true })
      expect(result.captureSpans().lines.flatMap((line) => line.spans).some((span) => (span.attributes & inverse) !== 0)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders resolver-owned selection colors", async () => {
    const foreground = RGBA.fromHex("#ffffff")
    const background = RGBA.fromHex("#0055aa")
    const result = await testRender(() => (
      <ControlledTextField presentation={{ value: "alpha", cursor: 5, selection: { start: 1, end: 5 }, preferredVisualColumn: null }} focused width={8} selectionForeground={foreground} selectionBackground={background} />
    ), { width: 8, height: 1 })
    try {
      await result.renderOnce()
      const selected = result.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.bg.equals(background))
      expect(selected.map((span) => span.text).join("")).toContain("lpha")
      expect(selected.every((span) => span.fg.equals(foreground))).toBe(true)
    } finally { result.renderer.destroy() }
  })

  it("keeps a leftward selection contiguous at its cursor edge", async () => {
    const foreground = RGBA.fromHex("#ffffff")
    const background = RGBA.fromHex("#0055aa")
    const result = await testRender(() => (
      <ControlledTextField presentation={{ value: "alpha", cursor: 1, selection: { start: 1, end: 5 }, preferredVisualColumn: null }} focused width={8} selectionForeground={foreground} selectionBackground={background} />
    ), { width: 8, height: 1 })
    try {
      await result.renderOnce()
      const selected = result.captureSpans().lines.flatMap((line) => line.spans).filter((span) => span.bg.equals(background))
      expect(selected.map((span) => span.text).join("")).toContain("lpha")
    } finally { result.renderer.destroy() }
  })

  it("keeps either end caret visible for over-width values and does not split wide graphemes", async () => {
    for (const [cursor, expected] of [[0, "ab"], [10, "ij"]] as const) {
      const result = await testRender(() => <ControlledTextField presentation={{ value: "abcdefghij", cursor, selection: null, preferredVisualColumn: null }} focused width={3} />, { width: 3, height: 1 })
      try { await result.renderOnce(); expect(result.captureCharFrame()).toContain(expected) } finally { result.renderer.destroy() }
    }
    const wide = await testRender(() => <ControlledTextField presentation={{ value: "ab👩‍💻cd", cursor: 2, selection: null, preferredVisualColumn: null }} focused width={4} />, { width: 4, height: 1 })
    try { await wide.renderOnce(); expect(wide.captureCharFrame()).toContain("👩‍💻") } finally { wide.renderer.destroy() }
  })
})
