import type { ModelAssignmentRow } from "../../../src/protocol/model-assignment-protocol-types.js"

/** The role browser's rows, as pure projections of what the runtime reports.
 *
 *  Flywheel does not run one model. It assigns a model and an effort per role:
 *  the chat that answers you, an agent of a workflow, the
 *  reviewer, the explorer, the implementer, the advisor, the background
 *  learner. The roles come from the runtime rather than from a list restated
 *  here: the registry that owns them sits behind imports that reach Bun, and a
 *  client cannot read it. */

export type ModelScope = { readonly kind: "defaults" } | { readonly kind: "session"; readonly sessionId: string }

export interface RoleDescriptor {
  readonly id: string
  readonly label: string
  readonly description: string
  readonly group: string
}

/** One seat the browser can change. */
export interface SeatRow {
  readonly roleId: string
  readonly label: string
  readonly detail?: string
  /** The model and effort in force, or "not assigned". */
  readonly value: string
  readonly savedModel?: string
}

export interface SeatGroup {
  readonly title: string
  readonly rows: readonly SeatRow[]
}

function groupLabel(group: string): string {
  switch (group) {
    case "core": return "Core"
    case "agents": return "Agents"
    case "background": return "Background"
    default: return group
  }
}

/** `model · effort`, with the inheritance glyph only when both the model and
 *  the effort match the inherited pair (PI-MODEL-008). */
function modelAssignmentDescription(row: { readonly model: string; readonly effort: string; readonly matchesInheritedPair: boolean }): string {
  return `${row.model} · ${row.effort}${row.matchesInheritedPair ? " ↳" : ""}`
}

function describeSeat(assigned: ModelAssignmentRow | undefined): string {
  return assigned === undefined ? "not assigned" : modelAssignmentDescription(assigned)
}

/** The roles in the runtime's order, grouped under the runtime's group names. */
export function roleGroups(roles: readonly RoleDescriptor[], assignments: readonly ModelAssignmentRow[]): readonly SeatGroup[] {
  const groups: SeatGroup[] = []
  for (const role of roles) {
    const title = groupLabel(role.group)
    const assigned = assignments.find((row) => row.slot.kind === "role" && row.slot.roleId === role.id)
    const row: SeatRow = {
      roleId: role.id, label: role.label,
      detail: [role.description, assigned?.savedModel ? `Saved: ${assigned.savedModel}` : undefined].filter(Boolean).join(" · "),
      value: describeSeat(assigned), savedModel: assigned?.savedModel,
    }
    const last = groups[groups.length - 1]
    if (last !== undefined && last.title === title) groups[groups.length - 1] = { title, rows: [...last.rows, row] }
    else groups.push({ title, rows: [row] })
  }
  return groups
}

