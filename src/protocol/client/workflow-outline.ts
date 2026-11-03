/**
 * The one fold of a workflow's tree that every surface draws. The outline
 * lists the workflow's phases in run order: a phase of one agent, a phase of
 * named agents, or one phase of a stream over a list, and each round of a
 * repeat holds its own phases. Each phase lists its agents: the agent of a
 * phase of one agent, the named agents, or the agent of each item. The card
 * and the agent view read their phases, agents, and agent states from
 * {@link workflowOutline} and the tree primitives here, and fold no
 * hierarchy of their own.
 */

import type { ToolPresentation, WorkflowAgentState } from "../../infra/output-blocks.js"
import type { LoadedWorkflowView, WorkflowAgentLive, WorkflowAgentPersona, WorkflowTree, WorkflowTreeAgent, WorkflowTreeJoin, WorkflowTreeNode, WorkflowTreePhase } from "../workflow-view-protocol-types.js"
import { coveragePart, coverageText, coverageTone, loopOutcomeText, selectionText, unexpandedList, workflowProgress, workflowTreeUnits, type SummaryPart, type WorkflowProgress } from "./workflow-progress.js"
import { summaryLine } from "../../infra/summary-line.js"

type View = Pick<LoadedWorkflowView, "attempts" | "tree">
type WorkflowAttempt = LoadedWorkflowView["attempts"][number]

const GLYPHS = {
  running: "●", parked: "‖", done: "✓", failed: "✗", skipped: "–", waiting: "○", queued: "○", conditional: "○",
} as const satisfies { readonly [State in WorkflowAgentState]: string }

export function workflowAgentGlyph(state: WorkflowAgentState): string {
  return GLYPHS[state]
}

/** The tree's nodes by id, each node's children in run order, and each
 *  node's position in the tree. It is built once for each tree. */
export interface WorkflowTreeIndex {
  readonly byId: ReadonlyMap<string, WorkflowTreeNode>
  readonly children: ReadonlyMap<string, readonly WorkflowTreeNode[]>
  readonly order: ReadonlyMap<string, number>
}

const indexes = new WeakMap<WorkflowTree, WorkflowTreeIndex>()

export function workflowTreeIndex(tree: WorkflowTree): WorkflowTreeIndex {
  const cached = indexes.get(tree)
  if (cached !== undefined) return cached
  const children = new Map<string, WorkflowTreeNode[]>()
  for (const node of tree.nodes) {
    const key = node.parentId ?? ""
    const list = children.get(key) ?? []
    list.push(node)
    children.set(key, list)
  }
  const index = {
    byId: new Map(tree.nodes.map((node) => [node.id, node])),
    children,
    order: new Map(tree.nodes.map((node, position) => [node.id, position])),
  }
  indexes.set(tree, index)
  return index
}

/** The children of a node, or the nodes that the workflow owns for `null`. */
function workflowTreeChildren(index: WorkflowTreeIndex, id: string | null): readonly WorkflowTreeNode[] {
  return index.children.get(id ?? "") ?? []
}

/** The phase that holds an agent, when it holds several agents: a phase of
 *  named agents or a phase over a list. An agent of a phase of one agent
 *  shows as an ordinary section. */
function workflowPhaseNodeId(tree: WorkflowTree, agentNodeId: string): string | undefined {
  const { byId } = workflowTreeIndex(tree)
  const agent = byId.get(agentNodeId)
  const phase = agent?.parentId === null || agent === undefined ? undefined : byId.get(agent.parentId)
  return phase?.kind === "phase" && phase.form !== "single" ? phase.id : undefined
}

/** The agent that an agent of a later phase of a stream follows: the agent
 *  of the phase before with the same item. Undefined outside a stream and
 *  in its first phase. */
function workflowStreamPrevious(tree: WorkflowTree, agent: WorkflowTreeAgent): WorkflowTreeAgent | undefined {
  const index = workflowTreeIndex(tree)
  const phase = agent.parentId === null ? undefined : index.byId.get(agent.parentId)
  if (phase?.kind !== "phase" || phase.list === undefined || agent.item === undefined) return undefined
  const listId = phase.list.id
  const previous = tree.nodes.slice(0, index.order.get(phase.id)).findLast((node): node is WorkflowTreePhase => node.kind === "phase" && node.list?.id === listId)
  if (previous === undefined) return undefined
  const key = agent.item.key
  return workflowTreeChildren(index, previous.id).find((node): node is WorkflowTreeAgent => node.kind === "agent" && node.item?.key === key)
}

