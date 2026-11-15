import { errorMessage } from "../../../infra/error-message.js"
import { requireGuardedEventAppender } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { EMPTY_LEAD_CHATS, leadChatsCursor, leadReportCall, type LeadChatsView, type LeadSeenState } from "../../../protocol/modules/lead.js"
import type { SessionEventKind } from "../../chat/runner-types.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import type { SessionOpenHold } from "../../app-service/runtime-supervisor-types.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { readChatDetail, readChatRoster, type ChatProgress } from "./chat-progress.js"
import type { LeadFact } from "./facts.js"
import { createLeadJournal, type LeadJournal } from "./journal.js"
import type { RouteInput, RouteOutcome } from "./route-request.js"
import { createLeadRows, type LeadRowChange, type LeadRows } from "./rows.js"

const log = Log.create({ service: "lead" })

/** What a chat is to the lead: the lead chat itself, a chat that the lead started, or neither. */
export type LeadRole = "lead" | "started"

/** The lead module's execution service: its fold of the `lead` aggregate, the
 *  routes of the person's requests, and the watches and rows of the chats that
 *  the lead started. The control part (`control.ts`) owns the designation of
 *  the lead chat; this service follows it through the store's broadcast. The
 *  instance lives for the process, also while the module is off; then it
 *  opens no chat, appends no fact, and watches no chat (ARCH-STRUCTURE-026,
 *  PI-LEAD-008). */
