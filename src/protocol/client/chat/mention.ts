/** The `@path` token a person is typing, and its replacement once picked.
 *  A mention starts at the beginning of the text or after whitespace and
 *  runs to the caret without whitespace; the same shape the agent reads a
 *  file reference in, so what the picker inserts is what the message says. */

export interface MentionToken {
  /** Index of the `@`. */
  readonly start: number
  /** Index of the caret, where the token ends. */
  readonly end: number
  /** The text after the `@`. */
  readonly query: string
}

export function mentionAt(text: string, caret: number): MentionToken | undefined {
  const before = text.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return undefined
  const start = caret - (match[1]?.length ?? 0) - 1
  return { start, end: caret, query: match[1] ?? "" }
}

export interface MentionInsertion {
  readonly text: string
  readonly caret: number
}

/** How a path reads inside a mention: quoted when it holds whitespace, since
 *  a mention ends at the first space otherwise. */
export function mentionPath(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path
}

/** The text with the token replaced by the mention, and the caret after it.
 *  A file gets a space after it when the next character is not already one,
 *  so the next word begins clear of the path. A directory gets a slash and
 *  no space: the caret stays in the token, so the picker keeps listing what
 *  is inside. */
export function insertMention(text: string, token: MentionToken, path: string, directory = false): MentionInsertion {
  const rest = text.slice(token.end)
  const mention = directory ? `@${path}/` : `@${mentionPath(path)}${/^\s/.test(rest) ? "" : " "}`
  return { text: `${text.slice(0, token.start)}${mention}${rest}`, caret: token.start + mention.length }
}
