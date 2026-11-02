import type { OffCommandDescriptor } from "../command-catalog-protocol-types.js"

/** The one refusal for a slash token that only a turned-off module provides,
 *  or undefined when no off command has that id or alias. The terminal, the
 *  web client, and the runtime all say these words, so a person reads the
 *  same refusal however the command was entered. */
export function offCommandRefusal(offCommands: readonly OffCommandDescriptor[], token: string): string | undefined {
  const name = token.toLowerCase()
  const command = offCommands.find((candidate) => candidate.id === name || candidate.aliases.includes(name))
  if (command === undefined) return undefined
  const modules = command.modules
  if (modules.length <= 1) return `"/${name}" needs the ${modules[0] ?? command.id} module, which is off. Turn it on in Settings.`
  const names = modules.length === 2 ? modules.join(" or ") : `${modules.slice(0, -1).join(", ")}, or ${modules.at(-1)}`
  return `"/${name}" needs one of the ${names} modules, which are off. Turn one on in Settings.`
}
