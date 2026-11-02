import { describe, expect, it } from "bun:test"
import { RGBA, createTextAttributes, type CapturedFrame } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { TabInfo } from "../../../../src/tui/hooks/create-tabs.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme, type TuiTheme } from "../../../../src/tui/context/theme/resolve.js"

const color = (r: number, g: number, b: number) => RGBA.fromInts(r, g, b)
const theme: TuiTheme = {
  ...resolveTheme(flywheelTheme, "dark"),
  primary: color(1, 2, 3),
  text: color(20, 21, 22),
  textMuted: color(40, 41, 42),
  textSubtle: color(60, 61, 62),
  warning: color(200, 120, 0),
}

const spinnerPattern = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/

async function renderTabsFixture(
  tabs: () => readonly TabInfo[],
  availableWidth: () => number = () => 100,
  onReorder?: (id: string, beforeId: string | null) => void,
  onActivate: (id: string) => void = () => {},
  rendererHeight = 3,
) {
  const [{ TabsBar }, { TickPoolProvider }] = await Promise.all([
    import("../../../../src/tui/components/tabs-bar.js"),
    import("../../../../src/tui/context/tick-pool-context.js"),
  ])
  return testRender(
    () => createComponent(TickPoolProvider, {
      get children() {
        return createComponent(TabsBar, {
          tabs,
          availableWidth,
          theme,
          onActivate,
          onNewTab: () => {},
          onReorder,
        })
      },
    }),
    { width: 100, height: rendererHeight },
  )
}

async function renderTabs(tabs: readonly TabInfo[]): Promise<{ text: string; frame: CapturedFrame }> {
  const result = await renderTabsFixture(() => tabs)

  try {
    await result.renderOnce()
    return { text: result.captureCharFrame(), frame: result.captureSpans() }
  } finally {
    result.renderer.destroy()
  }
}

function tabLabelRow(text: string): string {
  return text.split("\n")[1] ?? ""
}

