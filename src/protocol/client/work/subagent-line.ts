import { isAgentInFlight, type AgentGroupBlock, type WorkflowAgentState } from "../../../infra/substrate/events/output-blocks.js"
import type { RoleAssignmentView } from "../../auth/role-protocol-types.js"
import { agentGroupInitializing, agentGroupModelLabel } from "./agent-group-summary.js"
import { formatElapsed } from "../format.js"
import { activeTimeMs } from "./session-time.js"
import { runStatusLabel, type ChildCardStatus } from "./session-controls.js"
import { workflowAgentDetail, type WorkflowAgentDetail, type WorkflowCardHeaderPart } from "./workflow/workflow-card.js"
import { workflowAgentGlyph } from "./workflow/workflow-outline.js"

export interface SubagentLine {
  readonly state: WorkflowAgentState | "partial"
  readonly glyph: string
  readonly tone: "running" | "done" | "warning" | "failed" | "muted"
  readonly detail?: WorkflowAgentDetail
  readonly failureDetail?: string
  /** The elapsed time for the header or the web client's row time. */
  readonly time: string
}

/** The server-projected subagent as one workflow-style agent line. No child
 *  tool selection or clock origin is invented by a client. */
export function subagentLine(block: AgentGroupBlock, child: ChildCardStatus | undefined, now: number): SubagentLine {
  const inFlight = isAgentInFlight(block.status)
  const activeMs = activeTimeMs(block.duration ?? 0, inFlight ? block.activeStartedAt : undefined, now)
  const time = inFlight || activeMs > 0 ? formatElapsed(activeMs) : ""
  let state: SubagentLine["state"]
  let detail: WorkflowAgentDetail | undefined
  let tone: SubagentLine["tone"]
  switch (block.status) {
    case "pending":
    case "active":
      state = agentGroupInitializing(block) ? "waiting" : "running"
      tone = state === "waiting" ? "muted" : child?.waitingOn !== undefined ? "warning" : "running"
      detail = state === "waiting" ? undefined : child?.waitingOn !== undefined
        ? { kind: "state", text: child.waitingOn }
        : workflowAgentDetail({ state, runtimeActivity: child?.activity, ...(block.activity === undefined ? {} : { activity: block.activity }) }, undefined)
      break
    case "queued":
      state = "queued"
      tone = "muted"
      break
    case "completed":
      state = "done"
      tone = "done"
      detail = workflowAgentDetail({ state, ...(block.summary === undefined ? {} : { detail: block.summary }) }, undefined)
      break
    case "partial":
      state = "partial"
      tone = "warning"
      detail = { kind: "state", text: ["Partial", block.summary].filter(Boolean).join(": ") }
      break
    case "error":
      state = "failed"
      tone = "failed"
      detail = workflowAgentDetail({ state, detail: block.failure.message }, undefined)
      break
    case "paused":
    case "interrupted":
      state = "parked"
      tone = "warning"
      detail = workflowAgentDetail({ state }, block.status === "paused" && block.pausedBy === "person" ? "Interrupted by you" : runStatusLabel(block))
      break
    case "stopped":
    case "cancelled":
      state = "skipped"
      tone = "muted"
      detail = workflowAgentDetail({ state, detail: runStatusLabel(block) }, undefined)
      break
  }
  return {
    state, tone, glyph: state === "partial" ? "◐" : workflowAgentGlyph(state), time,
    ...(detail === undefined ? {} : { detail }),
    ...(block.status === "error" && block.failure.detail !== undefined ? { failureDetail: block.failure.detail } : {}),
  }
}

export interface SubagentHeaderPart extends WorkflowCardHeaderPart {
  readonly kind: "persona" | "goal" | "model" | "time" | "operations"
  /** A client drops the lowest rank first until the header fits. */
  readonly rank: number
}

/** Header order and shrink priority. Drop finite ranks lowest first, then
 *  cut the goal. Persona, model, optional elapsed time, and the caller's controls never drop. */
export function subagentHeaderParts(block: AgentGroupBlock, model: string | undefined = block.model, time?: string): readonly SubagentHeaderPart[] {
  const parts: SubagentHeaderPart[] = [{ kind: "persona", text: block.label, tone: "plain", rank: Infinity }]
  const goal = agentGroupInitializing(block) ? "Initializing..." : block.description !== block.label ? block.description : ""
  if (goal) parts.push({ kind: "goal", text: goal, tone: "muted", rank: 2 })
  if (model) parts.push({ kind: "model", text: model, tone: "muted", rank: Infinity })
  if (time) parts.push({ kind: "time", text: time, tone: "muted", rank: Infinity })
  if (block.totalToolCount > 0) parts.push({ kind: "operations", text: `${block.totalToolCount} ${block.totalToolCount === 1 ? "operation" : "operations"}`, tone: "muted", rank: 1 })
  return parts
}

/** What a subagent card shows: whether it still initializes, its agent line,
 *  and its header parts. */
export interface SubagentCard {
  /** A card that initializes shows only its persona and goal, and offers no
   *  open or control. */
  readonly initializing: boolean
  readonly line: SubagentLine
  readonly header: readonly SubagentHeaderPart[]
}

/** The card of one subagent run. The model is the serving selection that the
 *  child's role reading names, else the launch label. `timedHeader` puts the
 *  line's elapsed time into the header, for a client that shows no other
 *  time beside the card. */
export function subagentCard(block: AgentGroupBlock, reading: { readonly roles: RoleAssignmentView | undefined; readonly child: ChildCardStatus | undefined; readonly now: number; readonly timedHeader?: boolean }): SubagentCard {
  const served = { ...block, model: agentGroupModelLabel(block.model, reading.roles) }
  const initializing = agentGroupInitializing(served)
  const line = subagentLine(served, reading.child, reading.now)
  const header = initializing
    ? subagentHeaderParts({ ...block, model: "" }).filter(({ kind }) => kind === "persona" || kind === "goal")
    : subagentHeaderParts(served, served.model, reading.timedHeader === true ? line.time : undefined)
  return { initializing, line, header }
}
