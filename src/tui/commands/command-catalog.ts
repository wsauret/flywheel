import type { ModalSelectOption } from "../components/modal-select-types.js"
import type { BuiltInCommandContext } from "./command-definitions.js"
import type { BuiltInCommandDefinition, CommandSpec } from "./command-types.js"


/** Derives presentation data from the built-in definitions. */
export function commandSpecs(definitions: readonly BuiltInCommandDefinition<BuiltInCommandContext>[]): readonly CommandSpec[] {
  return definitions.map((definition) => definition.spec)
}

/** The slash-command menu as select options. Every entry is a built-in
 * command; skills are agent methods and never appear here.
 * Shared by the palette and slash suggestions.
 * One row per command under its own token (PI-INTERACTION-081): its aliases
 * show beside that token and match a search, so typing an alias finds the
 * command it names. */
export function commandsToOptions(commands: readonly CommandSpec[]): ModalSelectOption[] {
  return commands
    .filter((c) => !c.hidden)
    .map((c) => ({
      id: c.id,
      title: c.title,
      value: `/${c.id}`,
      description: c.keybinding ? `${c.description} (${c.keybinding})` : c.description,
      footer: [c.id, ...(c.aliases ?? [])].map((name) => `/${name}`).join(" "),
    }))
}
