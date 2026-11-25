import { createSignal, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { AttachedRuntimeClient } from "../../../protocol/runtime/app-service-types.js"
import {
  commandCatalogCursor,
  type BuiltInCommandDescriptor,
  type OffCommandDescriptor,
  type RuntimeCommandCatalog,
} from "../../../protocol/commands/command-catalog-protocol-types.js"
import { createHeldView } from "../../../protocol/client/held-view.js"
import type { CommandCatalogReadiness } from "../../../protocol/client/commands/slash-route.js"

export interface CommandCatalogCache extends CommandCatalogReadiness {
  /** Metadata contributed by enabled capability modules. Empty until the
   *  first snapshot arrives, as is every roster here. */
  builtInCommands(): readonly BuiltInCommandDescriptor[]
  /** Commands that only a turned-off module provides, for their refusal only. */
  offCommands(): readonly OffCommandDescriptor[]
  /** The publication the rendered roster came from; a built-in invocation echoes it. */
  revision(): number
  /** Re-reads the roster whole, for after the runtime refused an echoed revision. */
  refresh(): Promise<void>
}

/** Client intake for the runtime-owned command catalog, which the runtime
 *  republishes whole when the commands that enabled modules provide change. */
export function createCommandCatalog(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): CommandCatalogCache {
  const [builtInCommands, setBuiltInCommands] = createStore<BuiltInCommandDescriptor[]>([])
  const [offCommands, setOffCommands] = createSignal<readonly OffCommandDescriptor[]>([])
  const [revision, setRevision] = createSignal(0)
  let known = false
  const arrival = Promise.withResolvers<void>()
  const apply = (catalog: RuntimeCommandCatalog): void => {
    known = true
    arrival.resolve()
    setRevision(catalog.revision)
    setBuiltInCommands(reconcile([...catalog.builtInCommands], { key: "id" }))
    setOffCommands(catalog.offCommands)
  }
  const held = createHeldView<RuntimeCommandCatalog>({
    client: deps.appService,
    cursor: commandCatalogCursor(),
    read: async () => {
      const snapshot = await deps.appService.query({ type: "commandCatalog" })
      return { view: snapshot, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "commands.updated" ? payload.catalog : undefined),
    changed: apply,
    label: "command catalog",
  })
  onCleanup(held.dispose)
  return {
    builtInCommands: () => builtInCommands,
    offCommands,
    revision,
    known: () => known,
    arrived: arrival.promise,
    refresh: held.refresh,
  }
}
