import { builtInCommandDeclarations, builtInCommandDescriptor } from "../../src/orchestration/app-service/kernel-commands.js"
import { composeFirstPartyModules, type FirstPartyModuleComposition } from "../../src/orchestration/modules.js"
import type { BuiltInCommandDescriptor } from "../../src/protocol/command-catalog-protocol-types.js"
import { commandSpecs } from "../../src/tui/commands/command-catalog.js"
import { buildCommandDefinitions } from "../../src/tui/commands/command-definitions.js"
import type { CommandSpec } from "../../src/tui/commands/command-types.js"
import type { Keymap } from "../../src/tui/keymap/keymap.js"

/** The descriptors the runtime catalog publishes for one module composition,
 *  every installed module on by default. */
export function publishedCommands(modules: FirstPartyModuleComposition = composeFirstPartyModules()): readonly BuiltInCommandDescriptor[] {
  return builtInCommandDeclarations(modules).map(builtInCommandDescriptor)
}

/** The terminal's command list as presentation data for the given published
 *  descriptors. */
export function buildCommandCatalog(chordFor: Keymap["chordFor"], builtInCommands: readonly BuiltInCommandDescriptor[] = []): readonly CommandSpec[] {
  return commandSpecs(buildCommandDefinitions(chordFor, builtInCommands))
}
