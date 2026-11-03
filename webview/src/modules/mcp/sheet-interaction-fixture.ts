import { createComponent, createRoot } from "solid-js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { McpStatusRow } from "../../../../src/protocol/modules/mcp.js"
import { fakeClient, fakeClientActions, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import { McpSheet } from "./sheet.js"

/** Mounts the real MCP sheet against an in-memory Solid host, so a test
 *  presses its buttons through their own click handlers. */
export function mountMcpSheet(servers: readonly McpStatusRow[]) {
  return createRoot((dispose) => {
    const root = createElement("root")
    const mutations: FrontendMutation[] = []
    const idle = fakeViewState()
    const view = { ...idle, projectRoot: "/repo", modules: { ...idle.modules, mcp: servers }, settings: fakePanelSettings({ moduleIds: ["mcp"] }) }
    Reflect.set(globalThis, "__flywheelMcpSheetTestClient", fakeClient({
      state: () => view,
      actions: fakeClientActions(),
      connection: fakeRuntimeConnection({ onDispatch: (mutation) => { mutations.push(mutation) }, mutations: { "mcp.reconnect": () => ({ ok: true }) } }),
      report: () => {},
    }))
    insert(root, createComponent(McpSheet, {}))
    // The sheet renders one control group per server, in server order.
    const rowButtons = (name: string) => {
      const row = nodes(root).filter((node) => node.tag === "div" && node.properties.class === "sheet-row-main")[servers.findIndex((server) => server.name === name)]
      if (!row) throw new Error(`Missing row: ${name}`)
      return nodes(row).filter((node) => node.tag === "button")
    }
    return {
      dispose: () => { dispose(); Reflect.deleteProperty(globalThis, "__flywheelMcpSheetTestClient") },
      ready: async () => { for (let turn = 0; turn < 8; turn += 1) await Promise.resolve() },
      mutations: () => mutations,
      buttons: (name: string) => rowButtons(name).map(textContent),
      click(name: string, label: string) {
        const button = rowButtons(name).find((node) => textContent(node) === label)
        const handler = button?.properties.onClick
        if (typeof handler !== "function") throw new Error(`Missing ${label} on ${name}`)
        handler({ currentTarget: button })
      },
    }
  })
}
