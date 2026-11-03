/**
 * The workflow card at both sizes: the bounded fold of the plan that the
 * card's summary reader ships on the inline card's block, the whole plan
 * that the full-size card shows, the lines that the terminal and the web
 * client draw from either, and the words of one agent's line. The reader
 * folds with the same {@link workflowCard} that a client runs over the
 * workflow view, so the two cannot disagree.
 */

import { isAgentInFlight, type AgentGroupBlock, type ToolPresentation, type WorkflowAgentState, type WorkflowCard } from "../../infra/output-blocks.js"
import type { FrontendActivity, WorkflowDefinitionDrift } from "../app-service-types.js"
import type { LoadedWorkflowView, WorkflowAgentLive } from "../workflow-view-protocol-types.js"
import { workflowDriftExplanation } from "./workflow-drift-copy.js"
import { presentedWorkflowState, runStatusLabel, CONDITIONAL_PHASE_LABEL, type WorkflowStateRow } from "./session-controls.js"
import { formatActivity, formatDuration, formatElapsed } from "./format.js"
import { activeTimeMs } from "./session-time.js"
import { workflowUnitCounts, type WorkflowUnitCounts } from "./workflow-chits.js"
import { workflowPhaseTitle, type WorkflowActiveTime, type WorkflowAgentSeat, type WorkflowOutline, type WorkflowPhase, type WorkflowPhaseAgent } from "./workflow-outline.js"
import type { SummaryPart } from "./workflow-progress.js"

/** The most phase lines the inline card shows, its fold lines included. */
const CARD_PHASE_LINES = 8
/** The most agent lines one phase shows before its counted line. */
const CARD_AGENT_LINES = 6
/** The most agent lines the inline card shows in all. */
const CARD_AGENT_TOTAL = 10
/** The fewest agent lines a shrink leaves a phase that shows agents. */
const CARD_AGENT_MIN = 2

type CardPhase = WorkflowCard["phases"][number]
type CardAgent = NonNullable<CardPhase["agents"]>[number]
type CardStatus = AgentGroupBlock["status"]

function settledState(state: WorkflowAgentState): boolean {
  return state === "done" || state === "failed" || state === "skipped"
}

function notStarted(state: WorkflowAgentState): boolean {
  return state === "waiting" || state === "queued" || state === "conditional"
}

/** Whether an agent has started, so its line opens its agent view. */
export function workflowAgentOpens(agent: { readonly state: WorkflowAgentState; readonly startedAt?: number }): boolean {
  return agent.startedAt !== undefined || (!notStarted(agent.state) && agent.state !== "skipped")
}

function firstLine(text: string): string {
  return text.split("\n", 1)[0]?.trim() ?? ""
}

/** The quiet column of an agent's line: the newest call of a running agent,
 *  what it handed off once it finished, why it failed or was skipped, or
 *  the state it holds before it runs, such as `interrupted`, `waiting for
 *  its probe`, or `if needed`. */
export type WorkflowAgentDetail =
  | { readonly kind: "activity"; readonly tool: string; readonly text: string }
  | { readonly kind: "summary"; readonly text: string }
  | { readonly kind: "reason"; readonly text: string }
  | { readonly kind: "state"; readonly text: string }

/** What the quiet column of an agent's line reads, including its live
 *  activity before the first call. `cut` is the run's cut
 *  word, which a parked agent reads. A parent agent reads the same words in
 *  its address lines. */
export function workflowAgentDetail(agent: { readonly state: WorkflowAgentState; readonly detail?: string; readonly activity?: ToolPresentation; readonly runtimeActivity?: FrontendActivity | undefined }, cut: string | undefined): WorkflowAgentDetail | undefined {
  switch (agent.state) {
    case "running": return agent.activity === undefined ? { kind: "state", text: formatActivity(agent.runtimeActivity) } : { kind: "activity", tool: agent.activity.name, text: agent.activity.detail }
    case "done": return agent.detail === undefined ? undefined : { kind: "summary", text: agent.detail }
    case "failed":
    case "skipped": return agent.detail === undefined ? undefined : { kind: "reason", text: agent.detail }
    case "parked": return { kind: "state", text: cut ?? "interrupted" }
    case "conditional": return { kind: "state", text: CONDITIONAL_PHASE_LABEL }
    case "waiting": return agent.detail === undefined ? undefined : { kind: "state", text: agent.detail }
    case "queued": return undefined
  }
}

/** An agent's time in its agent view: the time its session worked, which
 *  runs to `now` while it works, or nothing before it started. */
export function workflowAgentFigures(agent: WorkflowActiveTime, now: number): string {
  return agent.activeMs === undefined ? "" : formatElapsed(activeTimeMs(agent.activeMs, agent.activeStartedAt, now))
}

