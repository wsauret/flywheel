/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from "@opentui/solid"
import { StyledText, bold as stBold, fg as stFg, type TextChunk } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show, untrack, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { errorMessage } from "../../../infra/error-message.js"
import type { RuntimeClient } from "../../../protocol/app-service-types.js"
import type { DiffColorMode } from "../../../orchestration/config/schema.js"
import { dispatchInterrupt, offeredSessionControls, resumeMutation, sessionControls, workflowParked, workflowStateLabel, type ControlRefusal } from "../../../protocol/client/session-controls.js"
import { workflowAgentPlace, workflowOutline } from "../../../protocol/client/workflow-outline.js"
import { workflowAgentBand, workflowAgentHeaderDrops, workflowAgentModel, workflowAgentMove, workflowAgentOpenTarget, workflowBriefLine, workflowNextAgentLabel, type WorkflowAgentHeaderDrop, type WorkflowAgentTarget } from "../../../protocol/client/workflow-agent.js"
import { workflowAgentAddress } from "../../../protocol/client/workflow-addresses.js"
import { workflowRunName } from "../../../protocol/client/workflow-card.js"
import { CHIT_SLOTS } from "../../../protocol/client/workflow-chits.js"
import { WORKFLOW_GLYPH } from "../../../protocol/client/glyphs.js"
import type { SessionSurface } from "@tui/hooks/create-session-surface.js"
import type { WorkflowInspection } from "./inspection.js"
import { useTheme } from "@tui/context/theme.js"
import { useTickPool } from "@tui/context/tick-pool-context.js"
import { workflowProgressChunks } from "@tui/output-blocks/workflow-card.js"
import { workflowChitChunks } from "@tui/output-blocks/workflow-palette.js"
import { bindStyledTextContent } from "@tui/utils/reactive-text.js"
import { chunksWidth, displayWidth, shareWidth, truncateToWidth } from "@tui/utils/text.js"
import { Button } from "@tui/components/button.js"
import { ModalFrame, MODAL_FRAME_CLOSE_WIDTH, MODAL_FRAME_HORIZONTAL_INSET, modalFrameBackWidth, sessionViewerBodyHeight, sessionViewerWidth } from "@tui/components/modal-frame.js"
import { WorkflowAgentHeader } from "./agent-header.js"
import { ChildSessionBody, type ChildSessionBodyProps } from "@tui/components/child-session-body.js"
import type { ChildSessionViewerInput } from "@tui/components/child-session-viewer.js"

/** What an agent viewer opens: an agent, with `follow` once the viewer knows
 *  whether it runs, or the follow-up conversation. A link names an agent
 *  without `follow`, and the viewer opens it as a person's open of its line
 *  would. */
export type WorkflowAgentViewerTarget =
  | { readonly kind: "agent"; readonly agentNodeId: string; readonly follow?: boolean; readonly historySessionId?: string }
  | { readonly kind: "followUp" }

/** The columns between the parts of the workflow band. */
const BAND_GAP = "  "
/** The fewest columns that the way back and the workflow's name each keep
 *  on a band of one line, unless the text is shorter. */
const NAME_MIN_WIDTH = 8
/** The workflow's glyph before its name, as the full-size card's title
 *  draws it, and the columns it takes with its space. The terminal draws
 *  the gear in one cell, where string-width counts the emoji as two. */
const NAME_GLYPH = `${WORKFLOW_GLYPH} `
const NAME_GLYPH_WIDTH = 2

export interface WorkflowAgentViewerProps {
  readonly workflowId: string
  readonly target: WorkflowAgentViewerTarget
  readonly origin: "chat" | "card"
  readonly createSurface: (sessionId: () => string | undefined) => SessionSurface
  readonly inspectWorkflow: (workflowId: () => string) => WorkflowInspection
  readonly body: (sessionId: string) => Omit<ChildSessionBodyProps, "sessionId" | "surface" | "input" | "width" | "height" | "header" | "navigation" | "messaging" | "placeholder" | "controls" | "active" | "focused" | "agentKind">
  readonly appService: Pick<RuntimeClient, "dispatch" | "query">
  /** The title of a session, for the back control that names the chat. */
  readonly title: (sessionId: string) => string | undefined
  readonly input: ChildSessionViewerInput
  readonly active: Accessor<boolean>
  readonly focused: Accessor<boolean>
  /** Back to where the view opened from. */
  readonly onBack: () => void
  /** Back to the chat. */
  readonly onClose: () => void
  /** The agent that the view shows now, for the route that a successor
   *  terminal reopens. */
  readonly onShown?: (target: WorkflowAgentTarget) => void
  readonly onHistoryShown?: (sessionId: string | undefined) => void
  readonly showToast: (opts: { message: string; variant: "info" | "warning" | "error" | "success" }) => void
  readonly showThinking: boolean
  readonly diffColors: () => DiffColorMode
}

