import { errorMessage } from "../../../infra/error-message.js"
import { requireGuardedEventAppender } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { EMPTY_LEAD_VIEW, LEAD_COMMAND_NAME, leadCursor, type LeadView } from "../../../protocol/modules/lead.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { readChatDetail, readChatRoster, type ChatProgress } from "./chat-progress.js"
import type { LeadFact } from "./facts.js"
import { createLeadJournal, type LeadJournal } from "./journal.js"
import type { RouteInput, RouteOutcome } from "./route-request.js"

const log = Log.create({ service: "lead" })

/** What a chat is to the lead: the lead chat itself, a chat that the lead started, or neither. */
export type LeadRole = "lead" | "started"

/** The lead module's one process-scoped service: the journal of the `lead`
 *  aggregate, the designation of the lead chat, the routes of the person's
 *  requests, and the watches of the chats that the lead started. The
 *  instance lives for the process, also while the module is off; then it
 *  opens no chat, appends no fact, and watches no chat (ARCH-STRUCTURE-026,
 *  PI-LEAD-008). */
export interface LeadService extends ModuleServiceInstance {
  /** Answers the lead chat. `launch` answers null while the lead is dismissed; `command` ends the dismissal. Null while the module is off. */
  open(reason: "launch" | "command"): Promise<string | null>
  /** Dismisses the designated lead chat. Answers the dismissed chat, or null when `sessionId` is not the shown lead or the module is off. */
  dismiss(sessionId: string): Promise<string | null>
  /** The view that the protocol domain serves: the empty view while the module is off. */
  view(): Promise<LeadView>
  /** What `sessionId` is to the lead: the designated chat while it is not dismissed, a chat that the lead started, or
   *  undefined. The request's module selection decides whether the module acts on it. */
  role(sessionId: string): LeadRole | undefined
  /** Forwards the person's entries of the lead chat's newest turns to a new chat or to a chat that the lead started
   *  (section "The routing tool" of the lead design): the runtime selects and copies the entries, and the caller
   *  names only the target. A repeated call starts no second chat and records nothing twice. */
  route(input: RouteInput): Promise<RouteOutcome>
  /** The progress of every chat that the lead started, or of one of them in its own words. */
  progress(chat: string | undefined): Promise<ChatProgress>
  readonly journal: LeadJournal
}

export const leadService = moduleServiceHandle<LeadService>("lead")

type LeadServiceInputs = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish" | "onSelectionChanged" | "enabled"> & {
  readonly sessionManager: Pick<ModuleProcessServices["sessionManager"], "read">
  readonly sessionStore: Pick<ModuleProcessServices["sessionStore"], "get">
  readonly executionEnvironment: () => Pick<ReturnType<ModuleProcessServices["executionEnvironment"]>, "openChat" | "sessionEvents" | "personEntries" | "forwardPersonEntries">
}

type NonEmptyIds = readonly [string, ...string[]]

const startedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.chat.started" ? [fact.payload.sessionId] : [])

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

  /** Watches each started chat for the shown lead while the module is on, and nothing otherwise. A change of the
   *  shown lead moves every watch; otherwise only the chats that `added` names gain one, so a fact costs one watch at
   *  most, whatever the number of started chats. */
  const applyWatches = (added: Iterable<string>): void => {
    const state = journal.state()
    const lead = !disposed && services.enabled() && !state.dismissed ? state.designated : null
    const events = services.executionEnvironment().sessionEvents
    let chats = added
    if (watched?.lead !== lead) {
      if (watched) for (const chat of watched.chats) events.unwatch(watched.lead, chat)
      watched = lead === null ? undefined : { lead, chats: new Set() }
      chats = state.started.keys()
    }
    if (!watched) return
    for (const chat of chats) {
      if (watched.chats.has(chat)) continue
      events.watch(watched.lead, chat)
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

  const follow = (added: readonly string[] = []): void => {
    if (!started || disposed) return
    applyWatches(added)
    publishView()
  }

  const own = (task: () => Promise<void>, failure: (error: string) => void): void => {
    background = background.then(task).catch((error: unknown) => { failure(errorMessage(error)) })
  }

  const unsubscribeStored = services.onStored((events) => {
    if (disposed) return
    own(async () => {
      const applied = await journal.observe(events)
      if (applied.length > 0) follow(startedChats(applied))
    }, (error) => { log.warn("the lead journal could not fold a stored batch", { error }) })
  })
  const unsubscribeSelection = services.onSelectionChanged(() => { follow() })

  const chatTitle = async (sessionId: string): Promise<string | undefined> => {
    const session = await services.sessionManager.read(sessionId)
    return session?.kind === "chat" ? sessionDisplayName({ id: sessionId, session }) : undefined
  }

  const openOnce = async (reason: "launch" | "command"): Promise<string | null> => {
    await journal.reconcile()
    const state = journal.state()
    if (reason === "launch" && state.dismissed) return null
    const existing = state.designated !== null && await chatTitle(state.designated) !== undefined ? state.designated : null
    const sessionId = existing ?? await services.executionEnvironment().openChat({ name: LEAD_COMMAND_NAME })
    if (await journal.append({ type: "lead.chat.designated", payload: { sessionId } })) {
      log.info("lead chat designated", { sessionId, reason, created: existing === null })
    }
    follow()
    return sessionId
  }

  /** The target of a route: the chat that the person's entries already started, or a new chat that this call
   *  records and watches before anything reaches it, so its first request and its first event find both. */
  const routeTarget = async (input: RouteInput, sourceEntryIds: NonEmptyIds): Promise<{ readonly sessionId: string; readonly started?: "now" | "earlier" } | { readonly refused: string }> => {
    const state = journal.state()
    if (input.kind === "existing") {
      if (input.chat === undefined || !state.started.has(input.chat)) return { refused: `the lead did not start chat ${input.chat ?? "(none named)"}, so it routes nothing there` }
      return { sessionId: input.chat }
    }
    const earlier = state.startedBy(sourceEntryIds)
    if (earlier !== undefined && await chatTitle(earlier) !== undefined) return { sessionId: earlier, started: "earlier" }
    const sessionId = await services.executionEnvironment().openChat({})
    await journal.append({ type: "lead.chat.started", payload: { sessionId, sourceEntryIds } })
    follow([sessionId])
    log.info("lead started a chat", { leadSessionId: input.leadSessionId, sessionId, entries: sourceEntryIds.length })
    return { sessionId, started: "now" }
  }

  return {
    journal,
    start() {
      started = true
      own(async () => { follow(startedChats(await journal.reconcile())) }, (error) => { log.error("the lead journal could not replay", { error }) })
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
    role(sessionId) {
      const state = journal.state()
      if (state.designated === sessionId && !state.dismissed) return "lead"
      return state.started.has(sessionId) ? "started" : undefined
    },
    async route(input) {
      const environment = services.executionEnvironment()
      let entries
      try {
        entries = await environment.personEntries(input.leadSessionId, input.earlierTurns)
      } catch (error) {
        return { ok: false, reason: errorMessage(error) }
      }
      // A turn that a notice started holds no message of the person: the lead routes only at the person's request.
      const [first, ...rest] = entries.map((entry) => entry.entryId)
      if (first === undefined || !entries.some((entry) => entry.turnsBack === 0)) return { ok: false, reason: "the newest turn holds no message from the person, and the lead routes only what the person asks for" }
      const sourceEntryIds: NonEmptyIds = [first, ...rest]
      await journal.reconcile()
      const target = await routeTarget(input, sourceEntryIds)
      if ("refused" in target) return { ok: false, reason: target.refused }
      const forwarded = await environment.forwardPersonEntries({ sourceSessionId: input.leadSessionId, entryIds: sourceEntryIds, targetSessionId: target.sessionId })
      if (!forwarded.ok) return forwarded
      const recorded = await journal.append({ type: "lead.request.forwarded", payload: {
        leadSessionId: input.leadSessionId, targetSessionId: target.sessionId, newChat: target.started === "now", sourceEntryIds,
      } })
      if (recorded) log.info("lead forwarded a request", { leadSessionId: input.leadSessionId, sessionId: target.sessionId, entries: sourceEntryIds.length })
      return {
        ok: true, sessionId: target.sessionId, title: await chatTitle(target.sessionId) ?? target.sessionId,
        ...(target.started ? { started: target.started } : {}), entries, recorded,
      }
    },
    async progress(chat) {
      await journal.reconcile()
      const deps = { reader: services.projectionReader, sessionManager: services.sessionManager, sessionStore: services.sessionStore }
      if (chat === undefined) return readChatRoster(deps, [...journal.state().started.keys()])
      if (!journal.state().started.has(chat)) return { kind: "refused", reason: `the lead did not start chat ${chat}` }
      return readChatDetail(deps, chat)
    },
    async dispose() {
      disposed = true
      unsubscribeStored()
      await unsubscribeSelection()
      await background
      // `disposed` makes the shown lead null, so this releases every watch.
      if (watched) applyWatches([])
    },
  }
}