/** The agents of an agent's item in each phase of its stream, in stream
 *  order, or the agent alone outside a stream. */
export function workflowStreamAgents(tree: WorkflowTree, agent: WorkflowTreeAgent): readonly WorkflowTreeAgent[] {
  const index = workflowTreeIndex(tree)
  const phase = agent.parentId === null ? undefined : index.byId.get(agent.parentId)
  if (phase?.kind !== "phase" || phase.list === undefined || agent.item === undefined) return [agent]
  const listId = phase.list.id
  const key = agent.item.key
  return tree.nodes.flatMap((node) => node.kind === "phase" && node.list?.id === listId
    ? workflowTreeChildren(index, node.id).filter((child): child is WorkflowTreeAgent => child.kind === "agent" && child.item?.key === key)
    : [])
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1)
}

function unfinishedPrerequisites(tree: WorkflowTree, node: WorkflowTreeNode): readonly WorkflowTreeNode[] {
  if (node.kind !== "agent") return []
  const { byId } = workflowTreeIndex(tree)
  return (node.waitsOn ?? []).flatMap((id) => {
    // SAFETY: The workflow tree producer names only nodes in this tree as prerequisites.
    const before = byId.get(id)!
    return before.disposition === "completed" ? [] : [before]
  })
}

/** What a waiting agent waits for: the unfinished agents of its phase that
 *  it waits on, such as `waiting for b and c`, else the agent before it in
 *  its stream, such as `waiting for its implement`. */
export function workflowWaitingText(tree: WorkflowTree, node: WorkflowTreeNode): string {
  const labels = unfinishedPrerequisites(tree, node).map(({ label }) => lowerFirst(label))
  const last = labels.at(-1)
  const previous = node.kind === "agent" ? workflowStreamPrevious(tree, node)?.definitionId : undefined
  if (last === undefined) return `waiting for its ${lowerFirst(previous ?? "previous phase")}`
  return `waiting for ${labels.length === 1 ? last : `${labels.slice(0, -1).join(", ")} and ${last}`}`
}

/** Where one agent stands. `cut` is the run's cut word, such as
 *  `interrupted`, when an interrupt or a Stop cut the run, and `live` is
 *  the live value of the agent's current attempt. */
function workflowAgentState(tree: WorkflowTree, agent: WorkflowTreeAgent, cut: string | undefined, live: WorkflowAgentLive | undefined): WorkflowAgentState {
  if ((agent.disposition === "pending" || agent.disposition === "running") && (
    live?.interruptedAt !== undefined
    || (cut !== undefined && (agent.disposition === "running" || tree.currentAgentNodeId === agent.id) && workflowPhaseNodeId(tree, agent.id) === undefined)
  )) return "parked"
  switch (agent.disposition) {
    case "running": return "running"
    case "completed": return "done"
    case "failed": return "failed"
    case "skipped": return "skipped"
    case "conditional": return "conditional"
    case "pending": {
      const previous = workflowStreamPrevious(tree, agent)
      return unfinishedPrerequisites(tree, agent).length > 0 || (previous !== undefined && previous.disposition !== "completed") ? "waiting" : "queued"
    }
  }
}

/** A node's own disposition in the words of an agent's state. */
function workflowNodeState(node: WorkflowTreeNode): WorkflowAgentState {
  switch (node.disposition) {
    case "running": return "running"
    case "completed": return "done"
    case "failed": return "failed"
    case "skipped": return "skipped"
    case "conditional": return "conditional"
    case "pending": return "queued"
  }
}

/** The state that sums several agents: a running agent wins over a park,
 *  then work that has not started, and finished work reads failed when any
 *  of its agents failed. Work that some agents finished and others have not
 *  started reads running while the run goes on, and queued once an
 *  interrupt or a Stop cut the run (`cut`), because none of its agents runs
 *  then. */
function workflowSumState(states: readonly WorkflowAgentState[], fallback: WorkflowAgentState, cut: boolean): WorkflowAgentState {
  if (states.length === 0) return fallback
  if (states.includes("running")) return "running"
  if (states.includes("parked")) return "parked"
  if (states.every((state) => state === "conditional")) return "conditional"
  if (states.some((state) => state === "waiting" || state === "queued")) return !cut && states.some((state) => state === "done" || state === "failed") ? "running" : "queued"
  if (states.every((state) => state === "skipped")) return "skipped"
  return states.includes("failed") ? "failed" : "done"
}

