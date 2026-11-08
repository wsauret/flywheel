/** @jsxImportSource @opentui/solid */

import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import { ManualClock } from "@opentui/core/testing"
import { createRoot } from "solid-js"
import type { FilteredResult } from "../../../../src/tui/components/modal-select-types.js"
import type { SettingsRow, SettingsView, SettingsVisibleRow } from "../../../../src/tui/hooks/settings-modal-types.js"
import { flattenModalDisclosureTree } from "../../../../src/tui/components/modal-disclosure.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsModalController } from "../../../../src/tui/hooks/settings-modal-controller.js"

const [{ testRender }, { ThemeProvider }, { SettingsModal }, { createComponent }] = await Promise.all([
  import("@opentui/solid"),
  import("../../../../src/tui/context/theme.js"),
  import("../../../../src/tui/modals/settings-modal.js"),
  import("solid-js/web"),
])

const noOp = (): void => {}
const presentation = (value: string) => ({ value, cursor: value.length, selection: null, preferredVisualColumn: null })

function cycle(id: string, label: string, value: string, warning = false): SettingsRow {
  return { kind: "cycle", id, label, value: () => value, ...(warning ? { warning: "This value is invalid, so the default is in force." } : {}), onActivate: noOp, onStep: noOp }
}

function unavailableCycle(id: string, label: string, reason: string): SettingsRow {
  return { kind: "cycle", id, label, value: () => "ON", description: "hidden while unavailable", unavailableReason: () => reason, onActivate: noOp }
}

function editRow(id: string, label: string, value: string): SettingsRow {
  return {
    kind: "edit",
    id,
    label,
    value: () => value,
    edit: { hint: "hint", current: () => value, initialDraft: () => "", submit: () => ({ ok: true }) },
  }
}

function lineContaining(frame: string, text: string): string {
  const line = frame.split("\n").find((candidate) => candidate.includes(text))
  if (!line) throw new Error(`Missing rendered line: ${text}`)
  return line
}

function valueColumn(line: string, value: string): number {
  const start = line.indexOf(value)
  if (start < 0) throw new Error(`Missing rendered value: ${value}`)
  return start
}

function visibleRows(rows: SettingsRow[]): SettingsVisibleRow[] {
  return flattenModalDisclosureTree(rows.map((item) => ({ item })), new Set()).map((row) => {
    if (row.kind !== "disclosure") return row
    if (row.disclosure === undefined) throw new Error(`Missing disclosure presentation: ${row.id}`)
    return { ...row, disclosure: row.disclosure }
  })
}

function renderSettings(rows: SettingsRow[], options: { width?: number; height?: number; clock?: ManualClock; cursor?: number | (() => number); view?: SettingsView | (() => SettingsView); onActivate?: (index: number) => void; onToggle?: (rowIndex: number) => void; onSelect?: (rowIndex: number) => void; onEditBlur?: () => void } = {}) {
  return testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      return createComponent(SettingsModal, {
        get cursor() {
          const cursor = options.cursor
          return typeof cursor === "function" ? cursor() : cursor ?? 0
        },
        get view() {
          const view = options.view
          return typeof view === "function" ? view() : view ?? { kind: "list", presentation: presentation(""), rows: visibleRows(rows) }
        },
        onClose: noOp,
        onEditBlur: options.onEditBlur,
        onActivate: options.onActivate ?? noOp,
        onToggle: options.onToggle ?? noOp,
        onSelect: options.onSelect ?? noOp,
      })
    },
  }), { width: options.width ?? 80, height: options.height ?? 24, clock: options.clock })
}

