import { LEAD_COMMAND, LEAD_COMMAND_NAME, LEAD_SURFACE, leadChatsProtocol, leadDesignationProtocol } from "../../../protocol/modules/lead.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { CHAT_PROGRESS_TOOL_NAME } from "./chat-progress.js"
import { FIND_CHAT_TOOL_NAME } from "./find-chat.js"
import { LEAD_PROMPT, LISTED_CHAT_PROMPT, STARTED_CHAT_PROMPT } from "./prompt.js"
import { createLeadControl, leadControl } from "./control.js"
import { createLeadChatsProtocol, createLeadControlProtocol } from "./protocol.js"
import { ROUTE_REQUEST_TOOL_NAME } from "./route-request.js"
import { createLeadRuntime, leadRuntime } from "./runtime.js"
import { createLeadService, leadService } from "./service.js"
import { chatProgressDeclaration, findChatDeclaration, LEAD_TOOLS, routeRequestDeclaration } from "./tools.js"

/** The model role of the lead chat's requests. Every other chat, also one that the lead started, keeps Chat. */
const LEAD_MODEL_ROLE = "lead-chat"

/** The lead (PI-LEAD-001 to PI-LEAD-008): one always-on chat for each project
 *  that routes the person's requests to other chats. Its facts, the
 *  designation of the lead chat in its control part (ARCH-STRUCTURE-045),
 *  its two workspace domains, the `/lead` command,
 *  the lead chat's prompt and tool list, its three tools, the prompt
 *  addition of a chat that it started or that started while it showed. */
export const leadModule = {
  id: "lead",
  dependencies: [],
  availability: { kind: "available" },
  attended: true,
  service: { handle: leadService, create: createLeadService },
  runtime: { handle: leadRuntime, create: createLeadRuntime },
  protocol: moduleProtocol({ contract: leadChatsProtocol, create: createLeadChatsProtocol }),
  control: {
    service: { handle: leadControl, create: createLeadControl },
    protocol: moduleProtocol({ contract: leadDesignationProtocol, create: createLeadControlProtocol }),
  },
  facts: { prefixes: ["lead."] },
  contributions: [
    { domain: "chatProfiles", id: "lead", value: {
      profile: ({ sessionId, modules }) => modules.get(leadService)?.role(sessionId) === "lead" ? { prompt: LEAD_PROMPT, tools: LEAD_TOOLS, role: LEAD_MODEL_ROLE } : undefined,
    } },
    // The lead's own model setting (PI-LEAD-020), which the model settings list only while the module is on.
    { domain: "modelRoles", id: "lead", value: [LEAD_MODEL_ROLE] },
    { domain: "tools", id: ROUTE_REQUEST_TOOL_NAME, value: { kind: "tool", name: ROUTE_REQUEST_TOOL_NAME, declaration: routeRequestDeclaration } },
    { domain: "tools", id: CHAT_PROGRESS_TOOL_NAME, value: { kind: "tool", name: CHAT_PROGRESS_TOOL_NAME, declaration: chatProgressDeclaration } },
    { domain: "tools", id: FIND_CHAT_TOOL_NAME, value: { kind: "tool", name: FIND_CHAT_TOOL_NAME, declaration: findChatDeclaration } },
    // The role is set when the chat starts, and a chat that the lead first gives a request to becomes briefed then, so a
    // chat's prompt changes at most once while it lives (PI-LEAD-012).
    { domain: "promptFragments", id: "lead-started-chat", value: {
      order: 3,
      render: async ({ modules }) => {
        const role = await modules.get(leadRuntime)?.settledRole()
        return role === "started" ? STARTED_CHAT_PROMPT : role === "briefed" ? LISTED_CHAT_PROMPT : undefined
      },
    } },
    { domain: "commands", id: LEAD_COMMAND, value: {
      id: LEAD_COMMAND,
      title: LEAD_COMMAND_NAME,
      description: "Open the lead chat that routes your requests to other chats",
      aliases: [],
      // The client's surface sends `lead.open`, so the control part stays the one writer of the designation.
      opens: LEAD_SURFACE,
    } },
    { domain: "settings", id: "lead", value: { control: "binary", group: "Interface", label: "Lead", description: "Open one lead chat that routes your requests to other chats" } },
  ],
  observers: [],
  transformers: [],
  gates: [],
} as const satisfies FirstPartyModule
