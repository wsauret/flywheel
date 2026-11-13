import type { TuiModule } from "../../tui-module.js"
import { createLeadClient } from "./client.js"

export const leadTui = { id: "lead", createClient: createLeadClient } as const satisfies TuiModule
