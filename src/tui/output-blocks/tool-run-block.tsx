/** @jsxImportSource @opentui/solid */

import type { ToolStreamingText } from "@infra/output-blocks"
import { formatDuration } from "../../protocol/client/format.js"
import { presentsAsFileChange } from "../../protocol/client/file-change-body.js"
import { toolActivity } from "../../protocol/client/transcript-model.js"
import { StyledText, bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { useRowWidth } from "@tui/context/row-width.js"
import { createMemo, Index, Show } from "solid-js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "./block-frame.js"
import { executedRunLabel, execRunLabel, exploreRunLabel } from "./group-summary.js"
import { mergeExploreReadRuns } from "./tool-entry-helpers.js"
import { getToolDisplay } from "@infra/tools/tool-display-registry.js"
import { ToolRow } from "./tool-row.js"
import { ToolEntry } from "./tool-entry.js"
import type { RowProcessControls } from "./stop-affordance.js"
import type { ToolRun } from "./visible-output-blocks.js"

// A tool run is a display-only fold of consecutive standalone explore
// (read/list/search) or exec (shell) tool calls, synthesized per frame by
// visible-output-blocks. Unlike an agent group it has no lifecycle of its own:
// status derives from its children (active/paused/completed, never
// pending/error), it carries no link, and it never collapses. The header is a
// plain heading; each row owns its own expand/contract affordance.
interface StreamingToolTextById { readonly [toolUseId: string]: ToolStreamingText }

/** A Bash row under Ran reads as its command alone. Every other tool in the
 *  run, shell-like or not, keeps its name so the reader knows what ran. */
function isBareCommand(tool: ToolRun["children"][number]): boolean {
  return getToolDisplay(tool.name) === getToolDisplay("bash") && tool.invocationBody === undefined
}
interface ToolRunBlockProps {
  block: ToolRun
  streamingToolText?: StreamingToolTextById
  /** Forwarded to exec rows for lazy historical output hydration. */
  onHydrateBody?: (blockId: string) => void
  processControls?: RowProcessControls
}

export function ToolRunBlock(props: ToolRunBlockProps) {
  const { theme } = useTheme()
  const visibleTools = createMemo(() => mergeExploreReadRuns(props.block.children))
  const isPaused = () => props.block.status === "paused"
  const isExecRun = () => props.block.category === "exec"
  const isExecuteRun = () => props.block.category === "execute"
  const isActive = () => props.block.status === "active" || props.block.children.some((entry) => toolActivity(entry, {
    held: props.processControls?.activeHeldToolCallIds().has(entry.id) ?? false,
    managed: props.processControls?.activeManagedProcessToolCallIds().has(entry.id) ?? false,
  }).active)

  // Bold Explored/Ran heading, no chevron. The gutter dot is the only run
  // marker; elapsed time trails when finished as the completeness marker.
  const headerContent = createMemo(() => {
    const label = isExecuteRun() ? executedRunLabel(props.block.status) : isExecRun() ? execRunLabel(props.block.status) : exploreRunLabel(props.block.status)
    const chunks: TextChunk[] = [stBold(stFg(theme.text)(label))]
    if (!isActive() && props.block.duration != null) {
      chunks.push(stFg(theme.textSubtle)(` · ${formatDuration(props.block.duration)}`))
    }
    return new StyledText(chunks)
  })

  // Seeded from the shared row width minus the BlockFrame gutter, so rows
  // wrap into their final shape on the mount frame; the element measurement
  // remains the drift-healing authority.
  const rowWidth = useRowWidth()
  const measured = createMeasuredWidth(() => rowWidth.width() - BLOCK_GUTTER_WIDTH)

  return (
    <BlockFrame active={isActive}>
      <box flexDirection="column" ref={measured.ref}>
        <box>
          <text
            ref={bindStyledTextContent(headerContent)}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Index each={visibleTools()}>
          {(child, i) => {
            const isLast = () => i === visibleTools().length - 1
            return (
              <>
                {/* Exec entries are often multi-line (command + output), so
                  * stacked rows get a rail-only spacer line for breathing room.
                  * Explore rows stay compact one-liners and need none. */}
                <Show when={(isExecRun() || isExecuteRun()) && i > 0}>
                  <text fg={theme.textMuted} overflow="hidden" wrapMode="none">│</text>
                </Show>
                {presentsAsFileChange(child())
                  ? (
                      <ToolEntry
                        block={child()}
                        streamingToolText={props.streamingToolText}
                        interrupted={isPaused()}
                        onHydrateBody={props.onHydrateBody}
                        rowControls={props.processControls}
                        embedded
                      />
                    )
                  : (
                      <ToolRow
                        tool={child()}
                        streamingToolText={props.streamingToolText}
                        onHydrateBody={props.onHydrateBody}
                        rowControls={props.processControls}
                        availWidth={measured.width()}
                        interrupted={isPaused()}
                        hideStatusIcon
                        hideVerb={isExecRun() ? isBareCommand(child()) : child().name === "code"}
                        padLeft={0}
                        connector={isLast() ? "└ " : "├ "}
                        continuationConnector={isLast() ? undefined : "│"}
                      />
                    )}
              </>
            )
          }}
        </Index>
      </box>
    </BlockFrame>
  )
}
