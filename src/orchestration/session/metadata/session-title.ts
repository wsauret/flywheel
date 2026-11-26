import { SHORT_TITLE_MAX_CHARS } from "../../../protocol/runtime/app-service-types.js"

// Session-picker title budget: at full modal width (terminal ≥144 cols) a
// root row in split mode has 67 columns; icons/padding on the left (2) and
// diff + time columns on the right (~19) leave 46 for the title, so a
// 46-char title renders unellipsized in the steady-state picker row.
export const TITLE_MAX_CHARS = 46
const FORK_SHORT_PREFIX = "Fork: "

export interface SessionTitles {
  full: string
  short: string
}

/** Derives fork labels without model work or collision-dependent state. */
export function forkSessionTitles(source: { label: string; shortLabel?: string }): SessionTitles {
  const sourceShort = source.shortLabel ?? source.label
  // The short title keeps whole words of the source's, so a tab never shows
  // a word cut in half; only a first word longer than the room is cut.
  const room = SHORT_TITLE_MAX_CHARS - FORK_SHORT_PREFIX.length
  let words = ""
  for (const word of sourceShort.trim().split(/\s+/)) {
    const longer = words ? `${words} ${word}` : word
    if (longer.length > room) break
    words = longer
  }
  const candidate = `${FORK_SHORT_PREFIX}${words || sourceShort.slice(0, room)}`.trimEnd()
  return {
    full: `Fork of ${source.label}`,
    short: candidate === sourceShort ? "Fork: branch" : candidate,
  }
}

function quickTitle(words: string[], wordLimit: number, charLimit: number): string {
  const quick = words.slice(0, wordLimit).join(" ")
  return quick.length > charLimit ? quick.slice(0, charLimit) : quick
}

export function titleCaseWords(value: string): string {
  return value.replace(/\S+/gu, (word) =>
    word.replace(/\p{L}/u, (firstLetter) => firstLetter.toLocaleUpperCase()))
}

/** Synchronous, deterministic title derived from the message: first 10 words
 *  for the full label, first 2 for the short label, hard-truncated (no
 *  ellipsis) so the compact titles don't waste tab space. */
export function quickTitleFromMessage(message: string): SessionTitles {
  const words = message.trim().split(/\s+/)
  return {
    full: quickTitle(words, 10, TITLE_MAX_CHARS),
    short: titleCaseWords(words.slice(0, 2).join(" ")).slice(0, SHORT_TITLE_MAX_CHARS),
  }
}
