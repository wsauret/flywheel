import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import type { RuntimeTool } from "../../agent-runtime/tools/types.js"
import type { SessionMessaging } from "../../session/session-messaging.js"
import { createChatProgressTool } from "./chat-progress.js"
import { createRouteRequestTool } from "./route-request.js"
import { leadService, type LeadRole } from "./service.js"

/** The lead's per-runner runtime: what the runner's chat is to the lead, and the lead's two tools for that chat. */
export interface LeadRuntime {
  role(): LeadRole | undefined
  readonly chatProgress: RuntimeTool
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
    chatProgress: createChatProgressTool((chat) => service.progress(chat)),
    routeRequest: (sessions) => createRouteRequestTool((input) => service.route(input), sessions),
  }
}
