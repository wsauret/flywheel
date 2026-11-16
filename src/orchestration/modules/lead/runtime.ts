import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import type { RuntimeTool } from "../../agent-runtime/tools/types.js"
import type { SessionMessaging } from "../../session/session-messaging.js"
import { createChatProgressTool } from "./chat-progress.js"
import { createFindChatTool } from "./find-chat.js"
import { milestoneMessageUse } from "./prompt.js"
import { createRouteRequestTool } from "./route-request.js"
import { leadService, type LeadRole } from "./service.js"

/** The lead's per-runner runtime: what the runner's chat is to the lead, and the lead's tools for that chat. */
export interface LeadRuntime {
  role(): LeadRole | undefined
  /** The role once the service folded what it heard before this call (`LeadService.settledRole`). */
  settledRole(): Promise<LeadRole | undefined>
  /** The use of `message_session` that the chat has while it is in the shown lead's list, or undefined (PI-LEAD-012). */
  milestoneUse(): Promise<string | undefined>
  readonly chatProgress: RuntimeTool
  readonly findChat: RuntimeTool
  routeRequest(sessions: SessionMessaging): RuntimeTool
}

export const leadRuntime = moduleRuntimeHandle<LeadRuntime>("lead")

/** Builds for a runner of a session while the lead service exists; the role is read again for each request. */
export function createLeadRuntime(services: Pick<ModuleRuntimeServices, "sessionId" | "modules">): LeadRuntime | undefined {
  const service = services.modules.get(leadService)
  const { sessionId } = services
  if (!service || sessionId === undefined) return undefined
  return {
    role: () => service.role(sessionId),
    settledRole: () => service.settledRole(sessionId),
    async milestoneUse() {
      const lead = await service.settledListingLead(sessionId)
      return lead === null ? undefined : milestoneMessageUse(lead)
    },
    chatProgress: createChatProgressTool((chat) => service.progress(chat)),
    findChat: createFindChatTool((query) => service.findChats(query)),
    routeRequest: (sessions) => createRouteRequestTool((input) => service.route(input), sessions),
  }
}
