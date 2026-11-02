import { useTerminalDimensions } from "@opentui/solid"
import { type Accessor, createContext, useContext } from "solid-js"

const TranscriptViewportHeightContext = createContext<Accessor<number>>()

export const TranscriptViewportHeightProvider = TranscriptViewportHeightContext.Provider

/** The scroll viewport's rows, or terminal rows when rendered outside a transcript. */
export function useTranscriptViewportHeight(): Accessor<number> {
  const height = useContext(TranscriptViewportHeightContext)
  const terminal = useTerminalDimensions()
  return height ?? (() => terminal().height)
}
