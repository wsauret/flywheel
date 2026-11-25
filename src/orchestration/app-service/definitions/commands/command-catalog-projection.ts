import type { DefinitionRootWatch } from "../definition-root-watcher.js"
import type { ProjectDefinitionRegistry } from "../../../../workflows/definitions/definition-registry.js"
import type { FirstPartyModuleSnapshot } from "../../../module-contract/module-catalog.js"
import { commandCatalogCursor, type RuntimeCommandCatalog } from "../../../../protocol/commands/command-catalog-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../../../protocol/runtime/runtime-ui-protocol-types.js"
import type { DefinitionAvailabilityOwner } from "../../../config/policy/definition-availability.js"
import { builtInCommandDeclarations, builtInCommandDescriptor, offCommandDescriptors } from "./kernel-commands.js"

export interface CommandCatalogProjection {
  snapshot(): RuntimeCommandCatalog
  dispose(): Promise<void>
}

/** The runtime's command catalog and the one live skill watcher. Skill
 *  packages are user files that appear or change mid-session; the watcher
 *  reloads the registry every consumer reads and refreshes definition
 *  availability. The catalog publishes built-in commands only, because skills
 *  are agent methods that no person types (ARCH-PROTOCOL-038).
 *
 *  Publication is driven by the availability owner alone, which republishes on
 *  a skill reload and on a capability change, so the roster clients render and
 *  the roster this realm admits against are the same projection. */
export function createCommandCatalogProjection(options: {
  readonly definitions: ProjectDefinitionRegistry
  readonly availability: DefinitionAvailabilityOwner
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly publish: (input: RuntimeUiPatchInput) => void
  /** The observation of the skill roots, started before the registry loaded;
   *  this projection names what a change runs. */
  readonly watch: Pick<DefinitionRootWatch, "bind">
  /** Optional module reconciliation before installed definitions reload. */
  readonly beforeDefinitionsReload?: () => Promise<void>
  /** Settles consumers of the complete definition revision before its command catalog publishes. */
  readonly onDefinitionsReloaded?: () => void | Promise<void>
}): CommandCatalogProjection {
  const definitions = options.definitions
  // Counts publications, so a client that echoes the revision it rendered is
  // refused after any republication.
  let revision = 0
  const build = (): RuntimeCommandCatalog => {
    const moduleSnapshot = options.moduleSelection()
    revision += 1
    return {
      revision,
      // Kernel commands plus the commands of every enabled capability module.
      builtInCommands: builtInCommandDeclarations(moduleSnapshot).map(builtInCommandDescriptor),
      // A client asks this list only about a token that nothing published runs.
      offCommands: offCommandDescriptors(moduleSnapshot),
    }
  }
  let catalog = build()
  const unsubscribe = options.availability.onChange(() => {
    catalog = build()
    options.publish({ cursor: commandCatalogCursor(), payload: { kind: "commands.updated", catalog } })
  })
  options.watch.bind({
    reload: definitions.reload,
    ...(options.beforeDefinitionsReload ? { beforeReload: options.beforeDefinitionsReload } : {}),
    onReloaded: async () => {
      await options.onDefinitionsReloaded?.()
      await options.availability.refresh()
    },
  })

  return {
    snapshot: () => catalog,
    dispose: async () => { unsubscribe() },
  }
}
