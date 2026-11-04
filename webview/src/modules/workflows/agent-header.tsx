import { createEffect, createMemo, createSignal, Index, onCleanup, Show, untrack, type Accessor, type JSX } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { workflowAgentBand, workflowAgentHeaderDrops, workflowAgentLine, workflowNextAgentLabel, type WorkflowAgentHeaderDrop, type WorkflowAgentLine, type WorkflowAgentModel } from "../../../../src/protocol/client/workflow-agent.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { workflowRunName } from "../../../../src/protocol/client/workflow-card.js"
import { workflowAgentAddress } from "../../../../src/protocol/client/workflow-addresses.js"
import type { WebModuleClientHost } from "../../web-module-client.js"
import { summaryOf } from "../../client/view-state.js"
import { createSessionReading } from "../../app/session-reading.js"
import { sessionServingLabel } from "../../../../src/protocol/role-protocol-types.js"
import { WORKFLOW_TEXT_GLYPH } from "../../app/icons.js"
import { WorkflowPlanChits } from "./card.js"
import { workflowCut, type WorkflowPlace } from "./navigation.js"
import type { WorkflowReading } from "./inspection.js"
import "../../styles/workflow-agent-header.css"

function HeaderPart(props: { readonly sep: "" | "·" | "›"; readonly class: string; readonly title?: string; readonly children: JSX.Element }) {
  return <span class={`workflow-agent-part-item ${props.class}`} title={props.title}><span class="workflow-agent-sep" aria-hidden="true">{props.sep}</span>{props.children}</span>
}
type AgentDrop = WorkflowAgentHeaderDrop<"agent">
const NO_DROPS: ReadonlySet<AgentDrop> = new Set()
const measurers = new WeakMap<Document, CanvasRenderingContext2D | null>()
function agentLineDrops(element: HTMLElement, line: WorkflowAgentLine): ReadonlySet<AgentDrop> {
  const width = element.clientWidth
  const host = element.ownerDocument.defaultView
  if (!measurers.has(element.ownerDocument)) measurers.set(element.ownerDocument, element.ownerDocument.createElement("canvas").getContext("2d"))
  const context = measurers.get(element.ownerDocument)
  if (!Number.isFinite(width) || width <= 0 || !host || !context) return NO_DROPS
  const style = host.getComputedStyle(element)
  const measure = (text: string, weight = style.fontWeight) => {
    context.font = style.fontSize ? [style.fontStyle, weight, style.fontSize, style.fontFamily].join(" ") : style.font
    return Math.ceil(context.measureText(text).width)
  }
  const sep = 2 * measure("0")
  const side = (widths: readonly number[]) => widths.length === 0 ? 0 : widths.reduce((sum, part) => sum + sep + part, -sep)
  // oxlint-disable-next-line unicorn/prefer-number-coercion -- boundary: a computed CSS length carries a unit suffix that only parseFloat skips
  const gap = Number.parseFloat(style.columnGap) || 0
  return workflowAgentHeaderDrops("agent", dropped => side([
    ...(line.phase === undefined ? [] : [measure(line.phase)]),
    ...(line.name === undefined ? [] : [measure(line.name, "600")]),
    ...line.how.filter(part => !dropped.has(part.kind)).map(part => measure(part.text)),
  ]) + gap + side(line.facts.filter(part => part.kind === "state" || !dropped.has(part.kind)).map(part => measure(part.text))) <= width)
}