/** The agent that an address stands for, among agents that have an
 *  attempt. Unrun placeholders never hide a started continuation, a
 *  failure, or a completed handoff. */
export function workflowCurrentAgent<Agent extends { readonly attemptId?: string; readonly state: WorkflowAgentState; readonly startedAt?: number }>(agents: readonly Agent[]): Agent | undefined {
  const real = agents.filter(({ attemptId }) => attemptId !== undefined)
  return real.find(({ state }) => state === "running" || state === "parked")
    ?? real.find(({ state, startedAt }) => (state === "queued" || state === "waiting") && startedAt !== undefined)
    ?? real.find(({ state }) => state === "queued" || state === "waiting")
    ?? real.find(({ state }) => state === "failed")
    ?? real.findLast(({ state }) => state !== "skipped" && state !== "conditional")
    ?? real.at(-1)
}

/** The model seat of one attempt of an agent of a workflow: the brief that
 *  it runs, its agent record id, and the persona that the record names. */
export interface WorkflowAgentSeat {
  readonly briefId: string
  readonly definitionId: string
  readonly persona?: WorkflowAgentPersona
}

/** The seat of one client attempt row. */
function agentSeat(attempt: Pick<WorkflowAttempt, "briefId" | "definitionId" | "persona">): WorkflowAgentSeat {
  return { briefId: attempt.briefId, definitionId: attempt.definitionId, ...(attempt.persona === undefined ? {} : { persona: attempt.persona }) }
}

/** What a settled join of each reducer did, in plain words. Another
 *  reducer's settled join reads `Joined`. */
const SETTLED_JOIN_WORDS = new Map([
  ["dedupe", "Removed duplicates"],
  ["top", "Ranked"],
  ["quorum", "Voted"],
  ["list-selection", "Selected"],
  ["coverage", "Coverage"],
])

function reducerId(reducer: string): string {
  return reducer.split("@")[0] ?? reducer
}

function settledJoinPart(join: WorkflowTreeJoin): SummaryPart {
  const failed = `${join.failed > 0 ? `, ${join.failed} failed` : ""}${join.missing > 0 ? `, ${join.missing} missing` : ""}`
  const word = reducerId(join.reducer)
  if (join.coverage !== undefined) return { text: `Coverage: ${coverageText(join.coverage)}${failed}`, tone: coverageTone(join.coverage) }
  if (join.selection !== undefined) return { text: `${SETTLED_JOIN_WORDS.get(word) ?? "Joined"}: ${selectionText(join.selection)}${failed}`, tone: "done" }
  if (word === "collect") return { text: `Collected ${join.completed} ${join.completed === 1 ? "result" : "results"}${failed}`, tone: "done" }
  return { text: `${SETTLED_JOIN_WORDS.get(word) ?? "Joined"} ${join.completed} of ${join.slots}${failed}`, tone: "done" }
}

/** The line that closes a phase once its join settled, or undefined while
 *  it waits. It says what the join holds and names no next phase: a survey's coverage, such as `Coverage: required 7
 *  of 9, 2 unsurveyed`, a selection, such as `Removed duplicates: kept 7,
 *  dropped 3`, or the results that a collecting join holds, such as
 *  `Collected 4 results, 1 failed`. The join of one round of a repeat names
 *  its round and, when the repeat stopped there, why, such as `Round 2 ·
 *  Removed duplicates: kept 0, dropped 4 · dry`. Toned done, or failed when
 *  it folded a survey that left a required target unsurveyed. */
function settledJoin(phase: WorkflowTreePhase): SummaryPart | undefined {
  const join = phase.join
  // An empty list already reads `0 targets`.
  if (join === undefined || join.state !== "settled" || join.slots === 0) return undefined
  const part = settledJoinPart(join)
  if (phase.round === undefined) return part
  const { number, outcome } = phase.round
  const decision = outcome === undefined || outcome === "next" ? "" : ` · ${loopOutcomeText(number, outcome)}`
  return { ...part, text: `Round ${number} · ${part.text}${decision}` }
}

/** One agent of a phase: an agent of the tree with its attempt's figures
 *  and its live state, and the time its session worked. */
