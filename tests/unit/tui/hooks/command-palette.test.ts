import { describe, it, expect, mock } from "bun:test"
import { createRoot } from "solid-js"
import { useCommandPalette } from "../../../../src/tui/hooks/use-command-palette.js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { commandSpecs } from "../../../../src/tui/commands/command-catalog.js"
import { buildCommandDefinitions } from "../../../../src/tui/commands/command-definitions.js"

const TEST_COMMANDS = commandSpecs(buildCommandDefinitions(
  (binding) => binding === "new" ? "ctrl+n" : "ctrl+b",
  [{ id: "bg", title: "Background work", description: "Show the work this chat runs in the background", aliases: ["tasks"] }, { id: "new", title: "New chat", description: "Start a new chat session", aliases: [] }],
))

function createPalette(onActivate: (slashText: string) => void = () => {}) {
  const modals = createModalStack()
  const palette = useCommandPalette({
    modal: modals,
    renderModal: () => "mock-element",
    commands: () => TEST_COMMANDS,
    onActivate,
  })
  return { palette, modals }
}

describe("useCommandPalette", () => {
  it("searching narrows results and closing/reopening restores full list", () => {
    createRoot((dispose) => {
      const { palette, modals } = createPalette()
      palette.openCommandPalette()

      const full = palette.commandPaletteState().result.rows
      // Every row is a command, so the list carries no category heading.
      expect(full.every(r => r.kind === "option")).toBe(true)
      const fullCount = full.length

      modals.input({ name: "t" })
      modals.input({ name: "h" })
      modals.input({ name: "e" })
      modals.input({ name: "m" })
      modals.input({ name: "e" })

      const filtered = palette.commandPaletteState()
      expect(filtered.presentation.value).toBe("theme")
      const filteredOptions = filtered.result.rows.filter(r => r.kind === "option")
      expect(filteredOptions.length).toBeLessThan(fullCount)
      expect(filteredOptions.some(r => r.option?.id === "theme")).toBe(true)

      modals.input({ name: "escape" })
      palette.openCommandPalette()

      const restored = palette.commandPaletteState()
      expect(restored.presentation.value).toBe("")
      expect(restored.result.rows.filter(r => r.kind === "option").length).toBe(fullCount)
      dispose()
    })
  })

  it("activating a command closes the palette and invokes onActivate with slash text", () => {
    createRoot((dispose) => {
      const onActivate = mock((_slashText: string) => {})
      const { palette, modals } = createPalette(onActivate)
      palette.openCommandPalette()

      modals.input({ name: "return" })

      expect(modals.stack.length).toBe(0)
      expect(onActivate).toHaveBeenCalledTimes(1)
      expect(onActivate).toHaveBeenCalledWith(expect.stringMatching(/^\//))
      dispose()
    })
  })

  it("Esc closes the palette", () => {
    createRoot((dispose) => {
      const { palette, modals } = createPalette()
      palette.openCommandPalette()
      expect(modals.stack.length).toBe(1)

      modals.input({ name: "escape" })
      expect(modals.stack.length).toBe(0)
      dispose()
    })
  })

  it("row activation sends the command's bare slash text", () => {
    createRoot((dispose) => {
      const onActivate = mock((_slashText: string) => {})
      const { palette } = createPalette(onActivate)
      palette.openCommandPalette()

      const state = palette.commandPaletteState()
      const rowIndex = state.result.rows.findIndex(r => r.kind === "option" && r.option?.id === "new")
      expect(rowIndex).toBeGreaterThanOrEqual(0)
      palette.handleRowClick(rowIndex)

      expect(onActivate).toHaveBeenCalledTimes(1)
      expect(onActivate).toHaveBeenCalledWith("/new")
      dispose()
    })
  })

  it("uses the shared editor for cursor edits and modal paste", () => {
    createRoot((dispose) => {
      const { palette, modals } = createPalette()
      palette.openCommandPalette()

      modals.paste("theme\n")
      modals.input({ name: "left" })
      modals.input({ name: "backspace" })

      expect(palette.commandPaletteState()).toMatchObject({ presentation: { value: "thee", cursor: 3 } })
      dispose()
    })
  })

  it("includes command keybinding labels in palette descriptions", () => {
    createRoot((dispose) => {
      const { palette } = createPalette()
      palette.openCommandPalette()

      const newRow = palette.commandPaletteState().result.rows.find(r => r.kind === "option" && r.option?.id === "new")
      const exitRow = palette.commandPaletteState().result.rows.find(r => r.kind === "option" && r.option?.id === "exit")
      expect(newRow?.kind === "option" ? newRow.option.description : undefined).toContain("ctrl+n")
      expect(exitRow?.kind === "option" ? exitRow.option.description : undefined).not.toContain("ctrl+")
      dispose()
    })
  })

  it("does not show /help in the palette options", () => {
    createRoot((dispose) => {
      const { palette } = createPalette()
      palette.openCommandPalette()

      const state = palette.commandPaletteState()
      const helpRow = state.result.rows.find(r => r.kind === "option" && r.option?.id === "help")
      expect(helpRow).toBeUndefined()
      dispose()
    })
  })

})
