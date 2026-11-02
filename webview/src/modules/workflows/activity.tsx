import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show, untrack } from "solid-js"
import { parseWorkflowLink } from "../../../../src/protocol/client/session-links.js"
import { workflowCard, workflowCardChoice, workflowCardCut, workflowCardHeaderParts, workflowCardNotice, workflowCardSettled, workflowPlanAbsence } from "../../../../src/protocol/client/workflow-card.js"
import { workflowCardControls } from "../../../../src/protocol/client/session-controls.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { workflowAgentOpenTarget } from "../../../../src/protocol/client/workflow-agent.js"
import type { BlockProps } from "../../app/blocks.js"
import { WORKFLOW_TEXT_GLYPH } from "../../app/icons.js"
import { RowTime } from "../../app/row-time.js"
import { actionKey, controlActionKey } from "../../client/action-key.js"
import { WORKFLOW_CONTROLS, WorkflowCard } from "./card.js"
import { useWorkflows } from "./context.js"
import type { WorkflowReading } from "./inspection.js"
import { workflowSurfaceReads } from "../../../../src/protocol/client/workflow-surface.js"
import { agentGroupInFlight } from "../../../../src/protocol/client/agent-group-summary.js"
import { CARD_ACTION_COPY, CardActionHeader, type CardAction } from "../../app/card-action-header.js"

/** Workflow cards read passive run cursors, never a session detail or transcript. */
export function WorkflowActivity(props: BlockProps) {
  const client = useWorkflows()
  const block = () => props.block.kind === "agentGroup" ? props.block : undefined
  const workflowId = createMemo(() => parseWorkflowLink(block()?.linkUri)?.workflowId)
  const [reading, setReading] = createSignal<WorkflowReading>({ detail: undefined, view: undefined, live: [] })
  const key = () => JSON.stringify([props.sessionId, block()?.id])
  const choices = () => client.choices(key())
  const surface = createMemo(() => ({ kind: "card" as const, status: block()?.status ?? "completed", hasChoices: choices() !== undefined, agentModels: true }),
    undefined, { equals: (before, after) => {
      const a = workflowSurfaceReads(before)
      const b = workflowSurfaceReads(after)
      return a.view === b.view && a.detail === b.detail && a.live === b.live
    } })
  createEffect(on(workflowId, id => {
    if (id === undefined) return
    const subscription = client.subscribe(id, setReading, untrack(surface))
    onCleanup(subscription)
    createEffect(on(surface, demand => subscription.update(demand), { defer: true }))
  }))
  const [now, setNow] = createSignal(Date.now())
  const active = createMemo(() => { const current = block(); return current !== undefined && agentGroupInFlight(current) })
  createEffect(() => {
    if (!active()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const card = createMemo(() => {
    const current = block()
    const view = reading().view
    return current && view?.attemptsStatus === "loaded" && (active() || choices() !== undefined)
      ? workflowCard(workflowOutline(view, workflowCardCut(current.status), reading().live, reading().detail ?? undefined), { settled: workflowCardSettled(current.status), choices: choices() })
      : current?.card
  })
  const sessions = createMemo(() => {
    const view = reading().view
    return new Map(view?.attemptsStatus === "loaded"
      ? workflowOutline(view).phases.flatMap(phase => phase.agents.flatMap(agent => agent.sessionId === undefined ? [] : [[agent.agentNodeId, agent.sessionId] as const]))
      : [])
  })
  const roles = untrack(() => props.roleAssignments)
  const controls = () => workflowCardControls(workflowSurfaceReads(surface()).detail ? reading().detail : undefined, active(), block()?.status === "paused")
  const open = () => { const id = workflowId(); if (id !== undefined) client.open(id) }
  const parts = () => { const current = block(); return current ? workflowCardHeaderParts(current, now()) : [] }
  const actions = (): readonly CardAction[] => {
    const admitted = controls()
    const result: CardAction[] = []
    if (admitted.primary) {
      const kind = admitted.primary
      result.push({ kind, ...CARD_ACTION_COPY[kind], title: WORKFLOW_CONTROLS[kind].title,
        busyKey: controlActionKey(kind, workflowId() ?? ""), run: () => { const id = workflowId(); if (id) client.control(id, kind) } })
    }
    if (admitted.stop) result.push({ kind: "stop", ...CARD_ACTION_COPY.stop, title: "Stop this workflow.",
      busyKey: actionKey("stop-tool", block()?.toolUseId ?? ""), run: () => { const current = block(); if (current) props.onTerminateBackground(current.toolUseId) } })
    return result
  }
  return <Show when={block()}>{current => <div class="block agent-group-block chain">
    <RowTime timestamp={current().timestamp} />
    <CardActionHeader class="workflow-head" actions={actions()} working={props.working}>
      <button class="disclosure" title="Open this workflow" onClick={open}>
        <span class="chevron"><span class="marker-dot" classList={{ live: active() }} /></span>
        <span class="agent-group-summary workflow-summary"><span class="tool-title"><span class="workflow-glyph">{WORKFLOW_TEXT_GLYPH} </span>{current().label}</span>
          <span class="tool-detail workflow-header-parts"><Index each={parts()}>{(part, index) => <span classList={{ [`tone-${part().tone}`]: part().tone !== "muted" }}>{index > 0 ? " · " : ""}{part().text}</span>}</Index></span>
        </span><span class="agent-open">{"\u2197"}<span class="control-word"> Open</span></span>
      </button>
    </CardActionHeader>
    <Show when={card()}>{shown => <WorkflowCard card={shown()} status={current().status} live={reading().live} choices={choices()} now={now} sessions={sessions()} roles={roles}
      notice={workflowCardNotice(reading().detail, current(), shown())} onOpen={open} onAction={action => {
        const id = workflowId()
        if (id === undefined) return
        if (action.kind === "agent") client.open(id, { kind: "agent", ...workflowAgentOpenTarget(action) })
        else if (action.kind === "followUp") client.open(id, { kind: "followUp" })
        else client.choose(key(), workflowCardChoice(choices(), action, card(), current().status))
      }} />}</Show>
    <Show when={workflowPlanAbsence(reading().detail, { ...current(), card: card() })}>{absence => <div class="group-loading" classList={{ "plan-notice": absence().notice }}>{absence().text}</div>}</Show>
  </div>}</Show>
}
