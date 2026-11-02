import { createMemo, Index, Match, Show, Switch, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { FrontendOutputBlock } from "../../../../src/protocol/app-service-types.js"
import type { WorkflowControl } from "../../../../src/protocol/client/session-controls.js"
import { CHIT_SLOTS, workflowChits, type WorkflowUnitCounts } from "../../../../src/protocol/client/workflow-chits.js"
import { workflowAgentOperations, workflowCardLines, workflowCardSettled, workflowCardTime, type WorkflowCardChoices, type WorkflowCardLine } from "../../../../src/protocol/client/workflow-card.js"
import { workflowAgentGlyph, type WorkflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { workflowSeatRoleText } from "../../../../src/protocol/client/workflow-agent.js"
import type { WorkflowAgentLive } from "../../../../src/protocol/workflow-view-protocol-types.js"
import "../../styles/workflow-card.css"
import { keyedRows } from "../../app/keyed-rows.js"
import { AgentLineCells } from "../../app/agent-line.js"
import { createSessionReading, type SessionReadingSource } from "../../app/session-reading.js"
import { sessionServingLabel, type RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"

type AgentGroupBlock = Extract<FrontendOutputBlock, { kind: "agentGroup" }>
type WorkflowCardModel = NonNullable<AgentGroupBlock["card"]>
type PhaseLine = Extract<WorkflowCardLine, { kind: "phase" }>
type AgentLine = Extract<WorkflowCardLine, { kind: "agent" }>
type CountedLine = Extract<WorkflowCardLine, { kind: "counted" }>
type BarLine = Extract<WorkflowCardLine, { kind: "bar" }>
type TextLine = Extract<WorkflowCardLine, { kind: "notice" | "fold" }>

/** The class of a line of words: the one notice, or a fold of phases in the
 *  tone of what it folds. */
function textClass(line: TextLine): string {
  switch (line.kind) {
    case "notice": return "workflow-card-notice"
    case "fold": return `workflow-card-fold tone-${line.tone}`
  }
}

interface ControlFace {
  readonly icon: string
  readonly word: string
  readonly title: string
}

/** The icon, word, and title of a whole workflow's control, at both sizes
 *  of its card. */
export const WORKFLOW_CONTROLS = {
  interrupt: { icon: "\u2016", word: "Interrupt", title: "Interrupt every agent of this workflow. Resume continues them." },
  resume: { icon: "\u25b6", word: "Resume", title: "Continue this workflow with no new message." },
  restart: { icon: "\u21bb", word: "Restart", title: "Run this workflow again from its recorded request." },
} satisfies { readonly [Control in WorkflowControl]: ControlFace }

/** What a selection of a card line does: open an agent's view, expand or
 *  fold a phase, list every agent of a phase in place, or open the
 *  follow-up conversation. */
export type WorkflowCardAction =
  | { readonly kind: "agent"; readonly agentNodeId: string; readonly state: AgentLine["state"] }
  | { readonly kind: "phase"; readonly key: string }
  | { readonly kind: "counted"; readonly key: string }
  | { readonly kind: "followUp" }

/** What the full-size card reads beyond the inline card's input: the
 *  outline that it folded, whose seats and operations its lines name, the
 *  model and effort of a seat, whether the run opened a follow-up
 *  conversation, and the selected line, which the keys move. */
export interface WorkflowFullCard {
  readonly outline: WorkflowOutline
  readonly followUp: boolean
  readonly selected: Accessor<string | undefined>
  readonly onSelect: (key: string) => void
}

/** The key of a line that a person can select on the full-size card. */
function lineKey(line: PhaseLine | AgentLine | CountedLine | FollowUpLine): string {
  switch (line.kind) {
    case "phase": return `phase:${line.key}`
    case "agent": return `agent:${line.agentNodeId}`
    case "counted": return `counted:${line.phaseKey}`
    case "followUp": return "followUp"
  }
}

/** What a selection of a line does. A phase of one agent has no agent line,
 *  so on either card its own line opens its agent once it started. */
function lineAction(line: PhaseLine | AgentLine | CountedLine | FollowUpLine): WorkflowCardAction | undefined {
  switch (line.kind) {
    case "phase": return line.toggles ? { kind: "phase", key: line.key } : line.opens && line.agentNodeId !== undefined ? { kind: "agent", agentNodeId: line.agentNodeId, state: line.state } : undefined
    case "agent": return line.opens ? { kind: "agent", agentNodeId: line.agentNodeId, state: line.state } : undefined
    case "counted": return { kind: "counted", key: line.phaseKey }
    case "followUp": return { kind: "followUp" }
  }
}

type FollowUpLine = Extract<WorkflowCardLine, { kind: "followUp" }>

/** One phase with the agent lines and the counted line under it. */
type Section =
  | { readonly kind: "line"; readonly line: TextLine }
  | { readonly kind: "phase"; readonly line: PhaseLine; readonly tree: readonly (AgentLine | CountedLine)[] }
  | { readonly kind: "followUp"; readonly line: FollowUpLine }

function sections(lines: readonly WorkflowCardLine[]): readonly Section[] {
  const out: Section[] = []
  for (const line of lines) {
    if (line.kind === "bar") continue
    if (line.kind === "followUp") { out.push({ kind: "followUp", line }); continue }
    if (line.kind === "agent" || line.kind === "counted") {
      const last = out.at(-1)
      if (last?.kind === "phase") out[out.length - 1] = { ...last, tree: [...last.tree, line] }
      continue
    }
    out.push(line.kind === "phase" ? { kind: "phase", line, tree: [] } : { kind: "line", line })
  }
  return out
}

const counted = (line: AgentLine | CountedLine): CountedLine | undefined => line.kind === "counted" ? line : undefined
const agentLine = (line: AgentLine | CountedLine): AgentLine | undefined => line.kind === "agent" ? line : undefined
const phaseSection = (section: Section): Extract<Section, { kind: "phase" }> | undefined => section.kind === "phase" ? section : undefined
const plainLine = (section: Section): Extract<Section, { kind: "line" }>["line"] | undefined => section.kind === "line" ? section.line : undefined
const followUpLine = (section: Section): FollowUpLine | undefined => section.kind === "followUp" ? section.line : undefined

/** The model and effort that serve an agent's session. A full-size row keeps
 *  the cell in its grid while the agent has no session; an inline row leads
 *  its quiet column with the label and adds nothing without one. */
function ServingModel(props: { readonly sessionId: string | undefined; readonly roles: SessionReadingSource<RoleAssignmentView>; readonly cell: boolean }) {
  const roles = createSessionReading(() => props.sessionId, props.roles)
  const label = () => sessionServingLabel(roles())
  return <Show when={props.cell || label() !== undefined}><span class="workflow-card-model">{label() ?? ""}</span></Show>
}

/** Full-size rows add their brief, persona, and operation count. */
function agentFigures(line: AgentLine) {
  return {
    role: workflowSeatRoleText(line.seat),
    operations: workflowAgentOperations(line),
  }
}

/** The attributes of a line that a person can select on the full-size
 *  card: one item of the tree, which the keys move to and focus. */
interface TreeItemAttributes {
  readonly role?: "treeitem"
  readonly "aria-selected"?: boolean
  readonly tabindex?: number
  readonly ref?: (element: HTMLElement) => void
}

function treeItem(key: string, full: WorkflowFullCard | undefined, items: Map<string, HTMLElement>): TreeItemAttributes {
  if (full === undefined) return {}
  const selected = full.selected() === key
  return { role: "treeitem", "aria-selected": selected, tabindex: selected ? 0 : -1, ref: (element) => { items.set(key, element) } }
}

/** The chits of `counts` in `slots`: a filled chit in the colour of its
 *  state for each unit that started, then an empty one for each unit left. */
function Chits(props: { readonly counts: WorkflowUnitCounts; readonly slots: number; readonly class: string }) {
  const chits = createMemo(() => workflowChits(props.counts, props.slots).flatMap(({ tone, chits: count }) => Array.from({ length: count }, () => tone)))
  return (
    <span class={`workflow-chits ${props.class}`} aria-hidden="true">
      <Index each={chits()}>{(tone) => <span class={`workflow-chit tone-${tone()}`} />}</Index>
    </span>
  )
}

/** Each started agent follows its session's serving reading at either size. */
function PhaseView(props: { readonly line: PhaseLine; readonly tree: readonly (AgentLine | CountedLine)[]; readonly now: Accessor<number>; readonly act: (event: MouseEvent, line: PhaseLine | AgentLine | CountedLine) => void; readonly full: WorkflowFullCard | undefined; readonly items: Map<string, HTMLElement>; readonly sessions: ReadonlyMap<string, string>; readonly roles: SessionReadingSource<RoleAssignmentView> }) {
  const content = () => <>
    <Show when={props.full === undefined} fallback={<>
      {identity()}
      <ServingModel sessionId={props.sessions.get(props.line.agentNodeId ?? "")} roles={props.roles} cell />
      <span class="workflow-card-chits">{chits()}</span>
    </>}>
      <span class="workflow-card-head">{identity()}<span class="workflow-card-chits">{chits()}</span></span>
    </Show>
    <span class="workflow-card-detail">
      <Show when={props.full === undefined}><ServingModel sessionId={props.sessions.get(props.line.agentNodeId ?? "")} roles={props.roles} cell={false} /></Show>
      <Show when={props.full === undefined && props.line.count !== undefined}>{props.line.count}{props.line.agentNames !== undefined || props.line.detail !== undefined ? " · " : ""}</Show>
      <span class={`tone-${props.line.detail?.tone ?? "muted"}`}>
      <Show when={props.line.activity} fallback={
        <Show when={props.line.agentNames} fallback={props.line.detail?.text ?? ""}>
          {(names) => <Index each={names()}>{(name, index) => <>{index === 0 ? "" : " · "}<span class="workflow-card-agent-name">{name()}</span></>}</Index>}
        </Show>
      }>{(activity) => <><span class="workflow-card-tool">{activity().name}</span> {activity().detail}</>}</Show>
      </span>
    </span>
    <Show when={props.full !== undefined}><span class="workflow-card-operations">{workflowAgentOperations({ operations: props.line.operations })}</span></Show>
    <Show when={props.full !== undefined}><span class="workflow-card-count">{props.line.count ?? ""}</span></Show>
    <span class="workflow-card-time">{workflowCardTime(props.line, props.now())}</span>
  </>
  const identity = () => <>
    <span class="workflow-card-glyph">{workflowAgentGlyph(props.line.state)}</span>
    <span class="workflow-card-id">{props.line.title}<Show when={props.line.choice ?? (props.full !== undefined && props.line.toggles ? (props.tree.some((entry) => entry.kind === "agent") ? "expanded" : "folded") : undefined)}>{(choice) => <span class="workflow-card-choice">{choice() === "expanded" ? " ▾" : " ▸"}</span>}</Show></span>
  </>
  const chits = () => <Show when={props.line.chits}>{(counts) => <>
    <Chits counts={counts()} slots={CHIT_SLOTS.web.phase} class="wide-only" />
    <Chits counts={counts()} slots={CHIT_SLOTS.phone.phase} class="phone-only" />
  </>}</Show>
  const title = () => props.line.name === props.line.title ? undefined : props.line.name
  const opens = () => lineAction(props.line) !== undefined
  const renderEntry = (entry: Accessor<AgentLine | CountedLine>) => (
            <Switch>
              <Match when={counted(entry())}>
                {(line) => <button type="button" class="workflow-card-agent workflow-card-counted last" {...treeItem(lineKey(line()), props.full, props.items)} onClick={(event) => props.act(event, line())}>
                  <span class="workflow-card-branch" /><span class="workflow-card-more">{line().text}</span>
                </button>}
              </Match>
              <Match when={agentLine(entry())}>
                {(agent) => {
                  const own = createMemo(() => props.full === undefined ? undefined : agentFigures(agent()))
                  return <button type="button" class={`workflow-card-agent state-${agent().state}`} classList={{ last: agent().last }}
                    aria-disabled={!agent().opens || undefined} tabindex={agent().opens ? 0 : -1}
                    {...treeItem(lineKey(agent()), props.full, props.items)}
                    onClick={(event) => { if (agent().opens) props.act(event, agent()) }}>
                    <AgentLineCells glyph={workflowAgentGlyph(agent().state)} label={agent().label} detail={agent().detail}
                      time={workflowCardTime(agent(), props.now())} full={props.full !== undefined}
                      detailLead={<Show when={props.full === undefined}><ServingModel sessionId={props.sessions.get(agent().agentNodeId)} roles={props.roles} cell={false} /></Show>}
                      beforeDetail={<Show when={own()}>{(shown) => <><span class="workflow-card-role">{shown().role}</span><ServingModel sessionId={props.sessions.get(agent().agentNodeId)} roles={props.roles} cell /></>}</Show>}
                      afterDetail={<Show when={own()}>{(shown) => <span class="workflow-card-operations">{shown().operations}</span>}</Show>} />
                  </button>
                }}
              </Match>
            </Switch>
  )
  return <>
    <button type="button" class={`workflow-card-phase state-${props.line.state}`} aria-disabled={!opens() || undefined} tabindex={opens() ? 0 : -1}
      aria-expanded={props.line.toggles ? props.tree.some((entry) => entry.kind === "agent") : undefined} title={title()}
      {...treeItem(lineKey(props.line), props.full, props.items)}
      onClick={(event) => { if (opens()) props.act(event, props.line) }}>{content()}</button>
    <Show when={props.tree.length > 0}>
      <div class="workflow-card-tree" role={props.full === undefined ? undefined : "group"}
        ref={(parent) => keyedRows(parent, () => props.tree, lineKey, renderEntry)} />
    </Show>
  </>
}

/** The plan bar's label, long on a desktop and short on a phone. Each part
 *  is one item that wraps out of the label's one line whole, so a label
 *  that does not fit drops whole parts and never cuts a word; a phone drops
 *  the units that run or an interrupt holds first, which the chits already
 *  colour. */
function BarLabel(props: { readonly parts: BarLine["label"]; readonly short: boolean }) {
  return (
    <span class={`workflow-card-bar-label ${props.short ? "phone-only" : "wide-only"}`}>
      <Index each={props.parts}>
        {(part, index) => <span class={`workflow-card-bar-part tone-${part().tone}`} classList={{ active: index > 0 && part().tone === "plain" }}>{`${index > 0 ? " · " : ""}${props.short ? part().short : part().text}`}</span>}
      </Index>
    </span>
  )
}

/** The box of a workflow card: one line for each phase with its chits,
 *  what it does, its count, and its time; the agents of a phase that runs
 *  as a tree under it, with a counted line for the rest; and the plan bar
 *  with its count. A click on a phase line expands or folds it, on an agent
 *  line or the line of a phase of one agent opens that agent, and on the
 *  counted line lists every agent in
 *  place. In the parent chat, any other click opens the workflow.
 *
 *  With `full`, it is the full-size card: every phase, every agent of an
 *  expanded phase in item order with its brief, persona, model, and
 *  operations, the follow-up conversation, and the plan bar pinned under the
 *  lines. It is one tree: Up, Down, Home, and End move the selection, Enter
 *  acts on the selected line, Right expands a phase, and Left folds it or
 *  moves from an agent to its phase. */
export function WorkflowCard(props: {
  readonly card: WorkflowCardModel
  readonly status: AgentGroupBlock["status"]
  readonly live: readonly WorkflowAgentLive[]
  readonly choices?: WorkflowCardChoices | undefined
  readonly notice?: string | undefined
  readonly now: Accessor<number>
  readonly sessions: ReadonlyMap<string, string>
  readonly roles: SessionReadingSource<RoleAssignmentView>
  /** Opens the workflow. The full-size card passes none, since the
   *  workflow is open. */
  readonly onOpen?: () => void
  readonly onAction: (action: WorkflowCardAction) => void
  readonly full?: WorkflowFullCard
}) {
  const lines = createMemo(() => workflowCardLines(props.card, {
    status: props.status,
    live: props.live,
    notice: props.notice,
    ...(props.choices === undefined ? {} : { choices: props.choices }),
    ...(props.full === undefined ? {} : { outline: props.full.outline, followUp: props.full.followUp }),
  }))
  const bar = createMemo(() => lines().find((line): line is BarLine => line.kind === "bar"))
  const selectable = createMemo(() => lines().filter((line): line is PhaseLine | AgentLine | CountedLine | FollowUpLine => line.kind === "phase" || line.kind === "agent" || line.kind === "counted" || line.kind === "followUp"))
  // The element of each selectable line, so a key moves the focus with the
  // selection.
  const items = new Map<string, HTMLElement>()
  const act = (event: MouseEvent, line: PhaseLine | AgentLine | CountedLine | FollowUpLine): void => {
    event.stopPropagation()
    props.full?.onSelect(lineKey(line))
    const action = lineAction(line)
    if (action !== undefined) props.onAction(action)
  }
  /** Moves the selection to `key` and the focus with it. */
  const select = (key: string | undefined): void => {
    if (key === undefined) return
    props.full?.onSelect(key)
    const item = items.get(key)
    item?.focus()
    item?.scrollIntoView({ block: "nearest" })
  }
  const onKeyDown = (event: KeyboardEvent): void => {
    const all = selectable()
    const at = all.findIndex((line) => lineKey(line) === props.full?.selected())
    const line = all[at]
    const expanded = (key: string) => all.some((candidate) => candidate.kind === "agent" && candidate.phaseKey === key)
    switch (event.key) {
      case "ArrowDown": select(lineKey(all[Math.min(all.length - 1, at + 1)] ?? all[0]!)); break
      case "ArrowUp": select(lineKey(all[Math.max(0, at - 1)] ?? all[0]!)); break
      case "Home": select(all[0] === undefined ? undefined : lineKey(all[0])); break
      case "End": select(all.at(-1) === undefined ? undefined : lineKey(all.at(-1)!)); break
      case "Enter": {
        const action = line === undefined ? undefined : lineAction(line)
        if (action !== undefined) props.onAction(action)
        break
      }
      case "ArrowRight":
        if (line?.kind === "phase" && line.toggles && !expanded(line.key)) props.onAction({ kind: "phase", key: line.key })
        break
      case "ArrowLeft":
        if (line?.kind === "agent" || line?.kind === "counted") select(`phase:${line.phaseKey}`)
        else if (line?.kind === "phase" && line.toggles && expanded(line.key)) props.onAction({ kind: "phase", key: line.key })
        break
      default: return
    }
    event.preventDefault()
  }
  const planBar = () => <Show when={bar()}>
    {(plan) => (
      <div class="workflow-card-bar" role="progressbar" aria-valuemin={0} aria-valuemax={plan().counts.total} aria-valuenow={plan().counts.done} aria-label="Workflow progress">
        <Chits counts={plan().counts} slots={CHIT_SLOTS.web.plan} class="wide-only" />
        <Chits counts={plan().counts} slots={CHIT_SLOTS.phone.plan} class="phone-only" />
        <BarLabel parts={plan().label} short={false} />
        <BarLabel parts={plan().label} short />
      </div>
    )}
  </Show>

  return (
    // A pointer convenience over the inline card: the header's link is the
    // keyboard's way into the workflow.
    <div class="workflow-card" classList={{ settled: workflowCardSettled(props.status), opens: props.onOpen !== undefined, full: props.full !== undefined }}
      role={props.full === undefined ? undefined : "tree"} aria-label={props.full === undefined ? undefined : "Workflow plan"}
      onClick={() => props.onOpen?.()} onKeyDown={props.full === undefined ? undefined : onKeyDown}>
      <Show when={props.full === undefined}>{planBar()}</Show>
      {/* Lines keep their place as the run moves, so a live update rewrites
          only the text that changed and a pointer keeps its hover. */}
      <Key each={sections(lines())} by={section => section.kind === "phase" ? section.line.key : section.kind === "followUp" ? "followUp" : section.line.kind}>
        {(section) => (
          <Switch>
            <Match when={phaseSection(section())}>{(phase) => <PhaseView line={phase().line} tree={phase().tree} now={props.now} act={act} full={props.full} items={items} sessions={props.sessions} roles={props.roles} />}</Match>
            <Match when={followUpLine(section())}>{(line) => <button type="button" class="workflow-card-follow-up" {...treeItem(lineKey(line()), props.full, items)} onClick={(event) => act(event, line())}>{"↳ follow-up"}</button>}</Match>
            <Match when={plainLine(section())}>{(line) => <div class={textClass(line())} role={line().kind === "notice" ? "status" : undefined}>{line().text}</div>}</Match>
          </Switch>
        )}
      </Key>
      <Show when={props.full !== undefined}>{planBar()}</Show>
    </div>
  )
}

/** The chits of a workflow's plan, as the agent view's workflow band draws
 *  them. A phone draws fewer, so they fit beside the word `workflow` and a
 *  count on one line. */
export function WorkflowPlanChits(props: { readonly counts: WorkflowUnitCounts }) {
  return <>
    <Chits counts={props.counts} slots={CHIT_SLOTS.web.plan} class="wide-only" />
    <Chits counts={props.counts} slots={CHIT_SLOTS.phoneBand.plan} class="phone-only" />
  </>
}
