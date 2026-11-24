/** The most matches one transcript find returns. A client shows more as "1000+". */
export const TRANSCRIPT_FIND_LIMIT = 1000

/** What a person typed into a find bar and how to read it. */
interface FindPattern {
  readonly pattern: string
  readonly regex: boolean
  readonly matchCase: boolean
}

/** A half-open range of UTF-16 offsets in the searched text. */
export interface FindRange {
  readonly start: number
  readonly end: number
}

/** Every non-empty, non-overlapping occurrence in `text`, in order, at most `limit`. */
export type FindMatcher = (text: string, limit?: number) => readonly FindRange[]

type CompiledFind =
  | { readonly kind: "empty" }
  | { readonly kind: "bad-pattern" }
  | { readonly kind: "ready"; readonly matcher: FindMatcher }

/** Compiles a find. The runtime that counts the matches and the client that
 *  paints them read a pattern by this one rule: literal text matches as
 *  typed, a regular expression is JavaScript syntax with `^` and `$` at each
 *  line, and an empty match never counts. */
export function compileFind(find: FindPattern): CompiledFind {
  if (find.pattern.length === 0) return { kind: "empty" }
  let expression: RegExp
  try {
    expression = new RegExp(find.regex ? find.pattern : RegExp.escape(find.pattern), find.matchCase ? "gm" : "gim")
  } catch {
    return { kind: "bad-pattern" }
  }
  return {
    kind: "ready",
    matcher: (text, limit = Number.POSITIVE_INFINITY) => {
      const ranges: FindRange[] = []
      expression.lastIndex = 0
      while (ranges.length < limit) {
        const found = expression.exec(text)
        if (found === null) break
        if (found[0].length === 0) {
          expression.lastIndex += 1
          continue
        }
        ranges.push({ start: found.index, end: found.index + found[0].length })
      }
      return ranges
    },
  }
}