/** Workflow chrome only. Transcript, status, models, and input belong to the selected session. */
export function AgentHeader(props: {
  readonly host: WebModuleClientHost
  readonly place: Accessor<Extract<WorkflowPlace, { kind: "agent" }>>
  readonly reading: Accessor<WorkflowReading>
  readonly model: Accessor<WorkflowAgentModel | undefined>
  readonly back: () => void
  readonly next: () => void
  readonly history: (sessionId: string | undefined) => void
}) {
  const state = props.host.state
  const roles = createSessionReading(() => state().sessionId, untrack(() => ({ get: state().roleAssignments, subscribe: state().subscribeRoleAssignments })))
  const seat = () => sessionServingLabel(roles())
  const band = createMemo(() => {
    const reading = props.reading()
    const parent = summaryOf(state(), props.place().chatSessionId)
    return workflowAgentBand(props.place().origin, { chat: parent?.title || "Chat", workflow: workflowRunName(reading.view?.attemptsStatus === "loaded" ? reading.view : undefined, reading.detail?.title) },
      reading.view?.attemptsStatus === "loaded" ? workflowOutline(reading.view, workflowCut(reading), reading.live) : undefined)
  })
  const historical = () => { const target = props.place().target; return target.kind === "followUp" || (target.historySessionId !== undefined && target.historySessionId !== props.model()?.sessionId) }
  const [now, setNow] = createSignal(Date.now())
  const clockRuns = createMemo(() => props.model()?.running === true)
  createEffect(() => {
    if (!clockRuns()) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const line = createMemo(() => workflowAgentLine(props.model(), seat(), now()))
  const [element, setElement] = createSignal<HTMLElement>()
  const [resized, setResized] = createSignal(0)
  createEffect(() => {
    const target = element()
    const Observer = target?.ownerDocument.defaultView?.ResizeObserver
    if (!target || !Observer) return
    const observer = new Observer(() => setResized(value => value + 1))
    observer.observe(target)
    onCleanup(() => observer.disconnect())
  })
  const dropped = createMemo(() => { resized(); const target = element(); return target ? agentLineDrops(target, line()) : NO_DROPS })
  return <div class="workflow-agent-chrome">
    <div class="workflow-agent-band">
      <span class="workflow-agent-names">
        <button class="workflow-agent-back" title={`Back to ${band().back}`} onClick={props.back}>{`‹ ${band().back}`}</button>
        <span class="workflow-agent-workflow-name" title={band().name}><span class="workflow-glyph" aria-hidden="true">{`${WORKFLOW_TEXT_GLYPH} `}</span>{band().name}</span>
      </span>
      <Show when={band().progress}>{progress => <span class="workflow-agent-progress" role="progressbar" aria-valuemin={0} aria-valuemax={progress().counts.total} aria-valuenow={progress().counts.done} aria-label="Workflow progress">
        <span class="workflow-agent-drops"><span class="workflow-agent-drops-anchor" /><WorkflowPlanChits counts={progress().counts} /><span class="workflow-agent-word">{progress().word}</span></span>
        <span class="workflow-agent-parts workflow-agent-count"><Index each={progress().label}>{(part, index) => <HeaderPart sep={index === 0 ? "" : "·"} class={`workflow-card-bar-part tone-${part().tone}`}>{part().text}</HeaderPart>}</Index></span>
      </span>}</Show>
    </div>
    <div class="workflow-agent-header">
      <p class="workflow-agent-line" ref={setElement}>
        <span class="workflow-agent-parts workflow-agent-who">
          <Show when={line().phase}>{phase => <HeaderPart sep="" class="workflow-agent-phase">{phase()}</HeaderPart>}</Show>
          <Show when={line().name}>{name => <HeaderPart sep={line().phase === undefined ? "" : "›"} class="workflow-agent-name" title={props.model()?.name}>{name()}</HeaderPart>}</Show>
          <Key each={line().how.filter(part => !dropped().has(part.kind))} by="kind">{part => <HeaderPart sep="·" class={`workflow-agent-part part-${part().kind}`}>{part().text}</HeaderPart>}</Key>
        </span>
        <span class="workflow-agent-parts workflow-agent-facts"><Key each={line().facts.filter(part => part.kind === "state" || !dropped().has(part.kind))} by="kind">{(part, index) =>
          <HeaderPart sep={index() === 0 ? "" : "·"} class={`workflow-agent-part part-${part().kind}${part().kind === "state" ? ` agent-${props.model()?.state ?? ""}` : ""}`}>{part().text}</HeaderPart>
        }</Key></span>
      </p>
      <span class="workflow-agent-controls">
        <Show when={props.model()}>{model => <button class="workflow-agent-next" title="Open the next agent of the workflow (])" aria-keyshortcuts="]" onClick={props.next}>{workflowNextAgentLabel(model())}</button>}</Show>
        <Key each={props.model()?.history} by="sessionId">{(past, index) => <button class="workflow-agent-next" onClick={() => props.history(past().sessionId)}>{`Earlier session ${index() + 1}`}</button>}</Key>
        <Show when={historical() && props.place().target.kind === "agent"}><button class="workflow-agent-next" onClick={() => props.history(undefined)}>Latest session</button></Show>
      </span>
    </div>
  </div>
}

export function agentInput(reading: WorkflowReading, place: WorkflowPlace | undefined, model: WorkflowAgentModel | undefined) {
  if (place?.kind !== "agent") return undefined
  const historical = place.target.kind === "followUp" || (place.target.historySessionId !== undefined && place.target.historySessionId !== model?.sessionId)
  const address = model && reading.view?.attemptsStatus === "loaded" ? workflowAgentAddress(reading.view, model, workflowCut(reading)) : undefined
  return { placeholder: address?.placeholder ?? "This agent is read-only", wordsOnly: true, hidden: historical || address === undefined }
}
