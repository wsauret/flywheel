import type { ModuleServices } from "../infra/module-service.js"
import type { ChatProfile } from "./agent-runtime/types.js"
import type { FirstPartyModuleComposition } from "./modules.js"

/** What a module reads to decide the profile of one chat: the chat's session id and the process services, through
 *  which the module reaches its own state. */
interface ChatProfileInput {
  readonly sessionId: string
  readonly modules: ModuleServices
}

/** A module's declaration of the prompt, the tool names, and the model role of the chats it owns (ARCH-STRUCTURE-045). The module
 *  contributes it as `chatProfiles`, and `profile` answers undefined for a chat that the module does not own. */
export interface ChatProfileContribution {
  readonly profile: (input: ChatProfileInput) => ChatProfile | undefined
}

/** The profile of one chat in `composition`: the answer of the first enabled `chatProfiles` contribution that gives
 *  one, in composition order, or undefined when none does. A disabled module contributes nothing, so the profile
 *  ends at the first request that reads a selection without its owner. */
export function resolveChatProfile(composition: FirstPartyModuleComposition, input: ChatProfileInput): ChatProfile | undefined {
  for (const contribution of composition.contributions) {
    if (contribution.domain !== "chatProfiles") continue
    const profile = contribution.value.profile(input)
    if (profile) return profile
  }
  return undefined
}

/** The model role whose setting the requests of one chat use: its profile's role, or the Chat role of every chat that
 *  no module profiles. */
export function resolveChatRole(composition: FirstPartyModuleComposition, input: ChatProfileInput): string {
  return resolveChatProfile(composition, input)?.role ?? "chat"
}