/** An agent's operations column, such as `1 op` or `41 ops`, or empty
 *  before the agent ran any. */
export function workflowAgentOperations(agent: { readonly operations?: number | undefined }): string {
  return agent.operations === undefined ? "" : `${agent.operations} ${agent.operations === 1 ? "op" : "ops"}`
}

/** Whether a card's run has ended: completed, failed, or stopped. The card
 *  then keeps its box, and each line says what its phase did. */
export function workflowCardSettled(status: CardStatus): boolean {
  return status === "completed" || status === "error" || status === "stopped" || status === "cancelled"
}

/** The word that parks the agents a cut holds, in the words of the card's
 *  own state, or nothing while the run goes on. A completed or failed run
 *  has no agent to park. */
export function workflowCardCut(status: CardStatus): string | undefined {
  switch (status) {
    case "paused": return "interrupted"
    case "stopped": return "stopped"
    case "cancelled": return "canceled"
    default: return undefined
  }
}

/** What a settled phase did: its agent's handoff summary, a list's join, a
 *  phase's count, why it failed or was skipped, or how far it got before a
 *  Stop cut it. The count reads a list's failed agents as finished, as its
 *  join does, so `9/14 done, 5 stopped` adds up to the phase's agents. */
function phaseDetail(phase: WorkflowPhase, cut: string, full: boolean): CardPhase["detail"] {
  const agent = phase.agents[0]
  const count = `${phase.done}/${phase.total} done`
  switch (phase.state) {
    case "done": {
      if (phase.form === "single") {
        const summary = agent?.detail ?? ""
        return summary === "" ? undefined : { text: summary, tone: "muted" }
      }
      const result = full ? phase.form === "list" ? phase.join : undefined : phase.join ?? phase.coverage
      if (result !== undefined) return { text: result.text, tone: result.tone === "failed" ? "failed" : "muted" }
      return full ? { text: phase.total === 0 ? "0 targets" : count, tone: "muted" } : undefined
    }
    case "failed":
      if (phase.form === "single") return { text: firstLine(agent?.detail ?? "") || "failed", tone: "failed" }
      return { text: phase.join?.text ?? (full ? count : phase.agents.find(({ state }) => state === "failed")?.detail ?? "failed"), tone: "failed" }
    case "skipped": return { text: "skipped", tone: "muted" }
    case "parked":
    case "running": return { text: phase.form === "single" ? cut : `${full ? `${count}, ` : ""}${phase.total - phase.done} ${cut}`, tone: "muted" }
    case "waiting":
    case "queued":
    case "conditional": return { text: "not started", tone: "muted" }
  }
}

/** The active time of an agent or a phase, without its absent parts. */
function activeTime(item: WorkflowActiveTime): WorkflowActiveTime {
  return {
    ...(item.activeMs === undefined ? {} : { activeMs: item.activeMs }),
    ...(item.activeStartedAt === undefined ? {} : { activeStartedAt: item.activeStartedAt }),
  }
}

function cardAgent(agent: WorkflowPhaseAgent): CardAgent {
  const briefId = agent.seat === undefined || agent.seat.briefId === agent.definitionId ? undefined : agent.seat.briefId
  return {
    agentNodeId: agent.agentNodeId,
    ...(agent.attemptId === undefined ? {} : { attemptId: agent.attemptId }),
    label: agent.label,
    ...(briefId === undefined ? {} : { briefId }),
    ...(agent.seat?.persona === undefined ? {} : { persona: agent.seat.persona.id }),
    state: agent.state,
    ...(agent.startedAt === undefined ? {} : { startedAt: agent.startedAt }),
    ...activeTime(agent),
    ...(agent.detail === undefined ? {} : { detail: agent.state === "done" ? agent.detail : firstLine(agent.detail) }),
  }
}

/** The order in which a phase that needs attention shows its agents:
 *  failed ones, then those an interrupt holds, then the longest running,
 *  then the rest in item order. */
function attentionRank(agent: WorkflowPhaseAgent): number {
  switch (agent.state) {
    case "failed": return 0
    case "parked": return 1
    case "running": return 2
    default: return 3
  }
}

function attentionOrder(agents: readonly WorkflowPhaseAgent[]): readonly WorkflowPhaseAgent[] {
  return agents.map((agent, position) => ({ agent, position }))
    .toSorted((a, b) => attentionRank(a.agent) - attentionRank(b.agent)
      || (attentionRank(a.agent) === 2 ? (a.agent.startedAt ?? Infinity) - (b.agent.startedAt ?? Infinity) : 0)
      || a.position - b.position)
    .map(({ agent }) => agent)
}

