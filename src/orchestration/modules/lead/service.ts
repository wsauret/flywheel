import { errorMessage } from "../../../infra/error-message.js"
import { requireGuardedEventAppender } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { EMPTY_LEAD_VIEW, LEAD_COMMAND_NAME, leadCursor, type LeadView } from "../../../protocol/modules/lead.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { createLeadJournal, type LeadJournal } from "./journal.js"

const log = Log.create({ service: "lead" })

/** The lead module's one process-scoped service: the journal of the `lead`
 *  aggregate, the designation of the lead chat, and the watches of the chats
 *  that the lead started. The instance lives for the process, also while the
 *  module is off; then it opens no chat, appends no fact, and watches no chat
 *  (ARCH-STRUCTURE-026, PI-LEAD-008). */
export interface LeadService extends ModuleServiceInstance {
  /** Answers the lead chat. `launch` answers null while the lead is dismissed; `command` ends the dismissal. Null while the module is off. */
  open(reason: "launch" | "command"): Promise<string | null>
  /** Dismisses the designated lead chat. Answers the dismissed chat, or null when `sessionId` is not the shown lead or the module is off. */
  dismiss(sessionId: string): Promise<string | null>
  /** The view that the protocol domain serves: the empty view while the module is off. */
  view(): Promise<LeadView>
  readonly journal: LeadJournal
}

export const leadService = moduleServiceHandle<LeadService>("lead")

type LeadServiceInputs = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish" | "onSelectionChanged" | "enabled"> & {
  readonly sessionManager: Pick<ModuleProcessServices["sessionManager"], "read">
  readonly executionEnvironment: () => Pick<ReturnType<ModuleProcessServices["executionEnvironment"]>, "openChat" | "sessionEvents">
}

export function createLeadService(services: LeadServiceInputs): LeadService {
  const journal = createLeadJournal({
    reader: services.projectionReader,
    writer: requireGuardedEventAppender(services.eventWriter, "The lead requires guarded append authority"),
  })
  let started = false
  // Opens run one at a time, so two opens of an empty project create one chat and each open keeps its own reason.
  let opens: Promise<unknown> = Promise.resolve()
  // The startup replay and every stored-batch fold, in order; dispose settles them (ModuleServiceInstance).
  let background = Promise.resolve()
  let watched: { readonly lead: string; readonly chats: Set<string> } | undefined
  let published: string | undefined
  let disposed = false

  const currentView = (): LeadView => {
    if (!services.enabled()) return EMPTY_LEAD_VIEW
    const state = journal.state()
    return { leadSessionId: state.designated, dismissed: state.dismissed, rows: [] }
  }

  /** Watches each started chat for the shown lead while the module is on, and nothing otherwise. */
  const applyWatches = (): void => {
    const state = journal.state()
    const lead = !disposed && services.enabled() && !state.dismissed ? state.designated : null
    const events = services.executionEnvironment().sessionEvents
    if (watched && watched.lead !== lead) {
      for (const chat of watched.chats) events.unwatch(watched.lead, chat)
      watched = undefined
    }
    if (lead === null) return
    watched ??= { lead, chats: new Set() }
    for (const chat of state.started.keys()) {
      if (watched.chats.has(chat)) continue
      events.watch(lead, chat)
      watched.chats.add(chat)
    }
  }

  /** Publishes the view's lead fields when they changed since the last publication. */
  const publishView = (): void => {
    const view = currentView()
    const key = `${view.leadSessionId ?? ""}:${view.dismissed}`
    if (key === published) return
    published = key
    services.publish({ cursor: leadCursor(), payload: { kind: "lead.changed", leadSessionId: view.leadSessionId, dismissed: view.dismissed } })
  }

  const follow = (): void => {
    if (!started || disposed) return
    applyWatches()
    publishView()
  }

  const own = (task: () => Promise<void>, failure: (error: string) => void): void => {
    background = background.then(task).catch((error: unknown) => { failure(errorMessage(error)) })
  }

  const unsubscribeStored = services.onStored((events) => {
    if (disposed) return
    own(async () => { if ((await journal.observe(events)).length > 0) follow() }, (error) => { log.warn("the lead journal could not fold a stored batch", { error }) })
  })
  const unsubscribeSelection = services.onSelectionChanged(follow)

  const chatExists = async (sessionId: string): Promise<boolean> => (await services.sessionManager.read(sessionId))?.kind === "chat"

  const openOnce = async (reason: "launch" | "command"): Promise<string | null> => {
    await journal.reconcile()
    const state = journal.state()
    if (reason === "launch" && state.dismissed) return null
    const existing = state.designated !== null && await chatExists(state.designated) ? state.designated : null
    const sessionId = existing ?? await services.executionEnvironment().openChat({ name: LEAD_COMMAND_NAME })
    if (await journal.append({ type: "lead.chat.designated", payload: { sessionId } })) {
      log.info("lead chat designated", { sessionId, reason, created: existing === null })
    }
    follow()
    return sessionId
  }

  return {
    journal,
    start() {
      started = true
      own(async () => { await journal.reconcile(); follow() }, (error) => { log.error("the lead journal could not replay", { error }) })
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
      follow()
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
      await background
      // `disposed` makes the shown lead null, so this releases every watch.
      if (watched) applyWatches()
    },
  }
}