describe("SettingsModal controlled input", () => {
  it("finishes the typed setting on a click outside the field, not inside it", async () => {
    const submitted: string[] = []
    const h = createRoot((dispose) => {
      const stack = createModalStack()
      const row: SettingsRow = { kind: "edit", id: "days", label: "Days", value: () => "42", edit: { hint: "Click away to finish", current: () => "42", initialDraft: () => "42", submit: (text) => { submitted.push(text); return { ok: true } } } }
      const controller = createSettingsModalController({ rows: () => [row], modal: stack, renderModal: () => null, blocked: () => false })
      controller.open()
      controller.activateRow(0)
      stack.paste("14")
      return { dispose, controller }
    })
    const result = await renderSettings([], { view: h.controller.view, onEditBlur: h.controller.finishEdit })
    try {
      await result.renderOnce()
      const click = async (text: string) => {
        const lines = result.captureCharFrame().split("\n")
        const y = lines.findIndex((line) => line.includes(text))
        const x = lines[y]?.indexOf(text) ?? -1
        if (x < 0 || y < 0) throw new Error(`Missing mouse target: ${text}`)
        await result.mockMouse.pressDown(x, y)
        await result.mockMouse.release(x, y)
      }
      await click("14")
      expect(submitted).toEqual([])
      await click("Click away")
      expect(submitted).toEqual(["14"])
    } finally { result.renderer.destroy(); h.dispose() }
  })
  it("renders disabled deletion and busy progress without a cancel action", async () => {
    for (const pending of [false, true]) {
      const result = await renderSettings([], { view: { kind: "confirmation", phase: "ready", pending, label: "Delete Profile", message: "Delete Work?", actionLabel: "Delete", choice: "cancel", candidates: Array.from({ length: 40 }, (_, index) => ({ id: `${index}`, displayName: `Destination ${index}` })) } })
      try {
        await result.renderOnce()
        if (pending) {
          expect(result.captureCharFrame()).toContain("Deleting...")
          expect(result.captureCharFrame()).not.toContain("Cancel")
        } else {
          const disabled = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text.includes("Delete (disabled)"))
          expect(disabled?.fg.equals(resolveTheme(flywheelTheme, "dark").textMuted)).toBe(true)
          expect(result.captureCharFrame()).toContain("> Cancel")
        }
        expect(result.captureCharFrame()).not.toContain("Destination 39")
      } finally { result.renderer.destroy() }
    }
  })
  it("keeps a long edit value inside the modal frame at narrow widths", async () => {
    const value = "1".repeat(120)
    const result = await renderSettings([], { width: 60, view: { kind: "edit", label: "Threshold", hint: "hint", presentation: presentation(value), current: "", error: undefined } })
    try {
      await result.renderOnce()
      const inputLine = result.captureCharFrame().split("\n").find((line) => line.includes("1111"))
      expect(inputLine?.trimEnd().endsWith("│")).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })
  it("shows a locked row's value without step arrows and its whole reason in the footer", async () => {
    const reason = 'flywheel.toml disabled_modules contains unknown id "nope"; selection unchanged'
    const filler = Array.from({ length: 30 }, (_, index) => cycle(`row-${index}`, `Row ${index}`, "On"))
    const render = async (lockedReason: string): Promise<string> => {
      const locked: SettingsRow = { kind: "cycle", id: "bash", label: "Bash", value: () => "On", lockedReason: () => lockedReason, onActivate: noOp, onStep: noOp }
      const result = await renderSettings([locked, ...filler], { width: 80, height: 24 })
      try {
        await result.renderOnce()
        return result.captureCharFrame()
      } finally {
        result.renderer.destroy()
      }
    }
    const frame = await render(reason)
    expect(lineContaining(frame, "Bash")).toContain("On")
    expect(lineContaining(frame, "Bash")).not.toContain("N/A")
    expect(lineContaining(frame, "Bash")).not.toContain("‹")
    expect(frame.replace(/[│\s]+/g, " ")).toContain(reason)
    // The wrapped reason takes a list line, so the controls row stays where a one-line reason puts it.
    const controlsRow = (rendered: string): number => rendered.split("\n").findIndex((line) => line.includes("esc close"))
    expect(controlsRow(frame)).toBe(controlsRow(await render("short")))
  })
  it("wraps a long edit error so its last word stays visible", async () => {
    const error = "Enter 0 to turn it off, or at least 50,000 tokens. This sentence makes the rule longer than one line."
    const result = await renderSettings([], { width: 60, view: { kind: "edit", label: "Threshold", hint: "hint", presentation: presentation("1000"), current: "", error } })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("50,000 tokens.")
      expect(frame).toContain("one line.")
    } finally {
      result.renderer.destroy()
    }
  })
})

