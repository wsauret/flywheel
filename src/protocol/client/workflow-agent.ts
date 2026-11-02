/**
 * The places of a workflow in every client, the agent view of one agent
 * with its workflow band and agent line, and the model seats that an agent
 * line and an agent view name.
 * {@link workflowAgentModel} reads the agent and its sibling agents from the
 * workflow's outline.
 */

import type { WorkflowAgentState } from "../../infra/output-blocks.js"
import type { FrontendOutputBlock } from "../app-service-types.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../workflow-view-protocol-types.js"
import { workflowAgentPlace, workflowOutline, workflowPhaseTitle, workflowStreamAgents, workflowTreeIndex, workflowWaitingText, type WorkflowActiveTime, type WorkflowOutline, type WorkflowAgentSeat, type WorkflowPhaseAgent } from "./workflow-outline.js"
import { workflowAgentFigures, workflowAgentOpens, workflowAgentOperations, workflowProgressLabel, type WorkflowCardBarPart } from "./workflow-card.js"
import { workflowUnitCounts, type WorkflowUnitCounts } from "./workflow-chits.js"

type View = Pick<LoadedWorkflowView, "attempts" | "tree">

/** What the agent view shows: the agent of `agentNodeId` that a person
 *  pinned, or, with `follow`, the agent of that agent's item in a later
 *  phase of its stream once that agent runs, so the view moves on with the
 *  item to its next phase. */
export interface WorkflowAgentTarget {
  readonly agentNodeId: string
  readonly follow: boolean
}

/** What the back control of an agent view reads by the place that the view
 *  opened from: the chat's title for an agent that opened from the chat's
 *  inline card, and `All agents` for an agent that opened from the
 *  full-size card, which lists every agent of the workflow. The workflow's
 *  own name stands beside it in the workflow band. The full-size card's own
 *  back names the chat. */
export function workflowBackLabel(origin: "chat" | "card", names: { readonly chat: string }): string {
  return origin === "card" ? "All agents" : names.chat
}

/** The target that a person's open of an agent makes: an agent that runs or
 *  that an interrupt parked follows its item into the next phase of its
 *  stream, and one that settled stays pinned. */
export function workflowAgentOpenTarget(agent: { readonly agentNodeId: string; readonly state: WorkflowAgentState }): WorkflowAgentTarget {
  return { agentNodeId: agent.agentNodeId, follow: agent.state === "running" || agent.state === "parked" }
}

/** One agent of a workflow as its agent view shows it, with the time its
 *  session worked. */
export interface WorkflowAgentModel extends WorkflowActiveTime {
  /** The agent shown now. */
  readonly agentNodeId: string
  readonly sessionId?: string
  readonly history: readonly { readonly sessionId: string; readonly conversationId: string }[]
  /** Whether the view follows the agent's item. */
  readonly follow: boolean
  readonly attemptId?: string
  readonly kind: "single" | "list" | "parallel"
  /** The agent's phase, by its id and its round in a repeat, which leads
   *  the agent line. */
  readonly phaseId: string
  /** The agent's place among the agents of its phase in item order, such
   *  as `2/9`, which the control that opens the next agent shows. Absent
   *  for the agent of a phase of one agent. */
  readonly position?: string
  readonly state: WorkflowAgentState
  /** The state in the words its card line uses: the run's cut word for a
   *  parked agent, and what a waiting agent waits for. */
  readonly stateText: string
  /** What the view says while the agent's transcript has no block. */
  readonly emptyText: string
  /** The agent's item key in a list, or its record id. */
  readonly label: string
  /** The record id that the agent runs, such as `review`. */
  readonly definitionId: string
  /** The name of the agent's record, for when a person points at it. */
  readonly name: string
  /** The phase whose handoff the agent's brief carries: the agent of its
   *  item in the phase before in its stream, or the phase before a phase
   *  that runs over no list. */
  readonly from?: string
  /** Whether the agent's attempt runs now. Only a running agent takes a
   *  message. */
  readonly running: boolean
  /** Whether this is the agent that workflow control acts on. */
  readonly current: boolean
  readonly seat?: WorkflowAgentSeat
  /** Tools and subagents that the agent started: live while it runs, and
   *  from its attempt's outcome once it settled. */
  readonly operations?: number
}

/** The outline agents of an agent's item in each phase of its stream. */
function streamParts(view: View, outline: WorkflowOutline, agentNodeId: string): readonly WorkflowPhaseAgent[] {
  const agent = workflowTreeIndex(view.tree).byId.get(agentNodeId)
  if (agent?.kind !== "agent") return []
  return workflowStreamAgents(view.tree, agent).flatMap((part) => workflowAgentPlace(view.tree, outline, part.id)?.agent ?? [])
}

