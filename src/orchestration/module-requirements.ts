import type { FirstPartyModule, ModuleId, FirstPartyModuleComposition } from "./modules.js"
import { installedModules } from "./module-catalog.js"

import { canonicalModuleIds } from "../protocol/module-ids.js"

function installedModule(modules: readonly FirstPartyModule[], id: string): FirstPartyModule {
  const module = modules.find((candidate) => candidate.id === id)
  if (!module) throw new Error(`Capability contribution requires uninstalled module ${id}`)
  return module
}

/** Returns the complete installed-module closure required by one contribution.
 *  A catalog other than the installed one is a test's. */
export function moduleRequirementsForContribution(domain: string, id: string, modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  const owner = modules.find((module) =>
    module.contributions.some((contribution) => contribution.domain === domain && contribution.id === id),
  )
  if (!owner) throw new Error(`No module contributes ${domain}:${id}`)

  const required = new Set<string>()
  const include = (module: FirstPartyModule): void => {
    if (required.has(module.id)) return
    required.add(module.id)
    for (const dependency of module.dependencies) include(installedModule(modules, dependency))
  }
  include(owner)

  const contribution = owner.contributions.find((candidate) => candidate.domain === domain && candidate.id === id)
  if (!contribution) throw new Error(`No module contributes ${domain}:${id}`)
  if (contribution.domain === "tools") {
    for (const registration of Object.values(contribution.value.declaration.registrations)) {
      for (const capability of registration.capabilities) include(installedModule(modules, capability))
    }
  }

  return canonicalModuleIds(required)
}

/** Tests behavior availability from the enabled contribution surface, not module identity. */
export function hasModuleContribution(composition: FirstPartyModuleComposition, domain: string, id?: string): boolean {
  return composition.contributions.some((contribution) => contribution.domain === domain && (id === undefined || contribution.id === id))
}

export function backgroundShellModuleRequirements(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  const entries = modules.flatMap((module) => module.contributions.filter((entry) => entry.domain === "shellOperations" && entry.value.background))
  if (entries.length === 0) throw new Error("No module contributes background shell execution")
  return canonicalModuleIds(entries.flatMap((entry) => moduleRequirementsForContribution("shellOperations", entry.id, modules)))
}
