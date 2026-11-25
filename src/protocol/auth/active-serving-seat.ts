import { briefAtRoleId, briefPersonaRoleId, briefRoleId } from "./brief-role-id.js"
import type { ProviderRequestOptions } from "../../infra/providers/llm/access/provider-options.js"

interface ServingSeat {
  readonly briefId: string
  readonly definitionId: string
  /** Exact persona role followed by its explicit parent roles. */
  readonly personaRoles?: readonly string[]
}

interface ServingSelection {
  readonly model?: string
  readonly effort?: string
  readonly providerOptions?: ProviderRequestOptions
}

/** One record's request selection. The selection retains every field
 * supplied by its reader, including server-owned provider options. */
interface ActiveServingSeat<Selection> {
  readonly recordSeat: string
  readonly selection: Selection | undefined
}

/** Select a record, then its brief-scoped and global persona seats, then its
 * brief and Workflow Agent seats. A record seat already ranks a person's
 * setting against its workflow's default (refer to `effectiveRoleAssignments`),
 * so it serves whole. Readers normalize availability before entry.
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
  const selection = record ?? persona ?? accepted(briefRoleId(seat.briefId)) ?? accepted("workflow-agent")
  return { recordSeat, selection }
}