/** The agent that a target shows in `outline`: with `follow`, the last
 *  started agent of the target's item in its phase or a later stream phase,
 *  even after settlement. Unstarted and skipped successors do not advance
 *  the view. */
function shownAgent(view: View, outline: WorkflowOutline, target: WorkflowAgentTarget): string {
  if (!target.follow) return target.agentNodeId
  const parts = streamParts(view, outline, target.agentNodeId)
  const later = parts.slice(Math.max(0, parts.findIndex(({ agentNodeId }) => agentNodeId === target.agentNodeId)))
  return later.findLast(workflowAgentOpens)?.agentNodeId ?? target.agentNodeId
}

/** The agent view of a target, or undefined when the outline holds no such
 *  agent. */
export function workflowAgentModel(view: View, target: WorkflowAgentTarget, cut?: string, live?: readonly WorkflowAgentLive[]): WorkflowAgentModel | undefined {
  const tree = view.tree
  const outline = workflowOutline(view, cut, live)
  const agentNodeId = shownAgent(view, outline, target)
  const place = workflowAgentPlace(tree, outline, agentNodeId)
  if (place === undefined) return undefined
  const { phase, agent, index } = place
  const form = phase.form
  const node = workflowTreeIndex(tree).byId.get(agent.agentNodeId)
  if (node?.kind !== "agent") return undefined
  const { attemptId, state, operations, activeMs, activeStartedAt } = agent
  const attempt = attemptId === undefined ? undefined : view.attempts.find(({ id }) => id === attemptId)
  const stateText = state === "parked" ? cut ?? "interrupted" : state === "waiting" ? workflowWaitingText(tree, node) : state === "conditional" ? "if needed" : state
  const emptyText = state === "waiting" || state === "queued" || state === "conditional" ? "This agent has not started."
    : state === "skipped" ? "This agent did not run."
    : state === "running" || state === "parked" ? "This agent has not written anything yet."
    : "This agent wrote nothing."
  const parts = form === "list" ? streamParts(view, outline, agent.agentNodeId) : []
  const before = parts[parts.findIndex(({ agentNodeId: id }) => id === agent.agentNodeId) - 1]?.definitionId
  const phaseAt = outline.phases.indexOf(phase)
  const from = form === "list" ? before : phaseAt > 0 ? outline.phases[phaseAt - 1]?.phaseId : undefined
  return {
    agentNodeId: agent.agentNodeId,
    ...(attempt?.sessionId ? { sessionId: attempt.sessionId } : {}),
    history: view.attempts.filter((candidate) => candidate.agentNodeId === agent.agentNodeId || candidate === attempt)
      .flatMap((candidate) => [...candidate.history ?? [], ...(candidate !== attempt && candidate.sessionId && candidate.conversationId ? [{ sessionId: candidate.sessionId, conversationId: candidate.conversationId }] : [])]),
    follow: target.follow,
    ...(attemptId === undefined ? {} : { attemptId }),
    kind: form,
    phaseId: workflowPhaseTitle(phase),
    ...(form === "single" ? {} : { position: `${index + 1}/${phase.agents.length}` }),
    state,
    stateText,
    emptyText,
    label: agent.label,
    definitionId: node.definitionId,
    name: node.label,
    ...(from === undefined ? {} : { from }),
    running: state === "running",
    current: tree.currentAgentNodeId === node.id,
    ...(agent.seat === undefined ? {} : { seat: agent.seat }),
    ...(operations === undefined ? {} : { operations }),
    ...(activeMs === undefined ? {} : { activeMs }),
    ...(activeStartedAt === undefined ? {} : { activeStartedAt }),
  }
}

/** Where Tab or `]` (1) and Shift+Tab or `[` (-1) go: from the open agent,
 *  the next or previous agent that started, of every phase in run order,
 *  crossing from the end of one phase into the next and wrapping at the
 *  ends; with no agent open, the agent that the workflow's control acts on,
 *  else the first or the last that started. An agent that the keys reach
 *  opens pinned, so the keys visit every agent. Undefined when no agent
 *  started. */
export function workflowAgentMove(view: View, open: Pick<WorkflowAgentModel, "agentNodeId"> | undefined, direction: 1 | -1, cut?: string, live?: readonly WorkflowAgentLive[]): WorkflowAgentTarget | undefined {
  const outline = workflowOutline(view, cut, live)
  const order = outline.phases.flatMap((phase) => phase.agents.filter((agent) => workflowAgentOpens(agent) || agent.agentNodeId === open?.agentNodeId).map(({ agentNodeId }) => agentNodeId))
  if (order.length === 0) return undefined
  const openId = open?.agentNodeId
  const position = openId === undefined ? -1 : order.indexOf(openId)
  const controlled = view.tree.currentAgentNodeId === undefined ? undefined : workflowAgentPlace(view.tree, outline, view.tree.currentAgentNodeId)
  const controlledAt = controlled === undefined ? -1 : order.indexOf(controlled.agent.agentNodeId)
  const agentNodeId = position >= 0 ? order[(position + direction + order.length) % order.length]
    : controlledAt >= 0 ? order[controlledAt]
    : order[direction === 1 ? 0 : order.length - 1]
  return agentNodeId === undefined ? undefined : { agentNodeId, follow: false }
}

