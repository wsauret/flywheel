import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { ModuleRowAction } from "../../../src/protocol/protocol-module.js"
import { MODULE_IDS } from "../../../src/protocol/module-ids.js"
import { moduleRows } from "../../../src/protocol/modules.js"
import { pageDomainReader, type ModuleDomainViews } from "../client/module-domain-views.js"
import { ClientContext } from "../app/client-context.js"
import { fakeClient, fakeClientActions, fakePanelSettings, fakeViewState } from "../app/client-context-fixture.js"
import { IntroCard } from "../app/transcript/intro-card.js"
import { ModuleRowView } from "../app/sheets/sheet.js"

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

/** The two row hosts over one frame's module views: the intro card renders
 *  the registry's intro rows, and the status sheet's row view renders the same
 *  rows, so a reader can check they say the same thing. */
export function renderRowHosts(modules: ModuleDomainViews) {
  const noop = (_action: ModuleRowAction): void => {}
  const rows = moduleRows("intro", pageDomainReader(() => ({ modules, health: { kind: "healthy" } })), MODULE_IDS)
  return {
    intro: renderIntroCard(modules).html,
    status: renderToString(() => rows.map((row) => createComponent(ModuleRowView, { row, onAction: noop }))),
  }
}
