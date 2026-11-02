import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { RuntimeHealth } from "../../../src/protocol/app-service-types.js"
import type { ModuleId } from "../../../src/protocol/module-ids.js"
import type { ProtocolModule } from "../../../src/protocol/protocol-module.js"
import { ClientContext } from "./client-context.js"
import { ComposerStatus, RuntimeFaultNotice } from "./composer-status.js"
import { fakeClient, fakePanelSettings, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import type { ModuleDomainViews } from "../client/module-domain-views.js"
import { backgroundReads, createReadRetry } from "../../../src/protocol/client/background-reads.js"
import type { FaultReach } from "../../../src/protocol/client/runtime-fault-copy.js"

export function renderComposerStatus(enabled: readonly ModuleId[] | undefined, owner: ModuleId, health: RuntimeHealth = { kind: "faulted", since: 1 }, extra?: { readonly module: ProtocolModule; readonly views: Partial<ModuleDomainViews> }, failedReads = 0, reach?: FaultReach) {
  const connection = fakeRuntimeConnection()
  const retries = Array.from({ length: failedReads }, (_, index) => {
    const retry = createReadRetry(connection, `view ${index}`, () => {})
    retry.failed(new Error("unavailable"))
    return retry
  })
  const module: ProtocolModule = {
    id: owner, domains: [],
    composer: { status: () => [
      { id: "synthetic", text: "Ready to review", tone: "warning", suffix: { text: "3", tone: "success" }, action: { kind: "surface", id: "review-board" } },
      { id: "plain", text: "Background reading" },
    ] },
  }
  const idle = fakeViewState()
  const view = fakeViewState({ modules: { ...idle.modules, ...extra?.views }, health, settings: enabled === undefined ? undefined : fakePanelSettings({ moduleIds: enabled }) })
  const client = fakeClient({ connection, state: () => view })
  const html = renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return [createComponent(RuntimeFaultNotice, { reach }), createComponent(ComposerStatus, { modules: extra === undefined ? [module] : [module, extra.module] })] },
  }))
  for (const retry of retries) retry.dispose()
  if (backgroundReads(connection).failing) throw new Error("disposed reads retain their notice")
  return html
}
