import { RECLAIM_STORAGE_COMMAND, RECLAIM_STORAGE_COMMAND_NAME, RECLAIM_STORAGE_SURFACE, storageCursor, reclaimStorageProtocol } from "../../../protocol/modules/reclaim-storage.js"
import { moduleProtocol } from "../../app-service/module-protocol-host.js"
import type { FirstPartyModule } from "../../module-catalog.js"
import { createStorageService, storageService } from "./service.js"

/** The project's store size and the Reclaim storage command (PI-INTERACTION-182,
 *  ARCH-RUNTIME-083). The kernel owns the store's upkeep and its usage; this
 *  module shows them and offers the command in every client. */
export const reclaimStorageModule = {
  id: "reclaim-storage",
  host: "control",
  dependencies: [],
  service: { handle: storageService, create: createStorageService },
  protocol: moduleProtocol({
    contract: reclaimStorageProtocol,
    create: (services) => ({
      serve: {
        storageSnapshot: async () => ({
          storage: services.modules.get(storageService)?.view() ?? { usage: null, lastReclaim: null },
          snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: storageCursor() }),
        }),
        "storage.reclaimPreview": async () => services.modules.get(storageService)?.preview() ?? null,
      },
      mutate: {
        "storage.reclaim": async () => services.modules.get(storageService)?.reclaim() ?? { ok: false, error: "Storage is turned off." },
      },
      dispose() {},
    }),
  }),
  contributions: [
    { domain: "commands", id: RECLAIM_STORAGE_COMMAND, value: {
      id: RECLAIM_STORAGE_COMMAND,
      title: RECLAIM_STORAGE_COMMAND_NAME,
      description: "Show how much space this project's Flywheel store can give back, and reclaim it",
      aliases: ["vacuum"],
      opens: RECLAIM_STORAGE_SURFACE,
    } },
    { domain: "settings", id: "reclaim-storage", value: { control: "binary", group: "Interface", label: "Storage", description: "Show the store size and suggest Reclaim storage" } },
  ],
} as const satisfies FirstPartyModule
