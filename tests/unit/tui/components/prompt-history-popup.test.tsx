/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { createRoot } from "solid-js"
import { createComposerHistoryPopup, type ComposerHistoryPopupHook } from "../../../../src/tui/hooks/create-composer-history-popup.js"

const WIDTH = 40

async function renderPopup(entries: readonly string[]) {
  const [{ ComposerHistoryPopup }, { ThemeProvider }] = await Promise.all([
    import("../../../../src/tui/components/composer-history-popup.js"),
    import("../../../../src/tui/context/theme.js"),
  ])
  let hook!: ComposerHistoryPopupHook
  let disposeRoot!: () => void
  createRoot((dispose) => {
    disposeRoot = dispose
    hook = createComposerHistoryPopup({ entries: () => entries })
  })
  hook.open()
  const activations: number[] = []
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(ComposerHistoryPopup, {
          history: hook,
          width: () => WIDTH,
          onActivate: (index: number) => { activations.push(index) },
        })
      },
    }),
    { width: WIDTH, height: 6 },
  )
  await result.renderOnce()
  return { result, hook, activations, dispose: disposeRoot }
}

describe("ComposerHistoryPopup", () => {
  it("renders entries oldest-first with the newest on the bottom row", async () => {
    const { result, dispose } = await renderPopup(["oldest", "middle", "newest"])
    try {
      const lines = result.captureCharFrame().split("\n")
      expect(lines[0]).toContain("oldest")
      expect(lines[1]).toContain("middle")
      expect(lines[2]).toContain("newest")
    } finally {
      result.renderer.destroy()
      dispose()
    }
  })

  it("flattens multiline entries to one presentation row", async () => {
    const { result, dispose } = await renderPopup(["line one\n  line two"])
    try {
      const frame = result.captureCharFrame()
      expect(frame).toContain("line one line two")
    } finally {
      result.renderer.destroy()
      dispose()
    }
  })

  it("ellipsizes rows wider than the popup", async () => {
    const { result, dispose } = await renderPopup(["x".repeat(WIDTH + 20)])
    try {
      expect(result.captureCharFrame()).toContain("…")
    } finally {
      result.renderer.destroy()
      dispose()
    }
  })

  it("activates the absolute row index on row press", async () => {
    const { result, activations, dispose } = await renderPopup(["a", "b", "c"])
    try {
      await result.mockMouse.pressDown(2, 1)
      await result.mockMouse.release(2, 1)
      expect(activations).toEqual([1])
    } finally {
      result.renderer.destroy()
      dispose()
    }
  })

  it("colors the selected row differently from unselected rows", async () => {
    const { result, dispose } = await renderPopup(["older entry", "newest entry"])
    try {
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const selected = spans.find((span) => span.text.includes("newest entry"))
      const unselected = spans.find((span) => span.text.includes("older entry"))
      expect(selected).toBeDefined()
      expect(unselected).toBeDefined()
      expect(selected?.fg).not.toEqual(unselected?.fg)
    } finally {
      result.renderer.destroy()
      dispose()
    }
  })
})
