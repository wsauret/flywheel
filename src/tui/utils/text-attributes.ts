import { createTextAttributes, link, type StylableInput, type TextChunk } from "@opentui/core"

export const BOLD = createTextAttributes({ bold: true })
export const ITALIC = createTextAttributes({ italic: true })
export const UNDERLINE = createTextAttributes({ underline: true })
export const STRIKETHROUGH = createTextAttributes({ strikethrough: true })

/** Total character count across chunks. Char count, not terminal display
 *  width — use chunkDisplayWidth (tool-row-wrap.ts) when wide glyphs matter. */
export const chunksLength = (chunks: readonly TextChunk[]): number =>
  chunks.reduce((sum, chunk) => sum + chunk.text.length, 0)

const chunkFromInput = (input: StylableInput): TextChunk => {
  if (typeof input === "object" && input !== null && "__isChunk" in input) return input
  return { __isChunk: true, text: String(input) }
}

export const stStrike = (input: StylableInput): TextChunk => {
  const c = chunkFromInput(input)
  return { ...c, attributes: (c.attributes ?? 0) | STRIKETHROUGH }
}

/**
 * Clickable text affordance. Single source of truth for link styling: every
 * clickable chunk carries an OSC 8 hyperlink AND an underline so the user can
 * see it is actionable. Use this instead of OpenTUI's bare `link` for any
 * chunk rendered in the chat log.
 */
export const stLink = (url: string) => (input: StylableInput): TextChunk => {
  const c = link(url)(input)
  return { ...c, attributes: (c.attributes ?? 0) | UNDERLINE }
}