import type { LoadedWorkflowView, WorkflowTree, WorkflowTreeAgent, WorkflowTreeCoverage, WorkflowTreeDisposition, WorkflowTreeJoin, WorkflowTreeLoop, WorkflowTreeNode, WorkflowTreePhase, WorkflowTreeSelection, WorkflowTreeRound } from "../workflow-view-protocol-types.js"

type WorkflowAttempt = LoadedWorkflowView["attempts"][number]

/** One list of a tree workflow as its progress reads it: the last phase of
 *  its stream, which holds its join. */
interface WorkflowListProgress {
  readonly id: string
  readonly label: string
  readonly disposition: WorkflowTreeDisposition
  /** The join, once the list read its items. */
  readonly join?: WorkflowTreeJoin
}

/** Where a workflow is in its plan, as every reader counts it: the card's
 *  plan bar, desktop notifications, and a parent agent's progress read of
 *  its child. */
export interface WorkflowProgress {
  /** Units that finished: agents that completed or were skipped, and agents
   *  of a list that failed. A failed agent of a list is finished work that
   *  its join counts; a failed agent outside a list is not. */
  readonly done: number
  /** Every unit of the plan, including agents that run only if needed. */
  readonly total: number
  /** Units that failed. */
  readonly failed: number
  /** Agents that run now. Several run at once in a phase of several agents. */
  readonly running: number
  /** The attempt of the first agent that has not settled: the one that
   *  runs, the one an interrupt or a Stop cut, or the one that is blocked
   *  or failed. Absent when every agent settled. */
  readonly current?: WorkflowAttempt
  /** Agents that run only if an earlier agent's handoff asks for them. */
  readonly conditional: number
  /** The attempts of agents outside a list that completed, in run order. */
  readonly completed: readonly WorkflowAttempt[]
  /** The lists of a tree workflow, in tree order. */
  readonly lists: readonly WorkflowListProgress[]
  readonly loops: readonly { readonly label: string; readonly state: WorkflowTreeLoop }[]
}

/** One unit of a tree's progress, as {@link workflowProgress} counts it: an
 *  agent, or one placeholder for a phase over a list that has not read its
 *  items. `nodeId` names the agent or the phase. */
interface WorkflowTreeUnit {
  readonly nodeId: string
  readonly disposition: WorkflowTreeDisposition
  /** A failed agent of a list is finished work that its join counts; a
   *  failed agent outside a list is not. */
  readonly done: boolean
}

/** Whether a phase is a phase over a list that has not read its items. */
export function unexpandedList(node: WorkflowTreeNode): boolean {
  return node.kind === "phase" && node.list !== undefined && !node.list.expanded
}

/** Every unit of a tree's progress, in tree order: one for each agent, and
 *  one placeholder for each phase over a list that has not read its items.
 *  An item that moves through two phases of a stream is two units, one for
 *  each of its agents. */
export function workflowTreeUnits(tree: WorkflowTree): readonly WorkflowTreeUnit[] {
  return tree.nodes.flatMap((node): WorkflowTreeUnit[] => {
    if (node.kind === "agent") {
      const listed = node.item !== undefined
      return [{ nodeId: node.id, disposition: node.disposition, done: node.disposition === "completed" || node.disposition === "skipped" || (listed && node.disposition === "failed") }]
    }
    if (unexpandedList(node)) return [{ nodeId: node.id, disposition: node.disposition, done: node.disposition === "skipped" }]
    return []
  })
}

/** The last phase of each stream: the phase that holds the stream's join. */
function lastPhasesOfLists(tree: WorkflowTree): readonly WorkflowTreePhase[] {
  const last = new Map<string, WorkflowTreePhase>()
  for (const node of tree.nodes) if (node.kind === "phase" && node.list !== undefined) last.set(node.list.id, node)
  return [...last.values()]
}

/** Counts agents and the placeholders of lists that have not read their
 *  items. Skipped units count as done. Attempt rows supply execution
 *  details, never the hierarchy or its counts. */
