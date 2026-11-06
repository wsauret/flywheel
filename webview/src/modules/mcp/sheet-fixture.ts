import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"
import type { McpStatusRow } from "../../../../src/protocol/modules/mcp.js"
import { ClientContext } from "../../app/client-context.js"
import { fakeClient, fakeClientActions, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { McpSheet } from "./sheet.js"
import { actionKey } from "../../client/action-key.js"

/** SSR supplies the real sheet with its protocol rows and action owner. DOM focus is verified in installed UAT. */
export function renderMcpSheet(servers: readonly McpStatusRow[] | null | undefined, working?: string, claudeAiConnectors = false): string {
  const idle = fakeViewState()
  const modules = { ...idle.modules, mcp: servers ? { servers, claudeAiConnectors } : null }
  const view = { ...idle, projectRoot: "/repo", modules, settings: fakePanelSettings({ moduleIds: ["mcp"] }) }
  const client = fakeClient({
    state: () => view,
    actions: fakeClientActions({ working: (key: string) => working !== undefined && key === actionKey("mcp.server", working) }),
    confirm: async () => false,
  })
  return renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(McpSheet, {}) },
  }))
}
