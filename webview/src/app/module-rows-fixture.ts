import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { ModuleRow, ModuleRowAction } from "../../../src/protocol/protocol-module.js"
import { MODULE_IDS } from "../../../src/protocol/module-ids.js"
import type { ModuleDomainViews } from "../client/module-domain-views.js"
import { ClientContext } from "./client-context.js"
import { fakeClient, fakeClientActions, fakePanelSettings, fakeViewState } from "./client-context-fixture.js"
import { IntroCard, IntroModuleRow } from "./intro-card.js"
import { ModuleRowView } from "./sheets/status-sheet.js"

/** The intro card over a frame that carries only module views, so what it
 *  renders beyond the kernel rows comes from the registry's selectors. */
export function renderIntroCard(modules: ModuleDomainViews, backend: { readonly runtimeVersion?: string; readonly runtimeBuildId?: string | null; readonly showBuild?: boolean } = {}) {
  const invoked: string[] = []
  const view = fakeViewState({
    runtimeVersion: backend.runtimeVersion, runtimeBuildId: backend.runtimeBuildId, modules,
    settings: fakePanelSettings({ moduleIds: MODULE_IDS, showBuild: backend.showBuild ?? false, profile: { displayName: "", count: 1 } }),
  })
  const client = fakeClient({ state: () => view, actions: fakeClientActions({ invokeCommand: (id: string) => { invoked.push(id) } }) })
  const html = renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(IntroCard, {}) },
  }))
  return { html, invoked }
}

/** The two row hosts over the same rows, so a reader can check they say the same thing. */
export function renderRowHosts(rows: readonly ModuleRow[]) {
  const noop = (_action: ModuleRowAction | string): void => {}
  return {
    intro: renderToString(() => rows.map((row) => createComponent(IntroModuleRow, { row, onCommand: noop, working: () => false, onSurface: noop }))),
    status: renderToString(() => rows.map((row) => createComponent(ModuleRowView, { row, onAction: noop }))),
  }
}
