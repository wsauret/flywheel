/** A path segment that JavaScript can write after a dot. */
export const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/

/** The expression a Code Mode script calls a dotted tool name through, such
 *  as `tools.github.search` or `tools.context7["resolve-library-id"]`. */
export const toolExpression = (path: string): string =>
  "tools" + path
    .split(".")
    .map((segment) => (identifierSegment.test(segment) ? `.${segment}` : `[${JSON.stringify(segment)}]`))
    .join("")
