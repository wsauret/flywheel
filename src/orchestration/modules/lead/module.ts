import { LEAD_COMMAND, LEAD_COMMAND_NAME, leadProtocol } from "../../../protocol/modules/lead.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { CHAT_PROGRESS_TOOL_NAME } from "./chat-progress.js"
import { LEAD_PROMPT, STARTED_CHAT_PROMPT } from "./prompt.js"
import { createLeadProtocol } from "./protocol.js"
import { ROUTE_REQUEST_TOOL_NAME } from "./route-request.js"
import { createLeadRuntime, leadRuntime } from "./runtime.js"
import { createLeadService, leadService } from "./service.js"
import { chatProgressDeclaration, LEAD_TOOLS, routeRequestDeclaration } from "./tools.js"

/** The lead (PI-LEAD-001 to PI-LEAD-008): one always-on chat for each project
 *  that routes the person's requests to other chats. Its facts, the
 *  designation of the lead chat, its workspace domain, the `/lead` command,
 *  the lead chat's prompt and tool list, its two tools, and the prompt
 *  addition of a chat that it started. */
export const leadModule = {
  id: "lead",
  dependencies: [],
  availability: { kind: "available" },
  attended: true,
  service: { handle: leadService, create: createLeadService },
  runtime: { handle: leadRuntime, create: createLeadRuntime },
  protocol: moduleProtocol({ contract: leadProtocol, create: createLeadProtocol }),
  facts: { prefixes: ["lead."] },
  contributions: [
    { domain: "chatProfiles", id: "lead", value: {
      profile: ({ sessionId, modules }) => modules.get(leadService)?.role(sessionId) === "lead" ? { prompt: LEAD_PROMPT, tools: LEAD_TOOLS } : undefined,
    } },
    { domain: "tools", id: ROUTE_REQUEST_TOOL_NAME, value: { kind: "tool", name: ROUTE_REQUEST_TOOL_NAME, declaration: routeRequestDeclaration } },
    { domain: "tools", id: CHAT_PROGRESS_TOOL_NAME, value: { kind: "tool", name: CHAT_PROGRESS_TOOL_NAME, declaration: chatProgressDeclaration } },
    { domain: "promptFragments", id: "lead-started-chat", value: {
      order: 3,
      render: ({ modules }) => modules.get(leadRuntime)?.role() === "started" ? STARTED_CHAT_PROMPT : undefined,
    } },
    { domain: "commands", id: LEAD_COMMAND, value: {
      id: LEAD_COMMAND,
      title: LEAD_COMMAND_NAME,
      description: "Open the lead chat that routes your requests to other chats",
      aliases: [],
      execute: async (host) => {
        const sessionId = await host.modules.get(leadService)?.open("command")
        return sessionId ? { kind: "focus-session", sessionId } : { kind: "unavailable", message: "The lead is off" }
      },
    } },
    { domain: "settings", id: "lead", value: { control: "binary", group: "Interface", label: "Lead", description: "Open one lead chat that routes your requests to other chats" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
