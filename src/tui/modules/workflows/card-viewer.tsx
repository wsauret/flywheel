/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid"
import { StyledText, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For, Show, untrack, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { createKeyedListSelection } from "../../hooks/create-keyed-list-selection.js"
import { useListSelectionReveal } from "../../hooks/use-list-selection-reveal.js"
import type { RuntimeClient } from "../../../protocol/app-service-types.js"
import { dispatchInterrupt, resumeMutation, workflowCardControls, workflowParked, workflowStateLabel, type ControlRefusal } from "../../../protocol/client/session-controls.js"
import { workflowCard, workflowCardChoice, workflowCardNotice, workflowRunName, workflowViewCardStatus, type WorkflowCardChoices } from "../../../protocol/client/workflow-card.js"
import { workflowOutline } from "../../../protocol/client/workflow-outline.js"
import { workflowAgentOpenTarget, type WorkflowAgentTarget } from "../../../protocol/client/workflow-agent.js"
import type { WorkflowInspection } from "./inspection.js"
import { createWorkflowServingLabels, type WorkflowRoleReadings } from "./serving-labels.js"
import { formatElapsed, formatCostSplit } from "../../../protocol/client/format.js"
import { activeTimeMs } from "../../../protocol/client/session-time.js"
import { useTheme } from "@tui/context/theme.js"
import { useTickPool } from "@tui/context/tick-pool-context.js"
import { useHoverHighlight } from "@tui/hooks/use-hover-highlight.js"
import { workflowFullCardRows, type WorkflowCardAction, type WorkflowCardRow, type WorkflowFullCardRows } from "@tui/output-blocks/workflow-card.js"
import { hitsDrawnContent } from "@tui/utils/content-hit.js"

const NO_ROWS: WorkflowFullCardRows = { rows: [], bar: undefined }
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { displayWidth, shareWidth, truncateToWidth } from "@tui/utils/text.js"
import { Button } from "@tui/components/button.js"
import { ModalFrame, MODAL_FRAME_CLOSE_WIDTH, MODAL_FRAME_HORIZONTAL_INSET, modalFrameBackWidth, sessionViewerBodyHeight, sessionViewerWidth } from "@tui/components/modal-frame.js"

type KeyEvent = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault?: () => void }

/** The keys of the full-size card. The viewer binds what each does once it
 *  mounts. */
export interface WorkflowCardViewerInput {
  onKey(event: KeyEvent): void
  bind(handlers: { readonly key: (name: string) => void }): void
}

export function createWorkflowCardViewerInput(): WorkflowCardViewerInput {
  let key: (name: string) => void = () => {}
  return {
    onKey(event) {
      event.preventDefault?.()
      key(event.name)
    },
    bind(handlers) { key = handlers.key },
  }
}

export interface WorkflowCardViewerProps extends WorkflowRoleReadings {
  readonly workflowId: string
  readonly inspectWorkflow: (workflowId: () => string) => WorkflowInspection
  readonly appService: Pick<RuntimeClient, "dispatch">
  /** The title of a session, for the back control that names the chat. */
  readonly title: (sessionId: string) => string | undefined
  readonly input: WorkflowCardViewerInput
  readonly active: Accessor<boolean>
  /** Back to the chat. */
  readonly onClose: () => void
  /** Opens an agent's view over this card. */
  readonly onOpenAgent: (target: WorkflowAgentTarget) => void
  /** Opens the follow-up conversation over this card. */
  readonly onOpenFollowUp: () => void
  readonly showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success" }) => void
}

/** The full-size card of a workflow: its whole plan, which replaces the
 *  workflow view. The title line names the way back to the chat, the
 *  workflow's name, its state, time, and cost, and the controls
 *  that its row admits. Every phase follows in run order, with every agent
 *  of an expanded phase in item order, and the plan bar and the keys stay
 *  pinned under the lines, which scroll. Up and Down select a line, Enter
 *  opens an agent or expands or folds a phase, Right expands, Left folds or
 *  moves from an agent to its phase, and Escape goes back to the chat. */
