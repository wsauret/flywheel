import { RECLAIM_STORAGE_SURFACE } from "../../../../src/protocol/modules/reclaim-storage.js"
import type { WebModule } from "../../web-module.js"
import { ReclaimStorageSheet } from "./sheet.js"

export const reclaimStorageWeb = {
  id: "reclaim-storage",
  surfaces: [{ id: RECLAIM_STORAGE_SURFACE, sheet: ReclaimStorageSheet }],
} as const satisfies WebModule
