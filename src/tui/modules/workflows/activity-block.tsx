/** @jsxImportSource @opentui/solid */

import { agentGroupClockRuns, agentGroupGlyph, agentGroupInFlight } from "../../../protocol/client/agent-group-summary.js"
import { workflowCardControls } from "../../../protocol/client/session-controls.js"
import type { AgentGroupBlock as AgentGroupBlockModel } from "@infra/output-blocks"
import { StyledText, bg as stBg, bold as stBold, fg as stFg, type MouseEvent, type TextChunk, type TextRenderable } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useNavigateUri } from "@tui/context/navigation.js"
import { parseWorkflowLink } from "../../../protocol/client/session-links.js"
import { workflowCard, workflowCardChoice, workflowCardCut, workflowCardHeaderParts, workflowCardNotice, workflowCardSettled, workflowPlanAbsence, type WorkflowCardChoices, type WorkflowCardHeaderPart } from "../../../protocol/client/workflow-card.js"
import { workflowOutline } from "../../../protocol/client/workflow-outline.js"
import { useWorkflowCards } from "./cards.js"
import { createWorkflowServingLabels } from "./serving-labels.js"
import { useTheme } from "@tui/context/theme"
import { createMeasuredWidth } from "@tui/hooks/create-measured-width.js"
import { useTickPool } from "@tui/context/tick-pool-context.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { hitsDrawnContent, hitsLabel } from "@tui/utils/content-hit.js"
import { hasSelectedCells } from "@tui/utils/selection.js"
import { stLink, stStrike } from "@tui/utils/text-attributes.js"
import { useUnifiedToggle } from "@tui/hooks/use-body-toggle.js"
import { useRowWidth } from "@tui/context/row-width.js"
import { useLandingBackground } from "@tui/context/landing-highlight.js"
import { createEffect, createMemo, on, onCleanup, Show } from "solid-js"
import { BlockFrame, BLOCK_GUTTER_WIDTH } from "@tui/output-blocks/block-frame.js"
import { childProcessControl, processControlChunks, type RowProcessControls } from "@tui/output-blocks/stop-affordance.js"
import { chunkDisplayWidth, truncateChunks } from "@tui/output-blocks/tool-row-wrap.js"
import { isNarrowWorkflowCard, WorkflowCardBox, type WorkflowCardAction } from "@tui/output-blocks/workflow-card.js"
import { workflowSurfaceReads } from "../../../protocol/client/workflow-surface.js"

/** One control of a card's header: its label, which a click hits, the
 *  chunks that draw it, and what it does. */
interface HeaderControl {
  readonly label: string
  readonly chunks: readonly TextChunk[]
  readonly dispatch: () => void
}

interface AgentGroupBlockProps {
  block: AgentGroupBlockModel
  processControls?: RowProcessControls
}

