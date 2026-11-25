/**
 * What every client reads alike about an agent row: a subagent run or a
 * workflow. A workflow row names no model, because each agent can run on a
 * different model; its glyph marks it as a workflow instead. The parts of a
 * subagent row's header come from `subagentHeaderParts`.
 */

import { WORKFLOW_GLYPH } from "./glyphs.js"
import { type AgentGroupBlock, type ContainerKind, isAgentInFlight } from "../../../infra/substrate/events/output-blocks.js"
import { sessionServingLabel, type RoleAssignmentView } from "../../auth/role-protocol-types.js"

/** The glyph a client renders before the row's label, if the kind has one. */
export function agentGroupGlyph(containerKind: ContainerKind): string | undefined {
  return containerKind === "workflow" ? WORKFLOW_GLYPH : undefined
}

/** A card keeps its launch label until the child's reading names a serving selection. */
export function agentGroupModelLabel(launchLabel: string | undefined, roles: RoleAssignmentView | undefined): string | undefined {
  return sessionServingLabel(roles) ?? launchLabel
}

/** Whether a row stands for a run that is still going: a client marks it live. */
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