/** A person's choices on a card, which hold until the person changes them:
 *  the phases they expanded or folded, and the phases whose counted line
 *  they selected, which list every agent in place. */
export interface WorkflowCardChoices {
  readonly phases: ReadonlyMap<string, "expanded" | "folded">
  readonly all: ReadonlySet<string>
}

const NO_CHOICES: WorkflowCardChoices = { phases: new Map(), all: new Set() }

/** The choices after a person selects a phase line or a counted line of
 *  `card`. A counted line lists every agent of its phase in place. A phase
 *  line folds a phase that shows its agents and expands a folded one; with
 *  no choice yet, a phase shows its agents while one of them runs or an
 *  interrupt holds it. */
export function workflowCardChoice(current: WorkflowCardChoices | undefined, selected: { readonly kind: "phase" | "counted"; readonly key: string }, card: WorkflowCard | undefined, status: CardStatus): WorkflowCardChoices {
  const { phases, all } = current ?? NO_CHOICES
  if (selected.kind === "counted") return { phases: new Map([...phases, [selected.key, "expanded"]]), all: new Set([...all, selected.key]) }
  const phase = card?.phases.find(({ key }) => key === selected.key)
  const shown = phases.get(selected.key) ?? (!workflowCardSettled(status) && (phase?.state === "running" || phase?.state === "parked") ? "expanded" : "folded")
  return {
    phases: new Map([...phases, [selected.key, shown === "expanded" ? "folded" : "expanded"]]),
    all: new Set([...all].filter((key) => key !== selected.key)),
  }
}

/** The status that a card without a block shows, as the full-size card and
 *  the agent view read it from the workflow's view and row: a Stop, the
 *  run's end, or an interrupt that holds it. A run that a successor owes its
 *  continuation is active (`presentedWorkflowState`). */
export function workflowViewCardStatus(state: LoadedWorkflowView["state"], row: Pick<WorkflowStateRow, "stoppedBy" | "continuationOwed"> | null | undefined, parked: boolean): CardStatus {
  if (row?.stoppedBy !== undefined) return "stopped"
  switch (presentedWorkflowState(state, row)) {
    case "completed": return "completed"
    case "failed": return "error"
    case "paused": return "paused"
    default: return parked ? "paused" : "active"
  }
}

/** What the notice line says about saved progress that cannot run, which
 *  the card's Restart runs again. */
const WORKFLOW_RESTART_NOTICE = "This workflow's saved progress cannot run. Restart runs it again from its recorded request."

/** The one notice line at the top of a card's box: a changed definition,
 *  or saved progress that cannot run, from the workflow's held row, or a
 *  failure of the run that belongs to no phase. */
export function workflowCardNotice(row: { readonly definitionDrift?: WorkflowDefinitionDrift | undefined; readonly admittedActions?: readonly string[] | undefined } | undefined, block: { readonly status: CardStatus; readonly failure?: { readonly message: string } }, card: WorkflowCard | undefined): string | undefined {
  if (row?.definitionDrift !== undefined) return workflowDriftExplanation(row.definitionDrift)
  if (row?.admittedActions?.includes("workflow.restart") === true) return WORKFLOW_RESTART_NOTICE
  return block.status === "error" && card !== undefined && !card.phases.some(({ state }) => state === "failed") ? block.failure?.message : undefined
}

/** What a card that has no plan shows in its place: the notice of a changed
 *  definition or of saved progress that cannot run, which says what the
 *  person can do, or, once the run settled, that its plan is unavailable.
 *  A launch that failed before it ran states its failure instead. */
export function workflowPlanAbsence(row: Parameters<typeof workflowCardNotice>[0], block: { readonly status: CardStatus; readonly failure?: { readonly message: string }; readonly card?: WorkflowCard | undefined }): { readonly text: string; readonly notice: boolean } | undefined {
  if (block.card !== undefined || block.status === "error") return undefined
  const notice = workflowCardNotice(row, block, undefined)
  if (notice !== undefined) return { text: notice, notice: true }
  return workflowCardSettled(block.status) ? { text: "This workflow's plan is unavailable.", notice: false } : undefined
}

/** The agents that a phase can show, in the order it shows them, and
 *  whether they are all of its agents, which a counted line then counts.
 *  A phase shows its agents while one runs or an interrupt holds it, and a
 *  person's choice wins; otherwise it shows its failed agents only. */
interface PhaseCandidates {
  readonly agents: readonly WorkflowPhaseAgent[]
  readonly whole: boolean
}

