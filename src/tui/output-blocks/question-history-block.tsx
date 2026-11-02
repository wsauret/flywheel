/** @jsxImportSource @opentui/solid */

import type { QuestionBlock } from "@infra/output-blocks"
import { StyledText, bold as stBold, fg as stFg } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { useRowWidth } from "@tui/context/row-width.js"
import { useLandingBackground } from "@tui/context/landing-highlight.js"
import { createMemo, Index } from "solid-js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "./block-frame.js"
import { adaptQuestionHistoryRows } from "./question-history-format.js"
import { ToolRow } from "./tool-row.js"

interface QuestionHistoryBlockProps {
  block: QuestionBlock
}

// The dock owns the live state; once it resolves the block renders like a
// tool run: a bold "Ask User" heading with each question as its own railed
// row (question title in the tool-name color, answer as the detail).
export function QuestionHistoryBlock(props: QuestionHistoryBlockProps) {
  const { theme } = useTheme()
  const rows = createMemo(() => adaptQuestionHistoryRows(props.block))
  const headerContent = createMemo(() => new StyledText([stBold(stFg(theme.text)("Ask User"))]))

  // Seeded from the shared row width minus the BlockFrame gutter, so rows
  // wrap into their final shape on the mount frame (same as ToolRunBlock).
  const rowWidth = useRowWidth()
  const measured = createMeasuredWidth(() => rowWidth.width() - BLOCK_GUTTER_WIDTH)
  const landingBackground = useLandingBackground(() => [props.block.toolUseId])

  return (
    <BlockFrame>
      <box flexDirection="column" ref={measured.ref} backgroundColor={landingBackground()}>
        <box>
          <text
            ref={bindStyledTextContent(headerContent)}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Index each={rows()}>
          {(row, i) => {
            const isLast = () => i === rows().length - 1
            return (
              <ToolRow
                tool={row()}
                availWidth={measured.width()}
                hideStatusIcon
                padLeft={0}
                connector={isLast() ? "└ " : "├ "}
                continuationConnector={isLast() ? undefined : "│"}
              />
            )
          }}
        </Index>
      </box>
    </BlockFrame>
  )
}