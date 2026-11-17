import { errorMessage } from "../../../infra/error-message.js"
import { parseProjectionFact } from "../../../infra/event-projection.js"
import { requireGuardedEventAppender, type StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { moduleServiceHandle } from "../../../infra/module-service.js"
import { EMPTY_LEAD_CHATS, leadChatsCursor, leadQuestionCall, leadReportCall, type LeadChatsView, type LeadQuestionOutcome, type LeadSeenState } from "../../../protocol/modules/lead.js"
import { formatAgentInputAnswers } from "../../../protocol/question-protocol-types.js"
import type { SessionEventKind } from "../../chat/runner-types.js"
import type { DeliveryOutcome } from "../../session/live-session-control.js"
import type { ModuleProcessServices, ModuleServiceInstance } from "../../app-service/module-service-host.js"
import type { SessionOpenHold } from "../../app-service/runtime-supervisor-types.js"
import { parseSessionMetadataFact } from "../../session/session-metadata-facts.js"
import { conversationHoldsMessage } from "../../session/empty-chat.js"
import { locatePassages, passagesHash } from "../../session/conversation/person-entries.js"
import { loadAgentInputProjection } from "../../session/agent-input-projection.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { questionText, readChatDetail, readChatRoster, type ChatProgress } from "./chat-progress.js"
import type { LeadFact } from "./facts.js"
import type { LeadFoundChat } from "./find-chat.js"
import { createLeadJournal, type LeadForward, type LeadJournal } from "./journal.js"
import type { RouteInput, RouteOutcome } from "./route-request.js"
import { createLeadRows, type LeadRowChange, type LeadRows } from "./rows.js"

const log = Log.create({ service: "lead" })

/** What a chat is to the lead: the lead chat itself, a chat that the lead started, a chat that joined the list at its
 *  creation while the lead showed or that the lead gave a request to, or none of these. */
export type LeadRole = "lead" | "started" | "briefed"

/** The lead module's execution service: its fold of the `lead` aggregate, the
 *  routes of the person's requests, and the list of the chats in use, with
 *  their watches, holds, and rows (PI-LEAD-004). The control part
 *  (`control.ts`) owns the designation of the lead chat; this service follows
 *  it through the store's broadcast. The instance lives for the process, also
 *  while the module is off; then it opens no chat, appends no fact, and
 *  watches no chat (ARCH-STRUCTURE-026, PI-LEAD-008). */
export interface LeadService extends ModuleServiceInstance {
  /** The rows that the `leadChats` domain serves: none while the module is off. */
  view(): Promise<LeadChatsView>
  /** What `sessionId` is to the lead (`LeadRole`). The request's module selection decides whether the module acts on
   *  it. */
  role(sessionId: string): LeadRole | undefined
  /** The role once the service folded every stored batch that it heard before this call, so a chat's first request
   *  reads the join that its creation recorded. */
  settledRole(sessionId: string): Promise<LeadRole | undefined>
  /** The shown lead chat when `sessionId` is a chat in its list, once the service folded every stored batch that it
   *  heard before this call; null otherwise. */
  settledListingLead(sessionId: string): Promise<string | null>
  /** Forwards the person's entries of the lead chat's newest turns to a new chat or to an earlier chat (section
   *  "The routing tool" of the lead design): the runtime selects and copies the entries, and the caller names only
   *  the target. A repeated call starts no second chat and records nothing twice. */
  route(input: RouteInput): Promise<RouteOutcome>
  /** The progress of every chat that shows a row in the list, or where one chat of the project stands, also one that
   *  left the list; with `before`, a page of that chat's conversation before a cursor that an earlier answer named. */
  progress(chat: string | undefined, before?: string): Promise<ChatProgress>
  /** The project's root chats other than the lead whose messages best match `query`, best first, each marked when it
   *  is in the list (PI-LEAD-001). */
  findChats(query: string): Promise<readonly LeadFoundChat[]>
  /** Records that the person read a listed chat's result up to `entryId`, so its row no longer holds it. Appends
   *  nothing while the module is off, and refuses a chat that is not in the list. */
  markRead(sessionId: string, entryId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  /** Records that the person opened a listed chat while its row was failed or cut at `entryId`, so the row shows that
   *  state no more until the chat changes state again. Appends nothing while the module is off, and refuses a chat
   *  that is not in the list. */
  markSeen(sessionId: string, state: LeadSeenState, entryId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>
  /** Where the question of a chat's ask_user call `toolUseId` stands, from the chat's own question facts, with the
   *  leading context of the call while the question waits in a listed chat. Unknown while the module is off. */
  question(sessionId: string, toolUseId: string): Promise<LeadQuestionOutcome>
  readonly journal: LeadJournal
}

export const leadService = moduleServiceHandle<LeadService>("lead")

type LeadServiceInputs = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish" | "onSelectionChanged" | "enabled"> & {
  readonly sessionManager: Pick<ModuleProcessServices["sessionManager"], "read" | "listActive" | "listForIds">
  readonly sessionStore: Pick<ModuleProcessServices["sessionStore"], "get" | "onChange">
  readonly executionEnvironment: () => Pick<ReturnType<ModuleProcessServices["executionEnvironment"]>, "openChat" | "findChats" | "sessionEvents" | "personEntries" | "forwardPersonEntries" | "sessionRuntime" | "sendSessionMessage" | "createOpenHold" | "onChatClosed" | "onSessionReleased" | "sessionShown" | "liveAgentCards">
}

type NonEmptyIds = readonly [string, ...string[]]
type MarkOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** The events of a listed chat that reach the lead as a hidden notice. A finished turn reaches it as the chat's
 *  report, and a question as the chat's question message, instead (PI-LEAD-005, PI-LEAD-006). */
const NOTICE_KINDS: readonly SessionEventKind[] = ["failed", "cut"]

/** One report or question of a listed chat that goes to the lead as a message from the chat. */
interface LeadPost {
  readonly kind: "report" | "question"
  readonly from: string
  readonly call: string
  readonly text: string
  /** The ids that name the post in its records. */
  readonly ids: { readonly entryId: string } | { readonly toolUseId: string }
}

const POST_RECORDS = {
  report: { posted: "lead posted a report", waits: "lead report waits for the lead's runner", failed: "lead could not post a report" },
  question: { posted: "lead posted a question", waits: "lead question waits for the lead's runner", failed: "lead could not post a question" },
} as const

const joinedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.chat.joined" ? [fact.payload.sessionId] : [])
const closedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.chat.closed" ? [fact.payload.sessionId] : [])
const markedChats = (facts: readonly LeadFact[]): readonly string[] => facts.flatMap((fact) => fact.type === "lead.result.read" || fact.type === "lead.chat.seen" ? [fact.payload.sessionId] : [])

/** A chat that became active in a stored batch, and whether the batch created it. */
interface Activation {
  readonly sessionId: string
  readonly created: boolean
}

/** The session facts of one stored batch that change the list. */
interface SessionChanges {
  readonly activations: readonly Activation[]
  readonly deleted: readonly string[]
}

/** Each activation of a session in one stored batch, and each deletion. The scan reads each fact once and reads
 *  nothing else. */
function sessionChanges(events: readonly StoredFact[]): SessionChanges {
  const activations: Activation[] = []
  const deleted: string[] = []
  for (const event of events) {
    if (!event.aggregateId.startsWith("session:")) continue
    if (event.type !== "session.created" && event.type !== "session.lifecycle.changed" && event.type !== "session.deleted") continue
    const sessionId = event.aggregateId.slice("session:".length)
    const fact = parseProjectionFact(event, parseSessionMetadataFact)
    if (fact.type === "session.deleted") deleted.push(sessionId)
    else if (fact.type === "session.created") {
      if (fact.payload.kind === "chat" && fact.payload.lifecycleState === "active") activations.push({ sessionId, created: true })
    } else if (fact.type === "session.lifecycle.changed" && fact.payload.lifecycleState === "active") activations.push({ sessionId, created: false })
  }
  return { activations, deleted }
}

export function createLeadService(services: LeadServiceInputs): LeadService {
  const journal = createLeadJournal({
    reader: services.projectionReader,
    writer: requireGuardedEventAppender(services.eventWriter, "The lead requires guarded append authority"),
  })
  let started = false
  // The startup replay, every stored-batch fold, and every change of the list, in order; dispose settles them
  // (ModuleServiceInstance).
  let background = Promise.resolve()
  // The posts of reports to the lead, in order, beside the folds: a delivery can wait on the lead's mailbox.
  let posting = Promise.resolve()
  let disposed = false
  // The shown lead that the watches and the hold follow, and the listed chats that each holds.
  let watched: { readonly lead: string; readonly chats: Set<string> } | undefined
  // The list's one open hold from the start. It holds chats only while a lead shows, and closes the chats that leave
  // the list at rest also while none shows.
  let opened: SessionOpenHold | undefined
  // The rows of the listed chats while the module is on.
  let rows: LeadRows | undefined
  // The disposals of the rows owners that a turn-off ended; dispose settles them.
  let endings: Promise<unknown> = Promise.resolve()
  let unsubscribeClosed: (() => void) | undefined
  let unsubscribeReleased: (() => void) | undefined
  // The reports and questions that this process posted, posts, or holds for the lead's runner, each as
  // `<lead>:<call>`, so a row that publishes again posts nothing more: a send to a running lead queues a report
  // uncommitted until its read mark lands. A restart posts each again, and the delivery records nothing for one that
  // the lead holds.
  const posted = new Set<string>()
  // The posts that the lead's absent runner holds: the attach of its runner posts each again, once (PI-LEAD-006).
  const waiting = new Set<string>()
  // Whether the watched lead had a runner at the last change of its store entry.
  let leadRunner = false

  const shownLead = (): string | null => {
    const state = journal.state()
    return !disposed && services.enabled() && !state.dismissed ? state.designated : null
  }

  /** Whether a chat that starts now holds the lead's rules for its whole life (PI-LEAD-012): while the module is on
   *  and the person has not dismissed the lead, also before any lead chat exists. */
  const briefable = (): boolean => !disposed && services.enabled() && !journal.state().dismissed

  /** Every chat of the list but the lead chat itself. It walks the whole list, so only a change of the shown lead or
   *  of the module's selection reads it. */
  const listed = (): string[] => {
    const { members, designated } = journal.state()
    return [...members].filter((sessionId) => sessionId !== designated)
  }

  function own(task: () => Promise<void>, failure: (error: string) => void): void {
    background = background.then(task).catch((error: unknown) => { failure(errorMessage(error)) })
  }

  const hasRunner = (sessionId: string): boolean => {
    const entry = services.sessionStore.get(sessionId)
    return entry?.kind === "chat" && entry.runner !== null
  }

  /** A send that the lead's absent runner holds: no runner reads it until the lead's next turn, so it counts as not
   *  shown, and the lead's next runner gets it again (PI-LEAD-006). */
  const waitsForLeadRunner = (outcome: DeliveryOutcome): boolean => outcome.status === "held" && outcome.reason === "no_reader"

  /** Posts every unread report and pending question of the listed rows to the shown lead, also each that waited for
   *  the lead's runner. */
  const postWaiting = (): void => {
    for (const key of waiting) posted.delete(key)
    waiting.clear()
    for (const row of rows?.rows() ?? []) {
      postReport(row.sessionId)
      postQuestions(row.sessionId)
    }
  }

  const publishRow = (change: LeadRowChange): void => {
    services.publish({ cursor: leadChatsCursor(), payload: change.kind === "updated" ? { kind: "lead.row.updated", row: change.row } : { kind: "lead.row.removed", sessionId: change.sessionId } })
    if (change.kind === "updated") {
      // A chat that shows a row is held again, also after it came to rest once.
      if (watched?.chats.has(change.row.sessionId)) opened?.hold(change.row.sessionId)
      postReport(change.row.sessionId)
      postQuestions(change.row.sessionId)
    }
  }

  /** Sends one post to the shown lead in order with the others, and runs `delivered` once the lead holds it. A post
   *  that the lead's absent runner holds waits for its attach and records its wait once; a refused or failed post can
   *  post again at the next publish of its row. */
  function post(lead: string, item: LeadPost, delivered?: () => Promise<void>): void {
    const key = `${lead}:${item.call}`
    if (posted.has(key)) return
    posted.add(key)
    const records = POST_RECORDS[item.kind]
    const fields = { leadSessionId: lead, sessionId: item.from, ...item.ids }
    posting = posting.then(async () => {
      const outcome = await services.executionEnvironment().sendSessionMessage({ fromSessionId: item.from, toSessionId: lead, call: item.call, text: item.text })
      if (outcome.status === "refused") {
        posted.delete(key)
        log.warn(records.failed, { ...fields, reason: outcome.reason })
        return
      }
      if (waitsForLeadRunner(outcome)) {
        waiting.add(key)
        log.info(records.waits, fields)
        return
      }
      log.info(records.posted, { ...fields, status: outcome.status, bytes: Buffer.byteLength(item.text) })
      await delivered?.()
    }).catch((error: unknown) => {
      posted.delete(key)
      log.warn(records.failed, { ...fields, error: errorMessage(error) })
    })
  }

  /** Posts each pending question of a chat to the shown lead, oldest first, as a message from the chat, which the
   *  lead's transcript shows as the question's widget at this point (PI-LEAD-005). The text holds the question word for
   *  word, so the lead can add a recommendation. Every question posts, also one of a chat that a client shows: the
   *  widget settles wherever the person answers. */
  function postQuestions(sessionId: string): void {
    const lead = watched?.lead
    if (lead === undefined) return
    for (const question of rows?.questions(sessionId) ?? []) {
      post(lead, { kind: "question", from: sessionId, call: leadQuestionCall(question.toolUseId), text: questionText(question), ids: { toolUseId: question.toolUseId } })
    }
  }

  /** Posts a chat's unread result to the shown lead as its report: the chat's final message in full, as a message
   *  from the chat, which the lead's transcript shows as one line that opens it. A report that the lead's runner takes
   *  reads it. A result of a chat that a client shows is read there, so it is marked read and posts nothing
   *  (PI-LEAD-006). A lead with no runner shows nothing, so its report stays unread and posts again when the lead's
   *  runner attaches. The report is the result as it stands now, so a later final message never takes its place. The
   *  runtime's delivery records nothing for a report that the lead already holds as an entry, so a repeat after a
   *  restart or a replayed batch posts it once. */
  function postReport(sessionId: string): void {
    const result = rows?.result(sessionId)
    if (result === undefined) return
    const { entryId, text } = result
    const environment = services.executionEnvironment()
    // A shown chat's result is read also while no lead shows, so a lead that shows later gets no report of it.
    if (environment.sessionShown(sessionId)) {
      own(async () => { await appendMark(sessionId, { type: "lead.result.read", payload: { sessionId, entryId } }) }, (error) => {
        log.warn("lead could not mark a shown report read", { sessionId, entryId, error })
      })
      return
    }
    const lead = watched?.lead
    if (lead === undefined) return
    post(lead, { kind: "report", from: sessionId, call: leadReportCall(entryId), text, ids: { entryId } }, async () => {
      await appendMark(sessionId, { type: "lead.result.read", payload: { sessionId, entryId } })
    })
  }

  /** Watches each listed chat for the shown lead, and holds each open as a tab does while it shows a row, so that a
   *  closed tab returns its chat to the list (PI-INTERACTION-082). A change of the shown lead moves every watch and
   *  hold; otherwise only the chats that `joined` and `left` name change, so a fact costs one watch at most, whatever
   *  the size of the list. While no lead shows, nothing is watched or held, and tabs close as without a lead. */
  const applyWatches = (joined: readonly string[], left: readonly string[]): void => {
    const lead = shownLead()
    const events = services.executionEnvironment().sessionEvents
    if (watched?.lead !== lead) {
      if (watched) for (const chat of watched.chats) events.unwatch(watched.lead, chat)
      opened?.drop()
      watched = undefined
      leadRunner = false
      if (lead === null) return
      // The new lead chat leaves its own row.
      rows?.remove(lead)
      watched = { lead, chats: new Set() }
      leadRunner = hasRunner(lead)
      watch(listed())
      // The results and questions that waited while no lead showed go to the lead that shows now.
      postWaiting()
      return
    }
    if (!watched) return
    watch(joined)
    for (const chat of left) {
      if (!watched.chats.delete(chat)) continue
      events.unwatch(watched.lead, chat)
      opened?.release(chat)
    }
  }

  function watch(chats: readonly string[]): void {
    if (!watched) return
    const events = services.executionEnvironment().sessionEvents
    for (const chat of chats) {
      if (chat === watched.lead || watched.chats.has(chat)) continue
      events.watch(watched.lead, chat, NOTICE_KINDS)
      // A chat whose row is not built yet is held, so its tab's close waits for its row.
      if (!rows?.resting(chat)) opened?.hold(chat)
      watched.chats.add(chat)
    }
  }

  /** Follows the listed chats' rows while the module is on. Turning it off releases every fold and removes each row
   *  that a client holds; turning it on builds the rows again. */
  const applyRows = (joined: readonly string[], left: readonly string[]): void => {
    if (disposed || !services.enabled()) {
      if (!rows) return
      const ended = rows
      rows = undefined
      const shown = ended.rows()
      // The owner stops at once, so no patch of its in-flight work follows these removals.
      const ending = ended.dispose()
      for (const row of shown) publishRow({ kind: "removed", sessionId: row.sessionId })
      endings = Promise.all([endings, ending.catch((error: unknown) => { log.warn("the lead rows could not end", { error: errorMessage(error) }) })])
      return
    }
    let chats: readonly string[] = joined
    if (!rows) {
      const owner: LeadRows = createLeadRows({
        reader: services.projectionReader,
        sessionManager: services.sessionManager,
        sessionStore: services.sessionStore,
        sessionRuntime: (sessionId) => services.executionEnvironment().sessionRuntime(sessionId),
        readMark: (sessionId) => journal.state().readMarks.get(sessionId),
        seenMark: (sessionId) => journal.state().seenMarks.get(sessionId),
        // Only the current owner publishes: an owner that a turn-off ended may still settle work it started.
        publish: (change) => { if (rows === owner) publishRow(change) },
        onRest: (sessionId) => { if (rows === owner) letGoLater(sessionId) },
      })
      rows = owner
      chats = listed()
    }
    for (const sessionId of left) rows.remove(sessionId)
    const designated = journal.state().designated
    // The builds run beside the journal's lane: a fold's first replay reads through a position captured after it starts.
    void rows.add(chats.filter((sessionId) => sessionId !== designated))
  }

  const follow = (joined: readonly string[] = [], left: readonly string[] = []): void => {
    if (!started || disposed) return
    applyWatches(joined, left)
    applyRows(joined, left)
  }

  /** Follows the facts that the journal applied, whoever read them, so no read of the journal hides one from the
   *  watches and the rows. */
  const applyFacts = (applied: readonly LeadFact[]): void => {
    if (applied.length === 0) return
    follow(joinedChats(applied), closedChats(applied))
    for (const sessionId of markedChats(applied)) rows?.refresh(sessionId)
  }

  const reconcileJournal = async (): Promise<void> => { applyFacts(await journal.reconcile()) }

  /** Records a chat's join and follows it. The journal folds its own append, so the store's broadcast of it applies
   *  nothing: the follow happens here. */
  async function join(sessionId: string, briefed: boolean, cause: "created" | "activated" | "started" | "routed" | "in use" | "first run"): Promise<void> {
    if (sessionId === journal.state().designated || !await journal.append({ type: "lead.chat.joined", payload: { sessionId, briefed } })) return
    log.info("chat joined the lead's list", { sessionId, cause, briefed })
    follow([sessionId])
  }

  /** Joins each chat other than the lead that became active and is not in the list (ARCH-SESSIONS-050): a root chat
   *  of kind chat, also a fork or a kept side question, which only names the chat it came from. A chat that the batch
   *  created is a chat by its creation fact; any other activation reads the chat once. A chat holds the lead's rules
   *  when it starts while they apply (PI-LEAD-012): it joins at its creation, or it ran no turn yet, as a chat that
   *  was created while execution was paused and becomes active with its first message. */
  async function joinActivated(activations: readonly Activation[]): Promise<void> {
    if (!services.enabled()) return
    for (const { sessionId, created } of activations) {
      const state = journal.state()
      if (state.members.has(sessionId) || sessionId === state.designated) continue
      let fresh = created
      if (!created) {
        const session = await services.sessionManager.read(sessionId)
        if (session?.kind !== "chat") continue
        fresh = briefable() && !await conversationHoldsMessage(services.projectionReader, session.conversationId, "assistant")
      }
      await join(sessionId, fresh && briefable(), created ? "created" : "activated")
    }
  }

  /** A chat that the person closed or deleted leaves the list, and so does one that came to rest with nothing for the
   *  person and is no longer open (PI-LEAD-004). */
  async function leave(sessionId: string, cause: "closed" | "deleted" | "at rest"): Promise<void> {
    const type = cause === "at rest" ? "lead.chat.retired" : "lead.chat.closed"
    if (!services.enabled() || !await journal.append({ type, payload: { sessionId } })) return
    log.info("chat left the lead's list", { sessionId, cause })
    follow([], [sessionId])
  }

  /** Lets go of a listed chat at rest with nothing for the person (PI-LEAD-004). A chat that a client shows, or that
   *  another holder holds open, stays in the list with no row until a release tells of it again; so does a new chat
   *  that waits for its first message (`LeadRows.resting`). Any other chat closes as a closed tab does and leaves the list, so every chat in
   *  use stays a member and a retired chat joins again when it becomes active. */
  async function letGoAtRest(sessionId: string): Promise<void> {
    const state = journal.state()
    if (!opened || !rows?.resting(sessionId) || !state.members.has(sessionId) || sessionId === state.designated) return
    if (await opened.close(sessionId)) await leave(sessionId, "at rest")
  }

  const letGoLater = (sessionId: string): void => {
    own(() => letGoAtRest(sessionId), (error) => { log.warn("the lead list could not let go of a chat at rest", { sessionId, error }) })
  }

  /** Adopts what no stored batch told the list while the module was off or before this process: each active chat
   *  other than the lead that is not in the list joins, and each member whose chat was deleted leaves. Runs at the
   *  start and at each turn on. It joins only chats in use, so a runtime stop that deactivated members removes none. */
  async function reconcileMembers(): Promise<void> {
    if (!started || disposed || !services.enabled()) return
    const active = (await services.sessionManager.listActive()).sessions
    for (const session of active) {
      const state = journal.state()
      if (session.kind === "chat" && session.id !== state.designated && !state.members.has(session.id)) await join(session.id, false, "in use")
    }
    const members = listed()
    if (members.length > 0) {
      const known = await services.sessionManager.listForIds(members)
      // A chat that the catalog cannot read still exists.
      const present = new Set([...known.sessions.map((session) => session.id), ...known.errors.map((error) => error.sessionId)])
      for (const sessionId of members) if (!present.has(sessionId)) await leave(sessionId, "deleted")
    }
    await seedStarted()
  }

  // Remove after 2027-05-15: a project whose lead kept no list yet lists only the chats that the lead started.
  /** The first run of a list in a project: every chat that the lead started and that the rule before the list showed,
   *  one that needs the person, works, or holds an unread result, joins, unless the person closed it since. The run
   *  ends with `lead.list.seeded`, so a run that stopped before it runs again at the next start. */
  async function seedStarted(): Promise<void> {
    const state = journal.state()
    if (state.seeded || !rows) return
    const earlier = [...state.started.keys()].filter((sessionId) => sessionId !== state.designated && !state.members.has(sessionId) && !state.closed.has(sessionId))
    const owner = rows
    await owner.add(earlier)
    let joined = 0
    for (const sessionId of earlier) {
      const row = (await owner.chat(sessionId))?.row
      if (row === undefined) {
        owner.remove(sessionId)
        continue
      }
      await join(sessionId, false, "first run")
      joined += 1
    }
    if (await journal.append({ type: "lead.list.seeded", payload: {} })) log.info("lead list seeded", { started: joined })
  }

  const unsubscribeStored = services.onStored((events) => {
    if (disposed) return
    own(async () => {
      applyFacts(await journal.observe(events))
      const { activations, deleted } = sessionChanges(events)
      await joinActivated(activations)
      for (const sessionId of deleted) if (journal.state().members.has(sessionId)) await leave(sessionId, "deleted")
      await rows?.observe(events)
    }, (error) => { log.warn("the lead journal could not fold a stored batch", { error }) })
  })
  // A lead whose runner attaches reads what waited for it: each change of the lead's store entry costs one read of
  // that entry, and only an attach posts, once per row (PI-LEAD-006).
  const unsubscribeStore = services.sessionStore.onChange((changed) => {
    const lead = watched?.lead
    if (disposed || lead === undefined || (changed !== undefined && !changed.has(lead))) return
    const attached = hasRunner(lead)
    const before = leadRunner
    leadRunner = attached
    if (!attached || before) return
    log.info("lead runner attached; posting what waited", { leadSessionId: lead, waiting: waiting.size })
    // After the posts in flight settle: one that read the lead at rest before the attach answers that it waits.
    posting = posting.then(postWaiting)
  }, "lead-service")
  const unsubscribeSelection = services.onSelectionChanged(() => {
    follow()
    own(reconcileMembers, (error) => { log.warn("the lead list could not adopt the chats in use", { error }) })
  })

  const chatTitle = async (sessionId: string): Promise<string | undefined> => {
    const session = await services.sessionManager.read(sessionId)
    return session?.kind === "chat" ? sessionDisplayName({ id: sessionId, session }) : undefined
  }

  /** Whether the lead can route to a chat: any root chat of the project but the lead, also one that left the list or
   *  never joined it (PI-LEAD-002). A route to it delivers and reopens it, so it joins the list. */
  const routable = async (sessionId: string): Promise<boolean> =>
    sessionId !== journal.state().designated && (await services.sessionManager.read(sessionId))?.kind === "chat"

  /** The target of a route: the chat that the person's entries already started, or a new chat that this call
   *  records, lists, and watches before anything reaches it, so its first request and its first event find all. */
  const routeTarget = async (input: RouteInput, forward: LeadForward & { readonly sourceEntryIds: NonEmptyIds }): Promise<{ readonly sessionId: string; readonly started?: "now" | "earlier" } | { readonly refused: string }> => {
    const state = journal.state()
    if (input.kind === "existing") {
      if (input.chat === undefined || !await routable(input.chat)) return { refused: `${input.chat ?? "(none named)"} is not a session of this project that you can route to` }
      return { sessionId: input.chat }
    }
    const earlier = state.startedBy(forward)
    if (earlier !== undefined && await chatTitle(earlier) !== undefined) return { sessionId: earlier, started: "earlier" }
    const sessionId = await services.executionEnvironment().openChat({})
    await journal.append({ type: "lead.chat.started", payload: { sessionId, ...forward } })
    await join(sessionId, briefable(), "started")
    log.info("lead started a chat", { leadSessionId: input.leadSessionId, sessionId, entries: forward.sourceEntryIds.length, split: forward.passagesHash !== undefined })
    return { sessionId, started: "now" }
  }

  /** Appends a read or seen mark of a listed chat and reads its row again. */
  async function appendMark(sessionId: string, fact: Parameters<LeadJournal["append"]>[0]): Promise<MarkOutcome> {
    if (!services.enabled()) return { ok: true }
    await reconcileJournal()
    if (!journal.state().members.has(sessionId)) return { ok: false, error: `session ${sessionId} is not in the lead's list` }
    // The journal folds its own append, so the store's broadcast of it applies nothing: refresh the row here.
    if (await journal.append(fact)) rows?.refresh(sessionId)
    return { ok: true }
  }

  const role = (sessionId: string): LeadRole | undefined => {
    const state = journal.state()
    // The lead chat joins at its creation, before its designation lands, so its join never makes it a listed chat.
    if (state.designated === sessionId) return state.dismissed ? undefined : "lead"
    if (state.started.has(sessionId)) return "started"
    return state.briefed.has(sessionId) ? "briefed" : undefined
  }

  return {
    journal,
    start() {
      started = true
      const environment = services.executionEnvironment()
      opened = environment.createOpenHold()
      unsubscribeClosed = environment.onChatClosed((sessionId) => {
        if (!disposed) own(() => leave(sessionId, "closed"), (error) => { log.warn("the lead could not record a closed chat", { sessionId, error }) })
      })
      // A chat that rested while a client showed it is let go once no client shows it.
      unsubscribeReleased = environment.onSessionReleased((sessionId) => {
        if (!disposed && rows?.resting(sessionId)) letGoLater(sessionId)
      })
      own(async () => {
        applyFacts(await journal.reconcile())
        follow()
        await reconcileMembers()
      }, (error) => { log.error("the lead journal could not replay", { error }) })
    },
    async view() {
      await reconcileJournal()
      return services.enabled() ? { rows: rows?.rows() ?? [] } : EMPTY_LEAD_CHATS
    },
    role,
    async settledListingLead(sessionId) {
      await background
      const lead = shownLead()
      return lead !== null && sessionId !== lead && journal.state().members.has(sessionId) ? lead : null
    },
    async settledRole(sessionId) {
      await background
      return role(sessionId)
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
      const { parts } = input
      if (parts !== undefined) {
        // The kernel checks the passages again at the forward; this check refuses before a new chat starts.
        const located = locatePassages(entries.map((entry) => entry.text), parts)
        if (!located.ok) return located
      }
      const forward = { sourceEntryIds, ...(parts === undefined ? {} : { passagesHash: passagesHash(parts) }) }
      await reconcileJournal()
      const target = await routeTarget(input, forward)
      if ("refused" in target) return { ok: false, reason: target.refused }
      // A chat that the lead gives a request to holds the lead's rules from then on (PI-LEAD-012). The briefing lands
      // before the forward, so the turn that the forward starts already renders them. A forward that the kernel
      // refuses leaves the chat briefed, which is accepted: the rules only shape its questions and reports, which the lead
      // reads either way.
      if (target.started === undefined && await journal.append({ type: "lead.chat.briefed", payload: { sessionId: target.sessionId } })) {
        log.info("lead briefed a chat", { leadSessionId: input.leadSessionId, sessionId: target.sessionId })
      }
      const forwarded = await environment.forwardPersonEntries({ sourceSessionId: input.leadSessionId, entryIds: sourceEntryIds, targetSessionId: target.sessionId, ...(parts === undefined ? {} : { passages: parts }) })
      if (!forwarded.ok) return forwarded
      // A chat that left the list joins it again (PI-LEAD-002), also when its activation records no lifecycle change.
      // It joins after the forward commits, so its row's first build reads the person's message and never finds it
      // at rest.
      if (target.started !== "now") await join(target.sessionId, false, "routed")
      const recorded = await journal.append({ type: "lead.request.forwarded", payload: {
        leadSessionId: input.leadSessionId, targetSessionId: target.sessionId, newChat: target.started === "now", ...forward,
      } })
      if (recorded) log.info("lead forwarded a request", { leadSessionId: input.leadSessionId, sessionId: target.sessionId, entries: sourceEntryIds.length, split: parts !== undefined })
      return {
        ok: true, sessionId: target.sessionId, title: await chatTitle(target.sessionId) ?? target.sessionId,
        ...(target.started ? { started: target.started } : {}), entries, recorded,
      }
    },
    async progress(chat, before) {
      await reconcileJournal()
      const current = rows
      if (!current) return { kind: "refused", reason: "the lead is off" }
      const deps = {
        reader: services.projectionReader, sessionManager: services.sessionManager, sessionStore: services.sessionStore,
        chat: (sessionId: string) => current.read(sessionId),
        agentCards: (sessionId: string) => services.executionEnvironment().liveAgentCards(sessionId),
      }
      if (chat === undefined) return readChatRoster(deps, current.rows().map((row) => row.sessionId))
      if (!await routable(chat)) return { kind: "refused", reason: `${chat} is not a session of this project other than you` }
      return readChatDetail(deps, chat, before)
    },
    async findChats(query) {
      await reconcileJournal()
      const { designated } = journal.state()
      const { chats } = await services.executionEnvironment().findChats({ query, exclude: designated === null ? [] : [designated] })
      const { members } = journal.state()
      return chats.map((chat) => ({ ...chat, listed: members.has(chat.sessionId) }))
    },
    markRead: (sessionId, entryId) => appendMark(sessionId, { type: "lead.result.read", payload: { sessionId, entryId } }),
    markSeen: (sessionId, state, entryId) => appendMark(sessionId, { type: "lead.chat.seen", payload: { sessionId, state, entryId } }),
    async question(sessionId, toolUseId) {
      if (!services.enabled()) return { state: "unknown" }
      // One keyed lookup in a held fold, at a pending widget's mount or at a change of its chat's question, never per
      // stored batch. An ask_user call's interaction id is its call id.
      const entry = (await loadAgentInputProjection(services.projectionReader, sessionId)).get(toolUseId)
      switch (entry?.kind) {
        case "pending": return {
          state: "pending",
          question: { kind: "question", toolUseId, questions: [...entry.request], timestamp: entry.openedAt },
          context: rows?.questions(sessionId).find((pending) => pending.toolUseId === toolUseId)?.context ?? null,
        }
        case "answered": return { state: "answered", answers: formatAgentInputAnswers(entry.answers) }
        case "cancelled": return { state: "skipped" }
        case "withdrawn": return { state: "withdrawn" }
        default: return { state: "unknown" }
      }
    },
    async dispose() {
      disposed = true
      unsubscribeStored()
      unsubscribeStore()
      unsubscribeClosed?.()
      unsubscribeReleased?.()
      await unsubscribeSelection()
      await background
      // `disposed` makes the shown lead null, so this releases every watch and hold.
      applyWatches([], [])
      const ending = rows?.dispose()
      rows = undefined
      await Promise.all([ending, endings, posting])
    },
  }
}
