/** Git's split_cmdline grammar, not shell parsing. Backslashes escape one
 * character outside single quotes, including inside double quotes. Leading
 * and trailing whitespace produce empty arguments. Malformed quotes or a
 * final escape return undefined. Shell aliases are not expanded here.
 * Grammar: https://github.com/git/git/blob/v2.49.0/alias.c */
export function splitGitAlias(value: string): string[] | undefined {
  const argv = [""]
  let quote: "'" | '"' | undefined
  for (let at = 0; at < value.length; at++) {
    const character = value.charAt(at)
    if (quote === undefined && /[ \t\n\r\v\f]/.test(character)) {
      while (/[ \t\n\r\v\f]/.test(value[at + 1] ?? "\0")) at++
      argv.push("")
    } else if (quote === undefined && (character === "'" || character === '"')) {
      quote = character
    } else if (character === quote) {
      quote = undefined
    } else {
      let literal = character
      if (character === "\\" && quote !== "'") {
        if (++at === value.length) return undefined
        literal = value.charAt(at)
      }
      argv[argv.length - 1] += literal
    }
  }
  return quote === undefined ? argv : undefined
}
