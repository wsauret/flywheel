/** The words of a title or a query: runs of letters and digits, lower case. Punctuation such as `_`, `-`, and `/`
 *  separates words, so "dim_land" is the words "dim" and "land". */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0)
}

/** The title match of a session list search (PI-INTERACTION-178), shared by every client: a session matches when
 *  each word of the query starts a word of one of its fields, such as its title, short title, and id. Returns a
 *  predicate over a session's fields; a query with no words matches every session. */
export function sessionTitleMatcher(query: string): (fields: readonly (string | undefined)[]) => boolean {
  const wanted = words(query)
  return (fields) => {
    if (wanted.length === 0) return true
    const have = fields.flatMap((field) => field === undefined ? [] : words(field))
    return wanted.every((word) => have.some((candidate) => candidate.startsWith(word)))
  }
}
