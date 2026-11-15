/** @jsxImportSource @opentui/solid */
import { createContext, useContext, type JSX } from "solid-js"
import type { TuiFirstTab, TuiModuleClient } from "../tui-module-client.js"
const ClientExtensionsContext = createContext<readonly TuiModuleClient[]>([])
export const ClientExtensionsProvider = ClientExtensionsContext.Provider
export function useClientExtensions(): readonly TuiModuleClient[] { return useContext(ClientExtensionsContext) }
const NO_FIRST_TAB: TuiFirstTab = { open: async () => undefined, current: () => undefined }
/** The first tab of the first client that names one. */
export function moduleFirstTab(clients: readonly TuiModuleClient[]): TuiFirstTab {
  return clients.find((client) => client.firstTab)?.firstTab ?? NO_FIRST_TAB
}
/** Whether `sessionId` is the first tab of a module that hides the tab controls for it (`TuiFirstTab.hidesTabControls`). */
export function hidesTabControls(clients: readonly TuiModuleClient[], sessionId: string | undefined): boolean {
  const first = moduleFirstTab(clients)
  return first.hidesTabControls === true && sessionId !== undefined && sessionId === first.current()
}
/** Whether the tab bar shows nothing: its only tab hides the tab controls. */
export function tabBarHidden(clients: readonly TuiModuleClient[], tabs: readonly { readonly id: string }[]): boolean {
  return tabs.length === 1 && hidesTabControls(clients, tabs[0]?.id)
}
/** Carries registered client contexts into detached viewer roots. */
export function ClientExtensionProviders(props: { readonly children: JSX.Element }) {
  const clients = useClientExtensions()
  const render = (index: number): JSX.Element => clients[index]?.provide(() => render(index + 1)) ?? props.children
  return <>{render(0)}</>
}
