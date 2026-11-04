/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { StyledText, bg as stBg, fg as stFg, bold as stBold, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import type { AgentGroupBlock as AgentGroupBlockModel } from "../../infra/output-blocks.js"
import type { RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import { agentGroupClockRuns, agentGroupInFlight, agentGroupInitializing, agentGroupModelLabel } from "../../protocol/client/agent-group-summary.js"
import { dispatchInterrupt, resumeMutation, subagentCardControls, type ChildCardStatus } from "../../protocol/client/session-controls.js"
import { subagentHeaderParts, subagentLine } from "../../protocol/client/subagent-line.js"
import { errorMessage } from "../../infra/error-message.js"
import { parseSessionLink } from "../../protocol/client/session-links.js"
import { useClientExtensions } from "../context/client-extensions.js"
import { useNavigateUri } from "../context/navigation.js"
import { useLandingBackground } from "../context/landing-highlight.js"
import { useSubagentControls } from "../context/subagent-controls.js"
import { useTheme } from "../context/theme.js"
import { useTickPool } from "../context/tick-pool-context.js"
import { useRowWidth } from "../context/row-width.js"
import { useUnifiedToggle } from "../hooks/use-body-toggle.js"
import { createMeasuredWidth } from "../hooks/create-measured-width.js"
import { hitsDrawnContent, hitsLabel } from "../utils/content-hit.js"
import { bindStyledTextContent } from "../utils/reactive-text.js"
import { hasSelectedCells } from "../utils/selection.js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "./block-frame.js"
import { childProcessControl, processControlChunks, rowProcessControl, type RowProcessControls } from "./stop-affordance.js"
import { chunkDisplayWidth, truncateChunks, wrapToolRowChunks } from "./tool-row-wrap.js"
import { subagentLineChunks } from "./agent-line.js"

export interface AgentGroupBlockProps {
  readonly block: AgentGroupBlockModel
  readonly roleView?: (sessionId: string) => RoleAssignmentView | undefined
  readonly childStatus?: (sessionId: string) => ChildCardStatus
  readonly processControls?: RowProcessControls
}

/** Modules render their own activity; ordinary child runs share the kernel's compact activity row. */
export function AgentGroupBlock(props: AgentGroupBlockProps) {
  const clients = useClientExtensions()
  const extension = () => clients.find((client) => client.activity?.matches(props.block))?.activity
  return <Show when={extension()} fallback={<ChildActivityBlock {...props} />}>{(renderer) => renderer().render(props)}</Show>
}

function ChildActivityBlock(props: AgentGroupBlockProps) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const navigate = useNavigateUri()
  const rowWidth = useRowWidth()
  const measured = createMeasuredWidth(() => rowWidth.width() - BLOCK_GUTTER_WIDTH)
  const active = () => agentGroupInFlight(props.block)
  const clock = useTickPool().createSharedTick(1000, () => agentGroupClockRuns(props.block))
  const sessionId = () => parseSessionLink(props.block.linkUri)?.sessionId
  const role = () => { const id = sessionId(); return id === undefined ? undefined : props.roleView?.(id) }
  const summaryBlock = () => ({ ...props.block, model: agentGroupModelLabel(props.block.model, role()) })
  const initializing = () => agentGroupInitializing(summaryBlock())
  const child = () => { const id = sessionId(); return id === undefined ? undefined : props.childStatus?.(id) }
  const controls = useSubagentControls()
  const heldChild = createMemo(() => initializing() || props.block.status === "completed" ? undefined : sessionId())
  createEffect(on(heldChild, (id) => {
    if (id === undefined || controls === undefined) return
    const hold = controls.details.retain(id)
    onCleanup(() => hold.release())
  }))
  const row = () => { const id = heldChild(); return id === undefined ? undefined : controls?.details.view(id)?.row }
  const canOpen = () => !initializing() && sessionId() !== undefined && navigate !== undefined
  const action = useUnifiedToggle(() => canOpen(), () => { if (props.block.linkUri) navigate?.(props.block.linkUri) }, () => active(), (event) => controlAt(event) !== undefined || hitsDrawnContent(event))
  const stop = () => initializing() || !active() ? undefined : childProcessControl(props.processControls, props.block.toolUseId, sessionId() !== undefined, active())
    ?? rowProcessControl(props.processControls, props.block.toolUseId)
  const headerControls = createMemo(() => {
    const items: { label: string; chunks: readonly TextChunk[]; dispatch: () => void }[] = []
    if (initializing()) return items
    const current = row()
    const primary = subagentCardControls(current, active()).primary
    if (primary !== null && current !== undefined && controls !== undefined) {
      const label = `\u00a0${primary}\u00a0`
      items.push({ label, chunks: [stFg(theme.text)("  "), stBg(theme.primary)(stFg(theme.background)(label))], dispatch: () => {
        if (primary === "interrupt") void dispatchInterrupt(controls.client, current).then((refusal) => { if (refusal) controls.report(refusal.reason, refusal.variant) })
        else void controls.client.dispatch(resumeMutation(current))
          .then((result) => { if (!result.ok) controls.report(result.error, "error") })
          .catch((cause: unknown) => controls.report(errorMessage(cause), "error"))
      } })
    }
    const ending = stop()
    if (ending) items.push({ ...ending, chunks: processControlChunks(theme, ending.label) })
    return items
  })
  const line = createMemo(() => { clock(); return subagentLine(summaryBlock(), child(), Date.now()) })
  const header = createMemo(() => {
    const open = action.hovered() ? stBold(stFg(theme.primaryBright)("  ↗ Open")) : stFg(theme.primary)("  ↗ Open")
    const suffix = [...(canOpen() ? [open] : []), ...headerControls().flatMap(({ chunks }) => chunks)]
    const room = measured.width() - chunkDisplayWidth(suffix)
    const parts = initializing()
      ? subagentHeaderParts({ ...props.block, model: "" }).filter(({ kind }) => kind === "persona" || kind === "goal")
      : subagentHeaderParts(summaryBlock(), summaryBlock().model, line().time)
    const chunksFor = (selected: ReturnType<typeof subagentHeaderParts>): TextChunk[] => selected.map((part, index) => part.kind === "persona"
      ? stBold(stFg(action.hovered() ? theme.textBright : theme.text)(part.text))
      : stFg(theme.textSubtle)(`${index === 0 ? "" : " · "}${part.text}`))
    let shown = parts
    if (chunkDisplayWidth(chunksFor(shown)) > room) shown = shown.filter((part) => part.kind !== "operations")
    const goal = shown.find(({ kind }) => kind === "goal")
    if (goal !== undefined && chunkDisplayWidth(chunksFor(shown)) > room) {
      const fixed = shown.filter((part) => part.kind !== "goal")
      const available = room - chunkDisplayWidth(chunksFor(fixed)) - 3
      const goalText = truncateChunks([stFg(theme.textSubtle)(goal.text)], Math.max(0, available), stFg(theme.textMuted)("…")).map(({ text }) => text).join("")
      shown = goalText === "" ? fixed : shown.map((part) => part.kind === "goal" ? { ...part, text: goalText } : part)
    }
    return new StyledText(wrapToolRowChunks([], [...chunksFor(shown), ...suffix], measured.width()))
  })
  const lineContent = createMemo(() => new StyledText(subagentLineChunks(line(), measured.width(), theme)))
  const landingBackground = useLandingBackground(() => [props.block.id, props.block.toolUseId])
  function controlAt(event: MouseEvent) {
    const content = header().chunks.map((chunk) => chunk.text).join("")
    return headerControls().find((control) => hitsLabel(event, headerText, content, control.label))
  }
  function press(event: MouseEvent): void {
    const control = controlAt(event)
    if (control === undefined) action.handlers.onMouseUp(event)
    else if (!hasSelectedCells(renderer.getSelection())) { event.stopPropagation(); control.dispatch() }
  }
  let headerText: TextRenderable | undefined
  return <BlockFrame active={active}><box flexDirection="column" backgroundColor={landingBackground()} {...action.handlers} onMouseUp={press}>
    <box ref={measured.ref} selectable={false} width="100%"><text ref={(el) => { headerText = el; bindStyledTextContent(header)(el) }} overflow="hidden" wrapMode="none" /></box>
    <Show when={!initializing()}><text ref={bindStyledTextContent(lineContent)} overflow="hidden" wrapMode="none" /></Show>
    <Show when={line().failureDetail}>{(detail) => <text paddingLeft={4} fg={theme.textMuted} overflow="hidden" wrapMode="none">{detail()}</text>}</Show>
  </box></BlockFrame>
}
