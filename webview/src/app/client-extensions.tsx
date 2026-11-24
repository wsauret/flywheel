import { createContext, useContext } from "solid-js"
import type { WebModuleClient } from "../web-module-client.js"

const Extensions = createContext<readonly WebModuleClient[]>([])
export const ClientExtensionsProvider = Extensions.Provider

export function useClientExtensions() {
  return useContext(Extensions)
}
