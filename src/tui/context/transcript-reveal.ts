import type { Renderable } from "@opentui/core"
import { createContext, useContext } from "solid-js"

/** Scrolls the transcript that holds `element` so that it shows the element in full, or its top when it is taller
 *  than the view. It leaves the view when the element already shows in full. Outside a transcript it does nothing. */
export type RevealInTranscript = (element: Renderable) => void

const TranscriptRevealContext = createContext<RevealInTranscript>(() => {})

export const TranscriptRevealProvider = TranscriptRevealContext.Provider

export function useRevealInTranscript(): RevealInTranscript {
  return useContext(TranscriptRevealContext)
}