describe("TabsBar", () => {
  it("keeps the spinner for busy chat tabs", async () => {
    const { text } = await renderTabs([{
      kind: "session",
      id: "chat",
      title: "Chat",
      isForeground: false,
      isBusy: true,
      isBlocked: false,
    }])

    expect(text).toMatch(spinnerPattern)
    expect(text).not.toContain("⚙ Chat")
  })

  it("uses the blocked glyph ahead of busy indicators", async () => {
    const { text, frame } = await renderTabs([{
      kind: "session",
      id: "blocked",
      title: "Blocked",
      isForeground: false,
      isBusy: true,
      isBlocked: true,
    }])

    expect(text).toContain("? Blocked")
    const label = frame.lines.flatMap((line) => line.spans).find((span) => span.text.includes("Blocked"))
    expect(label?.fg.equals(theme.warning)).toBe(true)
    expect((label?.attributes ?? 0) & createTextAttributes({ dim: true })).toBe(0)
    expect(text).not.toContain("⚙ Blocked")
    expect(text).not.toMatch(spinnerPattern)
  })

  it("keeps the new-tab affordance visible when cell roles shift", async () => {
    const tabs = Array.from({ length: 5 }, (_, i): TabInfo => ({
      kind: "session",
      id: `tab-${i}`,
      title: `Tab ${i + 1}`,
      isForeground: i === 0,
      isBusy: false,
      isBlocked: false,
    }))
    const [availableWidth, setAvailableWidth] = createSignal(100)
    const result = await renderTabsFixture(() => tabs, availableWidth)

    try {
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("+")

      // 38 columns forces overflow and changes the visible semantic cell roles.
      setAvailableWidth(38)
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("+")
    } finally {
      result.renderer.destroy()
    }
  })

  it("scrolls overflow arrows after visible cell roles change", async () => {
    const tabs = Array.from({ length: 5 }, (_, i): TabInfo => ({
      kind: "session",
      id: `tab-${i}`,
      title: `Tab ${i + 1}`,
      isForeground: i === 0,
      isBusy: false,
      isBlocked: false,
    }))
    const [availableWidth, setAvailableWidth] = createSignal(100)
    const result = await renderTabsFixture(() => tabs, availableWidth)

    try {
      await result.renderOnce()
      setAvailableWidth(38)
      await Bun.sleep(0)
      await result.renderOnce()

      const firstRow = tabLabelRow(result.captureCharFrame())
      await result.mockMouse.pressDown(firstRow.indexOf("›"), 1)
      await Bun.sleep(0)
      await result.renderOnce()
      const secondRow = tabLabelRow(result.captureCharFrame())
      expect(secondRow).toContain("Tab 2")
      expect(secondRow).not.toContain("Tab 1")

      await result.mockMouse.pressDown(secondRow.indexOf("‹"), 1)
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 1")
    } finally {
      result.renderer.destroy()
    }
  })

  it("scrolls overflowing tabs horizontally without handling vertical input", async () => {
    const tabs = Array.from({ length: 5 }, (_, i): TabInfo => ({
      kind: "session",
      id: `tab-${i}`,
      title: `Tab ${i + 1}`,
      isForeground: i === 0,
      isBusy: false,
      isBlocked: false,
    }))
    const activated: string[] = []
    const result = await renderTabsFixture(() => tabs, () => 38, undefined, (id) => activated.push(id), 4)

    try {
      await result.renderOnce()

      await result.mockMouse.scroll(5, 3, "right")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 1")

      await result.mockMouse.scroll(5, 1, "down")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 1")

      await result.mockMouse.scroll(5, 1, "right")
      await result.renderOnce()
      const secondRow = tabLabelRow(result.captureCharFrame())
      expect(secondRow).toContain("Tab 2")
      expect(secondRow).not.toContain("Tab 1")

      await result.mockMouse.scroll(5, 1, "up")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 2")
      await result.mockMouse.scroll(5, 1, "down")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 2")

      await result.mockMouse.scroll(5, 1, "left")
      await result.renderOnce()
      await result.mockMouse.scroll(5, 1, "left")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 1")

      for (let i = 0; i < tabs.length + 1; i++) {
        await result.mockMouse.scroll(5, 1, "right")
        await result.renderOnce()
      }
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 5")

      await result.mockMouse.scroll(5, 1, "right")
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 5")
      expect(activated).toEqual([])
    } finally {
      result.renderer.destroy()
    }
  })

  it("updates visible cells when canonical tab order changes", async () => {
    const first = { kind: "session", id: "first", title: "First", isForeground: true, isBusy: false, isBlocked: false } satisfies TabInfo
    const second = { kind: "session", id: "second", title: "Second", isForeground: false, isBusy: false, isBlocked: false } satisfies TabInfo
    const [tabs, setTabs] = createSignal<readonly TabInfo[]>([first, second])
    const result = await renderTabsFixture(tabs)

    try {
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame()).indexOf("First")).toBeLessThan(tabLabelRow(result.captureCharFrame()).indexOf("Second"))

      setTabs([second, first])
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame()).indexOf("Second")).toBeLessThan(tabLabelRow(result.captureCharFrame()).indexOf("First"))
    } finally {
      result.renderer.destroy()
    }
  })

  it("previews and commits mixed pending and durable drag reorder by tab slot", async () => {
    const tabs: TabInfo[] = [
      { kind: "pending", id: "first", title: "Opening", isForeground: true, isBusy: false, isBlocked: false },
      { kind: "session", id: "second", title: "Second", isForeground: false, isBusy: false, isBlocked: false },
      { kind: "session", id: "third", title: "Third", isForeground: false, isBusy: false, isBlocked: false },
    ]
    const calls: Array<{ id: string; beforeId: string | null }> = []
    const activations: string[] = []
    const result = await renderTabsFixture(() => tabs, () => 100, (id, beforeId) => { calls.push({ id, beforeId }) }, (id) => { activations.push(id) })

    try {
      await result.renderOnce()
      await result.mockMouse.pressDown(5, 1)
      expect(activations).toEqual(["first"])
      await result.mockMouse.moveTo(10, 1)
      await result.mockMouse.moveTo(30, 1)
      await Bun.sleep(0)

      let preview = ""
      for (let i = 0; i < 10; i++) {
        await result.renderOnce()
        preview = tabLabelRow(result.captureCharFrame())
        if (preview.indexOf("Second") < preview.indexOf("Opening")) break
        await Bun.sleep(5)
      }
      expect(preview.indexOf("Second")).toBeLessThan(preview.indexOf("Opening"))
      expect(preview).toContain("↔ Opening")

      await result.mockMouse.release(30, 1)
      await Bun.sleep(0)
      expect(calls).toEqual([{ id: "first", beforeId: "third" }])
    } finally {
      result.renderer.destroy()
    }
  })

  it("schedules no frames while a tab is held still", async () => {
    const tabs: TabInfo[] = [
      { kind: "session", id: "first", title: "First", isForeground: true, isBusy: false, isBlocked: false },
      { kind: "session", id: "second", title: "Second", isForeground: false, isBusy: false, isBlocked: false },
    ]
    const result = await renderTabsFixture(() => tabs, () => 100, () => {})

    try {
      await result.renderOnce()
      await result.mockMouse.moveTo(5, 1)
      await result.renderOnce()
      await result.mockMouse.pressDown(5, 1)
      const scheduled: boolean[] = []
      for (let frame = 0; frame < 4; frame++) {
        await result.renderOnce()
        scheduled.push(result.renderer.getSchedulerState().hasScheduledRender)
      }
      expect(scheduled).toEqual([false, false, false, false])
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders Opening with the existing idle tab colors and no spinner", async () => {
    for (const isForeground of [true, false]) {
      const state = { id: "local", title: "Opening", isForeground, isBusy: false, isBlocked: false }
      const pending = await renderTabs([{ ...state, kind: "pending" }])
      const durable = await renderTabs([{ ...state, kind: "session", title: "Opening" }])
      expect(pending.text).toBe(durable.text)
      expect(pending.frame).toEqual(durable.frame)
      expect(pending.text).toContain("Opening")
      expect(pending.text).not.toMatch(spinnerPattern)
    }
  })

  it("keeps the foreground tab in view when the strip narrows or the tab order moves it", async () => {
    const tabAt = (index: number, foreground: number): TabInfo => ({
      kind: "session", id: `tab-${index}`, title: `Tab ${index + 1}`, isForeground: index === foreground, isBusy: false, isBlocked: false,
    })
    const [tabs, setTabs] = createSignal<readonly TabInfo[]>(Array.from({ length: 5 }, (_, index) => tabAt(index, 4)))
    const [availableWidth, setAvailableWidth] = createSignal(100)
    const result = await renderTabsFixture(tabs, availableWidth)
    try {
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 5")

      setAvailableWidth(38)
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 5")

      // A reorder that moves the same foreground tab off the visible slot also re-anchors.
      const current = tabs()
      setTabs([current[4]!, ...current.slice(0, 4)])
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 5")

      // A manual scroll away from the foreground tab stays where the person put it.
      const row = tabLabelRow(result.captureCharFrame())
      await result.mockMouse.pressDown(row.indexOf("›"), 1)
      await Bun.sleep(0)
      await result.renderOnce()
      expect(tabLabelRow(result.captureCharFrame())).toContain("Tab 1")
      expect(tabLabelRow(result.captureCharFrame())).not.toContain("Tab 5")
    } finally {
      result.renderer.destroy()
    }
  })

  it("scrolls to the pending foreground after mixed-tab navigation", async () => {
    const initial: TabInfo[] = Array.from({ length: 5 }, (_, index) => ({
      kind: index === 4 ? "pending" : "session", id: `key-${index}`, title: index === 4 ? "Opening" : `Tab ${index}`,
      isForeground: index === 0, isBusy: false, isBlocked: false,
    }))
    const [tabs, setTabs] = createSignal<readonly TabInfo[]>(initial)
    const activated: string[] = []
    const result = await renderTabsFixture(tabs, () => 38, undefined, (key) => { activated.push(key) })
    try {
      await result.renderOnce()
      setTabs(initial.map((tab, index) => ({ ...tab, isForeground: index === 4 })))
      await result.renderOnce()
      const row = tabLabelRow(result.captureCharFrame())
      expect(row).toContain("Opening")
      await result.mockMouse.pressDown(row.indexOf("Opening"), 1)
      expect(activated).toEqual(["key-4"])
    } finally {
      result.renderer.destroy()
    }
  })
})
