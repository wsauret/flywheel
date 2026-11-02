import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry, type ProjectDefinitionRegistryOptions } from "../workflows/definition-registry.js"
import { installedDefinitionBundles } from "./module-catalog.js"
import { installedPersonaToolEntries } from "./tool-catalog.js"

/** One project's definition registry over this realm's installed catalog: the
 *  definition bundles and persona tools of every installed module. Each process
 *  that builds a registry therefore composes the same skills, and a package
 *  that depends on a module-bundled skill resolves in all of them or in none. */
export function createInstalledDefinitionRegistry(
  options: Omit<ProjectDefinitionRegistryOptions, "bundles" | "personaToolEntries">,
): ProjectDefinitionRegistry {
  return createProjectDefinitionRegistry({ ...options, bundles: installedDefinitionBundles(), personaToolEntries: installedPersonaToolEntries() })
}
