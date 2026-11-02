/** @jsxImportSource @opentui/solid */

import type { TextChunk } from "@opentui/core"
import { StyledText } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { SyntaxCode } from "@tui/components/syntax-code.js"
import { VerticalBarBorder } from "@tui/utils/border.js"
import { bindSelectableStyledTextContent } from "@tui/utils/reactive-text.js"
import { copyAsEmptyRow } from "@tui/utils/selection.js"
import { ITALIC } from "@tui/utils/text-attributes.js"
import type { Tokens } from "marked"
import { createMemo, Index, type JSX, Show } from "solid-js"
import { renderMarkdownToken, joinLines } from "./format-token.js"
import { renderToLineModel, type MarkdownSegment } from "./line-model.js"
import { createStreamingSegments } from "./streaming-line-model.js"
import { MarkdownTable } from "./markdown-table.js"
import { defaultMarkdownStyles, type MarkdownStyles } from "./markdown-styles.js"


function textChunksForLines(lines: TextChunk[][], inlineSuffix: readonly TextChunk[] = []): TextChunk[] {
  return [...joinLines(lines), ...inlineSuffix]
}

type SegmentRenderers = { [K in MarkdownSegment["kind"]]: () => JSX.Element }
interface MarkdownBodyProps {
  children: string
  /** Use explicit readable subdued colors for Markdown and fenced code. */
  dimColor?: boolean
  /** Styled chunks appended to the final text line without becoming message content. */
  inlineSuffix?: readonly TextChunk[]
  /** Strip ```md/```markdown fences that wrap real tables before lexing. */
  unwrapFences?: boolean
  /** Enable the lexer cache for stable content. Leave off for streaming content. */
  cache?: boolean
}

export function MarkdownBody(props: MarkdownBodyProps): JSX.Element {
  const themeCtx = useTheme()
  const palette = createMemo(() => props.dimColor ? themeCtx.subtleTheme : themeCtx.theme)
  const styles = createMemo(() => defaultMarkdownStyles(palette()))
  // Growing content lexes incrementally (committed prefix + volatile tail);
  // stable content does one cached full lex so scroll remounts stay cheap.
  const streamingSegments = createStreamingSegments()
  const segments = createMemo(() => props.cache
    ? renderToLineModel(props.children, styles(), props.unwrapFences, true)
    : streamingSegments(props.children, styles(), props.unwrapFences))

  const inlineSuffixTarget = createMemo(() => {
    if (!props.inlineSuffix || props.inlineSuffix.length === 0) return -1
    const items = segments()
    return items[items.length - 1]?.kind === "text" ? items.length - 1 : -1
  })
  return (
    <box flexDirection="column">
      {/* Rows are position-keyed (<Index>): the fold is append-only for
          committed segments, so settled rows never move or rebuild, and the
          volatile tail updates IN PLACE - a streaming code fence keeps one
          live renderable in incremental mode instead of being destroyed and
          re-parsed every flush. Only a kind change rebuilds a row. */}
      <Index each={segments()}>
        {(item, index) => {
          const inlineSuffix = () => index === inlineSuffixTarget() ? props.inlineSuffix : undefined
          const text = () => { const s = item(); return s.kind === "text" ? s : undefined }
          const code = () => { const s = item(); return s.kind === "code" ? s : undefined }
          const blockquote = () => { const s = item(); return s.kind === "blockquote" ? s : undefined }
          const table = () => { const s = item(); return s.kind === "table" ? s : undefined }
          const render: SegmentRenderers = {
            blank: () => <text ref={copyAsEmptyRow}>{" "}</text>,
            text: () => <text fg={palette().text} ref={bindSelectableStyledTextContent(() => new StyledText(textChunksForLines(text()?.lines ?? [], inlineSuffix())))} />,
            code: () => (
              <SyntaxCode
                filetype={code()?.lang}
                content={code()?.text ?? ""}
                streaming={code()?.streaming === true}
                dimColor={props.dimColor}
              />
            ),
            blockquote: () => <Show when={blockquote()}>{(seg) => <MarkdownBlockquote token={seg().token} styles={styles()} textColor={palette().text} />}</Show>,
            table: () => <Show when={table()}>{(seg) => <MarkdownTable token={seg().token} styles={styles()} textColor={palette().text} borderColor={props.dimColor === true ? themeCtx.theme.textMuted : themeCtx.theme.borderSubtle} />}</Show>,
          }
          const kind = createMemo(() => item().kind)
          const row = createMemo(() => render[kind()]())
          return <>{row()}</>
        }}
      </Index>
      {inlineSuffixTarget() === -1 && props.inlineSuffix && props.inlineSuffix.length > 0 && (
        <text fg={palette().text} ref={bindSelectableStyledTextContent(() => new StyledText(textChunksForLines([[]], props.inlineSuffix)))} />
      )}
    </box>
  )
}

function MarkdownBlockquote(props: { token: Tokens.Blockquote; styles: MarkdownStyles; textColor: NonNullable<TextChunk["fg"]> }): JSX.Element {
  const themeCtx = useTheme()
  const styled = createMemo(() => {
    const chunks = props.token.tokens.flatMap((t) => renderMarkdownToken(t, props.styles))
    // Italicize; strip leading newlines + trailing whitespace.
    while (chunks.length > 0 && chunks[0]?.text === "\n") chunks.shift()
    while (chunks.length > 0 && /^\s*$/.test(chunks[chunks.length - 1]?.text ?? "")) chunks.pop()
    return new StyledText(chunks.map((c) => ({
      ...c,
      attributes: (c.attributes ?? 0) | ITALIC,
    })))
  })

  return (
    <box
      border={["left"]}
      borderColor={themeCtx.theme.markdownBlockQuote}
      customBorderChars={VerticalBarBorder}
      paddingLeft={1}
    >
      <text fg={props.textColor} ref={bindSelectableStyledTextContent(styled)} />
    </box>
  )
}
