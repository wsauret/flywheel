import { createMemo, createRenderEffect } from "solid-js"

import { copyFrom } from "./copy.js"
import { createMarkdownStream } from "./markdown.js"
import { patchMarkdownChildren } from "./markdown-dom.js"

/** Rendered markdown that may still be arriving.
 *
 *  The element's children are the document's top-level blocks, exactly as one
 *  `innerHTML` render would produce them, so the stylesheet's child selectors
 *  hold. Only the nodes after the settled prefix are patched when the source
 *  grows, so a token appended to a long reply costs its last block, not the
 *  whole document. Existing paragraphs, code blocks, and text update in place. */
export function Markdown(props: { class: string; source: string }) {
  const stream = createMarkdownStream()
  const source = createMemo(() => props.source)
  // The live tail can become settled without changing its DOM identity.
  let settledNodes = 0
  // One listener for every code block's copy button, present or future: the
  // buttons arrive as inserted HTML and would lose a handler set on them.
  const onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element)) return
    const button = event.target.closest<HTMLElement>(".code-copy")
    const code = button?.closest("pre")?.querySelector("code")
    if (button && code) void copyFrom(button, code.textContent ?? "")
  }
  return (
    <div
      class={props.class}
      onClick={onClick}
      ref={(element) => {
        const settled = element.ownerDocument.createElement("template")
        const tail = element.ownerDocument.createElement("template")
        createRenderEffect(() => {
          const step = stream.advance(source())
          if (step.reset) settledNodes = 0
          settled.innerHTML = step.settledHtml
          tail.innerHTML = step.tailHtml
          const settledCount = settled.content.childNodes.length
          patchMarkdownChildren(element, [...settled.content.childNodes, ...tail.content.childNodes], settledNodes)
          settledNodes += settledCount
        })
      }}
    />
  )
}