function candidates(phase: WorkflowPhase, settled: boolean, choice: "expanded" | "folded" | undefined, size: WorkflowCardSize): PhaseCandidates {
  if (phase.form === "single" || choice === "folded") return { agents: [], whole: false }
  const active = !settled && (phase.state === "running" || phase.state === "parked")
  if (active) return { agents: size === "full" ? phase.agents : attentionOrder(phase.agents), whole: true }
  if (choice === "expanded") return { agents: phase.agents, whole: true }
  return { agents: phase.agents.filter(({ state }) => state === "failed"), whole: false }
}

/** How many agent lines a phase asks for, and whether the caps hold it. */
interface AgentLineDemand {
  readonly count: number
  readonly capped: boolean
}

/** How many agent lines each phase shows: at most {@link CARD_AGENT_LINES}
 *  each and {@link CARD_AGENT_TOTAL} in all. While the sum is higher, the
 *  phase with the most lines gives one up, the later phase on a tie, and no
 *  shrink leaves a phase fewer than {@link CARD_AGENT_MIN}. A phase whose
 *  counted line a person selected shows every agent, outside the caps. */
function agentLineCounts(wanted: readonly AgentLineDemand[]): readonly number[] {
  const lines = wanted.map(({ count, capped }) => ({ capped, shown: capped ? Math.min(count, CARD_AGENT_LINES) : count }))
  const total = () => lines.reduce((sum, line) => sum + (line.capped ? line.shown : 0), 0)
  while (total() > CARD_AGENT_TOTAL) {
    let widest: { shown: number } | undefined
    for (const line of lines) if (line.capped && line.shown > CARD_AGENT_MIN && (widest === undefined || line.shown >= widest.shown)) widest = line
    if (widest === undefined) break
    widest.shown -= 1
  }
  return lines.map(({ shown }) => shown)
}

/** What the hidden agents of a phase are, by state, which its counted line
 *  reads. */
function hiddenCounts(agents: readonly WorkflowPhaseAgent[]): NonNullable<CardPhase["agentsMore"]> {
  const count = (test: (state: WorkflowAgentState) => boolean) => agents.filter(({ state }) => test(state)).length
  return {
    count: agents.length,
    done: count((state) => state === "done"),
    running: count((state) => state === "running"),
    parked: count((state) => state === "parked"),
    failed: count((state) => state === "failed"),
    waiting: count(notStarted),
    skipped: count((state) => state === "skipped"),
  }
}

function phaseUnits(phase: WorkflowPhase): CardPhase["units"] {
  if (phase.form === "single" || !phase.expanded) return undefined
  const count = (state: WorkflowAgentState) => phase.agents.filter((agent) => agent.state === state).length
  return { done: count("done"), failed: count("failed"), running: count("running"), parked: count("parked") }
}

/** The lines `[start, end)` of `count` phases take, with one fold line for
 *  the phases before and one for the phases after. */
function foldLines(start: number, end: number, count: number): number {
  return (start > 0 ? 1 : 0) + (end - start) + (end < count ? 1 : 0)
}

/** The phases a card shows: every running, parked, or failed phase, or
 *  once the run settled every failed phase and the last one; then the most
 *  recent finished phase before them, then the phases after them, then
 *  earlier ones, while the lines fit. */
function shownRange(phases: readonly WorkflowPhase[], settled: boolean): readonly [number, number] {
  const count = phases.length
  if (count <= CARD_PHASE_LINES) return [0, count]
  const kept = phases.flatMap((phase, index) => {
    const failed = phase.state === "failed" || phase.failed > 0
    return failed || (settled ? index === count - 1 : phase.state === "running" || phase.state === "parked") ? [index] : []
  })
  const anchor = phases.findIndex(({ state }) => !settledState(state))
  let start = kept[0] ?? (anchor === -1 ? count - 1 : anchor)
  let end = (kept.at(-1) ?? start) + 1
  while (foldLines(start, end, count) > CARD_PHASE_LINES && start < end - 1) start += 1
  if (start > 0 && foldLines(start - 1, end, count) <= CARD_PHASE_LINES) start -= 1
  while (end < count && foldLines(start, end + 1, count) <= CARD_PHASE_LINES) end += 1
  while (start > 0 && foldLines(start - 1, end, count) <= CARD_PHASE_LINES) start -= 1
  return [start, end]
}

/** The two sizes of a card: inline in the parent chat, bounded by the
 *  line caps, or full-size, with every phase and every agent of an expanded
 *  phase in item order. */
export type WorkflowCardSize = "inline" | "full"

/** The card that the card's summary reader ships on the inline card's
 *  block, and that a client folds from the workflow view once a person made
 *  a choice or opened the full-size card. Its fold depends on line counts
 *  only, never on width. Each phase carries its agents' states as units for
 *  its chits, what it did once it settled, and the agents it shows. A Stop
 *  or an interrupt reaches the outline as its cut, which parks the agents
 *  it cut. */