const ALL_KINDS: SettingsRow[] = [
  cycle("thinking", "Show thinking", "YES"),
  cycle("diff-standard", "Diff colours", "NO"),
  unavailableCycle("updates", "Automatic updates", "The runtime has not published its update status yet"),
  cycle("diff", "Diff colours", "Theme"),
  cycle("workflows", "Workflows", "Ask first"),
  editRow("threshold", "Auto compact at", "300k"),
  { kind: "action", id: "font", label: "Font", value: () => "Installed", onActivate: noOp },
  { kind: "picker", id: "theme", label: "Theme", value: () => "flywheel", onActivate: noOp },
  {
    kind: "multiselect",
    id: "skills",
    label: "Skills",
    value: () => "2 on",
    options: () => [],
    selectedIds: () => [],
    onToggle: noOp,
  },
  { kind: "separator" },
  { kind: "navigation", id: "models", label: "Models", onActivate: noOp },
]

describe("SettingsModal list rendering", () => {
  it("renders every row kind in one aligned value column with standard colors", async () => {
    const result = await renderSettings(ALL_KINDS)

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      // Each probe is the value text itself, which identifies its row line
      // unambiguously; the cycle's "Theme" value is above the picker row.
      const values = ["‹ YES ›", "‹ NO ›", "N/A", "‹ Theme ›", "‹ Ask first ›", "300k", "Installed", "flywheel", "2 on", "→"]
      const columns = values.map((value) => valueColumn(lineContaining(frame, value), value))
      expect(new Set(columns).size).toBe(1)
      expect(frame).toContain("←→ change")
      expect(frame).toContain("type to filter")

      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const primaryReference = spans.find((span) => span.text === "Settings")
      const mutedReference = spans.find((span) => span.text.includes("←→ change"))
      const on = spans.find((span) => span.text === "‹ YES ›")
      const off = spans.find((span) => span.text === "‹ NO ›")
      const unavailable = spans.find((span) => span.text === "N/A")
      if (!primaryReference || !mutedReference || !on || !off || !unavailable) throw new Error("Missing styled settings span")
      expect(on.fg.equals(primaryReference.fg)).toBe(true)
      expect(off.fg.equals(mutedReference.fg)).toBe(true)
      expect(unavailable.fg.equals(mutedReference.fg)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders disclosure markers and indents inline children without cutting their labels", async () => {
    // The child's label is one column narrower than its parent's, so only
    // its indent can push it past the value column.
    const rows: SettingsVisibleRow[] = [
      { kind: "disclosure", id: "appearance", label: "Appearance", rows: () => [], depth: 0, disclosure: { id: "appearance", expanded: true, interaction: "disclosure-only" } },
      { kind: "cycle", id: "show-tips", label: "Show tips", value: () => "YES", onActivate: noOp, depth: 1 },
    ]
    const result = await renderSettings([], { cursor: 0, view: { kind: "list", presentation: presentation(""), rows } })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Appearance")
      expect(frame).toContain("▾")
      expect(lineContaining(frame, "YES")).toContain("Show tips")
      expect(lineContaining(frame, "Show").indexOf("Show")).toBeGreaterThan(lineContaining(frame, "Appearance").indexOf("Appearance"))
      expect(frame).toContain("enter collapse")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders warning markers in yellow without shifting the value column", async () => {
    const result = await renderSettings([
      cycle("thinking", "Show thinking", "NO", true),
      cycle("diff-standard", "Diff colours", "YES"),
    ])

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const warningLine = lineContaining(frame, "[!] Show thinking")
      const normalLine = lineContaining(frame, "Diff colours")
      expect(valueColumn(warningLine, "‹ NO ›")).toBe(valueColumn(normalLine, "‹ YES ›"))

      const marker = result.captureSpans().lines.flatMap((line) => line.spans).find((span) => span.text === "[!] ")
      if (!marker) throw new Error("Missing warning marker span")
      expect(marker.fg.equals(RGBA.fromHex("#ffe2a9"))).toBe(true)
      // The selected marked row explains its marker in the footer.
      expect(frame).toContain("[!] This value is invalid, so the default is in force.")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps every control value visible in one column at the minimum terminal width", async () => {
    const result = await renderSettings([
      cycle("thinking", "Thinking Visibility", "YES"),
      cycle("tools", "Tool Output Visibility", "NO"),
      unavailableCycle("updates", "Automatic Update Policy", "not published yet"),
      cycle("diff", "Diff Color Selection", "Alt"),
      editRow("threshold", "Auto compact at", "42"),
      { kind: "navigation", id: "models", label: "Model Configuration", onActivate: noOp },
    ], { width: 24 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const values = ["‹ YES ›", "‹ NO ›", "N/A", "‹ Alt ›", "42", "→"]
      const columns = values.map((value) => valueColumn(lineContaining(frame, value), value))
      expect(new Set(columns).size).toBe(1)
      expect(frame).toContain("...")
      expect(frame).not.toContain("Thinking Visibility")
    } finally {
      result.renderer.destroy()
    }
  })

  it("cuts a label before a value that needs at most half the row", async () => {
    // The widest label column and the long value are equally wide, and the
    // 72-column modal leaves one column too few for both.
    const rows: SettingsVisibleRow[] = [
      { kind: "cycle", id: "attribution", label: "Git AI attribution", value: () => "Off · Personal (environment)", onActivate: noOp, onStep: noOp, depth: 0 },
      { kind: "disclosure", id: "tools", label: "Tools", rows: () => [], depth: 0, disclosure: { id: "tools", expanded: true, interaction: "disclosure-only" } },
      { kind: "cycle", id: "persistent", label: "Allow persistent processes", value: () => "NO", onActivate: noOp, onStep: noOp, depth: 1 },
    ]
    const result = await renderSettings([], { width: 72, cursor: 0, view: { kind: "list", presentation: presentation(""), rows } })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("‹ Off · Personal (environment) ›")
      expect(valueColumn(lineContaining(frame, "‹ NO ›"), "‹ NO ›")).toBe(valueColumn(lineContaining(frame, "‹ Off"), "‹ Off"))
    } finally {
      result.renderer.destroy()
    }
  })

  it("shows the selected row's unavailable reason and fixed controls", async () => {
    const result = await renderSettings(ALL_KINDS, { cursor: 2 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("The runtime has not published its update status yet")
      // The reason wins over the row's own description.
      expect(frame).not.toContain("hidden while unavailable")
      expect(frame).toContain("←→ change")
    } finally {
      result.renderer.destroy()
    }
  })

  it("titles a section with its labeled separator and reports the selected row's description", async () => {
    const result = await renderSettings([
      { kind: "separator", label: "Display" },
      { kind: "cycle", id: "diff", label: "Diff colours", description: "Render diffs with the theme's palette.", value: () => "Theme", onActivate: noOp },
      cycle("thinking", "Show thinking", "ON"),
    ], { cursor: 1, view: { kind: "list", presentation: presentation("theme"), rows: visibleRows([
      { kind: "separator", label: "Display" },
      { kind: "cycle", id: "diff", label: "Diff colours", description: "Render diffs with the theme's palette.", value: () => "Theme", onActivate: noOp },
      cycle("thinking", "Show thinking", "ON"),
    ]) } })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Display")
      expect(frame).toContain("Render diffs with the theme's palette.")
      expect(frame).toContain("theme")
      expect(frame).toContain("←→ change")
    } finally {
      result.renderer.destroy()
    }
  })

  it("keeps the cursor row inside the first painted viewport in both directions and after leaving a shorter group", async () => {
    const rows: SettingsRow[] = [
      { kind: "separator", label: "AlphaSection" },
      ...Array.from({ length: 15 }, (_, i): SettingsRow => cycle(`first-${i}`, `First Row ${i}`, "ON")),
      { kind: "separator", label: "BetaSection" },
      ...Array.from({ length: 15 }, (_, i): SettingsRow => cycle(`second-${i}`, `Second Row ${i}`, "ON")),
      ...Array.from({ length: 3 }, (_, i): SettingsRow => cycle(`extra-${i}`, `Extra Row ${i}`, "ON")),
      { kind: "group", id: "providers", label: "Model providers", rows: () => Array.from({ length: 14 }, (_, i) => cycle(`provider-${i}`, `Provider ${i}`, "ON")) },
      ...Array.from({ length: 4 }, (_, i): SettingsRow => cycle(`tail-${i}`, `Tail Row ${i}`, "ON")),
    ]
    const { controller, modals, dispose } = createRoot((disposeRoot) => {
      const stack = createModalStack()
      const settings = createSettingsModalController({ rows: () => rows, modal: stack, renderModal: () => "modal", blocked: () => false })
      settings.open()
      settings.activateRow(rows.length - 1)
      return { controller: settings, modals: stack, dispose: disposeRoot }
    })
    const result = await renderSettings(rows, { cursor: controller.cursor, view: controller.view, height: 20, clock: new ManualClock() })
    const painted: string[] = []
    result.renderer.on("frame", () => { painted.push(result.captureCharFrame()) })

    async function settle(): Promise<string> {
      // Under load, every timer retry can run before the renderer's first layout.
      await new Promise((resolve) => setTimeout(resolve, 5))
      painted.length = 0
      await result.renderOnce()
      expect(painted.length).toBeGreaterThan(0)
      return painted[0]!
    }

    try {
      const bottom = await settle()
      expect(bottom).toContain("Second Row 14")
      expect(bottom).not.toContain("First Row 0")

      controller.activateRow(1)
      const top = await settle()
      expect(top).toContain("First Row 0")
      // An upward scroll reveals the section header above the cursor row.
      expect(top).toContain("AlphaSection")
      expect(top).not.toContain("Second Row 14")

      controller.activateRow(35)
      expect(controller.view()).toMatchObject({ kind: "list", label: "Model providers", presentation: { value: "" } })
      const group = await settle()
      expect(group).toContain("Provider 0")
      expect(group).not.toContain("First Row 0")

      modals.input({ name: "backspace" })
      expect(controller.cursor()).toBe(35)
      const root = await settle()
      expect(root).toContain("Model providers")
      expect(root).not.toContain("Provider 0")
    } finally {
      await result.dispose()
      dispose()
    }
  })

  it("shows Ask first in the shared value column and colors it as an enabled capability", async () => {
    // Ask first is Workflows enabled under a confirmation preference, so it reads as
    // enabled wherever the cursor is; the cursor sits on another row here.
    const result = await renderSettings(ALL_KINDS, { cursor: 0 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const columns = ["‹ YES ›", "‹ Ask first ›", "‹ NO ›", "flywheel"].map((value) => valueColumn(lineContaining(frame, value), value))
      expect(new Set(columns).size).toBe(1)

      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const primaryReference = spans.find((span) => span.text === "Settings")
      const mutedReference = spans.find((span) => span.text.includes("←→ change"))
      const ask = spans.find((span) => span.text === "‹ Ask first ›")
      if (!primaryReference || !mutedReference || !ask) throw new Error("Missing styled settings span")
      expect(ask.fg.equals(primaryReference.fg)).toBe(true)
      expect(ask.fg.equals(mutedReference.fg)).toBe(false)
    } finally {
      result.renderer.destroy()
    }
  })

  it.each(["Delete", "OK"])("renders Cancel before %s and highlights the selected action", async (actionLabel) => {
    const result = await renderSettings([], { view: { kind: "confirmation", label: "Confirm action", message: "Proceed with this action?", actionLabel, choice: "cancel" } })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      const actions = lineContaining(frame, "> Cancel")
      expect(actions.indexOf("Cancel")).toBeLessThan(actions.indexOf(actionLabel))
      const spans = result.captureSpans().lines.flatMap((line) => line.spans)
      const cancel = spans.find((span) => span.text.includes("> Cancel"))
      const confirm = spans.find((span) => span.text.includes(actionLabel))
      const theme = resolveTheme(flywheelTheme, "dark")
      expect(cancel?.fg.equals(theme.primary)).toBe(true)
      expect(confirm?.fg.equals(theme.text)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("activates every interactive row kind from its mouse hit area", async () => {
    const activations: number[] = []
    const result = await renderSettings([
      cycle("diff", "Diff colours", "Theme"),
      { kind: "action", id: "font", label: "Font", value: () => "Installed", onActivate: noOp },
      { kind: "picker", id: "theme", label: "Theme", value: () => "flywheel", onActivate: noOp },
      { kind: "navigation", id: "models", label: "Models", onActivate: noOp },
      editRow("threshold", "Auto compact at", "300k"),
    ], { onActivate: (index) => { activations.push(index) } })

    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      for (const label of ["Diff colours", "Font", "flywheel", "Models", "Auto compact at"]) {
        const y = lines.findIndex((line) => line.includes(label))
        const x = lines[y]?.indexOf(label) ?? -1
        if (x < 0 || y < 0) throw new Error(`Missing mouse target row: ${label}`)
        await result.mockMouse.pressDown(x, y)
        await result.mockMouse.release(x, y)
      }
      expect(activations).toEqual([0, 1, 2, 3, 4])
    } finally {
      result.renderer.destroy()
    }
  })
})

const MULTISELECT_RESULT: FilteredResult<string> = {
  rows: [
    { kind: "option", id: "alpha", rowIndex: 0, option: { id: "alpha", title: "Alpha", value: "alpha" } },
    { kind: "option", id: "beta", rowIndex: 1, option: { id: "beta", title: "Beta", value: "beta" } },
  ],
  totalMatches: 2,
  capped: false,
}

describe("SettingsModal multiselect rendering", () => {
  const view: SettingsView = {
    kind: "multiselect",
    label: "Skills",
    presentation: presentation("al"),
    result: MULTISELECT_RESULT,
    cursor: 0,
    selectedIds: ["alpha"],
  }

  it("marks each option with its own checkbox and titles the subview", async () => {
    const result = await renderSettings(ALL_KINDS, { view })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Settings › Skills")
      expect(frame).toContain("al")
      expect(lineContaining(frame, "Alpha")).toContain("[x]")
      expect(lineContaining(frame, "Beta")).toContain("[ ]")
      expect(frame).toContain("space/enter toggle")
    } finally {
      result.renderer.destroy()
    }
  })

  it("toggles the clicked option through the same path as the keyboard", async () => {
    const toggles: number[] = []
    const result = await renderSettings(ALL_KINDS, { view, onToggle: (rowIndex) => { toggles.push(rowIndex) } })

    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Beta"))
      const x = lines[y]?.indexOf("Beta") ?? -1
      if (x < 0 || y < 0) throw new Error("Missing multiselect mouse target")
      await result.mockMouse.pressDown(x, y)
      await result.mockMouse.release(x, y)
      expect(toggles).toEqual([1])
    } finally {
      result.renderer.destroy()
    }
  })
})

describe("SettingsModal single-select rendering", () => {
  const view: SettingsView = {
    kind: "single-select",
    label: "Profile",
    presentation: presentation("pro"),
    result: {
      rows: [
        { kind: "option", id: "production", rowIndex: 0, option: { id: "production", title: "Production", value: "production", rightDetail: "Active" } },
        { kind: "option", id: "create", rowIndex: 1, option: { id: "create", title: "Create profile", value: "create", statusIcon: "+" } },
      ],
      totalMatches: 2,
      capped: false,
    },
    cursor: 0,
    filterable: true,
    currentId: "production",
    hotkeyHint: "r rename",
  }

  it("uses ModalSelect filtering, current value, action marker, and footer", async () => {
    const result = await renderSettings(ALL_KINDS, { view })
    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("Settings › Profile")
      expect(frame).toContain("pro")
      expect(frame).toContain("Production")
      expect(frame).toContain("Active")
      expect(frame).toContain("Create profile")
      expect(frame).toContain("enter select")
      expect(frame).toContain("← back · esc close")
      expect(frame).toContain("r rename")
      expect(lineContaining(frame, "enter select")).not.toContain("r rename")
      expect(lineContaining(frame, "r rename")).not.toContain("enter select")
    } finally {
      result.renderer.destroy()
    }
  })

  it("selects a clicked option through the same row-index path as the keyboard", async () => {
    const selections: number[] = []
    const result = await renderSettings(ALL_KINDS, { view, onSelect: (rowIndex) => { selections.push(rowIndex) } })
    try {
      await result.renderOnce()
      const lines = result.captureCharFrame().split("\n")
      const y = lines.findIndex((line) => line.includes("Create profile"))
      const x = lines[y]?.indexOf("Create profile") ?? -1
      if (x < 0 || y < 0) throw new Error("Missing single-select mouse target")
      await result.mockMouse.pressDown(x, y)
      await result.mockMouse.release(x, y)
      expect(selections).toEqual([1])
    } finally {
      result.renderer.destroy()
    }
  })
})