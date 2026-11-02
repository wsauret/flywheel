/**
 * The one composition of an agent row's header: a subagent run or a workflow.
 *
 * A row must say what ran, what it was asked to do, and what it cost, or it
 * reads as an unexplained tool. A subagent row also names its model. A
 * workflow row names none, because each agent can run on a different model;
 * its glyph marks it as a workflow instead. Every client joins these parts
 * with " · " after the row's label; keeping the selection and order here
 * means the TUI and an editor client describe the same run the same way.
 */

import { formatElapsed, formatTokens } from "./format.js"
import { activeTimeMs } from "./session-time.js"
import { WORKFLOW_GLYPH } from "./glyphs.js"
import { type AgentGroupBlock, type ContainerKind, isAgentInFlight } from "../../infra/output-blocks.js"
import { sessionServingLabel, type RoleAssignmentView } from "../role-protocol-types.js"

export interface AgentGroupSummaryInput {
  readonly label: string
  readonly description: string
  readonly containerKind: ContainerKind
  readonly totalToolCount: number
  readonly model?: string | undefined
  readonly totalTokens?: number | undefined
  readonly duration?: number | undefined
  readonly activeStartedAt?: number | undefined
}

/** The glyph a client renders before the row's label, if the kind has one. */
export function agentGroupGlyph(containerKind: ContainerKind): string | undefined {
  return containerKind === "workflow" ? WORKFLOW_GLYPH : undefined
}

/** A card keeps its launch label until the child's reading names a serving selection. */
export function agentGroupModelLabel(launchLabel: string | undefined, roles: RoleAssignmentView | undefined): string | undefined {
  return sessionServingLabel(roles) ?? launchLabel
}

function pluralizeOperations(n: number): string {
  return `${n} operation${n === 1 ? "" : "s"}`
}

/** The goal line: the run's description, unless it merely repeats the label. */
function agentGroupGoal(block: Pick<AgentGroupSummaryInput, "label" | "description">): string {
  if (!block.description) return ""
  if (block.description === block.label) return ""
  return block.description
}

/** Whether a row stands for a run that is still going: a client marks it
 *  live and describes it with `agentGroupActiveParts`. */
export function agentGroupInFlight(block: Pick<AgentGroupBlock, "status">): boolean {
  return isAgentInFlight(block.status)
}

/** A new subagent reveals its card when the child's projection and selected
 * model are available. Resumed cards retain their recorded active time.
 * Historical active inline cards have no linked child's clock. */
export function agentGroupInitializing(block: Pick<AgentGroupBlock, "containerKind" | "status" | "model" | "activeStartedAt" | "duration" | "linkUri">): boolean {
  return block.containerKind === "subagent" && block.status !== "queued" && agentGroupInFlight(block)
    && !(block.status === "active" && block.linkUri === undefined)
    && (!block.model || (block.activeStartedAt === undefined && !(block.duration !== undefined && block.duration > 0)))
}

/** Whether a row's active time grows now: the run is in flight and its
 *  child's clock runs. A client ticks the row only then. */
export function agentGroupClockRuns(block: Pick<AgentGroupBlock, "status" | "activeStartedAt">): boolean {
  return agentGroupInFlight(block) && block.activeStartedAt !== undefined
}

/** Summary parts while the run is still going: goal, a subagent's model,
 *  operations, tokens, and the active time at `now` once it is at least a
 *  second. */
export function agentGroupActiveParts(block: AgentGroupSummaryInput, now: number): string[] {
  // A row with no open episode states only the settled time, so it never
  // counts the time since launch and never goes down when the run settles.
  const elapsedMs = activeTimeMs(block.duration ?? 0, block.activeStartedAt, now)
  const parts: string[] = []
  const goal = agentGroupGoal(block)
  if (goal) parts.push(goal)
  if (block.containerKind === "subagent" && block.model) parts.push(block.model)
  if (block.totalToolCount > 0) parts.push(pluralizeOperations(block.totalToolCount))
  if (block.totalTokens != null) parts.push(`${formatTokens(block.totalTokens)} tokens`)
  if (elapsedMs >= 1000) parts.push(formatElapsed(elapsedMs))
  return parts
}
