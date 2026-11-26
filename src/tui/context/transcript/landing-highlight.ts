import type { RGBA } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { type Accessor, createContext, useContext } from "solid-js"

// The entry id a transcript landing (a /bg row click or a session list
// message hit) just scrolled to. OutputWindow owns the value and clears it
// after a short time; the card that represents the entry marks itself so the
// person can find it in the transcript.
const LandingTargetContext = createContext<Accessor<string | undefined>>(() => undefined)

export const LandingTargetProvider = LandingTargetContext.Provider

/** Whether a card that represents any of `ids` is the landing target now.
 *  A card whose resting background is already the shared hover color marks
 *  the landing another way, from this. */
export function useLanded(ids: () => readonly (string | undefined)[]): Accessor<boolean> {
  const target = useContext(LandingTargetContext)
  return () => {
    const id = target()
    return id !== undefined && ids().includes(id)
  }
}

/** The background of a card that represents any of `ids`: the shared hover
 *  color while one of them is the landing target, otherwise undefined. */
export function useLandingBackground(ids: () => readonly (string | undefined)[]): Accessor<RGBA | undefined> {
  const landed = useLanded(ids)
  const { theme } = useTheme()
  return () => landed() ? theme.backgroundElement : undefined
}
