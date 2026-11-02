import { Key } from "@solid-primitives/keyed"

import { pageDomainReader } from "../client/module-domain-views.js"
import type { ToolbarBadge, WebModule } from "../web-module.js"
import { useClient } from "./client-context.js"

/** The `toolbar.badges` slot: every registered module's badge from its own
 *  views, after the kernel's own controls, in registry order. A selector that
 *  throws contributes no badge and is reported once naming the module, so a
 *  broken module never takes the toolbar with it. */
export function ToolbarBadges(props: { readonly modules: readonly WebModule[]; readonly report: (module: WebModule, error: unknown) => void }) {
  const client = useClient()
  const reported = new Set<WebModule>()
  const badges = (): readonly ToolbarBadge[] => {
    const read = pageDomainReader(client.state)
    return props.modules.flatMap((module) => {
      if (!module.toolbar) return []
      try {
        const badge = module.toolbar(read)
        return badge === undefined ? [] : [badge]
      } catch (error) {
        if (!reported.has(module)) {
          reported.add(module)
          props.report(module, error)
        }
        return []
      }
    })
  }
  const run = (badge: ToolbarBadge): void => {
    if (badge.action.kind === "surface") client.openSurface(badge.action.id)
    else client.actions.invokeCommand(badge.action.id)
  }
  return (
    <Key each={badges()} by="id">
      {(badge) => (
        <button class={`connection toolbar-badge toolbar-badge-${badge().tone ?? "plain"}`} title={`${badge().count} ${badge().label}`} aria-label={`${badge().count} ${badge().label}`} aria-busy={(badge().action.kind === "command" && client.actions.commandWorking(client.state().sessionId, badge().action.id)) || undefined} onClick={() => run(badge())}>
          <span class="toolbar-badge-count">{badge().count}</span>
          <span class="toolbar-badge-label">{badge().label}</span>
        </button>
      )}
    </Key>
  )
}
