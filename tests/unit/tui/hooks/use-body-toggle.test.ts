import { describe, expect, it } from "bun:test"
import { BoxRenderable, MouseEvent, ScrollBoxRenderable, TextBufferRenderable, TextRenderable } from "@opentui/core"
import { createComponent } from "solid-js/web"
import type { ClickToggleHook } from "../../../../src/tui/hooks/use-body-toggle.js"
import { hitsDrawnContent, hitsLabel } from "../../../../src/tui/utils/content-hit.js"

/** A press on the first glyph of `target`, a text drawn at the origin. */
function pressAt(target: TextRenderable): MouseEvent {
  return new MouseEvent(target, { type: "up", button: 0, x: 0, y: 0, modifiers: { shift: false, alt: false, ctrl: false } })
}

async function mountToggle(
  which: "body" | "header" | "unified",
  clickable: () => boolean,
  height = 3,
  hits?: (event: MouseEvent) => boolean,
) {
  const [{ testRender }, { ThemeProvider }, toggleModule] = await Promise.all([
    import("@opentui/solid"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/hooks/use-body-toggle.js"),
  ])
  let toggles = 0
  let hook: ClickToggleHook | undefined
  const Probe = () => {
    const toggle = () => { toggles += 1 }
    hook = which === "unified"
      ? toggleModule.useUnifiedToggle(clickable, toggle, () => toggles % 2 === 1, hits)
      : (which === "body" ? toggleModule.useBodyToggle : toggleModule.useHeaderToggle)(clickable, toggle)
    return null
  }
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(Probe, {})
      },
    }),
    { width: 20, height },
  )
  if (!hook) throw new Error("probe did not mount")
  return { ...result, hook, toggles: () => toggles, dispose: () => result.renderer.destroy() }
}

/** Mounts a probe toggle with a drawn text whose first glyph its presses hit. */
async function mountPressedToggle(which: "body" | "header" | "unified", clickable: () => boolean) {
  const result = await mountToggle(which, clickable)
  const target = new TextRenderable(result.renderer, { content: "toggle" })
  result.renderer.root.add(target)
  await result.renderOnce()
  return { ...result, press: () => pressAt(target) }
}

