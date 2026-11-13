import { EMPTY_LEAD_VIEW, leadCursor, type leadProtocol } from "../../../protocol/modules/lead.js"
import type { ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { leadService } from "./service.js"

/** The lead's protocol runtime. The service answers the view and the
 *  mutations and publishes `lead.changed` and the row patches; while the
 *  module is off, or before its service was ever built, the snapshot is the
 *  empty view and no mutation opens or dismisses a chat or records a read. */
export function createLeadProtocol(services: Pick<ModuleProtocolServices, "modules" | "enabled" | "snapshotPosition">): ModuleProtocolRuntime<typeof leadProtocol> {
  const service = () => (services.enabled() ? services.modules.get(leadService) : undefined)
  return {
    serve: {
      leadSnapshot: async () => {
        const view = await service()?.view() ?? EMPTY_LEAD_VIEW
        return { view, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: leadCursor() }) }
      },
    },
    mutate: {
      "lead.open": async (mutation) => ({ ok: true, sessionId: await service()?.open(mutation.reason) ?? null }),
      "lead.dismiss": async (mutation) => ({ ok: true, sessionId: await service()?.dismiss(mutation.sessionId) ?? null }),
      "lead.result.mark_read": async (mutation) => await service()?.markRead(mutation.sessionId, mutation.entryId) ?? { ok: true },
    },
    dispose() {},
  }
}
