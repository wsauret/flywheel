import { createContext, useContext } from "solid-js"

type NavigateUriFn = (uri: string) => void

const NavigationContext = createContext<NavigateUriFn>()

export const NavigationProvider = NavigationContext.Provider

export function useNavigateUri(): NavigateUriFn | undefined {
  return useContext(NavigationContext)
}