export interface WorkflowPhaseAgent extends WorkflowActiveTime {
  readonly agentNodeId: string
  readonly sessionId?: string
  readonly history: readonly { readonly sessionId: string; readonly conversationId: string }[]
  /** The item key of an agent of a list, or the agent's record id. */
  readonly label: string
  readonly attemptId?: string
  /** The record id this agent runs, such as `check`. */
  readonly definitionId: string
  readonly state: WorkflowAgentState
  readonly startedAt?: number
  readonly completedAt?: number
  /** Tools and subagents that the agent started: live while it runs or an
   *  interrupt holds it, and from its attempt's outcome once it settled. */
  readonly operations?: number
  /** The newest call of a running agent. */
  readonly activity?: ToolPresentation
  /** The brief, record, and persona of its attempt. Each agent has its own,
   *  so the agents of one phase can run different briefs and personas. */
  readonly seat?: WorkflowAgentSeat
  /** Its handoff summary once done, why it failed or was skipped, or what
   *  it waits for before it starts. */
  readonly detail?: string
}

/** One phase: its time is the part of its span in which its run was active.
 *  It has a time once it started and the run's active intervals are known. */
export interface WorkflowPhase extends WorkflowActiveTime {
  /** The phase's tree node id. */
  readonly key: string
  readonly form: WorkflowTreePhase["form"]
  /** The phase id that the workflow file declares. */
  readonly phaseId: string
  /** The round of a phase of a repeat. */
  readonly round?: number
  /** The authored name with its round, for a tooltip or a title. */
  readonly name: string
  /** Its agents in item order. Empty until a list reads its items. */
  readonly agents: readonly WorkflowPhaseAgent[]
  /** False for a phase over a list that has not read its items. */
  readonly expanded: boolean
  readonly state: WorkflowAgentState
  /** In {@link workflowProgress}'s own units: each agent is 1, and a phase
   *  over a list that has not read its items is 1. The phases of one
   *  outline always sum to `progress.done`, `.total`, `.failed`, and
   *  `.running`. */
  readonly done: number
  readonly total: number
  readonly failed: number
  readonly running: number
  readonly startedAt?: number
  /** Present once the phase settled. */
  readonly completedAt?: number
  /** The settled join, in the words that close the phase. */
  readonly join?: SummaryPart
  readonly coverage?: SummaryPart
}

/** The name that every surface shows for a phase: its id, with its round,
 *  such as `hunt · round 2`. */
export function workflowPhaseTitle(phase: Pick<WorkflowPhase, "phaseId" | "round">): string {
  return phase.round === undefined ? phase.phaseId : `${phase.phaseId} · round ${phase.round}`
}

/** An active time that a client counts at `now` with `activeTimeMs`: the
 *  milliseconds before the open episode, and when the open episode started,
 *  only while one runs. */
export interface WorkflowActiveTime {
  readonly activeMs?: number
  readonly activeStartedAt?: number
}

/** When a run was active: its closed intervals, and the start of its open
 *  interval while it runs. A workflow's detail carries both. */
export interface WorkflowRunActivity {
  readonly activeIntervals: readonly { readonly start: number; readonly end: number }[]
  readonly streamingStartedAt: number | null
}

export interface WorkflowOutline {
  readonly phases: readonly WorkflowPhase[]
  readonly progress: WorkflowProgress
  /** The run's cut word, such as `interrupted`, when an interrupt or a Stop
   *  cut it. */
  readonly cut?: string
}

interface Fold {
  readonly tree: WorkflowTree
  readonly index: WorkflowTreeIndex
  readonly attempts: ReadonlyMap<string, WorkflowAttempt>
  readonly cut: string | undefined
  /** The `workflow_live` value by attempt, indexed once per fold. */
  readonly live: ReadonlyMap<string, WorkflowAgentLive>
  readonly activity: WorkflowRunActivity | undefined
}

function settledState(state: WorkflowAgentState): boolean {
  return state === "done" || state === "failed" || state === "skipped"
}

