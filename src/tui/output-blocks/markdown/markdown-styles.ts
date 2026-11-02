import type { TextChunk } from "@opentui/core"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { BOLD, ITALIC, UNDERLINE } from "@tui/utils/text-attributes.js"

/**
 * Per-role formatting spec consulted by `renderMarkdownToken`. Themes can override
 * any role to customize attributes and foreground colors without forking the
 * token switch.
 */
export interface StyleSpec {
  attr: number
  fg?: TextChunk["fg"]
}

export interface MarkdownStyles {
  h1: StyleSpec; h2: StyleSpec; h3: StyleSpec
  h4: StyleSpec; h5: StyleSpec; h6: StyleSpec
  strong: StyleSpec; emphasis: StyleSpec
  code: StyleSpec; codeBlock: StyleSpec
  link: StyleSpec; listMarker: StyleSpec
  blockquoteBody: StyleSpec; blockquoteBar: StyleSpec
  horizontalRule: StyleSpec; image: StyleSpec
}

export function defaultMarkdownStyles(theme: Readonly<TuiTheme>): MarkdownStyles {
  const heading: StyleSpec = { attr: BOLD, fg: theme.markdownHeading }
  return {
    h1: { attr: BOLD | ITALIC | UNDERLINE, fg: theme.markdownHeading },
    h2: heading, h3: heading, h4: heading, h5: heading, h6: heading,
    strong: { attr: BOLD },
    emphasis: { attr: ITALIC },
    code: { attr: 0, fg: theme.markdownCode },
    codeBlock: { attr: 0, fg: theme.markdownCodeBlock },
    link: { attr: UNDERLINE, fg: theme.markdownLink },
    listMarker: { attr: 0, fg: theme.markdownListEnumeration },
    blockquoteBody: { attr: ITALIC },
    blockquoteBar: { attr: 0, fg: theme.markdownBlockQuote },
    horizontalRule: { attr: 0, fg: theme.markdownHorizontalRule },
    image: { attr: 0, fg: theme.markdownImage },
  }
}