export function workflowCard(outline: WorkflowOutline, options: { readonly settled: boolean; readonly choices?: WorkflowCardChoices; readonly size?: WorkflowCardSize }): WorkflowCard {
  const { settled } = options
  const size = options.size ?? "inline"
  const choices = options.choices ?? NO_CHOICES
  const cut = outline.cut ?? "stopped"
  const counts = workflowUnitCounts(outline)
  const [start, end] = size === "full" ? [0, outline.phases.length] : shownRange(outline.phases, settled)
  const shown = outline.phases.slice(start, end)
  const wanted = shown.map((phase) => ({ phase, ...candidates(phase, settled, choices.phases.get(phase.key), size) }))
  const lineCounts = size === "full" ? wanted.map(({ agents }) => agents.length) : agentLineCounts(wanted.map(({ phase, agents, whole }) => ({ count: agents.length, capped: !(whole && choices.all.has(phase.key)) })))
  const coverage = outline.phases.flatMap(({ coverage: part }) => part ?? [])
  return {
    ...(size === "full" ? { size } : {}),
    done: outline.progress.done,
    total: outline.progress.total,
    failed: outline.progress.failed,
    finishedFailed: outline.progress.done - counts.done,
    running: counts.running,
    parked: counts.parked,
    ...(coverage.length === 0 ? {} : { coverage }),
    before: start,
    after: outline.phases.length - end,
    phases: wanted.map(({ phase, agents, whole }, index): CardPhase => {
      // A counted line that would stand for one agent shows that agent.
      const lines = agents.length - (lineCounts[index] ?? 0) === 1 ? agents.length : lineCounts[index] ?? 0
      const hidden = whole ? agents.slice(lines) : []
      const own = phase.form === "single" ? phase.agents.filter(({ attemptId }) => attemptId !== undefined) : agents.slice(0, lines)
      const units = phaseUnits(phase)
      const detail = settled || settledState(phase.state) ? phaseDetail(phase, cut, size === "full") : undefined
      const names = size === "full" ? detail === undefined && phase.form === "parallel" && notStarted(phase.state)
        : phase.form !== "single" && ((!settled && !phase.agents.every(({ state }) => settledState(state))) || detail === undefined)
      const agentNames = names ? phase.agents.map(({ label }) => label) : undefined
      return {
        key: phase.key,
        phaseId: phase.phaseId,
        ...(phase.round === undefined ? {} : { round: phase.round }),
        name: phase.name,
        form: phase.form,
        state: phase.state,
        done: phase.done,
        total: phase.total,
        failed: phase.failed,
        ...(units === undefined ? {} : { agentCount: phase.agents.length, units }),
        ...activeTime(phase),
        ...(detail === undefined ? {} : { detail }),
        ...(agentNames === undefined || agentNames.length === 0 ? {} : { agentNames }),
        ...(own.length === 0 ? {} : { agents: own.map(cardAgent) }),
        ...(hidden.length === 0 ? {} : { agentsMore: hiddenCounts(hidden) }),
      }
    }),
  }
}

/** Whether an interrupt or a Stop holds a card's run, so its running agents
 *  read as parked. */
function cardCut(status: CardStatus): boolean {
  return status === "paused" || status === "interrupted" || status === "stopped" || status === "cancelled"
}

/** An agent's or a phase's state as its card shows it. The card's live
 *  status wins over a fold that its summary reader built from older
 *  evidence: after a Stop, work that did not finish never runs, so it reads
 *  skipped; an agent of a card that an interrupt holds reads parked; and a
 *  parked agent of a card whose resumed run goes on reads running, unless
 *  its own interrupt (`interrupted`, from its live value) still holds it. */
export function workflowCardDisplayState(state: WorkflowAgentState, status: CardStatus, interrupted = false): WorkflowAgentState {
  if ((status === "stopped" || status === "cancelled") && !settledState(state)) return "skipped"
  if (state === "running" && (cardCut(status) || interrupted)) return "parked"
  if (state === "parked" && isAgentInFlight(status) && !interrupted) return "running"
  return state
}

/** One part of the bar's label, with the short form a narrow card shows. */
export interface WorkflowCardBarPart extends SummaryPart {
  readonly short: string
}

export interface WorkflowCardBar {
  readonly counts: WorkflowUnitCounts
  readonly label: readonly WorkflowCardBarPart[]
}

/** The phase's chits and what it does, in the words of its line. */
type PhaseLine = Extract<WorkflowCardLine, { readonly kind: "phase" }>

