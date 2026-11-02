import type { RGBA } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { type Accessor, createContext, useContext } from "solid-js"

// The entry id a transcript landing (a /bg row click) just scrolled to.
// OutputWindow owns the value and clears it after a short time; the card that
// represents the entry paints the shared hover background so the person can
// find it in the transcript.
const LandingTargetContext = createContext<Accessor<string | undefined>>(() => undefined)

export const LandingTargetProvider = LandingTargetContext.Provider

/** The background of a card that represents any of `ids`: the shared hover
 *  color while one of them is the landing target, otherwise undefined. */
export function useLandingBackground(ids: () => readonly (string | undefined)[]): Accessor<RGBA | undefined> {
  const target = useContext(LandingTargetContext)
  const { theme } = useTheme()
  return () => {
    const id = target()
    return id !== undefined && ids().includes(id) ? theme.backgroundElement : undefined
  }
}