/** The workflow band of an agent view, which both clients draw above a
 *  rule: everything in it is about the whole workflow, and everything under
 *  the rule is about one agent. */
export interface WorkflowAgentBand {
  /** What the back control reads, from {@link workflowBackLabel}. */
  readonly back: string
  /** The workflow's name, which the band always shows apart from the way
   *  back. */
  readonly name: string
  /** The whole workflow's progress: the word that marks it as the
   *  workflow's, its chits, and the words of its plan bar. Absent until the
   *  workflow's plan loads. */
  readonly progress?: { readonly word: string; readonly counts: WorkflowUnitCounts; readonly label: readonly WorkflowCardBarPart[] }
}

/** The workflow band of an agent view that opened from `origin`: the way
 *  back, the workflow's name, and the progress of every agent of the
 *  workflow, such as `workflow ▰▰▰▱ 3/4 done · 1 running`. */
export function workflowAgentBand(origin: "chat" | "card", names: { readonly chat: string; readonly workflow: string }, outline: WorkflowOutline | undefined): WorkflowAgentBand {
  const counts = outline === undefined ? undefined : workflowUnitCounts(outline)
  return {
    back: workflowBackLabel(origin, names),
    name: names.workflow,
    ...(counts === undefined ? {} : { progress: { word: "workflow", counts, label: workflowProgressLabel(counts) } }),
  }
}

/** The order in which each line of the agent view's header drops its parts
 *  while it is too narrow: the workflow band drops the word `workflow`,
 *  then the chits, then reads its count in the short words of a narrow
 *  plan bar, such as `7/21 · 11 running`; the agent line drops the operations,
 *  the model, the persona, the brief, and then the time. A header never
 *  drops the way back, the workflow's name or progress count, the phase's
 *  name, the agent's name, its state, or a control. */
const HEADER_DROP_ORDER = {
  band: ["workflowWord", "chits", "countWords"],
  agent: ["operations", "model", "persona", "brief", "time"],
} as const

type HeaderLine = keyof typeof HEADER_DROP_ORDER

/** A part of the workflow band, or of the agent line, that a narrow line
 *  can drop. */
export type WorkflowAgentHeaderDrop<Line extends HeaderLine = HeaderLine> = (typeof HEADER_DROP_ORDER)[Line][number]

/** The parts that one line of the header drops so that it fits. It drops
 *  parts in {@link HEADER_DROP_ORDER} until `fits` holds, then puts back
 *  each dropped part, from the last one dropped, that still lets the line
 *  fit, so a part drops only while the line has no room for it. A line
 *  that does not fit with every part gone drops them all and then cuts its
 *  flexible text, such as the workflow's name. */
export function workflowAgentHeaderDrops<Line extends HeaderLine>(line: Line, fits: (dropped: ReadonlySet<WorkflowAgentHeaderDrop<Line>>) => boolean): ReadonlySet<WorkflowAgentHeaderDrop<Line>> {
  const order: readonly WorkflowAgentHeaderDrop<Line>[] = HEADER_DROP_ORDER[line]
  const dropped = new Set<WorkflowAgentHeaderDrop<Line>>()
  for (const part of order) {
    if (fits(dropped)) break
    dropped.add(part)
  }
  for (const part of [...dropped].toReversed()) {
    dropped.delete(part)
    if (!fits(dropped)) dropped.add(part)
  }
  return dropped
}

/** The agent line, from {@link workflowAgentLine}. */
export interface WorkflowAgentLine {
  /** The agent's phase with its round, such as `hunt · round 2`. Absent for
   *  the follow-up conversation. */
  readonly phase?: string
  /** The agent's own name. Absent for the agent of a phase of one agent,
   *  which its phase names. */
  readonly name?: string
  /** How the agent runs, after its name: its persona, its brief, and its
   *  model and effort. */
  readonly how: readonly { readonly kind: Extract<WorkflowAgentHeaderDrop<"agent">, "persona" | "brief" | "model">; readonly text: string }[]
  /** What changes as the agent runs, at the right: its state, which never
   *  drops, its time, and its operations. */
  readonly facts: readonly { readonly kind: "state" | Extract<WorkflowAgentHeaderDrop<"agent">, "time" | "operations">; readonly text: string }[]
}

