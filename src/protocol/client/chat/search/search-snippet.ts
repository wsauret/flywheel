/** One run of a search snippet: words that matched the query, or the text around them. */
export interface SnippetPart {
  readonly text: string
  readonly match: boolean
}

/** A search snippet's bracketed matches, as the conversation index marks them, split for emphasis. */
export function snippetParts(snippet: string): SnippetPart[] {
  return snippet.split(/(\[[^\]]*\])/).filter((part) => part.length > 0).map((part) =>
    part.startsWith("[") && part.endsWith("]") ? { text: part.slice(1, -1), match: true } : { text: part, match: false })
}