export function WorkflowActivityBlock(props: AgentGroupBlockProps) {
  const { theme } = useTheme()
  const navigateUri = useNavigateUri()
  const renderer = useRenderer()
  // Historical derived folds settle unresulted agent runs before they reach the
  // durable view, so an in-flight status here always means a live runner.
  const isActive = () => agentGroupInFlight(props.block)
  const isInterrupted = () => props.block.status === "interrupted"
  // The row ticks only while the child's clock runs; otherwise it states the
  // settled active time the block carries.
  // A running workflow card also ticks its entries' and agents' times.
  const clock = useTickPool().createSharedTick(1000, () => agentGroupClockRuns(props.block) || isActive())
  const headerRowWidth = useRowWidth()
  const headerMeasured = createMeasuredWidth(() => headerRowWidth.width() - BLOCK_GUTTER_WIDTH)
  const landingBackground = useLandingBackground(() => [props.block.id, props.block.toolUseId])

  // A workflow card draws its first frame from its block. While its run goes
  // on, or once a person made a choice on it, it folds the workflow's view
  // and live state itself, as the block's summary reader does.
  const cards = useWorkflowCards()
  const workflowId = () => parseWorkflowLink(props.block.linkUri)?.workflowId
  const choices = (): WorkflowCardChoices | undefined => cards?.choices(props.block.id)
  const reads = () => workflowSurfaceReads({ kind: "card", status: props.block.status, hasChoices: choices() !== undefined })
  const folds = () => reads().view
  // Each hold is keyed on the workflow it reads, not on the block: a release
  // empties the cache until a fresh read lands, so a hold renewed on every
  // block update would blank the card's live activity and controls.
  const followedWorkflow = createMemo(() => folds() ? workflowId() : undefined)
  createEffect(on(followedWorkflow, (id) => {
    if (id === undefined || cards === undefined) return
    const hold = cards.follow(id)
    onCleanup(() => hold.release())
  }))
  // The held detail admits the header's Interrupt or Resume and names a
  // changed definition, so a card holds it while its run can still act.
  const heldWorkflow = createMemo(() => reads().detail ? workflowId() : undefined)
  createEffect(on(heldWorkflow, (id) => {
    if (id === undefined || cards === undefined) return
    const held = cards.hold(id)
    onCleanup(() => held.release())
  }))
  const workflowRow = () => { const id = workflowId(); return id === undefined ? undefined : cards?.row(id) }
  const workflowLive = () => { const id = workflowId(); return id === undefined || cards === undefined ? [] : cards.live(id) }
  const outline = createMemo(() => {
    const id = workflowId()
    const view = id === undefined ? undefined : cards?.view(id)
    return view?.attemptsStatus === "loaded" ? workflowOutline(view, workflowCardCut(props.block.status), workflowLive(), workflowRow() ?? undefined) : undefined
  })
  const workflowCardModel = createMemo(() => {
    if (workflowId() === undefined) return undefined
    const folded = outline()
    if (folded === undefined || !folds()) return props.block.card
    const chosen = choices()
    return workflowCard(folded, { settled: workflowCardSettled(props.block.status), ...(chosen === undefined ? {} : { choices: chosen }) })
  })
  // Each agent line names the model that serves its agent, as the
  // full-size card does.
  const modelLabel = cards === undefined ? undefined : createWorkflowServingLabels(() => outline(), cards)
  const workflowNotice = () => workflowCardNotice(workflowRow(), props.block, workflowCardModel())
  const onCardAction = (action: WorkflowCardAction): void => {
    // An agent opens over this chat, so its Back returns here.
    if (action.kind === "agent") {
      const id = workflowId()
      if (id !== undefined) cards?.openAgent(id, action)
      return
    }
    if (action.kind === "followUp") return
    cards?.choose(props.block.id, workflowCardChoice(choices(), action, workflowCardModel(), props.block.status))
  }
  const planAbsence = () => workflowId() !== undefined ? workflowPlanAbsence(workflowRow(), { ...props.block, card: workflowCardModel() }) : undefined
  const openUri = () => workflowId() === undefined ? undefined : props.block.linkUri
  const canOpen = () => openUri() !== undefined && navigateUri !== undefined

  const makeLabelChunks = (): TextChunk[] => {
    let text = stBold(stFg(groupAction.hovered() ? theme.textBright : theme.text)(props.block.label))
    if (isInterrupted()) text = stStrike(text)
    const uri = openUri()
    const label = uri ? stLink(uri)(text) : text
    const glyph = agentGroupGlyph(props.block.containerKind)
    return glyph === undefined ? [label] : [stFg(theme.accent)(`${glyph} `), label]
  }

  // Stop remains a separate target, and text selection wins over clicks.
  const groupAction = useUnifiedToggle(canOpen, () => {
    const uri = openUri()
    if (uri && navigateUri) navigateUri(uri)
  }, () => workflowCardModel() !== undefined, (event) => controlAt(event) !== undefined || hitsDrawnContent(event))
  const accentChunk = (text: string): TextChunk =>
    groupAction.hovered() ? stBold(stFg(theme.primaryBright)(text)) : stFg(theme.primary)(text)

  const activeHeader = (): TextChunk[] => {
    const chunks: TextChunk[] = []
    if (props.block.status === "queued") {
      chunks.push(stFg(theme.text)(" "))
      chunks.push(stFg(theme.warning)("· queued"))
    }
    return chunks
  }

  const workflowParts = (): readonly WorkflowCardHeaderPart[] => {
    clock()
    return workflowCardHeaderParts(props.block, Date.now())
  }
  const partChunk = (part: WorkflowCardHeaderPart): TextChunk =>
    stFg(part.tone === "warning" ? theme.warning : part.tone === "failed" ? theme.error : theme.textSubtle)(` · ${part.text}`)

  // Exactly one header renders at a time (active or terminal), so a
  // single memo switching on status serves both render sites.
  const headerChunks = createMemo<TextChunk[]>(() => {
    const tail = isActive() ? activeHeader() : []
    return [...makeLabelChunks(), ...tail]
  })
  // Declared before the memo below, which runs at once: a chat that opens
  // with its workflow's detail already held admits a control on that run.
  const workflowControl = (kind: "interrupt" | "resume" | "restart", dispatch: () => void): HeaderControl => {
    const label = `\u00a0${kind}\u00a0`
    return { label, chunks: [stFg(theme.text)("  "), stBg(theme.primary)(stFg(theme.background)(label))], dispatch }
  }
  // A workflow card's header holds the workflow's Interrupt or Resume, as
  // its held detail admits them, before the Stop of its parent's call.
  const headerControls = createMemo((): readonly HeaderControl[] => {
    const row = reads().detail ? workflowRow() : undefined
    const admitted = workflowCardControls(row, isActive(), props.block.status === "paused")
    const stop = childProcessControl(props.processControls, props.block.toolUseId, workflowId() !== undefined, admitted.stop)
    const primary = admitted.primary === undefined || row === undefined || cards === undefined ? undefined : workflowControl(admitted.primary, () => cards[admitted.primary ?? "resume"](row))
    return [
      ...(primary === undefined ? [] : [primary]),
      ...(stop === undefined ? [] : [{ label: stop.label, chunks: processControlChunks(theme, stop.label), dispatch: stop.dispatch }]),
    ]
  })
  // Below the narrow width a workflow card's controls take a line of their
  // own, so the header's state and time never drop.
  const narrowWorkflow = () => isNarrowWorkflowCard(headerMeasured.width())
  const headerSuffix = createMemo(() => [
    ...(canOpen() ? [stFg(theme.text)("  "), accentChunk(isNarrowWorkflowCard(headerMeasured.width()) ? "↗" : "↗ Open")] : []),
    ...headerControls().flatMap(({ chunks }) => chunks),
  ])
  // Every suffix part opens with a spacer chunk; on a line of its own the
  // first is dropped, so the line starts at its first glyph and the blank
  // before it is box, which opens nothing.
  const controlsContent = createMemo(() => new StyledText(headerSuffix().slice(1)))
  const visibleHeaderChunks = createMemo(() => {
    const suffix = narrowWorkflow() ? [] : headerSuffix()
    const room = headerMeasured.width() - chunkDisplayWidth(suffix)
    const ellipsis = stFg(theme.textMuted)("…")
    const chunks = headerChunks()
    const partChunks = workflowParts().map(partChunk)
    const labelRoom = room - chunkDisplayWidth(partChunks)
    if (labelRoom > 0) return [...truncateChunks(chunks, labelRoom, ellipsis), ...partChunks, ...suffix]
    return [...truncateChunks([...chunks, ...partChunks], room, ellipsis), ...suffix]
  })
  const headerContent = createMemo(() => new StyledText(visibleHeaderChunks()))

  let headerText: TextRenderable | undefined
  let controlsText: TextRenderable | undefined
  /** The control under the pointer, on the header or on the controls line. */
  function controlAt(event: MouseEvent): HeaderControl | undefined {
    const header = headerContent().chunks.map((chunk) => chunk.text).join("")
    const controls = controlsContent().chunks.map((chunk) => chunk.text).join("")
    return headerControls().find((control) => hitsLabel(event, headerText, header, control.label) || hitsLabel(event, controlsText, controls, control.label))
  }

  function handleMouseUp(event: MouseEvent): void {
    const control = controlAt(event)
    if (control === undefined) groupAction.handlers.onMouseUp(event)
    else if (!hasSelectedCells(renderer.getSelection())) {
      event.stopPropagation()
      control.dispatch()
    }
  }

  return (
    <BlockFrame active={isActive}>
      <box
        flexDirection="column"
        backgroundColor={landingBackground()}
        {...groupAction.handlers}
        onMouseUp={handleMouseUp}
      >
        <box ref={headerMeasured.ref} selectable={false} width="100%">
          <text
            ref={(el) => { headerText = el; bindStyledTextContent(headerContent)(el) }}
            overflow="hidden"
            wrapMode="none"
          />
        </box>
        <Show when={narrowWorkflow() && headerSuffix().length > 0}>
          {/* Right-aligned by layout, so the blank to the left is box, not text. */}
          <box selectable={false} width="100%" flexDirection="row" justifyContent="flex-end">
            <text ref={(el) => { controlsText = el; bindStyledTextContent(controlsContent)(el) }} overflow="hidden" wrapMode="none" />
          </box>
        </Show>
        <Show when={workflowCardModel()}>
          {(card) => (
            <box flexShrink={0}>
              <WorkflowCardBox card={card()} status={props.block.status} live={workflowLive()} choices={choices()} notice={workflowNotice()} width={headerMeasured.width()} now={() => { clock(); return Date.now() }} hovered={groupAction.hovered()} theme={theme}
                modelLabel={modelLabel} onAction={onCardAction} />
            </box>
          )}
        </Show>
        <Show when={planAbsence()}>
          {(absence) => (
            <box flexShrink={0} flexDirection="row" paddingLeft={2}>
              <Show when={absence().notice}><text fg={theme.warning} flexShrink={0}>{"! "}</text></Show>
              <text fg={absence().notice ? theme.warning : theme.textMuted} wrapMode="word" flexGrow={1} flexShrink={1} minWidth={0}>{absence().text}</text>
            </box>
          )}
        </Show>

        <Show when={props.block.status === "error" && workflowCardModel() === undefined ? props.block.failure : undefined}>
          {(failure) => (
            <box flexDirection="row">
              <box selectable={false} flexShrink={0}>
                <text fg={theme.textSubtle}>{"  ⎿  "}</text>
              </box>
              <box flexDirection="column" flexShrink={1} flexGrow={1}>
                <text fg={theme.error}>{failure().message}</text>
                <Show when={failure().detail}>
                  {(detail) => <text fg={theme.textMuted}>{detail()}</text>}
                </Show>
              </box>
            </box>
          )}
        </Show>
      </box>
    </BlockFrame>
  )
}
