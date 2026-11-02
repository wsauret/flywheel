/** @jsxImportSource @opentui/solid */
import { describe, expect, it } from "bun:test"
import { RGBA, fg } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"

import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import type { ComposerControlAction } from "../../../../src/tui/components/composer-border-labels.js"

const color = RGBA.fromInts(200, 200, 200)
const theme = {
  ...resolveTheme(flywheelTheme, "dark"),
  background: RGBA.fromInts(0, 0, 0),
  text: color,
  textSubtle: color,
  textMuted: color,
  warning: color,
  error: color,
  border: color,
}
const noAction = () => {}
const noActions = {
  update: noAction,
  changes: noAction,
  model: noAction,
  sessions: noAction,
  new: noAction,
  close: noAction,
  switch: noAction,
  background: noAction,
  resume: noAction,
} satisfies { [Action in ComposerControlAction]: () => void }

async function renderPopupFrame(input: {
  popupHeight: number
  height: number
  topRightText?: string
  updateClickText?: string
  onDismissUpdate?: () => void
  /** Each change rebuilds the controls as fresh, equal objects, as the
   *  status line does on every spinner frame. */
  controlsRevision?: () => number
}) {
  const [{ ComposerFrame }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/components/composer-frame.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  const width = 40
  function PopupFrame() {
    return createComponent(ComposerFrame, {
      theme,
      width,
      bodyHeight: 1,
      topRightChunks: () => [fg(theme.border)(input.topRightText ?? "model-x")],
      bottomLeftChunks: () => [],
      bottomRightChunks: () => [],
      controls: () => (input.controlsRevision?.(), input.updateClickText)
        ? [{ action: "update" as const, label: "topRight" as const, offset: 1, chunks: [fg(theme.border)(input.updateClickText)] }]
        : [],
      actions: { ...noActions, update: () => input.onDismissUpdate?.() },
      popupHeight: input.popupHeight,

      get popup() {
        return input.popupHeight > 0
          ? (
            <box flexDirection="column">
              <text>row-one</text>
              <text>row-two</text>
            </box>
          )
          : undefined
      },
      get children() { return undefined },
    })
  }
  return testRender(
    () => createComponent(TickPoolProvider, {
      get children() { return createComponent(PopupFrame, {}) },
    }),
    { width, height: input.height },
  )
}

describe("ComposerFrame popup section", () => {
  it("expands the frame with popup rows and an inset divider", async () => {
    const result = await renderPopupFrame({ popupHeight: 2, height: 6 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const lines = frame.split("\n")
      expect(lines[0]).toMatch(/^╭─.*model-x.*─╮$/)
      expect(frame).toContain("row-one")
      expect(frame).toContain("row-two")
      const dividerLine = lines.find((line) => line.includes("│ ─"))
      expect(dividerLine).toMatch(/^│ ─+ │\s*$/)
      const bottomLine = lines.findLast((line) => line.startsWith("╰"))
      expect(bottomLine).toMatch(/^╰─+╯\s*$/)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders the plain three-line frame when popupHeight is 0", async () => {
    const result = await renderPopupFrame({ popupHeight: 0, height: 3 })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).not.toContain("│ ─")
      expect(frame).not.toContain("row-one")
      expect(frame.split("\n")[0]).toMatch(/^╭─.*model-x.*─╮$/)
    } finally {
      result.renderer.destroy()
    }
  })

  it("dismisses an update alert from its top-border hit area", async () => {
    let dismissals = 0
    const updateText = "update available ×"
    const topRightText = ` ${updateText} · model-x `
    const result = await renderPopupFrame({
      popupHeight: 0,
      height: 3,
      topRightText,
      updateClickText: updateText,
      onDismissUpdate: () => { dismissals += 1 },
    })
    try {
      await result.renderOnce()
      const line = result.captureCharFrame().split("\n")[0] ?? ""
      const x = line.indexOf(updateText)
      if (x < 0) throw new Error("Missing update alert mouse target")
      await result.mockMouse.pressDown(x, 0)
      await result.mockMouse.release(x, 0)
      expect(dismissals).toBe(1)
    } finally {
      result.renderer.destroy()
    }
  })
  it("keeps a hovered control highlighted while its controls republish", async () => {
    const updateText = "Update ready"
    const [revision, setRevision] = createSignal(0)
    const result = await renderPopupFrame({ popupHeight: 0, height: 3, topRightText: ` ${updateText} `, updateClickText: updateText, controlsRevision: revision })
    try {
      await result.renderOnce()
      const line = result.captureCharFrame().split("\n")[0] ?? ""
      const x = line.indexOf(updateText)
      if (x < 0) throw new Error("Missing update control")
      const highlighted = () => result.captureSpans().lines[0]!.spans.some((span) => span.text.includes("Update") && span.bg.equals(theme.backgroundRaised))
      await result.mockMouse.moveTo(x, 0)
      await result.renderOnce()
      expect(highlighted()).toBe(true)
      setRevision(1)
      await result.renderOnce()
      expect(highlighted()).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })
})
