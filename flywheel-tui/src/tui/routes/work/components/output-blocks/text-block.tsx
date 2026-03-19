/** @jsxImportSource @opentui/solid */
/**
 * TextBlock Component
 *
 * Renders a text output block using the native OpenTUI <markdown> element
 * with syntax highlighting from the theme context.
 */

import { useTheme } from "@tui/shared/context/theme"
import type { TextBlock as TextBlockType } from "../../state/types"

export interface TextBlockProps {
  block: TextBlockType
}

export function TextBlock(props: TextBlockProps) {
  const themeCtx = useTheme()
  return (
    <markdown
      syntaxStyle={themeCtx.syntax}
      content={props.block.content}
      streaming={true}
      conceal={true}
    />
  )
}
