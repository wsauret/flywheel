/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createComponent } from "solid-js/web"
import { createSignal } from "solid-js"
import type { ModalSelectOption } from "../../../../src/tui/components/modal-select-types.js"
import type { SlashSuggestionsHook } from "../../../../src/tui/hooks/create-slash-suggestions.js"

const WIDTH = 60

function makeOptions(count: number): ModalSelectOption[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `cmd-${String(i).padStart(2, "0")}`,
    value: `/cmd-${String(i).padStart(2, "0")}`,
    title: `Command ${i}`,
    // Long enough to overrun the scrollbar's reserved columns if rows were
    // not width-clipped.
    description: `Description ${i}`.padEnd(80, "x"),
  }))
}

/** Signal-backed stand-in for the suggestions hook; selection semantics match
 *  the real hook (clamped select, wrapping moveSelection). */
function makeHook(initialOptions: ModalSelectOption[]): SlashSuggestionsHook & { selected: () => number; setOptions: (options: ModalSelectOption[]) => void } {
  const [selected, setSelected] = createSignal(0)
  const [options, setOptions] = createSignal(initialOptions)
  return {
    visible: () => true,
    matches: options,
    selectedIndex: selected,
    moveSelection: (delta) => setSelected((s) => (s + delta + options().length) % options().length),
    select: (index) => {
      if (index >= 0 && index < options().length) setSelected(index)
    },
    completedText: () => undefined,
    dismiss: () => {},
    selected,
    setOptions,
  }
}

async function renderSuggestions(count: number, options = makeOptions(count)) {
  const [{ SlashSuggestions }, { ThemeProvider }] = await Promise.all([
    import("../../../../src/tui/components/slash-suggestions.js"),
    import("../../../../src/tui/context/theme.js"),
  ])
  const hook = makeHook(options)
  const activations: number[] = []
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(SlashSuggestions, {
          suggestions: hook,
          width: () => WIDTH,
          onActivate: (index: number) => { activations.push(index) },
        })
      },
    }),
    { width: WIDTH, height: 6 },
  )
  await result.renderOnce()
  return { result, hook, activations }
}

const BAR_X = WIDTH - 1

describe("slash suggestions scrollbar", () => {
  it("shows no scrollbar when all matches fit", async () => {
    const { result, activations } = await renderSuggestions(5)
    try {
      expect(result.captureCharFrame()).not.toMatch(/[█▀▄]/)
      await result.mockMouse.pressDown(BAR_X, 2)
      await result.mockMouse.release(BAR_X, 2)
      expect(activations).toEqual([2])
    } finally {
      result.renderer.destroy()
    }
  })

  it("jumps the window when the bar is pressed, without activating the row", async () => {
    const { result, hook, activations } = await renderSuggestions(20)
    try {
      expect(result.captureCharFrame()).toMatch(/[█▀▄]/)
      // The blank gap column left of the track cell is part of the bar's hit
      // area: it must jump the selection, never activate the row under it.
      await result.mockMouse.pressDown(BAR_X - 2, 4)
      expect(hook.selected()).toBe(19)
      await result.mockMouse.release(BAR_X - 2, 4)
      await result.mockMouse.pressDown(BAR_X, 0)
      expect(hook.selected()).toBe(0)
      await result.mockMouse.release(BAR_X, 0)
      expect(activations).toEqual([])
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps drag capture outside the bar while filtering hides and restores it", async () => {
    const { result, hook, activations } = await renderSuggestions(20)
    try {
      await result.mockMouse.pressDown(BAR_X, 0)
      expect(hook.selected()).toBe(0)
      // OpenTUI sends motion to the pressed bar even outside its columns.
      await result.mockMouse.moveTo(10, 2)
      expect(hook.selected()).toBe(10)
      await result.renderOnce()
      hook.setOptions(makeOptions(4))
      await result.renderOnce()
      hook.setOptions(makeOptions(20))
      await result.renderOnce()
      await result.mockMouse.moveTo(10, 4)
      expect(hook.selected()).toBe(19)
      await result.mockMouse.release(10, 4)
      expect(activations).toEqual([])
    } finally {
      result.renderer.destroy()
    }
  })

  it("windows five rows and recenters the window on the selection", async () => {
    const { result, hook } = await renderSuggestions(20)
    try {
      const frame = result.captureCharFrame()
      expect(frame).toContain("/cmd-00")
      expect(frame).toContain("/cmd-04")
      expect(frame).not.toContain("/cmd-05")
      hook.select(10)
      await result.renderOnce()
      const centered = result.captureCharFrame()
      expect(centered).toContain("/cmd-08")
      expect(centered).toContain("/cmd-12")
      expect(centered).not.toContain("/cmd-07")
      expect(centered).not.toContain("/cmd-13")
    } finally {
      result.renderer.destroy()
    }
  })

  it("colors the selected row differently from unselected rows", async () => {
    const { result } = await renderSuggestions(5)
    try {
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const selected = spans.find((span) => span.text.includes("/cmd-00"))
      const unselected = spans.find((span) => span.text.includes("/cmd-01"))
      expect(selected).toBeDefined()
      expect(unselected).toBeDefined()
      expect(selected?.fg).not.toEqual(unselected?.fg)
      expect(selected?.attributes).not.toBe(unselected?.attributes)
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows a command's aliases beside its token, and a row without aliases by its value", async () => {
    const options: ModalSelectOption[] = [
      { id: "model-and-effort", value: "/model-and-effort", title: "Model and effort", description: "Edit the model", footer: "/model-and-effort /effort" },
      { id: "review", value: "/review", title: "Review", description: "[Skill] Review" },
    ]
    const { result } = await renderSuggestions(2, options)
    try {
      const rows = result.captureSpans().lines.map((line) => line.spans.map((span) => span.text).join(""))
      expect(rows[0]).toStartWith("/model-and-effort /effort  Edit the model")
      // The column fits the widest tokens, so a row without aliases aligns under it.
      expect(rows[1]).toStartWith(`${"/review".padEnd("/model-and-effort /effort".length)}  [Skill] Review`)
    } finally {
      result.renderer.destroy()
    }
  })

  it("moves the selection one step per wheel notch", async () => {
    const { result, hook } = await renderSuggestions(20)
    try {
      await result.mockMouse.scroll(10, 2, "down")
      expect(hook.selected()).toBe(1)
      await result.mockMouse.scroll(10, 2, "down")
      expect(hook.selected()).toBe(2)
      await result.mockMouse.scroll(10, 2, "up")
      expect(hook.selected()).toBe(1)
    } finally {
      result.renderer.destroy()
    }
  })

  it("activates the absolute row index on row press", async () => {
    const { result, hook, activations } = await renderSuggestions(20)
    try {
      await result.mockMouse.pressDown(2, 3)
      await result.mockMouse.release(2, 3)
      expect(activations).toEqual([3])
      hook.select(10)
      await result.renderOnce()
      await result.mockMouse.pressDown(2, 0)
      await result.mockMouse.release(2, 0)
      expect(activations).toEqual([3, 8])
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the scrollbar's reserved cells free of row text", async () => {
    const { result } = await renderSuggestions(20)
    try {
      const lines = result.captureCharFrame().split("\n").slice(0, 5)
      for (const line of lines) {
        // Two gap columns before the track cell belong to the bar; rows are
        // clipped so their text never renders under them.
        expect(line[BAR_X - 2]).toBe(" ")
        expect(line[BAR_X - 1]).toBe(" ")
        expect(line[BAR_X]).toMatch(/[ ▀▄]/)
      }
    } finally {
      result.renderer.destroy()
    }
  })
})
