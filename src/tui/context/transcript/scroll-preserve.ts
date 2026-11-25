import { createContext, useContext } from "solid-js"

export type PreserveScrollFn = (fn: () => void) => void

const noop: PreserveScrollFn = (fn) => fn()

const ScrollPreserveContext = createContext<PreserveScrollFn>(noop)

export const ScrollPreserveProvider = ScrollPreserveContext.Provider

export function usePreserveScroll(): PreserveScrollFn {
  return useContext(ScrollPreserveContext) ?? noop
}