export type WorkflowCardLine =
  | { readonly kind: "notice"; readonly text: string }
  | { readonly kind: "fold"; readonly text: string; readonly tone: SummaryPart["tone"] }
  | {
    readonly kind: "phase"
    readonly key: string
    readonly state: WorkflowAgentState
    /** The phase id with its round, such as `hunt · round 2`. */
    readonly title: string
    /** The authored name, which a client shows when a person points at it. */
    readonly name: string
    /** The chits of a phase of several agents while the run goes on. */
    readonly chits?: WorkflowUnitCounts
    /** `3/14`, or `0 targets` for a list with no items. */
    readonly count?: string
    readonly detail?: SummaryPart
    /** The agents of a phase of named agents that has not started, which
     *  its line names in place of a detail. */
    readonly agentNames?: readonly string[]
    /** The newest call of the running agent of a phase of one agent. */
    readonly activity?: ToolPresentation
    /** The phase's active time, which {@link workflowCardTime} reads. */
    readonly activeMs?: number
    readonly activeStartedAt?: number
    /** A person's choice, which marks the line. */
    readonly choice?: "expanded" | "folded"
    /** Whether a selection expands or folds the phase's agents. */
    readonly toggles: boolean
    /** The agent of a phase of one agent, which a selection of the phase
     *  opens once it started. */
    readonly agentNodeId?: string
    readonly opens: boolean
    /** The full-size card's operations of the agent of a phase of one agent. */
    readonly operations?: number
  }
  | {
    readonly kind: "agent"
    readonly phaseKey: string
    readonly agentNodeId: string
    readonly label: string
    readonly state: WorkflowAgentState
    readonly detail?: WorkflowAgentDetail
    /** The agent's active time, which {@link workflowCardTime} reads. */
    readonly activeMs?: number
    readonly activeStartedAt?: number
    /** The last line under its phase, which the tree draws with `└`. */
    readonly last: boolean
    readonly opens: boolean
    /** The full-size card's figures: the agent's seat, which names its
     *  brief, persona, model, and effort, and its operations. */
    readonly seat?: WorkflowAgentSeat
    readonly operations?: number
  }
  | { readonly kind: "counted"; readonly phaseKey: string; readonly text: string }
  /** The conversation that a build before 2026-10 opened after the run
   *  completed, which the full-size card opens read-only. */
  | { readonly kind: "followUp" }
  | ({ readonly kind: "bar" } & WorkflowCardBar)

/** The states of a counted line in the order it names them, each with its
 *  word. */
const COUNTED_WORDS = [["done", "done"], ["running", "running"], ["parked", "interrupted"], ["failed", "failed"], ["waiting", "to start"], ["skipped", "skipped"]] as const

/** The counted line of a phase, such as `+24 more · 18 done · 2 running ·
 *  4 to start`, with each hidden agent in the state its line would show. */
function countedText(more: NonNullable<CardPhase["agentsMore"]>, status: CardStatus): string {
  const shown = new Map<WorkflowAgentState, number>()
  for (const [state] of COUNTED_WORDS) {
    const display = workflowCardDisplayState(state, status)
    const bucket = display === "queued" || display === "conditional" ? "waiting" : display
    shown.set(bucket, (shown.get(bucket) ?? 0) + more[state])
  }
  const parts = COUNTED_WORDS.flatMap(([state, word]) => {
    const count = shown.get(state) ?? 0
    return count > 0 ? [`${count} ${word}`] : []
  })
  return [`+${more.count} more`, ...parts].join(" · ")
}

