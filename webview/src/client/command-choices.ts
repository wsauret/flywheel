import type { BuiltInCommandDescriptor, CommandSurfaceTarget, OffCommandDescriptor, RuntimeCommandCatalog } from "../../../src/protocol/command-catalog-protocol-types.js"
import type { CommandCatalogReadiness } from "../../../src/protocol/client/slash-route.js"

/** This client's copy of the runtime's command catalog. */
export interface CommandRoster extends CommandCatalogReadiness {
  /** The built-in commands the runtime publishes, which a command menu renders whole. */
  readonly builtInCommands: readonly BuiltInCommandDescriptor[]
  /** Commands that only a turned-off module provides. No list offers them;
   *  they exist so a person who types one hears which module is off. */
  readonly offCommands: readonly OffCommandDescriptor[]
  /** The built-in a slash token names, by id or alias, with the catalog
   *  revision an invocation of it echoes, and the surface it opens, at its
   *  target, when the runtime publishes that as its whole effect. */
  builtIn(name: string): { readonly id: string; readonly revision: number; readonly opens?: string; readonly target?: CommandSurfaceTarget } | undefined
  accept(published: RuntimeCommandCatalog): void
}

/** Starts empty and takes each catalog the runtime publishes whole. */
export function createCommandRoster(): CommandRoster {
  let catalog: RuntimeCommandCatalog | undefined
  const arrival = Promise.withResolvers<void>()
  return {
    known: () => catalog !== undefined,
    arrived: arrival.promise,
    get offCommands() { return catalog?.offCommands ?? [] },
    get builtInCommands() { return catalog?.builtInCommands ?? [] },
    builtIn(name) {
      const command = catalog?.builtInCommands.find((candidate) => candidate.id === name || candidate.aliases.includes(name))
      if (catalog === undefined || command === undefined) return undefined
      return { id: command.id, revision: catalog.revision, ...(command.opens === undefined ? {} : { opens: command.opens }), ...(command.target === undefined ? {} : { target: command.target }) }
    },
    accept(published) {
      catalog = published
      arrival.resolve()
    },
  }
}

/** The headings of the command menu's three command groups, which the
 *  command panel and the Commands sheet share. */
export const COMMAND_MENU_SECTIONS = { top: "Common", chat: "Chat", rest: "More" } as const

/** How the bare panel describes the `commands` it is not showing: "Type to
 *  search 8 commands", and nothing at all for an empty list. */
export function catalogSummary(commands: readonly BuiltInCommandDescriptor[]): string | undefined {
  const n = commands.length
  return n === 0 ? undefined : `Type to search ${n} ${n === 1 ? "command" : "commands"}`
}
