import { EMPTY_LEAD_CHATS, EMPTY_LEAD_VIEW, leadChatsCursor, leadCursor, type leadChatsProtocol, type leadDesignationProtocol } from "../../../protocol/modules/lead.js"
import type { AccountModuleProtocolServices, ModuleProtocolRuntime } from "../../app-service/module-protocol-host.js"
import { leadControl } from "./control.js"
import { leadService } from "./service.js"

/** The lead's control protocol: the designation and the opening and dismissal of the lead chat, which the control
 *  part answers without waiting for the executor. While the module is off, or before its control part was ever
 *  built, the snapshot is the empty view and no mutation opens or dismisses a chat. */
export function createLeadControlProtocol(services: AccountModuleProtocolServices): ModuleProtocolRuntime<typeof leadDesignationProtocol> {
  const control = () => (services.enabled() ? services.modules.get(leadControl) : undefined)
  return {
    serve: {
      leadSnapshot: async () => {
        const view = await control()?.view() ?? EMPTY_LEAD_VIEW
        return { view, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: leadCursor() }) }
      },
    },
    mutate: {
      "lead.open": async (mutation) => {
        const opening = await control()?.open(mutation.reason)
        return opening ? { ok: true, ...opening } : { ok: true, sessionId: null }
      },
      "lead.dismiss": async (mutation) => ({ ok: true, sessionId: await control()?.dismiss(mutation.sessionId) ?? null }),
    },
    dispose() {},
  }
}

/** The lead's execution protocol: the rows of the started chats and the read marks of their results. While the
 *  module is off the snapshot holds no row and no mutation records a read. */
export function createLeadChatsProtocol(services: AccountModuleProtocolServices): ModuleProtocolRuntime<typeof leadChatsProtocol> {
  const service = () => (services.enabled() ? services.modules.get(leadService) : undefined)
  return {
    serve: {
      leadChatsSnapshot: async () => {
        const view = await service()?.view() ?? EMPTY_LEAD_CHATS
        return { view, snapshotPosition: services.snapshotPosition({ kind: "cursor", cursor: leadChatsCursor() }) }
      },
    },
    mutate: {
      "lead.result.mark_read": async (mutation) => await service()?.markRead(mutation.sessionId, mutation.entryId) ?? { ok: true },
    },
    dispose() {},
  }
}