function phaseLine(phase: CardPhase, input: { readonly status: CardStatus; readonly live: ReadonlyMap<string, WorkflowAgentLive>; readonly choice: "expanded" | "folded" | undefined; readonly settled: boolean; readonly full: boolean; readonly outline: WorkflowPhase | undefined }): PhaseLine {
  const state = workflowCardDisplayState(phase.state, input.status)
  // A cut holds every agent that ran when it came.
  const units = phase.units === undefined || !cardCut(input.status) ? phase.units : { ...phase.units, running: 0, parked: phase.units.running + phase.units.parked }
  const chits = input.settled || units === undefined || phase.agentCount === undefined ? undefined : { ...units, total: phase.agentCount }
  const count = phase.agentCount === undefined || units === undefined || (input.full && chits === undefined) ? undefined : phase.agentCount === 0 ? "0 targets" : `${units.done}/${phase.agentCount}`
  const agent = phase.form === "single" ? phase.agents?.[0] : undefined
  const own = agent?.attemptId === undefined || state !== "running" ? undefined : input.live.get(agent.attemptId)
  const activity = own?.activity
  const detail = phase.agentNames !== undefined ? undefined : phase.detail
    ?? (phase.form === "single" && state === "running" && activity === undefined ? { text: formatActivity(own?.runtimeActivity), tone: "muted" as const } : undefined)
    ?? (phase.form === "single" && state === "parked" ? { text: workflowCardCut(input.status) ?? "interrupted", tone: "muted" as const } : undefined)
    ?? (state === "conditional" ? { text: CONDITIONAL_PHASE_LABEL, tone: "muted" as const } : undefined)
    ?? (input.full && units !== undefined && (state === "running" || state === "parked") ? {
      text: ([[units.running, "running"], [units.parked, "interrupted"], [units.failed, "failed"]] as const).filter(([total]) => total > 0).map(([total, word]) => `${total} ${word}`).join(" · "),
      tone: "muted" as const,
    } : undefined)
  return {
    kind: "phase",
    key: phase.key,
    state,
    title: workflowPhaseTitle(phase),
    name: phase.name,
    ...(chits === undefined ? {} : { chits }),
    ...(count === undefined ? {} : { count }),
    ...(detail === undefined || detail.text === "" ? {} : { detail }),
    ...(phase.agentNames === undefined ? {} : { agentNames: phase.agentNames }),
    ...(activity === undefined ? {} : { activity }),
    ...activeTime(phase),
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    toggles: phase.form !== "single" && (phase.agentCount ?? 0) > 0,
    ...(agent === undefined ? {} : { agentNodeId: agent.agentNodeId }),
    opens: agent !== undefined && workflowAgentOpens(agent),
    ...(phase.form === "single" && input.outline?.agents[0]?.operations !== undefined ? { operations: input.outline.agents[0].operations } : {}),
  }
}

/** The lines both clients draw inside the card's box: one notice, the fold
 *  of earlier phases, one
 *  line for each phase with the agents it shows as a tree under it and its
 *  counted line, the fold of later phases, the follow-up conversation, and
 *  the plan bar. `live` is the workflow's `workflow_live` value, which names
 *  each running agent's newest call. The full-size card passes the
 *  `outline` that it folded, whose seats and operations its lines name. */
export function workflowCardLines(card: WorkflowCard, input: {
  readonly status: CardStatus
  readonly live: readonly WorkflowAgentLive[]
  readonly notice?: string | undefined
  readonly choices?: WorkflowCardChoices
  readonly outline?: WorkflowOutline
  readonly followUp?: boolean
}): readonly WorkflowCardLine[] {
  const settled = workflowCardSettled(input.status)
  const cut = workflowCardCut(input.status)
  const live = new Map(input.live.map((entry) => [entry.attemptId, entry]))
  const phases = new Map(input.outline?.phases.map((phase) => [phase.key, phase]))
  const agentsOf = new Map(input.outline?.phases.flatMap(({ agents }) => agents.map((agent) => [agent.agentNodeId, agent] as const)))
  const lines: WorkflowCardLine[] = []
  if (input.notice !== undefined && input.notice !== "") lines.push({ kind: "notice", text: input.notice })
  if (card.before > 0) lines.push({ kind: "fold", text: `✓ ${card.before} done`, tone: "done" })
  for (const phase of card.phases) {
    lines.push(phaseLine(phase, { status: input.status, live, choice: input.choices?.phases.get(phase.key), settled, full: card.size === "full", outline: phases.get(phase.key) }))
    if (phase.form === "single") continue
    const agents = phase.agents ?? []
    for (const [index, agent] of agents.entries()) {
      const own = agent.attemptId === undefined ? undefined : live.get(agent.attemptId)
      const state = workflowCardDisplayState(agent.state, input.status, own?.interruptedAt !== undefined)
      const detail = workflowAgentDetail({ state, runtimeActivity: own?.runtimeActivity, ...(agent.detail === undefined ? {} : { detail: agent.detail }), ...(own?.activity === undefined ? {} : { activity: own.activity }) }, cut)
      const outlined = agentsOf.get(agent.agentNodeId)
      lines.push({
        kind: "agent",
        phaseKey: phase.key,
        agentNodeId: agent.agentNodeId,
        label: agent.label,
        state,
        ...(detail === undefined ? {} : { detail }),
        ...activeTime(agent),
        last: index === agents.length - 1 && phase.agentsMore === undefined,
        opens: workflowAgentOpens(agent),
        ...(outlined?.seat === undefined ? {} : { seat: outlined.seat }),
        ...(outlined?.operations === undefined ? {} : { operations: outlined.operations }),
      })
    }
    if (phase.agentsMore !== undefined) lines.push({ kind: "counted", phaseKey: phase.key, text: countedText(phase.agentsMore, input.status) })
  }
  if (card.after > 0) lines.push({ kind: "fold", text: `○ ${card.after} more`, tone: "muted" })
  if (input.followUp === true) lines.push({ kind: "followUp" })
  lines.push({ kind: "bar", ...workflowCardBar(card, input.status) })
  return lines
}

