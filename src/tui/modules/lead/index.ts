import { LEAD_SURFACE } from "../../../protocol/modules/lead.js"
import type { TuiModule } from "../../tui-module.js"
import { createLeadClient } from "./client.js"
import { LeadStrip } from "./strip.js"

export const leadTui = {
  id: "lead",
  createClient: createLeadClient,
  strip: LeadStrip,
  surfaces: [{ id: LEAD_SURFACE, loadController: async () => (await import("./surface.js")).createLeadSurface }],
} as const satisfies TuiModule
