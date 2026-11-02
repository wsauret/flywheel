import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { createSettingsModalController } from "../../../../src/tui/hooks/settings-modal-controller.js"
import type { SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"

function createFilterHarness() {
  const modals = createModalStack()
  const calls: string[] = []
  const rows: readonly SettingsRow[] = [
    { kind: "separator", label: "Application" },
    { kind: "cycle", id: "billing", label: "Billing", description: "Model spend limits", value: () => "On", onActivate: () => calls.push("billing"), onStep: (direction) => calls.push(`billing:${direction}`) },
    { kind: "cycle", id: "model-choice", label: "Model Choice", value: () => "On", onActivate: () => calls.push("model-choice"), onStep: (direction) => calls.push(`model-choice:${direction}`) },
    { kind: "cycle", id: "default-model", label: "Default Model", value: () => "On", onActivate: () => calls.push("default-model"), onStep: (direction) => calls.push(`default-model:${direction}`) },
    {
      kind: "disclosure",
      id: "appearance",
      label: "Appearance",
      rows: () => [
        { kind: "cycle", id: "thinking", label: "Thinking", description: "Show internal thoughts", value: () => "On", onActivate: () => calls.push("thinking") },
      ],
    },
    { kind: "separator", label: "Autonomy" },
    {
      kind: "group",
      id: "tools",
      label: "Tools",
      rows: () => [
        { kind: "cycle", id: "bash", label: "Bash", description: "Allow subprocess execution", value: () => "On", onActivate: () => calls.push("bash"), onStep: (direction) => calls.push(`bash:${direction}`) },
      ],
    },
  ]
  const controller = createSettingsModalController({ rows: () => rows, modal: modals, renderModal: () => "modal", blocked: () => false })
  return { calls, controller, modals }
}

describe("settings modal controller filtering", () => {
  it("ranks label matches before descriptions and preserves section headings", () => {
    createRoot((dispose) => {
      const { controller, modals } = createFilterHarness()
      controller.open()

      for (const character of "model") modals.input({ name: character, raw: character })

      const view = controller.view()
      expect(view.kind).toBe("list")
      if (view.kind === "list") {
        expect(view.presentation.value).toBe("model")
        expect(view.rows?.map((row) => row.kind === "separator" ? row.label : row.id)).toEqual(["Application", "model-choice", "default-model", "billing"])
      }
      dispose()
    })
  })

  it("finds a nested setting from the root and carries the query into its group", () => {
    createRoot((dispose) => {
      const { controller, modals } = createFilterHarness()
      controller.open()

      for (const character of "subprocess") modals.input({ name: character, raw: character })
      const root = controller.view()
      if (root.kind !== "list") throw new Error("Expected filtered settings list")
      expect(root.rows?.map((row) => row.kind === "separator" ? row.label : row.id)).toEqual(["Autonomy", "tools"])

      controller.activateRow(1)
      expect(controller.view()).toMatchObject({ kind: "list", label: "Tools", presentation: { value: "subprocess" } })
      const group = controller.view()
      if (group.kind === "list") expect(group.rows?.map((row) => row.kind === "separator" ? "separator" : row.id)).toEqual(["bash"])
      dispose()
    })
  })

  it("reveals matching disclosure children without changing expansion state", () => {
    createRoot((dispose) => {
      const { controller, modals } = createFilterHarness()
      controller.open()

      for (const character of "thoughts") modals.input({ name: character, raw: character })
      const filtered = controller.view()
      if (filtered.kind !== "list") throw new Error("Expected filtered settings list")
      expect(filtered.rows?.map((row) => row.kind === "separator" ? row.label : `${row.id}:${row.depth}`)).toEqual(["Application", "appearance:0", "thinking:1"])

      for (let index = 0; index < "thoughts".length; index++) modals.input({ name: "backspace" })
      const cleared = controller.view()
      if (cleared.kind !== "list") throw new Error("Expected settings list")
      expect(cleared.rows?.some((row) => row.kind !== "separator" && row.id === "thinking")).toBe(false)
      dispose()
    })
  })

  it("types spaces without activating the selected cycle", () => {
    createRoot((dispose) => {
      const { calls, controller, modals } = createFilterHarness()
      controller.open()

      for (const character of "model spend") modals.input({ name: character === " " ? "space" : character, raw: character })

      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "model spend" } })
      expect(calls).toEqual([])
      dispose()
    })
  })

  it("delivers paste to the active settings filter", () => {
    createRoot((dispose) => {
      const { controller, modals } = createFilterHarness()
      controller.open()

      modals.paste("model\nchoice")

      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "modelchoice" } })
      dispose()
    })
  })

  it("clears a direct group-name query and returns with Backspace", () => {
    createRoot((dispose) => {
      const { calls, controller, modals } = createFilterHarness()
      controller.open()

      for (const character of "tools") modals.input({ name: character, raw: character })
      controller.activateRow(1)
      const group = controller.view()
      expect(group).toMatchObject({ kind: "list", label: "Tools", presentation: { value: "" } })
      if (group.kind === "list") expect(group.rows?.map((row) => row.kind === "separator" ? "separator" : row.id)).toEqual(["bash"])

      modals.input({ name: "backspace" })
      expect(controller.view()).toMatchObject({ kind: "list", presentation: { value: "" } })
      expect(calls).toEqual([])
      dispose()
    })
  })
})