describe("useClickToggle arming (click = down + up on the same element)", () => {
  it("toggles between header and body without a preceding pointer motion", async () => {
    const result = await mountToggle("unified", () => true)
    const target = new BoxRenderable(result.renderer, {
      width: 20, height: 3, flexDirection: "column",
      ...result.hook.handlers,
    })
    target.add(new TextRenderable(result.renderer, { content: "header", selectable: false }))
    const body = new TextRenderable(result.renderer, { content: "first body row\nsecond body row", selectable: true, visible: false })
    target.add(body)
    result.renderer.root.add(target)
    try {
      await result.renderOnce()
      for (const [count, x, y] of [[1, 2, 0], [2, 3, 2], [3, 2, 0]] as const) {
        await result.mockMouse.pressDown(x, y)
        await result.renderOnce()
        await result.mockMouse.release(x, y)
        expect(result.toggles()).toBe(count)
        body.visible = count % 2 === 1
        await result.renderOnce()
      }
      await result.mockMouse.pressDown(2, 0)
      await result.mockMouse.moveTo(19, 3)
      await result.mockMouse.release(2, 0)
      expect(result.toggles()).toBe(3)
    } finally {
      await result.renderer.destroy()
    }
  })

  it("toggles on mouse-up only after a mouse-down armed it", async () => {
    const { hook, press, toggles, dispose } = await mountPressedToggle("body", () => true)
    try {
      const bareUp = press()
      hook.handlers.onMouseUp(bareUp)
      expect(toggles()).toBe(0)
      expect(bareUp.propagationStopped).toBe(false)

      hook.handlers.onMouseDown(press())
      const click = press()
      hook.handlers.onMouseUp(click)
      expect(toggles()).toBe(1)
      expect(click.propagationStopped).toBe(true)
    } finally {
      dispose()
    }
  })

  it("consumes the armed state: a second mouse-up does not toggle", async () => {
    const { hook, press, toggles, dispose } = await mountPressedToggle("body", () => true)
    try {
      hook.handlers.onMouseDown(press())
      hook.handlers.onMouseUp(press())
      hook.handlers.onMouseUp(press())
      expect(toggles()).toBe(1)
    } finally {
      dispose()
    }
  })

  it("disarms on mouse-out, so a release after leaving the element never toggles", async () => {
    const { hook, press, toggles, dispose } = await mountPressedToggle("body", () => true)
    try {
      hook.handlers.onMouseDown(press())
      hook.handlers.onMouseOut(press())
      const up = press()
      hook.handlers.onMouseUp(up)
      expect(toggles()).toBe(0)
      expect(up.propagationStopped).toBe(false)
    } finally {
      dispose()
    }
  })

  it("lets an unarmed mouse-up bubble even when the body would swallow inert clicks", async () => {
    const { hook, press, toggles, dispose } = await mountPressedToggle("body", () => false)
    try {
      const unarmed = press()
      hook.handlers.onMouseUp(unarmed)
      expect(unarmed.propagationStopped).toBe(false)

      hook.handlers.onMouseDown(press())
      const armedInert = press()
      hook.handlers.onMouseUp(armedInert)
      expect(toggles()).toBe(0)
      expect(armedInert.propagationStopped).toBe(true)
    } finally {
      dispose()
    }
  })

  it("lets an armed inert header click fall through to enclosing toggles", async () => {
    const { hook, press, toggles, dispose } = await mountPressedToggle("header", () => false)
    try {
      hook.handlers.onMouseDown(press())
      const up = press()
      hook.handlers.onMouseUp(up)
      expect(toggles()).toBe(0)
      expect(up.propagationStopped).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("useClickToggle drawn-content extent", () => {
  async function mountExtent(content = "short   \n\nhello wonderful") {
    const result = await mountToggle("body", () => true, 5)
    const bubbled: string[] = []
    const shell = new BoxRenderable(result.renderer, { width: 20, height: 5, onMouseUp: (event: MouseEvent) => { bubbled.push(`${event.x},${event.y}`) } })
    const body = new BoxRenderable(result.renderer, {
      width: 20, height: 5, flexDirection: "column",
      ...result.hook.handlers,
    })
    // Rows: "short   " (trailing blanks), a blank line, then "hello " and
    // "wonderful", which word wrap splits at the text's 12 columns.
    body.add(new TextRenderable(result.renderer, { content, width: 12, wrapMode: "word", selectable: false }))
    shell.add(body)
    result.renderer.root.add(shell)
    await result.renderOnce()
    return { ...result, bubbled }
  }

  it("toggles on a line's glyphs and lets every press beside them bubble untouched", async () => {
    const result = await mountExtent()
    try {
      const misses = [[6, 0], [15, 0], [1, 1], [5, 2], [8, 2], [10, 3], [2, 4]] as const
      for (const [x, y] of misses) await result.mockMouse.click(x, y)
      expect(result.toggles()).toBe(0)
      expect(result.bubbled).toEqual(misses.map(([x, y]) => `${x},${y}`))
      for (const [x, y] of [[0, 0], [4, 0], [4, 2], [8, 3]] as const) await result.mockMouse.click(x, y)
      expect(result.toggles()).toBe(4)
      expect(result.bubbled).toHaveLength(misses.length)
    } finally {
      result.renderer.destroy()
    }
  })

  it("treats every Unicode space as blank after a line of wide glyphs", async () => {
    // "héllo 漢字" fills columns 0 through 9; an em space and an ideographic
    // space follow it.
    const result = await mountExtent("héllo 漢字\u2003\u3000")
    try {
      for (const x of [10, 11]) await result.mockMouse.click(x, 0)
      expect(result.toggles()).toBe(0)
      for (const x of [1, 9]) await result.mockMouse.click(x, 0)
      expect(result.toggles()).toBe(2)
    } finally {
      result.renderer.destroy()
    }
  })

  it("highlights only while the pointer is over a glyph, though it stays over the same text", async () => {
    const result = await mountExtent()
    try {
      const hovered: boolean[] = []
      for (const [x, y] of [[2, 0], [6, 0], [3, 2], [7, 2], [1, 1], [8, 3]] as const) {
        await result.mockMouse.moveTo(x, y)
        hovered.push(result.hook.hovered())
      }
      expect(hovered).toEqual([true, false, true, false, false, true])
    } finally {
      result.renderer.destroy()
    }
  })

  it("derives a text's drawn extents once per content change, however often the pointer moves", async () => {
    const result = await mountToggle("body", () => true, 2)
    const body = new BoxRenderable(result.renderer, { width: 20, height: 2, flexDirection: "column", ...result.hook.handlers })
    const text = new TextRenderable(result.renderer, { content: "hello there", selectable: false })
    let derivations = 0
    const plainText = Object.getOwnPropertyDescriptor(TextBufferRenderable.prototype, "plainText")!
    Object.defineProperty(text, "plainText", { get() { derivations += 1; return plainText.get!.call(text) } })
    body.add(text)
    result.renderer.root.add(body)
    try {
      await result.renderOnce()
      for (let pass = 0; pass < 5; pass++) {
        for (let x = 0; x < 20; x++) await result.mockMouse.moveTo(x, 0)
      }
      expect(derivations).toBe(1)
      text.content = "hi"
      await result.renderOnce()
      await result.mockMouse.moveTo(1, 0)
      expect(result.hook.hovered()).toBe(true)
      await result.mockMouse.moveTo(5, 0)
      expect(result.hook.hovered()).toBe(false)
      expect(derivations).toBe(2)
    } finally {
      result.renderer.destroy()
    }
  })

  it("updates the highlight when the content scrolls under a still pointer", async () => {
    const result = await mountToggle("body", () => true, 2)
    const scroll = new ScrollBoxRenderable(result.renderer, { width: 20, height: 2 })
    const body = new BoxRenderable(result.renderer, { width: 18, flexDirection: "column", ...result.hook.handlers })
    body.add(new TextRenderable(result.renderer, { content: "first long line\nx\nanother line\ny\nlast long line", selectable: false }))
    scroll.add(body)
    result.renderer.root.add(scroll)
    try {
      await result.renderOnce()
      await result.mockMouse.moveTo(8, 0)
      const seen: [string, boolean][] = []
      for (const top of [0, 1, 2, 3]) {
        scroll.scrollTop = top
        // The scroll box applies a new offset in the frame after it is set.
        await result.renderOnce()
        await result.renderOnce()
        seen.push([result.captureCharFrame().slice(0, 18).trimEnd(), result.hook.hovered()])
      }
      expect(seen).toEqual([["first long line", true], ["x", false], ["another line", true], ["y", false]])
    } finally {
      result.renderer.destroy()
    }
  })

  it("hovers and presses an inline control over its whole label, though its padding is blank", async () => {
    const content = "run \u00a0stop\u00a0"
    let row: TextRenderable | undefined = undefined
    const hits = (event: MouseEvent) => hitsLabel(event, row, content, "\u00a0stop\u00a0") || hitsDrawnContent(event)
    const result = await mountToggle("unified", () => true, 1, hits)
    const box = new BoxRenderable(result.renderer, { width: 20, height: 1, ...result.hook.handlers })
    row = new TextRenderable(result.renderer, { content, selectable: false })
    box.add(row)
    result.renderer.root.add(box)
    try {
      await result.renderOnce()
      await result.mockMouse.moveTo(9, 0)
      expect(result.hook.hovered()).toBe(true)
      await result.mockMouse.click(9, 0)
      expect(result.toggles()).toBe(1)
      await result.mockMouse.moveTo(10, 0)
      expect(result.hook.hovered()).toBe(false)
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("useClickToggle body area", () => {
  /** A header "head" with a body that holds "out" and a nested toggle: its
   *  heading "file" and its own body "ab", a blank line, and "cd". */
  async function mountNested() {
    const [{ testRender }, { ThemeProvider }, { useUnifiedToggle }] = await Promise.all([
      import("@opentui/solid"),
      import("../../../../src/tui/context/theme.js"),
      import("../../../../src/tui/hooks/use-body-toggle.js"),
    ])
    const toggles = { outer: 0, inner: 0 }
    let hooks: { outer: ClickToggleHook; inner: ClickToggleHook } | undefined
    const result = await testRender(
      () => createComponent(ThemeProvider, {
        mode: "dark",
        get children() {
          hooks = {
            outer: useUnifiedToggle(() => true, () => { toggles.outer += 1 }, () => true),
            inner: useUnifiedToggle(() => true, () => { toggles.inner += 1 }, () => true),
          }
          return null
        },
      }),
      { width: 20, height: 6 },
    )
    if (!hooks) throw new Error("probe did not mount")
    const { renderer } = result
    const text = (content: string) => new TextRenderable(renderer, { content, selectable: false })
    const outer = new BoxRenderable(renderer, { width: 20, flexDirection: "column", ...hooks.outer.handlers })
    const outerBody = new BoxRenderable(renderer, { flexDirection: "column", paddingLeft: 1 })
    const inner = new BoxRenderable(renderer, { flexDirection: "column", ...hooks.inner.handlers })
    const innerBody = new BoxRenderable(renderer, { flexDirection: "column" })
    hooks.outer.body(outerBody)
    hooks.inner.body(innerBody)
    innerBody.add(text("ab\n\ncd"))
    inner.add(text("file"))
    inner.add(innerBody)
    outerBody.add(text("out"))
    outerBody.add(inner)
    outer.add(text("head"))
    outer.add(outerBody)
    renderer.root.add(outer)
    await result.renderOnce()
    return { ...result, hooks, toggles }
  }

  it("toggles on every cell of a body, while the blank space beside a header does nothing", async () => {
    const result = await mountNested()
    try {
      await result.mockMouse.click(10, 0)
      expect(result.toggles).toEqual({ outer: 0, inner: 0 })
      // After the glyphs of "out", and on the body's padding column.
      for (const [x, y] of [[10, 1], [0, 1]] as const) await result.mockMouse.click(x, y)
      expect(result.toggles).toEqual({ outer: 2, inner: 0 })
    } finally {
      result.renderer.destroy()
    }
  })

  it("gives a click to the innermost body under the pointer, and the space beside a nested heading to the enclosing body", async () => {
    const result = await mountNested()
    try {
      // After "ab", then the blank line between "ab" and "cd".
      for (const [x, y] of [[10, 3], [3, 4]] as const) await result.mockMouse.click(x, y)
      expect(result.toggles).toEqual({ outer: 0, inner: 2 })
      await result.mockMouse.click(10, 2)
      expect(result.toggles).toEqual({ outer: 1, inner: 2 })
    } finally {
      result.renderer.destroy()
    }
  })

  it("highlights over a blank body line as over its text", async () => {
    const result = await mountNested()
    try {
      const hovered: [boolean, boolean][] = []
      // The blank line, the space after "ab", then the space after "head".
      for (const [x, y] of [[3, 4], [12, 3], [10, 0]] as const) {
        await result.mockMouse.moveTo(x, y)
        hovered.push([result.hooks.inner.hovered(), result.hooks.outer.hovered()])
      }
      expect(hovered.map(([inner]) => inner)).toEqual([true, true, false])
      expect(hovered[2]).toEqual([false, false])
    } finally {
      result.renderer.destroy()
    }
  })
})

async function selectableBody(clickable = true) {
  const [{ testRender }, { ThemeProvider }, { ToastProvider }, { useBodyToggle }, { useCopySelection }] = await Promise.all([
    import("@opentui/solid"),
    import("../../../../src/tui/context/theme.js"),
    import("../../../../src/tui/context/toast.js"),
    import("../../../../src/tui/hooks/use-body-toggle.js"),
    import("../../../../src/tui/hooks/use-copy-selection.js"),
  ])
  let hook: ClickToggleHook | undefined
  let copySelection: (() => boolean) | undefined
  let toggles = 0
  const copied: string[] = []
  const result = await testRender(
    () => createComponent(ThemeProvider, {
      mode: "dark",
      get children() {
        return createComponent(ToastProvider, {
          get children() {
            hook = useBodyToggle(() => clickable, () => { toggles += 1 })
            copySelection = useCopySelection({
              copy: async (text) => { copied.push(text) },
              readImage: async () => null,
            })
            return null
          },
        })
      },
    }),
    { width: 24, height: 2 },
  )
  if (!hook || !copySelection) throw new Error("probe did not mount")
  const body = new BoxRenderable(result.renderer, {
    width: 24,
    height: 2,
    ...hook.handlers,
  })
  const shell = new BoxRenderable(result.renderer, {
    width: 24,
    height: 2,
    onMouseUp: copySelection,
  })
  // The bound body takes every cell, so a drag over it still must not toggle.
  hook.body(body)
  const text = new TextRenderable(result.renderer, { content: "hello world", selectable: true })
  body.add(text)
  shell.add(body)
  result.renderer.root.add(shell)
  await result.renderOnce()
  return { ...result, toggles: () => toggles, copied, body, text }
}

describe("useBodyToggle native text selection", () => {
  for (const [from, to] of [[2, 3], [3, 2]] as const) {
    it(`treats inclusive one-cell jitter from ${from} to ${to} as a click`, async () => {
      const result = await selectableBody()
      try {
        await result.mockMouse.pressDown(from, 0)
        await result.mockMouse.moveTo(to, 0)
        expect(result.renderer.getSelection()?.getSelectedText()).toBe("ll")
        await result.mockMouse.release(to, 0)
        expect(result.toggles()).toBe(1)
        expect(result.copied).toEqual([])
      } finally {
        await result.renderer.destroy()
      }
    })
  }

  it("copies a long drag without toggling", async () => {
    const result = await selectableBody()
    try {
      await result.mockMouse.pressDown(1, 0)
      await result.mockMouse.moveTo(4, 0)
      await result.mockMouse.release(4, 0)
      expect(result.copied).toEqual(["ello"])
      expect(result.toggles()).toBe(0)
    } finally {
      await result.renderer.destroy()
    }
  })

  it("copies a stationary double-click word on an inert body without toggling", async () => {
    const result = await selectableBody(false)
    try {
      await result.mockMouse.pressDown(2, 0)
      await result.mockMouse.release(2, 0)
      await result.mockMouse.pressDown(2, 0)
      expect(result.renderer.getSelection()?.behavior).toBe("word")
      await result.mockMouse.release(2, 0)
      expect(result.copied).toEqual(["hello"])
      expect(result.toggles()).toBe(0)
    } finally {
      await result.renderer.destroy()
    }
  })

  it("toggles on the first click and copies a double-click word when the text stays", async () => {
    const result = await selectableBody()
    try {
      await result.mockMouse.click(8, 0)
      expect(result.toggles()).toBe(1)
      expect(result.copied).toEqual([])
      await result.mockMouse.click(8, 0)
      expect(result.toggles()).toBe(1)
      expect(result.copied).toEqual(["world"])
      expect(result.renderer.getSelection()).toBeNull()
    } finally {
      result.renderer.destroy()
      await result.renderer.closed
    }
  })

  it("toggles again instead of copying when the first click replaces the text", async () => {
    const result = await selectableBody()
    try {
      await result.mockMouse.click(8, 0)
      expect(result.toggles()).toBe(1)
      result.text.visible = false
      result.body.add(new TextRenderable(result.renderer, { content: "other words", selectable: true }))
      await result.renderOnce()
      await result.mockMouse.click(8, 0)
      expect(result.toggles()).toBe(2)
      expect(result.copied).toEqual([])
    } finally {
      result.renderer.destroy()
      await result.renderer.closed
    }
  })
})