/** The agent line, which both clients draw under the workflow band:
 *  `<phase> › <agent> · <persona> · brief <id> · <model> <effort>`, and at
 *  the right the agent's state in the words of its card line, its elapsed
 *  time, and its operations. The agent's name is its item key for an agent
 *  of a list and its agent id for a named agent, and never the record id
 *  that every agent of a list shares; the agent of a phase of one agent
 *  shows only its phase. The persona and the brief read as
 *  {@link workflowSeatRole} words them. The follow-up conversation (no
 *  `model`) reads `follow-up`. */
export function workflowAgentLine(model: WorkflowAgentModel | undefined, seat: string | undefined, now: number): WorkflowAgentLine {
  if (model === undefined) return { name: "follow-up", how: [], facts: [] }
  const { persona = "", brief = "" } = model.seat === undefined ? {} : workflowSeatRole(model.seat)
  return {
    ...agentNames(model),
    how: ([["persona", persona], ["brief", brief], ["model", seat ?? ""]] as const)
      .flatMap(([kind, text]) => text === "" ? [] : [{ kind, text }]),
    facts: ([["state", model.stateText], ["time", workflowAgentFigures(model, now)], ["operations", workflowAgentOperations(model)]] as const)
      .flatMap(([kind, text]) => text === "" ? [] : [{ kind, text }]),
  }
}

/** The words that lead an agent line: the agent's phase, and its own name
 *  unless its phase has one agent. */
function agentNames(model: Pick<WorkflowAgentModel, "phaseId" | "kind" | "label">) {
  return { phase: model.phaseId, ...(model.kind === "single" ? {} : { name: model.label }) }
}

/** The title of an agent's session: the words that lead its agent line,
 *  such as `areas › role-defaults`, or the phase alone for the agent of a
 *  phase of one agent. They never change for one attempt, so the runtime
 *  writes them once as the session's label. Undefined when the tree holds
 *  no such agent. */
export function workflowAgentTitle(view: View, agentNodeId: string): string | undefined {
  const model = workflowAgentModel(view, { agentNodeId, follow: false })
  if (model === undefined) return undefined
  const { phase, name } = agentNames(model)
  return name === undefined ? phase : `${phase} › ${name}`
}

/** What the control that opens the next agent reads: `Next agent`, with
 *  the open agent's place among the agents of its phase, such as
 *  `Next agent 2/9`. */
export function workflowNextAgentLabel(model: Pick<WorkflowAgentModel, "position"> | undefined): string {
  return model?.position === undefined ? "Next agent" : `Next agent ${model.position}`
}

interface WorkflowSeatRole {
  readonly brief?: string
  readonly persona?: string
}

/** What an agent runs beyond its own record, in the words of the agent line
 *  and the full-size card alike: its persona as its id, such as
 *  `reviewer-code-security`, and the brief that it runs when that is
 *  another record's or a named brief, such as `brief fix`. A brief id names
 *  its workflow before its own id, so `triage.fix` is the brief `fix`. */
function workflowSeatRole(seat: WorkflowAgentSeat): WorkflowSeatRole {
  const brief = seat.briefId.slice(seat.briefId.lastIndexOf(".") + 1)
  return {
    ...(brief === seat.definitionId ? {} : { brief: `brief ${brief}` }),
    ...(seat.persona === undefined ? {} : { persona: seat.persona.id }),
  }
}

/** The full-size card's column of what an agent runs beyond its own
 *  record, in the agent line's words and order, such as
 *  `reviewer-code-security · brief review`, or empty. */
export function workflowSeatRoleText(seat: WorkflowAgentSeat | undefined): string {
  if (seat === undefined) return ""
  const { persona, brief } = workflowSeatRole(seat)
  return [persona, brief].filter((part) => part !== undefined).join(" · ")
}

/** The closed row that stands for the brief an agent received as its first
 *  message: `Brief · item api · from probe · 52 lines`, `Brief · agent
 *  typecheck · 18 lines`, or `Brief · from investigate · 88 lines` for the
 *  agent of a phase of one agent. It names the agent's item or record, the
 *  phase whose handoff the brief carries, and how many lines it holds. */
export function workflowBriefLine(model: WorkflowAgentModel, brief: Extract<FrontendOutputBlock, { readonly kind: "userMessage" }>): string {
  const lines = brief.content.split("\n").length
  return [
    "Brief",
    ...(model.kind === "list" ? [`item ${model.label}`] : model.kind === "parallel" ? [`agent ${model.definitionId}`] : []),
    ...(model.from === undefined ? [] : [`from ${model.from}`]),
    `${lines} ${lines === 1 ? "line" : "lines"}`,
  ].join(" · ")
}
