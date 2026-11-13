import { errorMessage } from "../../../infra/error-message.js"
import { requireGuardedEventAppender } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import type { SessionCatalogRow } from "../../../protocol/app-service-types.js"
import { EMPTY_LEAD_VIEW, LEAD_COMMAND_NAME, leadCursor, type LeadView } from "../../../protocol/modules/lead.js"
import type { ControlModuleServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { createLeadJournal, type LeadJournal } from "./journal.js"

const log = Log.create({ service: "lead" })

/** The lead chat that an open answers, with the catalog row that a client shows at once. */
type LeadOpening = { readonly sessionId: string; readonly row: SessionCatalogRow; readonly created: boolean }

/** The lead module's control part (ARCH-STRUCTURE-045): the designation of the lead chat and whether the person
 *  dismissed it. It answers in the control placement, so the first tab never waits for the executor. It appends
 *  only `lead.chat.designated` and `lead.chat.dismissed`; the execution service appends the other lead facts to the
 *  same aggregate and follows these two through the store's broadcast. While the module is off it opens no chat
 *  and appends nothing (PI-LEAD-008). */
export interface LeadControl extends ModuleServiceInstance {
  /** Answers the lead chat, and creates it when none exists. `launch` answers null while the lead is dismissed;
   *  `command` ends the dismissal. Null while the module is off. */
  open(reason: "launch" | "command"): Promise<LeadOpening | null>
  /** Dismisses the designated lead chat. Answers the dismissed chat, or null when `sessionId` is not the shown lead
   *  or the module is off. */
  dismiss(sessionId: string): Promise<string | null>
  /** The designation that the `lead` domain serves: the empty view while the module is off. */
  view(): Promise<LeadView>
  readonly journal: LeadJournal
}

export const leadControl = moduleServiceHandle<LeadControl>("lead", "control")

export function createLeadControl(services: ControlModuleServices): LeadControl {
  const journal = createLeadJournal({
    reader: services.projectionReader,
    writer: requireGuardedEventAppender(services.eventWriter, "The lead requires guarded append authority"),
  })
  // Opens run one at a time, so two opens of an empty project create one chat and each open keeps its own reason.
  let opens: Promise<unknown> = Promise.resolve()
  // The startup replay and every stored-batch fold, in order; dispose settles them (ModuleServiceInstance).
  let background = Promise.resolve()
  let published: string | undefined
  let disposed = false

  const currentView = (): LeadView => {
    if (!services.enabled()) return EMPTY_LEAD_VIEW
    const { designated, dismissed } = journal.state()
    return { leadSessionId: designated, dismissed }
  }

  /** Publishes the designation when it changed since the last publication, whoever appended it. */
  const publishView = (): void => {
    if (disposed) return
    const view = currentView()
    const key = `${view.leadSessionId ?? ""}:${view.dismissed}`
    if (key === published) return
    published = key
    services.publish({ cursor: leadCursor(), payload: { kind: "lead.changed", ...view } })
  }

  function own(task: () => Promise<void>, failure: (error: string) => void): void {
    background = background.then(task).catch((error: unknown) => { failure(errorMessage(error)) })
  }

  const unsubscribeStored = services.onStored((events) => {
    if (disposed) return
    own(async () => { if ((await journal.observe(events)).length > 0) publishView() }, (error) => { log.warn("the lead journal could not fold a stored batch", { error }) })
  })
  const unsubscribeSelection = services.onSelectionChanged(publishView)

  const openOnce = async (reason: "launch" | "command"): Promise<LeadOpening | null> => {
    await journal.reconcile()
    const state = journal.state()
    if (reason === "launch" && state.dismissed) return null
    const existing = state.designated === null ? undefined : await services.chatRow(state.designated)
    // A deleted lead has no row, so the open creates a new lead chat.
    const opening = existing !== undefined
      ? { sessionId: existing.id, row: existing, created: false }
      : { ...await services.openChat({ name: LEAD_COMMAND_NAME }), created: true }
    if (await journal.append({ type: "lead.chat.designated", payload: { sessionId: opening.sessionId } })) {
      log.info("lead chat designated", { sessionId: opening.sessionId, reason, created: opening.created })
    }
    publishView()
    return opening
  }

  return {
    journal,
    start() {
      own(async () => {
        await journal.reconcile()
        publishView()
      }, (error) => { log.error("the lead journal could not replay", { error }) })
    },
    async open(reason) {
      if (!services.enabled()) return null
      const run = opens.then(() => openOnce(reason))
      opens = run.catch(() => undefined)
      return run
    },
    async dismiss(sessionId) {
      if (!services.enabled()) return null
      // The journal skips a dismissal of a chat that is not the shown lead.
      if (!await journal.append({ type: "lead.chat.dismissed", payload: { sessionId } })) return null
      log.info("lead chat dismissed", { sessionId })
      publishView()
      return sessionId
    },
    async view() {
      await journal.reconcile()
      return currentView()
    },
    async dispose() {
      disposed = true
      unsubscribeStored()
      await unsubscribeSelection()
      await Promise.all([background, opens])
    },
  }
}
