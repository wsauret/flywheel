import { createContext, useContext, type JSX } from "solid-js"
import type { WebModuleClient } from "../web-module-client.js"
import type { BlockProps } from "./blocks.js"

const Extensions = createContext<readonly WebModuleClient[]>([])
export const ClientExtensionsProvider = Extensions.Provider

/** Modules replace only the blocks they own. Ordinary blocks keep their renderer. */
export function ExtensionBlock(props: { readonly block: BlockProps; readonly fallback: () => JSX.Element }) {
  const clients = useContext(Extensions)
  const contribution = clients.find(client => client.block?.matches(props.block.block))?.block
  return contribution ? contribution.render(props.block) : props.fallback()
}

export function useClientExtensions() {
  return useContext(Extensions)
}