export function workflowProgress({ attempts, tree }: Pick<LoadedWorkflowView, "attempts" | "tree">): WorkflowProgress {
  const agents = tree.nodes.filter((node): node is WorkflowTreeAgent => node.kind === "agent")
  const units = workflowTreeUnits(tree)
  const rows = new Map(attempts.map((attempt) => [attempt.id, attempt]))
  const rowOf = (node: WorkflowTreeNode | undefined): WorkflowAttempt | undefined =>
    node?.kind !== "agent" || node.currentAttemptId === undefined ? undefined : rows.get(node.currentAttemptId)
  const current = rowOf(tree.currentAgentNodeId === undefined ? undefined : agents.find(({ id }) => id === tree.currentAgentNodeId))
    ?? rowOf(agents.find((node) => node.item === undefined && node.disposition === "failed"))
  return {
    done: units.filter(({ done }) => done).length,
    total: units.length,
    failed: units.filter(({ disposition }) => disposition === "failed").length,
    running: agents.filter((node) => node.disposition === "running").length,
    ...(current ? { current } : {}),
    conditional: units.filter(({ disposition }) => disposition === "conditional").length,
    completed: agents.flatMap((node) => {
      const row = node.item === undefined && node.disposition === "completed" ? rowOf(node) : undefined
      return row ? [row] : []
    }),
    lists: lastPhasesOfLists(tree).map((node) => ({
      id: node.id,
      label: node.label,
      disposition: node.disposition,
      ...(node.join === undefined ? {} : { join: node.join }),
    })),
    loops: tree.nodes.flatMap((node) => node.kind === "repeat" ? [{ label: node.label, state: node.loop }] : []),
  }
}

/** One piece of a summary line. The tone says how a client emphasizes it,
 *  so the terminal and the web client color the same words the same way. */
export interface SummaryPart {
  readonly text: string
  readonly tone: "plain" | "done" | "failed" | "muted"
}

const SUMMARY_SEPARATOR: SummaryPart = { text: " · ", tone: "muted" }

/** The aggregate line of a tree workflow, which every client shows before
 *  any agent: how many units are done, how many failed, and for each phase
 *  over a list how many of its agents finished, whether its join folded, and
 *  the coverage or the selection its reducer reports. An empty list reads as
 *  zero targets with no fraction, and a phase whose list has not expanded
 *  says that it waits for its items. A run whose coverage is incomplete keeps
 *  its completed status; this line names the coverage beside it. Bound and
 *  stuck read as failed because the repeat stopped without establishing that
 *  its work was complete. */
export function workflowSummaryParts(progress: WorkflowProgress): readonly SummaryPart[] {
  const parts: SummaryPart[] = [{ text: `${progress.done}/${progress.total} done`, tone: progress.total > 0 && progress.done === progress.total ? "done" : "plain" }]
  if (progress.failed > 0) parts.push({ text: `, ${progress.failed} failed`, tone: "failed" })
  if (progress.running > 1) parts.push({ text: `, ${progress.running} running`, tone: "plain" })
  for (const list of progress.lists) parts.push(SUMMARY_SEPARATOR, ...listSummary(list))
  for (const { state } of progress.loops) parts.push(SUMMARY_SEPARATOR, {
    text: `round ${state.iteration} of at most ${state.maxIterations}${state.outcome === undefined ? "" : ` · ${loopOutcomeText(state.iteration, state.outcome)}`}`,
    tone: state.outcome === undefined ? "plain" : state.outcome === "dry" ? "done" : "failed",
  })
  return parts
}

/** Repeat decisions use the same words in aggregate lines and join lines. */
export function loopOutcomeText(iteration: number, outcome: NonNullable<WorkflowTreeLoop["outcome"]>): string {
  return outcome === "bound" ? `max ${roundCount(iteration)}` : outcome
}

export function roundCount(rounds: number): string {
  return `${rounds} ${rounds === 1 ? "round" : "rounds"}`
}

/** Where a decided round leads. Open rounds have no target yet. */
export function roundTarget({ number, outcome }: WorkflowTreeRound): string | undefined {
  if (outcome === undefined) return undefined
  return ` → ${outcome === "next" ? `round ${number + 1}` : loopOutcomeText(number, outcome)}`
}

