import type { AgentGroupBlock } from "../../infra/output-blocks.js"
import { agentGroupInFlight } from "./agent-group-summary.js"

export type WorkflowSurface =
  | { readonly kind: "page" }
  | { readonly kind: "card"; readonly status: AgentGroupBlock["status"]; readonly hasChoices: boolean; readonly agentModels?: boolean }

/** Which workflow domains a surface reads. */
export interface WorkflowSurfaceReads {
  readonly view: boolean
  readonly detail: boolean
  readonly live: boolean
}

/** Read demand is shared by terminal, browser, and phone surfaces. */
export function workflowSurfaceReads(surface: WorkflowSurface): WorkflowSurfaceReads {
  if (surface.kind === "page") return { view: true, detail: true, live: true }
  const follows = agentGroupInFlight(surface) || surface.hasChoices
  // Failed agents can resume. Completed runs and parent-stopped calls cannot.
  const detail = surface.status !== "completed" && surface.status !== "stopped" && surface.status !== "cancelled"
  return { view: follows || surface.agentModels === true, detail, live: follows }
}
