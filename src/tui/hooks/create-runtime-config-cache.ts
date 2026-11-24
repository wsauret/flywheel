import type { Accessor } from "solid-js"
import { createSignal, onCleanup } from "solid-js"
import { createHeldView } from "../../protocol/client/held-view.js"
import type { AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import { runtimeConfigCursor, type RuntimeConfigMutation, type RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"

export interface RuntimeConfigCache {
  readonly view: Accessor<RuntimeConfigView | undefined>
  settlePublication(command: RuntimeConfigMutation, revision: number): Promise<boolean>
}

function publishedMutation(view: RuntimeConfigView | undefined, command: RuntimeConfigMutation, revision: number): boolean {
  if (view === undefined || view.revision < revision) return false
  // A reset commits several values under one revision; reaching it is the settlement.
  if (command.type === "config.reset") return true
  if (command.setting.id === "gitAiAttribution" || command.setting.id === "allowTrainingRoutes" || command.setting.id === "provider") {
    if (command.target?.kind !== "profile") return false
    const profile = view.values.profiles[command.target.profileId]
    const actual = command.setting.id === "provider"
      ? profile?.providers[command.setting.providerId]?.[command.setting.key]
      : profile?.[command.setting.id]
    return JSON.stringify(actual) === JSON.stringify(command.setting.desired)
  }
  if (command.setting.id === "module") return JSON.stringify(view.values.moduleSections[command.setting.section]?.[command.setting.key]) === JSON.stringify(command.setting.desired)
  return JSON.stringify(view.values[command.setting.id]) === JSON.stringify(command.setting.desired)
}

/** The one client-side RuntimeConfigView cache. Composition creates it before
 * providers so all settings consumers observe the same snapshot and patches. */
export function createRuntimeConfigCache(deps: { appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane"> }): RuntimeConfigCache {
  const [view, setView] = createSignal<RuntimeConfigView | undefined>()
  let closed = false
  const settlements = new Set<() => void>()
  const wake = (): void => { for (const settle of settlements) settle() }
  const held = createHeldView<RuntimeConfigView>({
    client: deps.appService,
    cursor: runtimeConfigCursor(),
    read: async () => {
      const snapshot = await deps.appService.query({ type: "configSnapshot" })
      return { view: snapshot.config, position: snapshot.snapshotPosition }
    },
    adopt: (payload) => (payload.kind === "config.changed" ? payload.config : undefined),
    changed: (next) => { setView(next); wake() },
    label: "configuration",
  })
  onCleanup(() => {
    closed = true
    held.dispose()
    wake()
  })
  return {
    view,
    async settlePublication(command, revision) {
      if (publishedMutation(view(), command, revision)) return true
      await held.refresh()
      // The write committed, so its revision reaches this cache: a failed read
      // retries, and a patch or a later lane's read lands it. Only closing the
      // cache ends the wait before the revision arrives.
      const answered = (): boolean => closed || (view()?.revision ?? -1) >= revision
      while (!answered()) {
        await new Promise<void>((resolve) => {
          const settle = (): void => { settlements.delete(settle); resolve() }
          settlements.add(settle)
        })
      }
      return !closed && publishedMutation(view(), command, revision)
    },
  }
}
