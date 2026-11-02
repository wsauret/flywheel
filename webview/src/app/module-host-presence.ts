import { createEffect, createMemo, createRoot, createSignal, getOwner, on, onCleanup, type Accessor } from "solid-js"

import type { FaultReach } from "../../../src/protocol/client/runtime-fault-copy.js"
import type { ModuleId } from "../../../src/protocol/module-ids.js"
import type { ClientHost } from "../host.js"
import { webModuleEnabled, type WebHostPresence, type WebModule } from "../web-module.js"
import { createScreenStack, type PlacementLabels, type ScreenStack, type ScreenStackSelection } from "./screen-stack.js"

/** Owns each admitted host contribution and the navigation it requests. Disabling
 *  a contribution releases its subscriptions before it can be mounted again. */
export function createModuleHostPresence(
  modules: readonly WebModule[],
  host: ClientHost,
  enabled: Accessor<readonly ModuleId[] | undefined>,
  report: (module: WebModule, error: unknown) => void,
  options: {
    readonly createStack?: typeof createScreenStack
    readonly selection?: ScreenStackSelection
    /** Called each time a presence's runtime turns served after it was not:
     *  the runtime the page reaches has appeared. */
    readonly appeared?: () => void
  } = {},
) {
  const owner = getOwner()
  const presences = modules.filter((module) => module.hostPresence).map((module) => {
    const [presence, setPresence] = createSignal<WebHostPresence>()
    const active = createMemo(() => webModuleEnabled(module.id, enabled()))
    createEffect(on(active, (admitted) => {
      if (!admitted) return
      let dispose = () => {}
      onCleanup(() => { setPresence(undefined); dispose() })
      try {
        const created = createRoot((release) => {
          dispose = release
          return module.hostPresence?.(host, active)
        }, owner)
        if (!created) return
        const failed = new Set<string>()
        const contain = <Value>(slot: string, read: Accessor<Value>): Value | undefined => {
          try { return read() }
          catch (error) {
            if (!failed.has(slot)) { failed.add(slot); report(module, error) }
            return undefined
          }
        }
        const { reach, served } = created
        setPresence({
          ...created,
          stage: () => contain("stage", created.stage),
          placement: () => contain("placement", created.placement),
          ...(reach === undefined ? {} : { reach: () => contain("reach", reach) }),
          ...(served === undefined ? {} : { served: () => contain("served", served) === true }),
        })
      } catch (error) { dispose(); report(module, error) }
    }))
    return { module, read: presence }
  })
  const active = () => presences.flatMap(({ module, read }) => { const presence = read(); return presence ? [{ module, presence }] : [] })
  const stage = () => active().map(({ presence }) => presence.stage()).find((value) => value !== undefined)
  const placement: Accessor<PlacementLabels | undefined> = () => active().map(({ presence }) => presence.placement()).find((value) => value !== undefined)
  const reach: Accessor<FaultReach | undefined> = () => active().map(({ presence }) => presence.reach?.()).find((value) => value !== undefined)
  const served = createMemo(() => active().some(({ presence }) => presence.served?.() === true))
  const appeared = options.appeared
  if (appeared !== undefined) createEffect(on(served, (now, before) => { if (now && before === false) appeared() }, { defer: true }))
  const [stack, setStack] = createSignal<ScreenStack>()
  const wantsStack = createMemo(() => active().some(({ presence }) => presence.navigation === "stack"))
  createEffect(on(wantsStack, (requested) => {
    if (!requested) return
    let dispose = () => {}
    onCleanup(() => { setStack(undefined); dispose() })
    try {
      setStack(createRoot((release) => {
        dispose = release
        return (options.createStack ?? createScreenStack)(placement, options.selection)
      }, owner))
    } catch (error) {
      dispose()
      const requester = active().find(({ presence }) => presence.navigation === "stack")
      if (requester) report(requester.module, error)
    }
  }))
  return { stage, placement, reach, stack }
}
