import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import { sessionServingSelection, type RuntimeRoleAssignmentEntry, type RoleAssignmentView } from "../../protocol/role-protocol-types.js"
import { isModelTierReference } from "../../protocol/model-tier-reference.js"

/** Tiers are config vocabulary, never display vocabulary. An entry whose model
 *  is still a tier ref (resolved without a provider listing) counts as absent,
 *  so the label falls through to a resolved source or renders nothing. */
function resolvedEntry(entry: RuntimeRoleAssignmentEntry | undefined): RuntimeRoleAssignmentEntry | undefined {
  return entry && isResolved(entry) ? entry : undefined
}

function isResolved(entry: RuntimeRoleAssignmentEntry): boolean {
  return !isModelTierReference(entry.model)
}

function formatChatLabel(chatEntry: RuntimeRoleAssignmentEntry | undefined, globalDefaultEntry: RuntimeChatDefault): string | undefined {
  const chat = resolvedEntry(chatEntry)
  const globalDefaultChat = globalDefaultEntry.kind === "model" ? globalDefaultEntry : undefined
  if (!chat) {
    if (globalDefaultEntry.kind === "pending") return undefined
    return globalDefaultChat ? `${globalDefaultChat.model} ${globalDefaultChat.effort}` : "not configured"
  }

  const label = `${chat.model} ${chat.effort}`
  const diverges = !!globalDefaultChat && (
    globalDefaultChat.model !== chat.model
    || globalDefaultChat.effort !== chat.effort
  )
  return diverges ? `${label}*` : label
}

/** A foreground chat compares its runtime selection with the new-chat default. */
export function sessionModelLabel(roles: RoleAssignmentView | undefined, globalDefaultChat: RuntimeChatDefault): string | undefined {
  return formatChatLabel(sessionServingSelection(roles), globalDefaultChat)
}