export function WorkflowCardViewer(props: WorkflowCardViewerProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const workflowId = untrack(() => props.workflowId)
  const surface = untrack(() => props.inspectWorkflow(() => workflowId))
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const contentWidth = () => width() - MODAL_FRAME_HORIZONTAL_INSET
  const height = createMemo(() => sessionViewerBodyHeight(dimensions().height))
  const row = surface.detail
  const live = surface.live
  const view = createMemo(() => { const loaded = surface.view(); return loaded?.attemptsStatus === "loaded" ? loaded : undefined })
  const parked = () => workflowParked(live(), row())
  const status = createMemo(() => workflowViewCardStatus(view()?.state, row(), parked()))
  const drift = () => row()?.definitionDrift
  const stateWord = () => workflowStateLabel(view()?.state, row()?.stoppedBy, drift(), parked())
  const outline = createMemo(() => { const loaded = view(); return loaded === undefined ? undefined : workflowOutline(loaded, stateWord(), live(), row() ?? undefined) })
  const modelLabel = createWorkflowServingLabels(() => outline(), props)
  const [choices, setChoices] = createSignal<WorkflowCardChoices>()
  const card = createMemo(() => {
    const folded = outline()
    if (folded === undefined) return undefined
    const chosen = choices()
    return workflowCard(folded, { settled: status() === "completed" || status() === "error" || status() === "stopped", size: "full", ...(chosen === undefined ? {} : { choices: chosen }) })
  })
  const tick = useTickPool().createSharedTick(1000, () => props.active() && status() === "active")
  const now = () => { tick(); return Date.now() }
  const [refusal, setRefusal] = createSignal<string>()
  const notice = () => refusal() ?? workflowCardNotice(row(), { status: status() }, card())
  // The card names the run by the title its launch gave it, as the inline
  // card does, and by the workflow's name when the launch gave none.
  const label = () => workflowRunName(view(), row()?.title)
  const rows = createMemo(() => {
    const folded = outline()
    const shown = card()
    if (folded === undefined || shown === undefined) return NO_ROWS
    return workflowFullCardRows({
      card: shown,
      status: status(),
      live: live(),
      ...(choices() === undefined ? {} : { choices: choices() }),
      width: contentWidth(),
      now: now(),
      theme,
      outline: folded,
      modelLabel,
      selected: () => selection.key(),
      followUp: view()?.followUp === true,
    })
  })
  const keys = createMemo(() => rows().rows.map(({ key }) => key))
  // Lines read selection as they draw, after row membership is available.
  const selection = createKeyedListSelection(() => keys(), () => {
    const running = outline()?.phases.find(({ state }) => state === "running" || state === "parked")
    return running === undefined ? keys()[0] : `phase:${running.key}`
  })
  const selectedKey = selection.key
  const setChosenKey = selection.choose
  const selectedRow = () => { const key = selectedKey(); return rows().rows.find((candidate) => candidate.key === key) }

  const report = (result: { ok: true } | { ok: false; error: string }): void => {
    setRefusal(result.ok ? undefined : result.error)
    if (!result.ok) props.showToast({ message: result.error, variant: "error" })
  }
  const reportRefusal = (failed: ControlRefusal | undefined): void => { if (failed) props.showToast({ message: `Interrupt failed: ${failed.reason}`, variant: failed.variant }) }
  const controls = createMemo(() => {
    const current = row()
    const admitted = workflowCardControls(current, false, parked())
    const stop = current?.admittedActions.includes("workflow.stop") ? { type: "workflow.stop", workflowId: props.workflowId } as const : undefined
    return [
      ...(current === undefined || admitted.primary === undefined ? [] : [{
        label: admitted.primary === "interrupt" ? "Interrupt" : admitted.primary === "resume" ? "Resume" : "Restart",
        press: () => {
          if (admitted.primary === "interrupt") void dispatchInterrupt(props.appService, current).then(reportRefusal)
          else if (admitted.primary === "resume") void props.appService.dispatch(resumeMutation(current)).then(report)
          else void props.appService.dispatch({ type: "workflow.restart", workflowId: current.workflowId }).then(report)
        },
      }]),
      ...(stop === undefined ? [] : [{ label: "Stop", press: () => { void props.appService.dispatch(stop).then(report) } }]),
    ]
  })

  const act = (action: WorkflowCardAction): void => {
    switch (action.kind) {
      case "agent": props.onOpenAgent(workflowAgentOpenTarget(action)); return
      case "followUp": props.onOpenFollowUp(); return
      case "phase":
      case "counted":
        setChoices(workflowCardChoice(choices(), action, card(), status()))
        selection.choose(selectedKey())
        return
    }
  }
  /** Whether a phase line shows its agents under it now. */
  const expanded = (phaseKey: string) => rows().rows.some((candidate) => candidate.phaseKey === phaseKey)
  const [scrollbox, setScrollbox] = createSignal<ScrollBoxRenderable>()
  const move = (offset: number): void => {
    const all = keys()
    const at = all.indexOf(selectedKey() ?? "")
    const next = all[Math.max(0, Math.min(all.length - 1, at + offset))]
    if (next !== undefined) setChosenKey(next)
  }
  const onKey = (name: string): void => {
    const selected = selectedRow()
    switch (name) {
      case "escape": props.onClose(); return
      case "up": move(-1); return
      case "down": move(1); return
      case "home": setChosenKey(keys()[0]); return
      case "end": setChosenKey(keys().at(-1)); return
      case "pageup": move(-Math.max(1, height() - 6)); return
      case "pagedown": move(Math.max(1, height() - 6)); return
      case "return":
      case "enter": if (selected?.action !== undefined) act(selected.action); return
      case "right":
        if (selected?.action?.kind === "phase" && !expanded(selected.action.key)) act(selected.action)
        return
      case "left":
        if (selected?.phaseKey !== undefined) setChosenKey(`phase:${selected.phaseKey}`)
        else if (selected?.action?.kind === "phase" && expanded(selected.action.key)) act(selected.action)
        else props.onClose()
        return
    }
  }
  untrack(() => props.input.bind({ key: onKey }))
  useListSelectionReveal({
    viewport: scrollbox,
    revision: selection.revision,
    layout: () => [rows(), width(), height()],
    fixedKeys: keys,
    elements: () => [],
    reveal: (scroll) => {
      const key = selectedKey()
      if (key === undefined) return false
      scroll.scrollChildIntoView(`${props.workflowId}:${key}`)
      return true
    },
  })

  const chatTitle = () => { const parent = row()?.launchedFrom.parentSessionId; return parent === undefined ? "Chat" : props.title(parent) ?? "Chat" }
  // The header's words and the way back in the columns that the controls
  // and the close affordance leave. A narrow header drops the cost.
  // Only a header that is still full cuts the way back and
  // the name, the longer one first, so the state, the time, and every
  // control stay.
  const header = createMemo(() => {
    const detail = row()
    const totals = detail?.totals
    const durationMs = detail ? activeTimeMs(detail.durationMs, detail.streamingStartedAt, now()) : 0
    const stats = {
      time: detail && !detail.totalsLoading && durationMs >= 1000 ? formatElapsed(durationMs) : "",
      cost: detail?.totalsLoading ? "totals loading" : totals ? formatCostSplit(totals.totalCost, totals.totalBilledCost) : "",
    }
    const state = [stateWord() === undefined ? "" : capitalized(stateWord() ?? ""), stats.time].filter(Boolean)
    const shown = controls()
    const room = contentWidth() - (1 + shown.reduce((sum, control) => sum + displayWidth(control.label) + 2, 0) + Math.max(0, shown.length - 1)) - MODAL_FRAME_CLOSE_WIDTH
    const words = (name: string, ...stat: readonly string[]) => [`⚙ ${name}`, ...state, ...stat].filter(Boolean).join(" · ")
    const back = chatTitle()
    const fitted = [words(label(), stats.cost), words(label())].find((text) => modalFrameBackWidth(back) + displayWidth(text) <= room)
    if (fitted !== undefined) return { back, title: fitted }
    const [backWidth = 0, nameWidth = 0] = shareWidth([displayWidth(back), displayWidth(label())], room - modalFrameBackWidth("") - displayWidth(words("")))
    return { back: truncateToWidth(back, backWidth, "…"), title: words(truncateToWidth(label(), nameWidth, "…")) }
  })
  return <ModalFrame title={header().title} width={width()} onClose={props.onClose} back={{ label: header().back, onPress: props.onClose }}
    titleAccessory={<box flexDirection="row" gap={1} flexShrink={0}><For each={controls()}>{(control) => <Button label={control.label} onPress={control.press} />}</For></box>}>
    <box flexDirection="column" width={contentWidth()} height={height()} gap={0}>
      {/* A notice's later lines start under its first word. */}
      <Show when={notice()}>{(text) => <box flexDirection="row" paddingLeft={2} flexShrink={0}>
        <text fg={theme.warning} flexShrink={0}>{"! "}</text>
        <text fg={theme.warning} wrapMode="word" flexGrow={1} flexShrink={1} minWidth={0}>{text()}</text>
      </box>}</Show>
      <box height={1} flexShrink={0} />
      <Show when={view() !== undefined || surface.view() === undefined} fallback={<text fg={theme.textMuted}>{"  This workflow's plan is unavailable."}</text>}>
        <scrollbox ref={setScrollbox} flexGrow={1} minHeight={0}>
          <Key each={rows().rows} by="key">{(line) => <CardLine id={`${props.workflowId}:${line().key}`} row={line} onPress={(action) => { setChosenKey(line().key); act(action) }} />}</Key>
        </scrollbox>
      </Show>
      <box height={1} flexShrink={0} />
      <Show when={rows().bar}>{(bar) => <text ref={bindStyledTextContent(() => new StyledText([...bar().content(false)]))} wrapMode="none" overflow="hidden" flexShrink={0} />}</Show>
      <text fg={theme.textMuted} wrapMode="none" overflow="hidden" flexShrink={0}>{"  ↑↓ select · enter open · → expand · ← fold · esc back"}</text>
    </box>
  </ModalFrame>
}

function capitalized(text: string): string {
  return text === "" ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`
}

/** One line of the full-size card, which a press selects and acts on. */
function CardLine(props: { readonly id: string; readonly row: Accessor<WorkflowCardRow>; readonly onPress: (action: WorkflowCardAction) => void }) {
  const hover = useHoverHighlight(() => props.row().action !== undefined, hitsDrawnContent)
  const content = createMemo(() => new StyledText([...props.row().content(hover.hovered())]))
  const press = (event: MouseEvent) => {
    const action = props.row().action
    if (action !== undefined && hitsDrawnContent(event)) props.onPress(action)
  }
  return <box id={props.id} flexShrink={0} {...hover.handlers} onMouseUp={press}>
    <text ref={bindStyledTextContent(content)} wrapMode="none" overflow="hidden" />
  </box>
}