/** The active time of a phase or agent at `now`: a running one's time runs,
 *  a settled one shows the time it worked, and a parked one shows its time
 *  once that time stopped, as it does while the whole run is interrupted.
 *  One that has not started shows nothing. */
export function workflowCardTime(item: WorkflowActiveTime & { readonly state: WorkflowAgentState }, now: number): string {
  if (item.activeMs === undefined || notStarted(item.state)) return ""
  if (item.state === "parked" && item.activeStartedAt !== undefined) return ""
  return formatElapsed(activeTimeMs(item.activeMs, item.activeStartedAt, now))
}

/** The bar's counts and its label, such as `7/21 done · 11 running`,
 *  `7/21 done · 11 interrupted`, or `17/21 done · 1 failed`, then the
 *  coverage of each list. A narrow card reads `7/21 · 11 running`. A
 *  settled card's bar shows only finished work. A cut holds every unit
 *  that ran; in a run that goes on, the units that their own interrupt
 *  holds count as interrupted, as the phase line and the agent view's band
 *  count them. */
export function workflowCardBar(card: WorkflowCard, status: CardStatus): WorkflowCardBar {
  const settled = workflowCardSettled(status)
  const cut = cardCut(status)
  const running = settled || cut ? 0 : card.running
  const parked = settled ? 0 : cut ? card.running + card.parked : card.parked
  const counts = { done: Math.max(0, card.done - card.finishedFailed), failed: card.failed, running, parked, total: card.total }
  return {
    counts,
    label: [...workflowProgressLabel(counts), ...(card.coverage ?? []).map((part) => ({ ...part, short: part.text }))],
  }
}

/** The words of a workflow's progress, such as `7/21 done · 11 running`,
 *  `7/21 done · 11 interrupted`, or `17/21 done · 1 failed`, each part with
 *  the short form that a narrow card shows. The short form drops only the
 *  word `done`, such as `7/21 · 11 running`, so a narrow count never mixes
 *  short and full words. The plan bar and the agent view's workflow band
 *  read the same words. */
export function workflowProgressLabel(counts: WorkflowUnitCounts): readonly WorkflowCardBarPart[] {
  const { done, total, running, parked, failed } = counts
  const label: WorkflowCardBarPart[] = [{ text: `${done}/${total} done`, short: `${done}/${total}`, tone: total > 0 && done === total ? "done" : "plain" }]
  if (running > 0) label.push({ text: `${running} running`, short: `${running} running`, tone: "plain" })
  if (parked > 0) label.push({ text: `${parked} interrupted`, short: `${parked} interrupted`, tone: "plain" })
  if (failed > 0) label.push({ text: `${failed} failed`, short: `${failed} failed`, tone: "failed" })
  return label
}

/** The name of a workflow run on its full-size card and its agent view in
 *  every client: the run's name that its view carries, which is the title
 *  that its launch gave it or its workflow's name, as the inline card's
 *  label is; else, while the view has not loaded, the session's title. */
export function workflowRunName(view: { readonly name?: string | undefined } | undefined, sessionTitle: string | undefined): string {
  return view?.name || sessionTitle || "Workflow"
}

export interface WorkflowCardHeaderPart {
  readonly text: string
  readonly tone: SummaryPart["tone"] | "warning"
}

/** The header's parts after the workflow's name: its state word when it is
 *  not running and its time. A narrow header never drops either. A workflow card names no
 *  operation count, because the box shows the plan. */
export function workflowCardHeaderParts(block: Parameters<typeof runStatusLabel>[0] & Pick<AgentGroupBlock, "duration" | "activeStartedAt">, now: number): readonly WorkflowCardHeaderPart[] {
  const parts: WorkflowCardHeaderPart[] = []
  const word = block.status === "completed" ? "Completed" : block.status === "error" ? "Failed" : runStatusLabel(block)
  if (word !== undefined) parts.push({ text: word, tone: block.status === "error" ? "failed" : block.status === "completed" ? "muted" : "warning" })
  const inFlight = isAgentInFlight(block.status)
  if (inFlight) parts.push({ text: formatElapsed(activeTimeMs(block.duration ?? 0, block.activeStartedAt, now)), tone: "muted" })
  else if (block.duration !== undefined && block.duration > 0) parts.push({ text: formatDuration(block.duration), tone: "muted" })
  return parts
}
