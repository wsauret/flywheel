import { createSignal } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import {
  commandCatalogCursor,
  type BuiltInCommandDescriptor,
  type CommandCatalogPatchPayload,
  type OffCommandDescriptor,
  type RuntimeCommandCatalog,
  type RuntimeCommandCatalogResult,
} from "../../protocol/command-catalog-protocol-types.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import type { CommandCatalogReadiness } from "../../protocol/client/slash-route.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"

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
  const cursor = commandCatalogCursor()
  const scope = { kind: "cursor", cursor } as const
  const receiver = createOrderedPatchReceiver<typeof scope, RuntimeCommandCatalogResult, RuntimeUiPatch & { payload: CommandCatalogPatchPayload }>({
    client: deps.appService,
    connectedScope: () => scope,
    accept(patch) {
      if (patch.cursor.scope !== "workspace" || patch.cursor.domain !== "commands") return null
      if (patch.payload.kind === "runtime.invalidate") return { cursor, scope }
      return patch.payload.kind === "commands.updated"
        ? { cursor, scope, patch: { ...patch, payload: patch.payload } }
        : null
    },
    scopeKey: runtimeSnapshotScopeKey,
    loadSnapshot: () => deps.appService.query({ type: "commandCatalog" }),
    applySnapshot(snapshot) {
      apply(snapshot)
      return { snapshotPosition: snapshot.snapshotPosition, cursors: [cursor] }
    },
    applyPayload(patch) {
      apply(patch.payload.catalog)
    },
  })
  return {
    builtInCommands: () => builtInCommands,
    offCommands,
    revision,
    known: () => known,
    arrived: arrival.promise,
    refresh: () => receiver.resnapshot(scope),
  }
}