function listSummary(list: WorkflowListProgress): readonly SummaryPart[] {
  const join = list.join
  if (join === undefined) {
    return [{ text: `${list.label}: ${list.disposition === "skipped" ? "skipped" : "waiting for its items"}`, tone: "muted" }]
  }
  const parts: SummaryPart[] = join.slots === 0
    ? [{ text: `${list.label}: 0 targets`, tone: "plain" }]
    : [{ text: `${list.label}: ${join.completed + join.failed}/${join.slots} agents`, tone: join.completed + join.failed === join.slots ? "done" : "plain" }]
  if (join.failed > 0) parts.push({ text: `, ${join.failed} failed`, tone: "failed" })
  if (join.missing > 0) parts.push({ text: `, ${join.missing} missing`, tone: "failed" })
  parts.push({ text: join.state === "settled" ? ", joined" : ", join pending", tone: "muted" })
  const coverage = join.coverage
  if (coverage !== undefined && coverage.status !== "empty") parts.push({ text: `, ${coverageLabel(coverage)}`, tone: coverageTone(coverage) })
  if (join.selection !== undefined) parts.push({ text: `, ${selectionText(join.selection)}`, tone: "plain" })
  return parts
}

/** What a selecting join kept and dropped, in the words every client shows:
 *  `kept 7, dropped 3` for a dedupe or a top join, and `passed 2 of 3` for
 *  the verdicts of a quorum join. A join reports what it dropped as well as
 *  what it kept, so a reader never takes the kept entries for all of them. */
export function selectionText(selection: WorkflowTreeSelection): string {
  return selection.verb === "passed"
    ? `passed ${selection.kept} of ${selection.kept + selection.dropped}`
    : `kept ${selection.kept}, dropped ${selection.dropped}`
}

/** The coverage that a join's reducer reports, in the words every client
 *  shows: how many required targets the survey reached out of all of them,
 *  and how many it did not reach, such as `required 7 of 9, 2 unsurveyed`.
 *  It names no percentage and never says full, so an empty or incomplete
 *  survey cannot read as complete; an empty one reads `0 targets`, and one
 *  of supporting targets alone reads `no required targets`. */
export function coverageText(coverage: WorkflowTreeCoverage): string {
  if (coverage.status === "empty") return "0 targets"
  if (coverage.required.total === 0) return "no required targets"
  const unsurveyed = coverage.unsurveyed.length
  return `required ${coverage.required.surveyed} of ${coverage.required.total}${unsurveyed > 0 ? `, ${unsurveyed} unsurveyed` : ""}`
}

/** The coverage as a phrase that stands beside other counts. */
function coverageLabel(coverage: WorkflowTreeCoverage): string {
  return `coverage ${coverageText(coverage)}`
}

/** How a client emphasizes a coverage: as done only when the survey reached
 *  every required target, and as a failure while a required target is
 *  unsurveyed. An empty survey is neither. */
export function coverageTone(coverage: WorkflowTreeCoverage): SummaryPart["tone"] {
  return coverage.status === "full" ? "done" : coverage.status === "partial" ? "failed" : "plain"
}

/** The coverage of a phase of a card, or undefined for a
 *  phase whose join reports none or reports an empty survey, which its count already
 *  reads as zero targets. */
export function coveragePart(join: WorkflowTreeJoin | undefined): SummaryPart | undefined {
  const coverage = join?.coverage
  return coverage === undefined || coverage.status === "empty" ? undefined : { text: coverageLabel(coverage), tone: coverageTone(coverage) }
}

/** The coverage that each join reports, in the words every client
 *  shows, such as `coverage required 7 of 9, 2 unsurveyed`. Empty when no
 *  join reports coverage or every survey was empty. */
export function workflowCoverage(progress: Pick<WorkflowProgress, "lists">): readonly string[] {
  return progress.lists.flatMap(({ join }) => coveragePart(join)?.text ?? [])
}

/** The aggregate count, such as `12/85 done, 1 failed, 3 running`, and the
 *  coverage that each join reports: what a parent chat's compact workflow
 *  card adds. It names how many agents run only when several run at once. A completed run with incomplete coverage names it here. */
export function workflowProgressCount(progress: Pick<WorkflowProgress, "done" | "total" | "failed" | "running" | "lists">): string {
  return [`${progress.done}/${progress.total} done${progress.failed > 0 ? `, ${progress.failed} failed` : ""}${progress.running > 1 ? `, ${progress.running} running` : ""}`, ...workflowCoverage(progress)].join(" · ")
}

/** The summary line as plain text, for a reader that does not color it. */
export function workflowSummaryText(progress: WorkflowProgress): string {
  return workflowSummaryParts(progress).map(({ text }) => text).join("")
}