function phaseAgent(fold: Fold, agent: WorkflowTreeAgent): WorkflowPhaseAgent {
  const attempt = agent.currentAttemptId === undefined ? undefined : fold.attempts.get(agent.currentAttemptId)
  const live = agent.currentAttemptId === undefined ? undefined : fold.live.get(agent.currentAttemptId)
  const agentState = workflowAgentState(fold.tree, agent, fold.cut, live)
  // Once a cut settles, the runtime returns each attempt it cut to pending;
  // the attempt that started marks the agent the cut holds. With no cut, the
  // run goes on, as while a planned replacement's successor owes it, after
  // a recovery, or before a Resume restarts the agent, so it runs.
  const returned = (agentState === "queued" || agentState === "waiting") && attempt?.startedAt !== undefined && attempt.status !== "completed"
  const state = !returned ? agentState : fold.cut === undefined ? "running" : "parked"
  const started = attempt?.startedAt !== undefined || (state !== "waiting" && state !== "queued" && state !== "conditional")
  // Convert summaries written before 2026-10-17; remove after 2027-04-17.
  const detail = state === "done" ? agent.evidence?.summary === undefined ? undefined : summaryLine(agent.evidence.summary)
    : state === "failed" || state === "skipped" ? agent.reason
      : state === "waiting" ? workflowWaitingText(fold.tree, agent) : undefined
  // Only an agent that runs or that an interrupt holds has a live value; a
  // settled one has its attempt's outcome.
  const operations = live?.operations ?? attempt?.toolUses
  return {
    agentNodeId: agent.id,
    ...(attempt?.sessionId ? { sessionId: attempt.sessionId } : {}),
    history: attempt?.history ?? [],
    label: agent.item?.key ?? agent.definitionId,
    ...(agent.currentAttemptId === undefined ? {} : { attemptId: agent.currentAttemptId }),
    definitionId: agent.definitionId,
    state,
    ...(operations === undefined ? {} : { operations }),
    ...(state === "running" && live?.activity !== undefined ? { activity: live.activity } : {}),
    ...(attempt === undefined ? {} : { seat: agentSeat(attempt) }),
    ...(started && attempt?.startedAt !== undefined ? { startedAt: attempt.startedAt } : {}),
    ...(started && attempt?.completedAt !== undefined && state !== "running" ? { completedAt: attempt.completedAt } : {}),
    ...(started && live !== undefined ? { activeMs: live.duration, ...(live.activeStartedAt === undefined ? {} : { activeStartedAt: live.activeStartedAt }) } : {}),
    ...(detail === undefined ? {} : { detail }),
  }
}

/** A phase's span runs from its first agent's start to its last agent's end,
 *  or on while it runs. Its time is the part of its span in which its run
 *  was active, so an interrupt of the run stops it, and it never exceeds the
 *  run's time. A phase that runs while its run's open interval runs ticks
 *  from the later of its start and that interval's start. */
function phaseTiming(agents: readonly WorkflowPhaseAgent[], state: WorkflowAgentState, run: WorkflowRunActivity | undefined): Pick<WorkflowPhase, "startedAt" | "completedAt" | "activeMs" | "activeStartedAt"> {
  const started = agents.flatMap(({ startedAt }) => startedAt ?? [])
  const completed = agents.flatMap(({ completedAt }) => completedAt ?? [])
  if (started.length === 0) return {}
  const startedAt = Math.min(...started)
  const completedAt = completed.length === 0 || !settledState(state) ? undefined : Math.max(...completed)
  const span = { startedAt, ...(completedAt === undefined ? {} : { completedAt }) }
  if (run === undefined) return span
  const end = completedAt ?? Infinity
  const overlap = (start: number, stop: number) => Math.max(0, Math.min(end, stop) - Math.max(startedAt, start))
  const activeMs = run.activeIntervals.reduce((total, interval) => total + overlap(interval.start, interval.end), 0)
  const open = run.streamingStartedAt
  if (open === null) return { ...span, activeMs }
  if (completedAt !== undefined) return { ...span, activeMs: activeMs + overlap(open, completedAt) }
  return { ...span, activeMs, activeStartedAt: Math.max(startedAt, open) }
}

type UncountedPhase = Omit<WorkflowPhase, "done" | "total" | "failed" | "running">

function outlinePhase(fold: Fold, node: WorkflowTreePhase): UncountedPhase {
  const round = node.round === undefined ? "" : ` · round ${node.round.number}`
  const agents = workflowTreeChildren(fold.index, node.id)
    .filter((child): child is WorkflowTreeAgent => child.kind === "agent")
    .toSorted((a, b) => (a.item?.ordinal ?? 0) - (b.item?.ordinal ?? 0))
    .map((agent) => phaseAgent(fold, agent))
  const own = workflowNodeState(node)
  const expanded = !unexpandedList(node)
  // A list that has not read its items runs no agent yet.
  const state = !expanded ? own === "running" ? "queued" : own
    : node.form === "single" ? agents[0]?.state ?? own
      : workflowSumState(agents.map(({ state: agentState }) => agentState), own, fold.cut !== undefined)
  const join = settledJoin(node)
  const coverage = coveragePart(node.join)
  return {
    key: node.id,
    form: node.form,
    phaseId: node.phaseId,
    ...(node.round === undefined ? {} : { round: node.round.number }),
    name: `${node.label}${round}`,
    agents,
    expanded,
    state,
    ...phaseTiming(agents, state, fold.activity),
    ...(join === undefined ? {} : { join }),
    ...(coverage === undefined ? {} : { coverage }),
  }
}

