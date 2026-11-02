import { briefAtRoleId, briefPersonaRoleId, briefRoleId, type FixedBriefFields } from "./brief-role-id.js"
import type { ProviderRequestOptions } from "../infra/llm/provider-options.js"

interface ServingSeat {
  readonly briefId: string
  readonly definitionId: string
  /** Exact persona role followed by its explicit parent roles. */
  readonly personaRoles?: readonly string[]
  readonly fixedFields?: FixedBriefFields
}

interface ServingSelection {
  readonly model?: string
  readonly effort?: string
  readonly providerOptions?: ProviderRequestOptions
  readonly setting?: { readonly fixedEffort?: string }
  readonly settingScope?: "session" | "profile"
}

/** One record's request selection and editing admission. The selection retains
 * every field supplied by its reader, including server-owned provider options. */
interface ActiveServingSeat<Selection> {
  readonly recordSeat: string
  readonly selection: Selection | undefined
  readonly fixedFields?: FixedBriefFields
}

/** Select a record, then its brief-scoped and global persona seats, then its
 * brief and Workflow Agent seats. Readers normalize availability before entry.
 * A client can skip a selection it cannot display without reconstructing it. */
export function activeServingSeat<Selection extends ServingSelection>(
  seat: ServingSeat,
  read: (roleId: string) => Selection | undefined,
  usable: (selection: Selection) => boolean = () => true,
): ActiveServingSeat<Selection> {
  const recordSeat = briefAtRoleId(seat.briefId, seat.definitionId)
  const accepted = (roleId: string) => {
    const selection = read(roleId)
    return selection !== undefined && usable(selection) ? selection : undefined
  }
  const record = accepted(recordSeat)
  const personaRoles = seat.personaRoles ?? []
  const persona = [...personaRoles.map((role) => briefPersonaRoleId(seat.briefId, role)), ...personaRoles]
    .map(accepted).find((selection) => selection !== undefined)
  // An independently authored effort fixes only that field. The persona still
  // supplies its model and options unless a session setting chose a whole pair.
  const selection = record && persona && record.setting?.fixedEffort !== undefined && record.settingScope !== "session"
    ? { ...persona, effort: record.effort, setting: { ...persona.setting, fixedEffort: record.setting.fixedEffort } }
    : record ?? persona ?? accepted(briefRoleId(seat.briefId)) ?? accepted("workflow-agent")
  return { recordSeat, selection, ...(seat.fixedFields === undefined ? {} : { fixedFields: seat.fixedFields }) }
}

/** Explain a refused edit of authored fields. A reset changes both fields. */
export function servingSeatFieldRefusal(fields: FixedBriefFields, change: { readonly model: boolean; readonly effort: boolean }): string | undefined {
  if (fields === "both") return "The workflow file or the launch sets the model and the effort of this agent."
  if (change.model && fields !== "effort") return "The workflow file or the launch sets the model of this agent."
  if (change.effort && fields !== "model") return "The workflow file or the launch sets the effort of this agent."
  return undefined
}
