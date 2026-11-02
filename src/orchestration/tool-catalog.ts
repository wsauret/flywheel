import { resolve } from "node:path"
import { composeModules } from "../infra/module-descriptor.js"
import { personaToolEntries, registrationNamed, toolRegistryFromComposition, type ToolRegistry } from "./agent-runtime/tools/tool-registry.js"
import type { RuntimeToolInput, ShellCommand } from "./agent-runtime/tools/types.js"
import { installedModules, validateModuleFactPrefixes } from "./module-catalog.js"
import type { FirstPartyModule, FirstPartyModuleComposition } from "./modules.js"

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

// Remove after 2027-10-30: transcripts that builds before 2026-10-30 wrote for
// gpt-6-luna call the shell as `exec`, with its directory in `working_directory`.
// No registration carries the name now, so history readers resolve it here.
const RETIRED_SHELL_NAME = "exec"

/** The tool that a provider-visible or recorded name calls: `apply_patch`
 *  calls `edit`, and a recorded `exec` called the shell tool. A reader that holds only
 *  a name judges the tool through this, whichever registration the model saw.
 *  A name that no installed registration carries is its own identity. */
export function toolIdentity(name: string): string {
  const registry = createToolRegistry()
  if (name === RETIRED_SHELL_NAME) return [...registry.values()].find((registration) => registration.action === "shell_exec")?.tool ?? name
  return registrationNamed(name, registry)?.tool ?? name
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

export function installedPersonaToolEntries(): ReturnType<typeof personaToolEntries> {
  return personaToolEntries(createToolRegistry())
}
