import { expect, test } from "bun:test"

import { CATALOG_PALETTE_COMMANDS } from "../../../vscode/src/catalog-commands.js"
import manifest from "../../../vscode/package.json"
import { publishedCommands } from "../../helpers/command-catalog.js"
import { HOST_ACTION_NAMES } from "../../../src/protocol/client/host-action-names.js"

test("each editor palette command that is a catalog command carries the catalog name", () => {
  const catalog = new Map(publishedCommands().map((command) => [command.id, command.title]))
  const titles = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]))
  for (const [command, id] of Object.entries(CATALOG_PALETTE_COMMANDS)) {
    const name = catalog.get(id)
    expect(name, `${command} runs ${id}, which the catalog does not publish`).toBeDefined()
    expect(titles.get(command)).toBe(`Flywheel: ${name}`)
  }
})

test("each editor palette command that is also a command menu action carries the menu's name", () => {
  const titles = new Map(manifest.contributes.commands.map((command) => [command.command, command.title]))
  for (const [command, name] of Object.entries(HOST_ACTION_NAMES)) expect(titles.get(command)).toBe(`Flywheel: ${name}`)
})

test("every editor palette title is sentence case after the Flywheel prefix", () => {
  for (const { title } of manifest.contributes.commands) {
    const words = title.replace(/^Flywheel: /, "").split(" ").slice(1)
    // Proper nouns and acronyms keep their capitals.
    expect(words.filter((word) => /^[A-Z][a-z]/.test(word) && word !== "Flywheel"), title).toEqual([])
  }
})
