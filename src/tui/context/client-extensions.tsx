/** @jsxImportSource @opentui/solid */
import { createContext, useContext, type JSX } from "solid-js"
import type { TuiModuleClient } from "../tui-module-client.js"
const ClientExtensionsContext = createContext<readonly TuiModuleClient[]>([])
export const ClientExtensionsProvider = ClientExtensionsContext.Provider
export function useClientExtensions(): readonly TuiModuleClient[] { return useContext(ClientExtensionsContext) }
/** Carries registered client contexts into detached viewer roots. */
export function ClientExtensionProviders(props: { readonly children: JSX.Element }) {
  const clients = useClientExtensions()
  const render = (index: number): JSX.Element => clients[index]?.provide(() => render(index + 1)) ?? props.children
  return <>{render(0)}</>
}
