import type { TuiModule } from "../../tui-module.js"
import { createLeadClient } from "./client.js"
import { LeadStrip } from "./strip.js"

export const leadTui = { id: "lead", createClient: createLeadClient, strip: LeadStrip } as const satisfies TuiModule
