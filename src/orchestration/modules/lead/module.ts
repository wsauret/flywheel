import { LEAD_COMMAND, LEAD_COMMAND_NAME, leadProtocol } from "../../../protocol/modules/lead.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../modules.js"
import { createLeadProtocol } from "./protocol.js"
import { createLeadService, leadService } from "./service.js"

/** The lead (PI-LEAD-001 to PI-LEAD-008): one always-on chat for each project
 *  that routes the person's requests to other chats. Its facts, the
 *  designation of the lead chat, its workspace domain, and the `/lead`
 *  command, which opens the lead and ends a dismissal. */
export const leadModule = {
  id: "lead",
  dependencies: [],
  availability: { kind: "available" },
  attended: true,
  service: { handle: leadService, create: createLeadService },
  protocol: moduleProtocol({ contract: leadProtocol, create: createLeadProtocol }),
  facts: { prefixes: ["lead."] },
  contributions: [
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
