import { deslugify } from "../../infra/canonical-name.js";
import type { AttemptRow } from "../../workflows/view/types.js";
import { AGENT_ROLE_IDS, AUX_ROLE_IDS, DEFAULT_ROLES, parentRoleId, type ResolvedRole, type ResolvedRoles, type RoleId, TOP_LEVEL_ROLE_IDS } from "./roles.js";
import { parseBriefRoleId, briefPersonaRoleId } from "../../protocol/brief-role-id.js";
import { activeServingSeat } from "../../protocol/active-serving-seat.js";
import type { ModelSelectionSlot } from "../../protocol/model-assignment-protocol-types.js";

/** The model selection slot one role occupies. */
export function roleSlot(roleId: RoleId): ModelSelectionSlot {
  return { kind: "role", roleId }
}

/** The persona roles of each agent record of a run, by record id. */
export type AgentPersonaRoles = ReadonlyMap<string, { readonly roles: readonly string[] }>;

export interface BriefScope {
  /** The brief that an agent of a workflow runs, the sole model-assignment
   *  identity of its seats. */
  briefId: string;
}

const AGENT_PARENT_ROLE_IDS: readonly RoleId[] = Array.from(new Set(AGENT_ROLE_IDS.flatMap((roleId) => {
  const parent = parentRoleId(roleId);
  return parent ? [parent] : [];
})));
const MODEL_SELECTION_ROLE_IDS: readonly RoleId[] = [...TOP_LEVEL_ROLE_IDS, ...AUX_ROLE_IDS, ...AGENT_PARENT_ROLE_IDS, ...AGENT_ROLE_IDS];

export function defaultRoleSlots(): readonly ModelSelectionSlot[] {
  return MODEL_SELECTION_ROLE_IDS.map(roleSlot);
}

function requireResolvedRole(roles: ResolvedRoles, roleId: RoleId): ResolvedRole {
  const role = roles.get(roleId);
  if (!role) throw new Error(`Resolved role missing: ${roleId}`);
  return role;
}

/** The model and effort of one agent of a workflow: its record seat, which
 *  holds the pair that its file or launch fixed; then, for an agent that
 *  runs as a persona, the seat of that persona under its brief and the
 *  persona's own seats, as a subagent dispatch of the persona reads them
 *  (refer to {@link resolveSubagentRole}); then its brief seat; then the
 *  Workflow Agent. */
export function resolveWorkflowAgentRole(agent: Pick<AttemptRow, "briefId" | "definitionId">, roles: ResolvedRoles, personaRole?: string): ResolvedRole | undefined {
  const parent = personaRole === undefined ? undefined : parentRoleId(personaRole);
  const personaRoles = personaRole === undefined ? [] : [personaRole, ...(parent === undefined ? [] : [parent])];
  return activeServingSeat({ ...agent, personaRoles }, (roleId) => roles.get(roleId)).selection;
}

/** Resolve a subagent persona through exact brief and global subtype seats, then their explicit parent seat. */
export function resolveSubagentRole(agentRole: string, briefScope: BriefScope | undefined, roles: ResolvedRoles): ResolvedRole | undefined {
  const parent = parentRoleId(agentRole);
  return (briefScope ? roles.get(briefPersonaRoleId(briefScope.briefId, agentRole)) : undefined)
    ?? (briefScope && parent ? roles.get(briefPersonaRoleId(briefScope.briefId, parent)) : undefined)
    ?? roles.get(agentRole)
    ?? (parent ? roles.get(parent) : undefined);
}

/** The seat a child's runner reads and its selection. A session Chat edit
 *  takes over a persona child; a general child always uses Chat. Otherwise a
 *  persona child serves from its own role, and a session edit of that role
 *  is the seat it reads first: a child's settings never hold a brief seat. */
export function childServingSeat(roleId: string, roles: ResolvedRoles, briefScope?: BriefScope): { readonly roleId: string; readonly selection: ResolvedRole | undefined } {
  const chat = roles.get("chat");
  return roleId === "chat" || chat?.settingScope === "session"
    ? { roleId: "chat", selection: chat }
    : { roleId, selection: resolveSubagentRole(roleId, briefScope, roles) };
}

/** The selection one seat serves. A record seat reads its record's persona
 *  seats before its brief seat, as its agent's runner does; `personas` names
 *  each record's persona roles, by record id. */
export function resolveSlotRole(slot: ModelSelectionSlot, roles: ResolvedRoles, personas?: AgentPersonaRoles): ResolvedRole {
  const selector = parseBriefRoleId(slot.roleId);
  const agentRole = selector?.personaRole;
  if (agentRole !== undefined) {
    const parent = parentRoleId(agentRole);
    const briefParent = selector && parent ? briefPersonaRoleId(selector.briefId, parent) : undefined;
    return roles.get(slot.roleId) ?? (briefParent ? roles.get(briefParent) : undefined) ?? roles.get(agentRole) ?? (parent ? roles.get(parent) : undefined) ?? requireResolvedRole(roles, "workflow-agent");
  }
  if (selector?.definitionId !== undefined) {
    return activeServingSeat({ ...selector, personaRoles: personas?.get(selector.definitionId)?.roles }, (roleId) => roles.get(roleId)).selection
      ?? requireResolvedRole(roles, "workflow-agent");
  }
  if (selector) return roles.get(slot.roleId) ?? requireResolvedRole(roles, "workflow-agent");
  const parent = parentRoleId(slot.roleId);
  return roles.get(slot.roleId) ?? (parent ? roles.get(parent) : undefined) ?? requireResolvedRole(roles, slot.roleId);
}


export function slotLabel(slot: ModelSelectionSlot): string {
  const meta = DEFAULT_ROLES[slot.roleId];
  if (meta) return meta.label;
  const selector = parseBriefRoleId(slot.roleId);
  if (selector?.personaRole !== undefined) {
    const roleMeta = DEFAULT_ROLES[selector.personaRole];
    return `${deslugify(selector.briefId)} ${roleMeta ? roleMeta.label : deslugify(selector.personaRole)}`;
  }
  if (selector) return `Brief ${selector.briefId}`;
  return slot.roleId;
}

/** One-line explanation of what the slot's role does, shown for the selected
 *  row in the model modal. */
export function slotDescription(slot: ModelSelectionSlot): string {
  const meta = DEFAULT_ROLES[slot.roleId];
  if (meta) return meta.description;
  const selector = parseBriefRoleId(slot.roleId);
  if (selector?.personaRole !== undefined) {
    const roleMeta = DEFAULT_ROLES[selector.personaRole];
    return `Overrides the ${roleMeta ? roleMeta.label : deslugify(selector.personaRole)} model for this brief only.`;
  }
  if (selector) return "The model of the agents that run this brief.";
  return "";
}

export function isBriefSlot(slot: ModelSelectionSlot): boolean {
  return parseBriefRoleId(slot.roleId) !== undefined;
}



export function sameSlot(a: ModelSelectionSlot, b: ModelSelectionSlot): boolean {
  return a.roleId === b.roleId;
}
