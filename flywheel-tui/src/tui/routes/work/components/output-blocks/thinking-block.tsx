/** @jsxImportSource @opentui/solid */
/**
 * ThinkingBlock Component
 *
 * Renders reasoning/thinking output:
 * Left border + italic "Thinking:" label in primary color + markdown-rendered content.
 */

import { useTheme } from "@tui/shared/context/theme"
import { EmptyBorder } from "@tui/shared/ui/border"
import type { ThinkingBlock as ThinkingBlockType } from "@tui/types"

export interface ThinkingBlockProps {
  block: ThinkingBlockType
}

export function ThinkingBlock(props: ThinkingBlockProps) {
  const { theme, subtleSyntax } = useTheme()

  const content = () => "_Thinking:_ " + props.block.content.trim()

  return (
    <box
      marginTop={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.backgroundElement}
      customBorderChars={{
        ...EmptyBorder,
        vertical: "┃",
      }}
    >
      <code
        filetype="markdown"
        drawUnstyledText={false}
        streaming={true}
        syntaxStyle={subtleSyntax}
        content={content()}
        conceal={true}
        fg={theme.textMuted}
      />
    </box>
  )
}