/** One agent's view of a workflow, or the follow-up conversation's, in two
 *  bands. The workflow band is the title line: the way back, which reads
 *  the chat's title or `All agents` as the place it opened from, the
 *  workflow's name, and the whole workflow's progress, which a rule
 *  closes. The agent line with the
 *  agent's own Interrupt or Resume and the agent's transcript follow, then
 *  the composer, which addresses the agent's item or the agent while it
 *  takes a message. Tab and Shift+Tab move to the next or previous agent
 *  that started, and the Next agent button shows the open agent's place in
 *  its phase. Left on an empty composer and Escape go back, and Close
 *  returns to the chat. */
export function WorkflowAgentViewer(props: WorkflowAgentViewerProps) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const workflowId = untrack(() => props.workflowId)
  const workflow = untrack(() => props.inspectWorkflow(() => workflowId))
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const contentWidth = () => width() - MODAL_FRAME_HORIZONTAL_INSET
  const height = createMemo(() => sessionViewerBodyHeight(dimensions().height))
  const row = workflow.detail
  const live = workflow.live
  const view = createMemo(() => { const loaded = workflow.view(); return loaded?.attemptsStatus === "loaded" ? loaded : undefined })
  const parked = () => workflowParked(live(), row())
  const cut = () => workflowStateLabel(view()?.state, row()?.stoppedBy, row()?.definitionDrift, parked())
  const outline = createMemo(() => { const loaded = view(); return loaded === undefined ? undefined : workflowOutline(loaded, cut(), live()) })

  // The agent that the view shows: a link's agent takes `follow` from its
  // state once the outline holds it, as an open of its line does.
  const [target, setTarget] = createSignal<WorkflowAgentTarget | undefined>(untrack(() => props.target.kind === "agent" && props.target.follow !== undefined ? { agentNodeId: props.target.agentNodeId, follow: props.target.follow } : undefined))
  createEffect(() => {
    const opened = props.target
    const folded = outline()
    const loaded = view()
    if (opened.kind !== "agent" || untrack(target) !== undefined || folded === undefined || loaded === undefined) return
    const place = workflowAgentPlace(loaded.tree, folded, opened.agentNodeId)
    setTarget(place === undefined ? { agentNodeId: opened.agentNodeId, follow: true } : workflowAgentOpenTarget(place.agent))
  })
  createEffect(() => { const shown = target(); if (shown !== undefined) props.onShown?.(shown) })
  const model = createMemo(() => {
    const open = target()
    const loaded = view()
    return open === undefined || loaded === undefined ? undefined : workflowAgentModel(loaded, open, cut(), live())
  })
  const [history, setHistory] = createSignal<string | undefined>(untrack(() => props.target.kind === "agent" ? props.target.historySessionId : undefined))
  createEffect(() => props.onHistoryShown?.(history()))
  const shownSessionId = () => history() ?? (props.target.kind === "followUp" ? view()?.followUpSessionId : model()?.sessionId)
  const surface = untrack(() => props.createSurface(shownSessionId))
  const tick = useTickPool().createSharedTick(1000, () => props.active() && model()?.state === "running")
  const now = () => { tick(); return Date.now() }

  const address = createMemo(() => {
    const shown = model()
    const loaded = view()
    return shown === undefined || loaded === undefined ? undefined : workflowAgentAddress(loaded, shown, cut())
  })
  const messageable = () => sessionControls(surface.summary() ?? undefined).message && history() === undefined
  const composerOpen = () => messageable() && address() !== undefined
  const report = (result: { ok: true } | { ok: false; error: string }): boolean => {
    if (result.ok) return true
    props.showToast({ message: result.error, variant: "error" })
    return false
  }
  const send = async (text: string): Promise<boolean> => {
    const to = untrack(address)
    if (!messageable() || to === undefined) return false
    try {
      const sessionId = untrack(shownSessionId)
      if (sessionId === undefined) return false
      return report(await props.appService.dispatch({ type: "session.send", sessionId, input: text }))
    } catch (error) {
      props.showToast({ message: `Message failed: ${errorMessage(error)}`, variant: "error" })
      return false
    }
  }
  untrack(() => {
    props.input.bindMessaging({ admits: messageable, shown: composerOpen, send })
    props.input.bindBack(() => "close")
    props.input.bindAgentMove(move)
  })
  function move(direction: 1 | -1): boolean {
    const loaded = untrack(view)
    if (loaded === undefined || props.target.kind === "followUp") return false
    const next = workflowAgentMove(loaded, untrack(model), direction, untrack(cut), untrack(live))
    if (next === undefined) return false
    setHistory(undefined)
    setTarget(next)
    return true
  }
  const canMove = createMemo(() => { const loaded = view(); return props.target.kind === "agent" && loaded !== undefined && workflowAgentMove(loaded, model(), 1, cut(), live()) !== undefined })

  const reportRefusal = (refusal: ControlRefusal | undefined): void => {
    if (refusal) props.showToast({ message: `Interrupt failed: ${refusal.reason}`, variant: refusal.variant })
  }
  const control = createMemo(() => history() === undefined ? offeredSessionControls(surface.summary(), surface.interruptible()).primary : null)
  const press = (): void => {
    const current = surface.summary()
    const selected = control()
    if (!current || selected === null) return
    if (selected === "interrupt") void dispatchInterrupt(props.appService, current).then(reportRefusal)
    else void props.appService.dispatch(resumeMutation(current)).then(report)
  }
  // The agent's own Interrupt or Resume, at the end of its agent line.
  const agentControl = createMemo(() => { const shown = control(); return shown === null ? undefined : { label: shown === "interrupt" ? "Interrupt" : "Resume", onPress: press } })

  // The workflow band: the way back as a button, the workflow's name in
  // bold behind the workflow's glyph, as the full-size card's title names
  // it, and the whole workflow's progress at the right, all before the
  // close affordance's gap. A narrow band drops the word `workflow`, then
  // the chits, then reads the count in its short words, and only then cuts
  // the way back and the name, the longer one first, so the count stays.
  // A band that would cut either of them below NAME_MIN_WIDTH columns takes
  // two lines: the way back and the name, and under them the progress.
  const band = createMemo(() => {
    const parent = row()?.launchedFrom.parentSessionId
    const shown = workflowAgentBand(props.origin, { chat: (parent === undefined ? undefined : props.title(parent)) ?? "Chat", workflow: workflowRunName(view(), row()?.title) }, outline())
    const progress = shown.progress
    const slots = CHIT_SLOTS.terminalFull.plan
    const progressChunks = (dropped: ReadonlySet<WorkflowAgentHeaderDrop<"band">>): TextChunk[] => progress === undefined ? [] : [
      ...(dropped.has("workflowWord") ? [] : [stFg(theme.textMuted)(progress.word), stFg(theme.text)(BAND_GAP)]),
      ...(dropped.has("chits") || progress.counts.total === 0 ? [] : [...workflowChitChunks(progress.counts, slots, theme), stFg(theme.text)(BAND_GAP)]),
      ...workflowProgressChunks(progress.label, theme, dropped.has("countWords")),
    ]
    const full = contentWidth()
    const room = full - MODAL_FRAME_CLOSE_WIDTH
    const names = [displayWidth(shown.back), displayWidth(shown.name)]
    // The columns that the way back's button and the glyph take, which
    // never give way, and the gap between the name and the progress, which
    // a band of two lines leaves to the names.
    const fixed = modalFrameBackWidth("") + NAME_GLYPH_WIDTH
    const progressWidth = (parts: ReadonlySet<WorkflowAgentHeaderDrop<"band">>) => progress === undefined ? 0 : BAND_GAP.length + chunksWidth(progressChunks(parts))
    const whole = names.reduce((sum, columns) => sum + columns, 0)
    const dropped = workflowAgentHeaderDrops("band", (parts) => fixed + whole + progressWidth(parts) <= room)
    const least = names.reduce((sum, columns) => sum + Math.min(columns, NAME_MIN_WIDTH), 0)
    const oneLine = fixed + least + progressWidth(dropped) <= room
    const tail = oneLine ? progressChunks(dropped) : []
    const tailWidth = oneLine ? progressWidth(dropped) : 0
    // Both keep their whole width while they fit.
    const [backWidth = 0, nameWidth = 0] = shareWidth(names, room - fixed - tailWidth)
    const back = truncateToWidth(shown.back, backWidth, "…")
    const named = truncateToWidth(shown.name, nameWidth, "…")
    const fill = Math.max(0, room - modalFrameBackWidth(back) - NAME_GLYPH_WIDTH - displayWidth(named) - chunksWidth(tail))
    // The progress on a line of its own drops its parts again against the
    // whole line, so the word and the chits come back when they fit.
    const own = oneLine || progress === undefined ? undefined : progressChunks(workflowAgentHeaderDrops("band", (parts) => chunksWidth(progressChunks(parts)) <= full))
    const second = own === undefined ? undefined : new StyledText([stFg(theme.text)(" ".repeat(Math.max(0, full - chunksWidth(own)))), ...own])
    return { back, content: new StyledText([stBold(stFg(theme.text)(`${NAME_GLYPH}${named}`)), stFg(theme.text)(" ".repeat(fill)), ...tail]), second }
  })
  function seat(): string | undefined {
    const id = shownSessionId()
    return id === undefined ? undefined : props.body(id).modelLabel()
  }
  return <ModalFrame title="" width={width()} onClose={props.onClose} back={{ label: band().back, onPress: props.onBack }}
    titleContent={<text ref={bindStyledTextContent(() => band().content)} wrapMode="none" overflow="hidden" />}>
    <Show when={band().second}>{(second) => <text ref={bindStyledTextContent(second)} wrapMode="none" overflow="hidden" flexShrink={0} />}</Show>
    {/* The rule closes the workflow band: everything under it is about one
        phase or one agent. */}
    <text fg={theme.borderSubtle} wrapMode="none" overflow="hidden" flexShrink={0}>{"─".repeat(contentWidth())}</text>
    <Show when={shownSessionId()} keyed fallback={<text fg={theme.textMuted}>{view() === undefined ? "Loading…" : model()?.emptyText ?? "This conversation is unavailable."}</text>}>{(sessionId) =>
      <ChildSessionBody {...props.body(sessionId)} agentKind="workflow-agent" sessionId={sessionId} surface={surface} input={props.input}
        active={props.active} focused={props.focused} width={contentWidth()} height={Math.max(1, height() - (band().second === undefined ? 1 : 2))}
        messaging={{ admits: messageable, shown: composerOpen, send }} placeholder={address()?.placeholder ?? ""} controls={() => ({})}
        initialMessageLabel={(block) => { const shown = model(); return shown === undefined ? "Request" : workflowBriefLine(shown, block) }}
        header={<WorkflowAgentHeader model={model} seat={seat} now={now} control={agentControl} />}
        navigation={<box flexDirection="row" gap={1} flexShrink={0}>
        <Button label="Back" hotkey="← esc" muted onPress={props.onBack} />
        <Button label="Close" muted onPress={props.onClose} />
        <Show when={canMove()}><Button label={workflowNextAgentLabel(model())} hotkey="tab" muted onPress={() => move(1)} /></Show>
        <Key each={model()?.history} by="sessionId">{(past, index) => <Button label={`Earlier session ${index() + 1}`} muted onPress={() => { setTarget((current) => current ? { ...current, follow: false } : current); setHistory(past().sessionId) }} />}</Key>
        <Show when={history() !== undefined}><Button label="Latest session" muted onPress={() => setHistory(undefined)} /></Show>
      </box>} />
    }</Show>
  </ModalFrame>
}
