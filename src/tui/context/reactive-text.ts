import { StyledText, type TextChunk, type TextRenderable } from "@opentui/core"
import { createEffect, createMemo } from "solid-js"
import { useFindPaint } from "./find-highlight.js"
import { preventSelectionStart } from "@tui/utils/selection.js"
import { textChunksEqual } from "@tui/utils/text.js"

// OpenTUI's <text> content setter diffs by StyledText OBJECT IDENTITY
// (index-...:19975: `if (this._text !== styledText)`), so assigning a fresh-but-equal
// StyledText is a cache MISS - it re-writes the native buffer and unconditionally
// markDirty's the Yoga node, forcing a re-wrap + re-measure. The text layout
// cache instead keys on the text VALUE (`if (this._text !== text)`), so an equal rebuild
// is a no-op (pay-once). A Solid createMemo returns a stable ref only until it
// recomputes, and a freshly-built StyledText always fails `===`, so every memo
// recompute (theme tick, an unrelated tracked signal, a streaming re-emit of an
// equal final value) would otherwise re-wrap byte-identical text. We mirror that:
// only assign content when the StyledText differs BY VALUE. (<code> already
// value-guards by string, so it needs none of this.) Inside a transcript the
// find bar's matches are painted over the content first, so a find that
// moves the current match repaints only the texts that held or hold it.
function bindContent(el: TextRenderable, content: () => StyledText, find: ReturnType<typeof useFindPaint>): void {
  let last: StyledText | undefined
  find?.bind(el)
  const strong = createMemo(() => find?.strongIndex(el) ?? -1)
  createEffect(() => {
    const styled = content()
    const next = find ? withChunks(styled, find.paint(el, styled.chunks, strong)) : styled
    if (last !== undefined && textChunksEqual(last.chunks, next.chunks)) return
    last = next
    el.content = next
  })
}

function withChunks(styled: StyledText, chunks: readonly TextChunk[]): StyledText {
  return chunks === styled.chunks ? styled : new StyledText([...chunks])
}

/** Ref for a `<text>` rendering reactive StyledText that is an affordance, not
 *  copyable body (headers, truncation notes): blocks selection start AND keeps
 *  `content` in sync only when it changes by value (so an equal memo recompute
 *  never forces a Yoga re-wrap). */
export function bindStyledTextContent(content: () => StyledText): (el: TextRenderable) => void {
  const find = useFindPaint()
  return (el) => {
    preventSelectionStart(el)
    bindContent(el, content, find)
  }
}

/** Same value-guarded content binding for selectable body text (markdown lines):
 *  selection is allowed; the wrap-cache guard is identical. */
export function bindSelectableStyledTextContent(content: () => StyledText): (el: TextRenderable) => void {
  const find = useFindPaint()
  return (el) => bindContent(el, content, find)
}
