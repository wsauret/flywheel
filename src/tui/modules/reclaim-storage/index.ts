import { RECLAIM_STORAGE_SURFACE } from "../../../protocol/modules/reclaim-storage.js"
import type { TuiModule } from "../../tui-module.js"

export const reclaimStorageTui = {
  id: "reclaim-storage",
  surfaces: [{ id: RECLAIM_STORAGE_SURFACE, loadController: async () => (await import("./surface.js")).createReclaimStorageSurface }],
} as const satisfies TuiModule