export interface LeadService extends ModuleServiceInstance {
  /** The rows that the `leadChats` domain serves: none while the module is off. */
  view(): Promise<LeadChatsView>
  /** What `sessionId` is to the lead: the designated chat while it is not dismissed, a chat that the lead started, or
   *  undefined. The request's module selection decides whether the module acts on it. */
  role(sessionId: string): LeadRole | undefined
  /** Forwards the person's entries of the lead chat's newest turns to a new chat or to a chat that the lead started
   *  (section "The routing tool" of the lead design): the runtime selects and copies the entries, and the caller
   *  names only the target. A repeated call starts no second chat and records nothing twice. */
  route(input: RouteInput): Promise<RouteOutcome>
  /** The progress of every chat that the lead started, or of one of them in its own words. */
  progress(chat: string | undefined): Promise<ChatProgress>
  /** Records that the person read a started chat's result up to `entryId`, so its row no longer holds it. Appends
   *  nothing while the module is off, and refuses a chat that the lead did not start. */
  markRead(sessionId: string, entryId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  /** Records that the person opened a started chat while its row was failed or cut at `entryId`, so the row leaves
   *  the list until the chat changes state again. Appends nothing while the module is off, and refuses a chat that
   *  the lead did not start. */
  markSeen(sessionId: string, state: LeadSeenState, entryId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  readonly journal: LeadJournal
}

export const leadService = moduleServiceHandle<LeadService>("lead")

type LeadServiceInputs = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish" | "onSelectionChanged" | "enabled"> & {
  readonly sessionManager: Pick<ModuleProcessServices["sessionManager"], "read">
  readonly sessionStore: Pick<ModuleProcessServices["sessionStore"], "get" | "onChange">
  readonly executionEnvironment: () => Pick<ReturnType<ModuleProcessServices["executionEnvironment"]>, "openChat" | "sessionEvents" | "personEntries" | "forwardPersonEntries" | "sessionRuntime" | "sendSessionMessage" | "createOpenHold">
}

type NonEmptyIds = readonly [string, ...string[]]

/** The events of a started chat that reach the lead as a hidden notice. A finished turn reaches it as the chat's
 *  report instead (PI-LEAD-006). */
const NOTICE_KINDS: readonly SessionEventKind[] = ["asked", "failed", "cut"]

const startedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.chat.started" ? [fact.payload.sessionId] : [])
const markedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.result.read" || fact.type === "lead.chat.seen" ? [fact.payload.sessionId] : [])

export function createLeadService(services: LeadServiceInputs): LeadService {
  const journal = createLeadJournal({
    reader: services.projectionReader,
    writer: requireGuardedEventAppender(services.eventWriter, "The lead requires guarded append authority"),
  })
  let started = false
  // The startup replay and every stored-batch fold, in order; dispose settles them (ModuleServiceInstance).
  let background = Promise.resolve()
  let watched: { readonly lead: string; readonly chats: Set<string> } | undefined
  let disposed = false
  // The rows of the started chats, while the module is on, and the open hold of each chat that has one (PI-LEAD-003).
  let rows: LeadRows | undefined
  let opened: SessionOpenHold | undefined
  // The closes that let-gos of the open hold started; dispose settles them.
  let releases: Promise<void> = Promise.resolve()
  // The disposals of the rows owners that a turn-off ended; dispose settles them.
  let endings: Promise<unknown> = Promise.resolve()

  const publishRow = (change: LeadRowChange): void => {
    services.publish({ cursor: leadChatsCursor(), payload: change.kind === "updated" ? { kind: "lead.row.updated", row: change.row } : { kind: "lead.row.removed", sessionId: change.sessionId } })
    if (change.kind === "updated") postReport(change.row.sessionId)
  }

  /** Posts a chat's unread result to the shown lead as its report: the chat's final message in full, as a message
   *  from the chat, which the lead's transcript shows as one line that opens it. Posting it reads it, so its row
   *  leaves the list. A lead with no runner holds the message until it runs. The report is the result as it stands
   *  now, so a later final message never takes its place. The runtime's delivery records nothing for a report that
   *  the lead already holds, so a repeat after a restart or a replayed batch posts it once. */
  function postReport(sessionId: string): void {
    const lead = watched?.lead
    const result = rows?.result(sessionId)
    if (lead === undefined || result === undefined) return
    const { entryId, text } = result
    own(async () => {
      const outcome = await services.executionEnvironment().sendSessionMessage({ fromSessionId: sessionId, toSessionId: lead, call: leadReportCall(entryId), text })
      if (outcome.status === "refused") {
        log.warn("lead could not post a report", { leadSessionId: lead, sessionId, entryId, reason: outcome.reason })
        return
      }
      log.info("lead posted a report", { leadSessionId: lead, sessionId, entryId, status: outcome.status, bytes: Buffer.byteLength(text) })
      await appendMark(sessionId, { type: "lead.result.read", payload: { sessionId, entryId } })
    }, (error) => {
      log.warn("lead could not post a report", { leadSessionId: lead, sessionId, entryId, error })
    })
  }

  /** Follows the started chats while the module is on. Turning it off releases every fold and removes each row that a
   *  client holds; turning it on builds the rows again. Otherwise only the chats that `added` names gain a fold. */
  const applyRows = (added: Iterable<string>): void => {
    if (disposed || !services.enabled()) {
      if (!rows) return
      const ended = rows
      rows = undefined
      // A module that turns off or a process that ends closes no chat: the rows leave without the person reading them.
      opened?.drop()
      opened = undefined
      const shown = ended.rows()
      // The owner stops at once, so no patch of its in-flight work follows these removals.
      const ending = ended.dispose()
      for (const row of shown) publishRow({ kind: "removed", sessionId: row.sessionId })
      endings = Promise.all([endings, ending.catch((error: unknown) => { log.warn("the lead rows could not end", { error: errorMessage(error) }) })])
      return
    }
    let chats = added
    if (!rows) {
      const hold = services.executionEnvironment().createOpenHold()
      const owner: LeadRows = createLeadRows({
        reader: services.projectionReader,
        sessionManager: services.sessionManager,
        sessionStore: services.sessionStore,
        sessionRuntime: (sessionId) => services.executionEnvironment().sessionRuntime(sessionId),
        readMark: (sessionId) => journal.state().readMarks.get(sessionId),
        seenMark: (sessionId) => journal.state().seenMarks.get(sessionId),
        // Only the current owner publishes: an owner that a turn-off ended may still settle work it started.
        publish: (change) => {
          if (rows !== owner) return
          if (change.kind === "updated") hold.hold(change.row.sessionId)
          else {
            const { sessionId } = change
            // Beside the journal's lane, because the close waits in the chat's mailbox.
            releases = releases.then(() => hold.release(sessionId)).catch((error: unknown) => { log.warn("the lead could not let go of a chat", { sessionId, error: errorMessage(error) }) })
          }
          publishRow(change)
        },
      })
      rows = owner
      opened = hold
      chats = journal.state().started.keys()
    }
    // The builds run beside the journal's lane: a fold's first replay reads through a position captured after it starts.
    void rows.add(chats)
  }

  /** Watches each started chat for the shown lead while the module is on, and nothing otherwise. A change of the
   *  shown lead moves every watch; otherwise only the chats that `added` names gain one, so a fact costs one watch at
   *  most, whatever the number of started chats. */
  const applyWatches = (added: Iterable<string>): void => {
    const state = journal.state()
    const lead = !disposed && services.enabled() && !state.dismissed ? state.designated : null
    const events = services.executionEnvironment().sessionEvents
    let chats = added
    let moved = false
    if (watched?.lead !== lead) {
      if (watched) for (const chat of watched.chats) events.unwatch(watched.lead, chat)
      watched = lead === null ? undefined : { lead, chats: new Set() }
      chats = state.started.keys()
      moved = true
    }
    if (!watched) return
    for (const chat of chats) {
      if (watched.chats.has(chat)) continue
      events.watch(watched.lead, chat, NOTICE_KINDS)
      watched.chats.add(chat)
    }
    // The results that waited while no lead showed go to the lead that shows now.
    if (moved) for (const row of rows?.rows() ?? []) postReport(row.sessionId)
  }

  const follow = (added: readonly string[] = []): void => {
    if (!started || disposed) return
    applyWatches(added)
    applyRows(added)
  }

  function own(task: () => Promise<void>, failure: (error: string) => void): void {
    background = background.then(task).catch((error: unknown) => { failure(errorMessage(error)) })
  }

  /** Follows the facts that the journal applied, whoever read them, so no read of the journal hides one from the
   *  watches and the rows. */
  const applyFacts = (applied: readonly LeadFact[]): void => {
    if (applied.length === 0) return
    follow(startedChats(applied))
    for (const sessionId of markedChats(applied)) rows?.refresh(sessionId)
  }

  const reconcileJournal = async (): Promise<void> => { applyFacts(await journal.reconcile()) }

  const unsubscribeStored = services.onStored((events) => {
    if (disposed) return
    own(async () => {
      applyFacts(await journal.observe(events))
      await rows?.observe(events)
    }, (error) => { log.warn("the lead journal could not fold a stored batch", { error }) })
  })
  const unsubscribeSelection = services.onSelectionChanged(() => { follow() })

  const chatTitle = async (sessionId: string): Promise<string | undefined> => {
    const session = await services.sessionManager.read(sessionId)
    return session?.kind === "chat" ? sessionDisplayName({ id: sessionId, session }) : undefined
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

  /** Appends a read or seen mark of a started chat and reads its row again. */
  async function appendMark(sessionId: string, fact: Parameters<LeadJournal["append"]>[0]): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    if (!services.enabled()) return { ok: true }
    await reconcileJournal()
    if (!journal.state().started.has(sessionId)) return { ok: false, error: `the lead did not start chat ${sessionId}` }
    // The journal folds its own append, so the store's broadcast of it applies nothing: refresh the row here.
    if (await journal.append(fact)) rows?.refresh(sessionId)
    return { ok: true }
  }

  return {
    journal,
    start() {
      started = true
      own(async () => {
        applyFacts(await journal.reconcile())
        follow()
      }, (error) => { log.error("the lead journal could not replay", { error }) })
    },
    async view() {
      await reconcileJournal()
      return services.enabled() ? { rows: rows?.rows() ?? [] } : EMPTY_LEAD_CHATS
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
      await reconcileJournal()
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
      await reconcileJournal()
      const current = rows
      if (!current) return { kind: "refused", reason: "the lead is off" }
      const deps = { sessionManager: services.sessionManager, sessionStore: services.sessionStore, chat: (sessionId: string) => current.chat(sessionId) }
      if (chat === undefined) return readChatRoster(deps, [...journal.state().started.keys()])
      if (!journal.state().started.has(chat)) return { kind: "refused", reason: `the lead did not start chat ${chat}` }
      return readChatDetail(deps, chat)
    },
    markRead: (sessionId, entryId) => appendMark(sessionId, { type: "lead.result.read", payload: { sessionId, entryId } }),
    markSeen: (sessionId, state, entryId) => appendMark(sessionId, { type: "lead.chat.seen", payload: { sessionId, state, entryId } }),
    async dispose() {
      disposed = true
      unsubscribeStored()
      await unsubscribeSelection()
      await background
      // `disposed` makes the shown lead null, so this releases every watch.
      if (watched) applyWatches([])
      const ending = rows?.dispose()
      rows = undefined
      opened?.drop()
      opened = undefined
      await Promise.all([ending, endings, releases])
    },
  }
}
