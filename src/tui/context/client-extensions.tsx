import { createContext, useContext } from "solid-js"
import type { TuiModuleClient } from "../tui-module-client.js"
const ClientExtensionsContext = createContext<readonly TuiModuleClient[]>([])
export const ClientExtensionsProvider = ClientExtensionsContext.Provider
export function useClientExtensions(): readonly TuiModuleClient[] { return useContext(ClientExtensionsContext) }
