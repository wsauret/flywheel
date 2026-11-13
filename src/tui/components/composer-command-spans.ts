/** The spans of `text` that name a slash command in `names` (lower case),
 *  so the composer can colour them. A command starts the text or follows
 *  white space. */
export function commandSpans(text: string, names: ReadonlySet<string>): { start: number; end: number }[] {
  if (!text.includes("/")) return []
  const spans: { start: number; end: number }[] = []
  // Match the leading whitespace/start as a non-captured boundary, then a
  // single capture for the command token. The whole match starts at the
  // boundary; the command starts at the "/" inside it, so cmdStart is the
  // match index plus the offset of "/" within match[0].
  const re = /(?:^|[\s])(\/[a-zA-Z][\w-]*(?::[\w-]*)?)/g
  for (const match of text.matchAll(re)) {
    const whole = match[0]
    const slash = whole.indexOf("/")
    const cmdText = whole.slice(slash)
    const cmdStart = match.index + slash
    const cmdName = cmdText.slice(1).toLowerCase()
    if (names.has(cmdName)) spans.push({ start: cmdStart, end: cmdStart + cmdText.length })
  }
  return spans
}
