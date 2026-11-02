import type { RuntimeSessionCursorIdentity, RuntimeSessionViewsResult, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"
import type { ModelSelectionSlot } from "./model-assignment-protocol-types.js"

export interface RuntimeRoleAssignmentEntry {
  readonly model: string
  readonly effort: string
}

export interface RuntimeRoleAssignments {
  readonly [role: string]: RuntimeRoleAssignmentEntry
}

/** The next-request selection and session-local edit target, resolved by the runtime. */
export interface RuntimeServingSeat {
  readonly slot: ModelSelectionSlot
  readonly selection?: RuntimeRoleAssignmentEntry
}

export interface RoleAssignmentView {
  readonly assignments: RuntimeRoleAssignments
  readonly serving?: RuntimeServingSeat
}

/** Read the runtime's serving selection without repeating request precedence. */
export function sessionServingSelection(view: RoleAssignmentView | undefined): RuntimeRoleAssignmentEntry | undefined {
  return view?.serving?.selection
}

export function sessionServingLabel(view: RoleAssignmentView | undefined): string | undefined {
  const selection = sessionServingSelection(view)
  return selection === undefined ? undefined : `${selection.model} ${selection.effort}`
}

export type RuntimeRoleSnapshotResult = RuntimeSessionViewsResult<RoleAssignmentView>

export type RolePatchPayload =
  | { readonly kind: "roles.updated"; readonly roles: RoleAssignmentView }
  | { readonly kind: "roles.removed" }

export function rolesCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "roles" } {
  return { scope: "session", domain: "roles", sessionId }
}

export function isRolePayload(payload: RuntimeUiPatchPayload): payload is RolePatchPayload {
  return payload.kind === "roles.updated" || payload.kind === "roles.removed"
}
