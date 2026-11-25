import { isQualifiedSkillId } from "../../infra/learning/skill-id.js"
import { isBriefId, isWorkflowLocalId } from "../../infra/workflow/workflow-identifiers.js"

/** The brief-role-id codec: how the model seat of an agent of a workflow is
 *  addressed.
 *
 *  The seat of a brief is `brief.<briefId>`, so every agent that runs the same
 *  brief shares one seat. One persona that runs under a brief, as a phase
 *  agent's `persona` or as a subagent that the brief dispatches, has the seat
 *  `brief.<briefId>.persona.<role>`. An agent record of a workflow file that
 *  sets its own `model` or `effort` also has a record seat
 *  `brief.<briefId>.at.<definitionId>` (refer to {@link briefAtRoleId}) and
 *  one default seat, which only the launch writes (refer to
 *  {@link briefDefaultRoleId}). Each of these seats has the Workflow Agent as
 *  its parent. Every client uses this codec because two spellings of the
 *  same key silently stop a session from honoring overrides. */

export function briefRoleId(briefId: string): string {
  return `${BRIEF_ROLE_PREFIX}${briefId}`
}

/** Format the seat of one persona under a brief:
 *  brief.<briefId>.persona.<role>. */
export function briefPersonaRoleId(briefId: string, personaRole: string): string {
  return `${BRIEF_ROLE_PREFIX}${briefId}${PERSONA_MARKER}${personaRole}`
}

/** Format the record seat of one agent record:
 *  brief.<briefId>.at.<definitionId>. A session's role view holds it, with
 *  the pair that the record's agents run on, for each record that has a
 *  default seat, and a client opens it as the seat of a running agent. */
export function briefAtRoleId(briefId: string, definitionId: string): string {
  return `${BRIEF_ROLE_PREFIX}${briefId}${AT_MARKER}${definitionId}`
}

/** The fields of one agent record that its workflow file or launch set as
 *  the record's default: both, or only one. */
export type BriefDefaultFields = "both" | "model" | "effort"

/** Format the default seat of one agent record: its record seat, with
 *  `.model` or `.effort` after it when the file set only that field. Its
 *  entry holds the fields that the launch bound for the record. They are the
 *  record's default for the run, and a setting that a person saves for the
 *  agent or its workflow ranks above them. Runs store these ids, so their
 *  spelling never changes. */
export function briefDefaultRoleId(briefId: string, definitionId: string, fields: BriefDefaultFields): string {
  return fields === "both" ? briefAtRoleId(briefId, definitionId) : `${briefAtRoleId(briefId, definitionId)}.${fields}`
}

/** What a `brief.` role id selects: the agents that run the brief `briefId`,
 *  or, when `personaRole` is present, one persona under that brief. When
 *  `definitionId` is present, it selects the agents of that one agent
 *  record, and `defaultFields` names the fields that its default seat holds. A brief id
 *  passes the workflow brief-id codec, so a malformed key is no brief
 *  selector at all rather than a brief selector with a strange id. */
export type BriefRoleSelector =
  | { readonly briefId: string; readonly personaRole?: string; readonly definitionId?: never; readonly defaultFields?: never }
  | { readonly briefId: string; readonly personaRole?: never; readonly definitionId: string; readonly defaultFields: BriefDefaultFields }

const BRIEF_ROLE_PREFIX = "brief."
const PERSONA_MARKER = ".persona."
const AT_MARKER = ".at."
/** Split a record id from the one field that its default seat sets, when it sets one. */
const RECORD = /^([^.]+)(?:\.(model|effort))?$/

export function parseBriefRoleId(roleId: string): BriefRoleSelector | undefined {
  if (!roleId.startsWith(BRIEF_ROLE_PREFIX)) return undefined
  const scoped = roleId.slice(BRIEF_ROLE_PREFIX.length)
  const marker = scoped.indexOf(PERSONA_MARKER)
  if (marker < 0) {
    const at = scoped.lastIndexOf(AT_MARKER)
    const record = at < 0 ? null : RECORD.exec(scoped.slice(at + AT_MARKER.length))
    const definitionId = record?.[1]
    if (definitionId !== undefined && isWorkflowLocalId(definitionId) && isBriefId(scoped.slice(0, at))) {
      const defaultFields = record?.[2] === "model" || record?.[2] === "effort" ? record[2] : "both"
      return { briefId: scoped.slice(0, at), definitionId, defaultFields }
    }
    return isBriefId(scoped) ? { briefId: scoped } : undefined
  }
  const briefId = scoped.slice(0, marker)
  const personaRole = scoped.slice(marker + PERSONA_MARKER.length)
  return isBriefId(briefId) && isQualifiedSkillId(personaRole) ? { briefId, personaRole } : undefined
}

/** The shared Workflow Agent default edits the admitted auth profile; brief seats edit their session. */
export function isProfileModelRole(roleId: string): boolean {
  return roleId === "workflow-agent"
}
