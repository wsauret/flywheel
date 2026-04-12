/** @jsxImportSource @opentui/solid */
/**
 * TextBlock Component
 *
 * Renders a text output block using the native OpenTUI <markdown> element
 * with syntax highlighting from the theme context.
 *
 * File paths in the rendered text are automatically linkified as OSC 8
 * hyperlinks, making them Cmd+clickable in supported terminals.
 */

import { detectLinks, type MarkdownRenderable } from "@opentui/core"
import { useTheme } from "@tui/shared/context/theme"
import { linkifyFilePaths } from "@tui/adapters/linkify-paths"
import type { TextBlock as TextBlockType } from "@infra/output-blocks"

/**
 * Wrap the default linkify pipeline to also detect file paths.
 * Runs detectLinks first (for URLs), then linkifyFilePaths (for local paths).
 */
function linkifyChunks(chunks: Parameters<typeof detectLinks>[0], context: Parameters<typeof detectLinks>[1]) {
  const linked = detectLinks(chunks, context)
  return linkifyFilePaths(linked)
}

export interface TextBlockProps {
  block: TextBlockType
}

export function TextBlock(props: TextBlockProps) {
  const themeCtx = useTheme()
  return (
    <box marginTop={1}>
      <markdown
        ref={(el: MarkdownRenderable) => {
          // _linkifyMarkdownChunks is a private property on MarkdownRenderable — `as any` required to override it
          (el as any)._linkifyMarkdownChunks = linkifyChunks
        }}
        syntaxStyle={themeCtx.syntax}
        content={props.block.content}
        streaming={true}
        conceal={true}
      />
    </box>
  )
}