const outlines = new WeakMap<WorkflowTree, { readonly attempts: View["attempts"]; readonly cut: string | undefined; readonly live: readonly WorkflowAgentLive[] | undefined; readonly activity: WorkflowRunActivity | undefined; readonly outline: WorkflowOutline }>()

/** The one fold of the tree that every surface draws: one phase for each
 *  phase of the tree, in run order. A repeat is visited inline, so each
 *  round's phases are phases of their own. `live` is the workflow's
 *  `workflow_live` value, which times each agent that started, and
 *  `activity` is when the run was active, which times each phase. The last
 *  outline of each tree is kept, so every surface of one view reads the same
 *  fold. */
export function workflowOutline(view: View, cut?: string, live?: readonly WorkflowAgentLive[], activity?: WorkflowRunActivity): WorkflowOutline {
  const kept = outlines.get(view.tree)
  if (kept !== undefined && kept.attempts === view.attempts && kept.cut === cut && kept.live === live && kept.activity === activity) return kept.outline
  const tree = view.tree
  const fold: Fold = { tree, index: workflowTreeIndex(tree), attempts: new Map(view.attempts.map((attempt) => [attempt.id, attempt])), cut, live: new Map(live?.map((entry) => [entry.attemptId, entry])), activity }
  const { byId } = fold.index
  // A unit names an agent, whose phase holds it, or a phase that has no agents yet.
  const phaseOf = (id: string): string => {
    const node = byId.get(id)
    return node?.kind === "agent" && node.parentId !== null ? node.parentId : id
  }
  const units = Map.groupBy(workflowTreeUnits(tree), ({ nodeId }) => phaseOf(nodeId))
  const running = Map.groupBy(tree.nodes.filter((node) => node.kind === "agent" && node.disposition === "running"), ({ id }) => phaseOf(id))
  const phases = tree.nodes.flatMap((node): WorkflowPhase[] => {
    if (node.kind !== "phase") return []
    const own = units.get(node.id) ?? []
    return [{
      ...outlinePhase(fold, node),
      done: own.filter(({ done }) => done).length,
      total: own.length,
      failed: own.filter(({ disposition }) => disposition === "failed").length,
      running: running.get(node.id)?.length ?? 0,
    }]
  })
  const outline = { phases, progress: workflowProgress(view), ...(cut === undefined ? {} : { cut }) }
  outlines.set(tree, { attempts: view.attempts, cut, live, activity, outline })
  return outline
}

/** Where an agent stands in an outline: its phase and its position there. */
export interface WorkflowAgentPlace {
  readonly phase: WorkflowPhase
  readonly agent: WorkflowPhaseAgent
  readonly index: number
}

const places = new WeakMap<WorkflowOutline, ReadonlyMap<string, WorkflowAgentPlace>>()

function outlinePlace(outline: WorkflowOutline, agentNodeId: string): WorkflowAgentPlace | undefined {
  let byId = places.get(outline)
  if (byId === undefined) {
    const found = new Map<string, WorkflowAgentPlace>()
    for (const phase of outline.phases) {
      for (const [index, agent] of phase.agents.entries()) found.set(agent.agentNodeId, { phase, agent, index })
    }
    byId = found
    places.set(outline, byId)
  }
  return byId.get(agentNodeId)
}

/** The place of an agent, or, for the node id of a history agent's control
 *  node, of the latest agent that it runs. */
export function workflowAgentPlace(tree: WorkflowTree, outline: WorkflowOutline, agentNodeId: string): WorkflowAgentPlace | undefined {
  const place = outlinePlace(outline, agentNodeId)
  if (place !== undefined) return place
  const execution = tree.nodes.findLast((node) => node.kind === "agent" && node.nodeId === agentNodeId)
  return execution === undefined ? undefined : outlinePlace(outline, execution.id)
}
