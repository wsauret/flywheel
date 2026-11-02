/**
 * The words every client and the refused Resume use for a workflow whose
 * definition changed after it started, so the terminal, the web client, and
 * the runtime's refusal say the same thing (PI-AGENT-015). The workflow VM
 * builds its refusal from this module, so it stays free of client transport.
 */

import type { WorkflowDefinitionChange, WorkflowDefinitionDrift } from "../app-service-types.js"

/** How many names of one kind the drift explanation shows before it counts
 *  the rest, so a large drift still reads as one short paragraph. */
const DRIFT_NAMES_SHOWN = 3

/** Why the workflow cannot continue and what the person can do. Each changed
 *  part is named once, by kind and name. Resume checks the definition again,
 *  so a person who restores the changed parts continues the run with it; a
 *  new workflow always works. */
export function workflowDriftExplanation(drift: WorkflowDefinitionDrift): string {
  const parts = [
    ...(drift.changes.some(({ component, id }) => (component === "workflow" || component === "graph") && id === undefined) ? ["the order of its phases"] : []),
    ...namedParts("the agents of phase", "the agents of phases", componentIds(drift.changes, "graph")),
    ...namedParts("the settings of agent", "the settings of agents", agentIds(drift.changes, "policy")),
    ...namedParts("the instructions of agent", "the instructions of agents", agentIds(drift.changes, "content")),
    ...namedParts("the output of agent", "the outputs of agents", agentIds(drift.changes, "output")),
    ...(drift.changes.some(({ component, aspect, id }) => component === "agent" && aspect === "output" && id === undefined) ? ["a shared agent output"] : []),
    ...namedParts("skill", "skills", componentIds(drift.changes, "skill")),
    ...namedParts("persona", "personas", componentIds(drift.changes, "persona")),
    ...(drift.changes.some(({ component }) => component === "version") ? ["the workflow engine"] : []),
  ]
  return [
    `The ${drift.workflowDefinitionId} workflow cannot continue because its definition changed after it started.`,
    ...(parts.length > 0 ? [`These parts changed: ${parts.join("; ")}.`, "Restore them, then press Resume, or start a new workflow."] : ["Restore its definition, then press Resume, or start a new workflow."]),
  ].join(" ")
}

function componentIds(changes: readonly WorkflowDefinitionChange[], component: WorkflowDefinitionChange["component"]): readonly string[] {
  return [...new Set(changes.flatMap((change) => change.component === component && change.id !== undefined ? [change.id] : []))]
}

function agentIds(changes: readonly WorkflowDefinitionChange[], aspect: NonNullable<WorkflowDefinitionChange["aspect"]>): readonly string[] {
  return componentIds(changes.filter((change) => change.aspect === aspect), "agent")
}

function namedParts(one: string, many: string, ids: readonly string[]): readonly string[] {
  if (ids.length === 0) return []
  const shown = ids.slice(0, DRIFT_NAMES_SHOWN)
  const more = ids.length - shown.length
  const names = more > 0
    ? `${shown.join(", ")}, and ${more} more`
    : shown.length <= 2 ? shown.join(" and ") : `${shown.slice(0, -1).join(", ")}, and ${shown.at(-1)}`
  return [`${ids.length === 1 ? one : many} ${names}`]
}
