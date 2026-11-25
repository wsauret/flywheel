import { resolve } from "node:path"
import { composeModules } from "../../../../infra/module-descriptor.js"
import { moduleDisabledReason } from "../../../../protocol/runtime/module-ids.js"
import { personaToolEntries, registrationNamed, toolRegistryFromComposition, type ToolRegistry } from "./tool-registry.js"
import type { RuntimeToolInput, ShellCommand } from "../types.js"
import { installedModules, RETIRED_SHELL_NAME, validateModuleFactPrefixes, type FirstPartyModule, type FirstPartyModuleComposition } from "../../../module-contract/module-catalog.js"

/** One metadata registry per catalog. The catalog is fixed for the realm, so
 *  the complete registry derived from it is a value every reader shares rather
 *  than a composition each planner, dispatcher, or migration rebuilds. */
const registries = new WeakMap<readonly FirstPartyModule[], ToolRegistry>()

/** All installed tool metadata for schemas, personas, and historical display.
 * Validates descriptor ownership and preserves execution registry ordering.
 * Provider credentials belong to runtime composition, not metadata reads. */
export function createToolRegistry(modules: readonly FirstPartyModule[] = installedModules()): ToolRegistry {
  const held = registries.get(modules)
  if (held !== undefined) return held
  validateModuleFactPrefixes(modules)
  const composition: FirstPartyModuleComposition = composeModules(modules)
  const registry = toolRegistryFromComposition(composition)
  registries.set(modules, registry)
  return registry
}

/** The shell command and absolute directory of a call to the registration
 *  that a provider-visible or recorded name calls, judged against
 *  `executionCwd`. Undefined for a call that is not a shell command. Live
 *  dispatch and history readers both read it here, so a recorded call means
 *  what it meant when it ran. */
export function shellCommandOf(name: string, input: Readonly<RuntimeToolInput>, executionCwd: string): ShellCommand | undefined {
  if (name === RETIRED_SHELL_NAME) {
    return typeof input.command === "string"
      ? { command: input.command, cwd: resolve(executionCwd, typeof input.working_directory === "string" ? input.working_directory : ".") }
      : undefined
  }
  return registrationNamed(name, createToolRegistry())?.shellCommand?.(input, executionCwd)
}

/** Why `selection` leaves the tool of the tool term `term` off, in the words
 *  that every refusal for a disabled module uses, or undefined while the
 *  module that contributes the tool and every module that it needs are on.
 *  It reads installed contributions and the installed catalog, because a
 *  selection registers no tool of a module that it leaves off. */
export function disabledToolReason(term: string, selection: Pick<FirstPartyModuleComposition, "enabledModuleIds" | "installedContributions">): string | undefined {
  const enabled = new Set<string>(selection.enabledModuleIds)
  const owner = selection.installedContributions.find((contribution) => contribution.domain === "tools" && contribution.value.name === term)?.module
  const needed = new Set([...owner === undefined ? [] : [owner], ...registrationNamed(term, createToolRegistry())?.capabilities ?? []])
  const missing = [...needed].filter((id) => !enabled.has(id))
  return missing.length > 0 ? moduleDisabledReason(missing) : undefined
}

export function installedPersonaToolEntries(): ReturnType<typeof personaToolEntries> {
  return personaToolEntries(createToolRegistry())
}
