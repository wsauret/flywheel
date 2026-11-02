import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { ModuleId } from "../../../src/protocol/module-ids.js"
import type { ModuleDomainViews } from "../client/module-domain-views.js"
import type { WebModule } from "../web-module.js"
import { ClientContext } from "./client-context.js"
import { fakeClient, fakeClientActions, fakeViewState } from "./client-context-fixture.js"
import { ToolbarBadges } from "./toolbar-badges.js"

/** The badge slot over a frame that carries only module views, so what it
 *  renders comes from the registry's selectors alone. */
export function renderToolbarBadges(modules: readonly WebModule[], views: ModuleDomainViews) {
  const reports: string[] = []
  const view = fakeViewState({ modules: views })
  const client = fakeClient({ state: () => view, actions: fakeClientActions({ invokeCommand: () => {} }) })
  const html = renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() {
      return createComponent(ToolbarBadges, { modules, report: (module, error) => { reports.push(`${module.id}: ${error instanceof Error ? error.message : String(error)}`) } })
    },
  }))
  return { html, reports }
}

/** A module no host names, under the id the test chooses: one badge from a constant reading, and one whose selector throws. */
export function syntheticBadges(id: ModuleId) {
  return {
    working: { id, toolbar: () => ({ id: "bench", label: "benches", count: 3, tone: "warning", action: { kind: "surface", id: "bench-board" } }) } satisfies WebModule,
    broken: { id, toolbar: () => { throw new Error("badge exploded") } } satisfies WebModule,
  }
}
