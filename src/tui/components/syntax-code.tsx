/** @jsxImportSource @opentui/solid */

import { StyledText, fg as stFg, type TextChunk } from "@opentui/core"
import { resolveSyntaxLanguage } from "@tui/adapters/syntax-language.js"
import { chatSyntaxColors, createHighlighter, type SyntaxColors } from "@tui/adapters/syntax-highlight.js"
import { useTheme } from "@tui/context/theme"
import type { TuiTheme } from "@tui/context/theme/resolve.js"
import { bindSelectableStyledTextContent } from "@tui/utils/reactive-text.js"
import { createMemo, For, type JSX, Show } from "solid-js"

interface SyntaxCodeProps {
  content: string
  filetype?: string
  lineNumbers?: boolean
  lineNumberWidth?: number
  streaming?: boolean
  dimColor?: boolean
  colors?: SyntaxColors
}

export function SyntaxCode(props: SyntaxCodeProps): JSX.Element {
  const themeCtx = useTheme()
  const language = createMemo(() => resolveSyntaxLanguage(props.filetype))
  const openTuiFiletype = createMemo(() => {
    const resolved = language()
    return props.lineNumbers !== true && resolved?.kind === "opentui"
      ? resolved.openTui
      : null
  })

  return (
    <Show
      when={openTuiFiletype()}
      fallback={<SyntaxCodeFallback {...props} filetype={language()?.highlightJs} />}
    >
      {(filetype) => (
        <code
          filetype={filetype()}
          content={props.content}
          syntaxStyle={props.dimColor ? themeCtx.subtleSyntax : themeCtx.syntax}
          streaming={props.streaming === true}
          // While streaming, OpenTUI keeps the last highlight until the next one lands only when unstyled drawing is off; on, every delta paints a plain frame.
          drawUnstyledText={props.streaming !== true}
          conceal={true}
          wrapMode="word"
          fg={props.dimColor ? themeCtx.subtleTheme.text : themeCtx.theme.text}
        />
      )}
    </Show>
  )
}

function SyntaxCodeFallback(props: SyntaxCodeProps): JSX.Element {
  const themeCtx = useTheme()
  const colors = createMemo(() => props.colors ?? (props.dimColor ? chatSyntaxColors(themeCtx.subtleTheme) : themeCtx.chatSyntaxColors))
  const highlighter = createMemo(() => {
    return createHighlighter(colors(), props.colors !== undefined)
  })
  const highlighted = createMemo(() => highlighter()(props.content, props.filetype))
  const lineNumberWidth = () => props.lineNumberWidth ?? String(highlighted().length).length

  const lineContent = (segments: ReturnType<ReturnType<typeof createHighlighter>>[number], index: number): StyledText => {
    const chunks: TextChunk[] = []
    if (props.lineNumbers) {
      chunks.push(stFg(colors().text)(` ${String(index + 1).padStart(lineNumberWidth())}  `))
    }
    for (const segment of segments) {
      chunks.push(stFg(segment.color ?? colors().text)(segment.text))
    }
    return new StyledText(chunks)
  }

  return (
    <For each={highlighted()}>
      {(segments, index) => (
        <text
          ref={bindSelectableStyledTextContent(() => lineContent(segments, index()))}
          wrapMode="word"
        />
      )}
    </For>
  )
}

/** SyntaxCode's line-numbered fallback branch as ONE StyledText: every
 *  highlighted line, optional gutter, newline-joined. Bodies that must keep a
 *  single renderable across state transitions (a tool entry's execution output
 *  settling into final content) bind this instead of mounting per-line
 *  elements, so the transition overwrites in place instead of unmounting one
 *  element and mounting another a frame later. */
export function syntaxBodyStyledText(args: {
  content: string
  filetype: string | undefined
  theme: TuiTheme
  colors?: SyntaxColors
  lineNumbers?: boolean
  lineNumberWidth?: number
}): StyledText {
  const language = resolveSyntaxLanguage(args.filetype)
  const colors = args.colors ?? chatSyntaxColors(args.theme)
  const highlighted = createHighlighter(colors, args.colors !== undefined)(args.content, language?.highlightJs)
  const width = args.lineNumberWidth ?? String(highlighted.length).length
  const chunks: TextChunk[] = []
  for (const [index, segments] of highlighted.entries()) {
    if (index > 0) chunks.push(stFg(args.theme.text)("\n"))
    if (args.lineNumbers) chunks.push(stFg(args.theme.text)(` ${String(index + 1).padStart(width)}  `))
    for (const segment of segments) chunks.push(stFg(segment.color ?? colors.text)(segment.text))
  }
  return new StyledText(chunks)
}
