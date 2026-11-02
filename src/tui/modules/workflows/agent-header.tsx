/** @jsxImportSource @opentui/solid */
import { StyledText, bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import { createMemo, Show, type Accessor } from "solid-js"
import { workflowAgentHeaderDrops, workflowAgentLine, type WorkflowAgentHeaderDrop, type WorkflowAgentLine, type WorkflowAgentModel } from "../../../protocol/client/workflow-agent.js"
import { useTheme } from "@tui/context/theme.js"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { agentStateColor } from "@tui/output-blocks/workflow-palette.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { chunksWidth, fitChunks } from "@tui/utils/text.js"
import { Button } from "@tui/components/button.js"

function agentLineText(line: WorkflowAgentLine, state: WorkflowAgentModel["state"] | undefined, width: number, theme: ReturnType<typeof useTheme>["theme"]): StyledText {
  const muted = stFg(theme.textMuted)
  const left = (dropped: ReadonlySet<WorkflowAgentHeaderDrop<"agent">>): TextChunk[] => [
    ...(line.phase === undefined ? [] : [stFg(theme.phaseName)(line.phase)]),
    ...(line.phase === undefined || line.name === undefined ? [] : [muted(" › ")]),
    ...(line.name === undefined ? [] : [stBold(stFg(theme.agentName)(line.name))]),
    ...line.how.filter(({ kind }) => !dropped.has(kind)).map(({ text }) => muted(` · ${text}`)),
  ]
  const right = (dropped: ReadonlySet<WorkflowAgentHeaderDrop<"agent">>): TextChunk[] => line.facts.filter(({ kind }) => kind === "state" || !dropped.has(kind)).flatMap(({ kind, text }, index) => [
    ...(index === 0 ? [] : [muted(" · ")]),
    kind === "state" && state !== undefined ? stFg(agentStateColor(state, theme))(text) : muted(text),
  ])
  const dropped = workflowAgentHeaderDrops("agent", (parts) => chunksWidth(left(parts)) + 3 + chunksWidth(right(parts)) <= width)
  const facts = right(dropped)
  const factsWidth = chunksWidth(facts)
  const shown = fitChunks(left(dropped), Math.max(0, width - factsWidth - (factsWidth === 0 ? 0 : 3)))
  return new StyledText([...shown, stFg(theme.text)(" ".repeat(Math.max(0, width - chunksWidth(shown) - factsWidth))), ...facts])
}

/** Workflow-only chrome; output and status belong to ChildSessionBody. */
export function WorkflowAgentHeader(props: {
  readonly model: Accessor<WorkflowAgentModel | undefined>
  readonly seat: Accessor<string | undefined>
  readonly now: Accessor<number>
  readonly control: Accessor<{ readonly label: string; readonly onPress: () => void } | undefined>
}) {
  const { theme } = useTheme()
  const width = createMeasuredWidth()
  const line = createMemo(() => agentLineText(workflowAgentLine(props.model(), props.seat(), props.now()), props.model()?.state, width.width(), theme))
  return <box flexDirection="row" flexShrink={0}>
    <box ref={width.ref} flexGrow={1} flexShrink={1} flexBasis={0} minWidth={0} height={1}>
      <text ref={bindStyledTextContent(line)} overflow="hidden" wrapMode="none" />
    </box>
    <Show when={props.control()}>{(shown) => <box flexShrink={0} paddingLeft={2}><Button label={shown().label} onPress={shown().onPress} /></box>}</Show>
  </box>
}
