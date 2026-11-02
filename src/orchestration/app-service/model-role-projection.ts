import { AGENT_ROLE_IDS, AUX_ROLE_IDS, DEFAULT_ROLES, ROLE_GROUP_ORDER, TOP_LEVEL_ROLE_IDS, type RoleId, type RoleMetadata } from "../config/roles.js"
import type { RuntimeModelRole } from "../../protocol/model-role-protocol-types.js"
import type { FirstPartyModuleComposition } from "../modules.js"

/** Projects roles available in the current module selection into client settings. Config retains every registered role. */
export function publishedModelRoles(composition: FirstPartyModuleComposition): readonly RuntimeModelRole[] {
  const ids: readonly RoleId[] = [...TOP_LEVEL_ROLE_IDS, ...AGENT_ROLE_IDS, ...AUX_ROLE_IDS]
  const moduleRoles = new Set(composition.contributions.flatMap((contribution) => contribution.domain === "modelRoles" ? contribution.value : []))
  return ids
    .flatMap((id) => {
      const meta: RoleMetadata | undefined = DEFAULT_ROLES[id]
      // A role id with no metadata is one this build does not describe. It is
      // still assignable, but a client cannot present it, so it is left out
      // rather than shown with an invented label.
      if (!meta) return []
      if (meta.moduleOwned && !moduleRoles.has(id)) return []
      return [{ id, label: meta.label, group: meta.group, order: meta.order, description: meta.description }]
    })
    .toSorted((left, right) => ROLE_GROUP_ORDER.indexOf(left.group) - ROLE_GROUP_ORDER.indexOf(right.group) || left.order - right.order)
}
