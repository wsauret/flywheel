import { capturedFacts, type AsyncEventReadSurface, type AsyncGuardedEventAppender, type StoredFact } from "../../../infra/event-store-types.js"
import type { LeadSeenState } from "../../../protocol/modules/lead.js"
import { LEAD_AGGREGATE_ID, parseLeadFact, type LeadFact } from "./facts.js"

/** The session id that every lead fact carries: the aggregate is the project's, not one session's. */
const JOURNAL_SESSION_ID = "lead"

/** What the `lead` aggregate states, folded from its facts in sequence order. Each fact updates the state in place
 *  and touches only the entries that it names, so a fold costs the same for any number of chats. */
interface LeadJournalState {
  readonly lastSeq: number
  readonly designated: string | null
  readonly dismissed: boolean
  /** Each started chat and the ids of the person's entries that started it. */
  readonly started: ReadonlyMap<string, readonly string[]>
  /** The chats of the lead's list: each chat whose newest join no close or retirement followed (ARCH-SESSIONS-050).
   *  It can hold the lead chat itself, which joins at its creation before its designation lands, and a deleted chat. */
  readonly members: ReadonlySet<string>
  /** The chats that joined at their creation while the lead showed (`lead.chat.joined`). */
  readonly briefed: ReadonlySet<string>
  /** The chats whose newest list fact is a close, so the person closed them. */
  readonly closed: ReadonlySet<string>
  /** Whether the first run of the list adopted the chats of the rule before it (`lead.list.seeded`). */
  readonly seeded: boolean
  /** Each chat's newest read result entry. */
  readonly readMarks: ReadonlyMap<string, string>
  /** Each chat's newest failed or cut state that the person saw, at its entry. */
  readonly seenMarks: ReadonlyMap<string, { readonly state: LeadSeenState; readonly entryId: string }>
  /** The chat that a forward started. */
  startedBy(forward: LeadForward): string | undefined
  /** Whether the journal holds this forward to this chat. */
  forwarded(targetSessionId: string, forward: LeadForward): boolean
}

/** One forward of the person's words: the person's entries, in order, and for a split request the hash of its
 *  passages. */
export interface LeadForward {
  readonly sourceEntryIds: readonly string[]
  readonly passagesHash?: string
}

/** One lead fact as a caller states it: its type and its payload. */
type LeadFactInput = LeadFact extends infer Fact ? Fact extends LeadFact ? Pick<Fact, "type" | "payload"> : never : never

export interface LeadJournal {
  /** Folds what was committed since the last read and answers the facts it applied. */
  reconcile(): Promise<readonly LeadFact[]>
  /** Folds a committed batch of the store's broadcast and answers the lead facts it applied. */
  observe(events: readonly StoredFact[]): Promise<readonly LeadFact[]>
  /** Appends one fact, unless the state already holds it. Answers whether it appended. */
  append(fact: LeadFactInput): Promise<boolean>
  state(): LeadJournalState
}

interface LeadJournalDeps {
  readonly reader: AsyncEventReadSurface
  readonly writer: AsyncGuardedEventAppender
  readonly now?: () => number
}

// Entry ids and hashes hold no line break or tab, so the joined parts name one forward.
const sourceKey = ({ sourceEntryIds, passagesHash }: LeadForward): string => `${sourceEntryIds.join("\n")}\t${passagesHash ?? ""}`
const forwardKey = (targetSessionId: string, forward: LeadForward): string => `${targetSessionId}\n${sourceKey(forward)}`

/** The one mutable state of a journal, with its fold and its rule for a fact that it already holds. */
function createLeadState() {
  const started = new Map<string, readonly string[]>()
  const startedBySource = new Map<string, string>()
  const forwards = new Set<string>()
  const members = new Set<string>()
  const briefed = new Set<string>()
  const closed = new Set<string>()
  const readMarks = new Map<string, string>()
  const seenMarks = new Map<string, { readonly state: LeadSeenState; readonly entryId: string }>()
  let lastSeq = -1
  let designated: string | null = null
  let dismissed = false
  let seeded = false

  const state: LeadJournalState = {
    get lastSeq() { return lastSeq },
    get designated() { return designated },
    get dismissed() { return dismissed },
    get seeded() { return seeded },
    started,
    members,
    briefed,
    closed,
    readMarks,
    seenMarks,
    startedBy: (forward) => startedBySource.get(sourceKey(forward)),
    forwarded: (targetSessionId, forward) => forwards.has(forwardKey(targetSessionId, forward)),
  }

  function apply(fact: LeadFact, seq: number): void {
    lastSeq = seq
    switch (fact.type) {
      case "lead.chat.designated":
        designated = fact.payload.sessionId
        dismissed = false
        return
      case "lead.chat.dismissed":
        dismissed ||= fact.payload.sessionId === designated
        return
      case "lead.chat.started":
        started.set(fact.payload.sessionId, fact.payload.sourceEntryIds)
        startedBySource.set(sourceKey(fact.payload), fact.payload.sessionId)
        return
      case "lead.request.forwarded":
        forwards.add(forwardKey(fact.payload.targetSessionId, fact.payload))
        return
      case "lead.result.read":
        readMarks.set(fact.payload.sessionId, fact.payload.entryId)
        return
      case "lead.chat.seen":
        seenMarks.set(fact.payload.sessionId, { state: fact.payload.state, entryId: fact.payload.entryId })
        return
      case "lead.chat.joined":
        members.add(fact.payload.sessionId)
        closed.delete(fact.payload.sessionId)
        if (fact.payload.briefed) briefed.add(fact.payload.sessionId)
        return
      case "lead.chat.closed":
        members.delete(fact.payload.sessionId)
        closed.add(fact.payload.sessionId)
        return
      case "lead.chat.retired":
        members.delete(fact.payload.sessionId)
        return
      case "lead.list.seeded":
        seeded = true
        return
    }
  }

  /** Whether appending `fact` would leave the state as it is. */
  function holds(fact: LeadFact): boolean {
    switch (fact.type) {
      case "lead.chat.designated":
        return designated === fact.payload.sessionId && !dismissed
      case "lead.chat.dismissed":
        return designated !== fact.payload.sessionId || dismissed
      case "lead.chat.started":
        return started.has(fact.payload.sessionId)
      case "lead.request.forwarded":
        return state.forwarded(fact.payload.targetSessionId, fact.payload)
      case "lead.result.read":
        return readMarks.get(fact.payload.sessionId) === fact.payload.entryId
      case "lead.chat.seen": {
        const seen = seenMarks.get(fact.payload.sessionId)
        return seen?.state === fact.payload.state && seen.entryId === fact.payload.entryId
      }
      case "lead.chat.joined":
        return members.has(fact.payload.sessionId)
      case "lead.chat.closed":
      case "lead.chat.retired":
        return !members.has(fact.payload.sessionId)
      case "lead.list.seeded":
        return seeded
    }
  }

  return { state, apply, holds }
}

/** Owns strict replay, sequence-guarded appends, and the one in-memory state of the `lead` aggregate. */
export function createLeadJournal(deps: LeadJournalDeps): LeadJournal {
  const now = deps.now ?? Date.now
  const { state, apply, holds } = createLeadState()
  let position = 0
  let replay = Promise.resolve<readonly LeadFact[]>([])

  const fold = (events: readonly StoredFact[]): LeadFact[] => {
    const applied: LeadFact[] = []
    for (const event of events) {
      if (event.aggregateId !== LEAD_AGGREGATE_ID || event.seq <= state.lastSeq) continue
      if (event.seq !== state.lastSeq + 1) throw new Error(`The lead journal skips from sequence ${state.lastSeq} to ${event.seq}`)
      const fact = parseLeadFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
      apply(fact, event.seq)
      applied.push(fact)
    }
    return applied
  }

  const reconcile = (): Promise<readonly LeadFact[]> => {
    const next = replay.then(async () => {
      const upper = await deps.reader.capturePosition()
      const applied: LeadFact[] = []
      for await (const item of capturedFacts(deps.reader, { aggregateId: LEAD_AGGREGATE_ID }, { upperPosition: upper, afterPosition: position })) {
        applied.push(...fold([item]))
      }
      position = upper
      return applied
    })
    replay = next.catch(() => [])
    return next
  }

  return {
    reconcile,
    async observe(events) {
      const relevant = events.filter((event) => event.aggregateId === LEAD_AGGREGATE_ID).toSorted((left, right) => left.seq - right.seq)
      const first = relevant[0]
      if (!first) return []
      // A batch past the next sequence means a commit this connection did not see: read it first.
      const applied = first.seq > state.lastSeq + 1 ? [...await reconcile()] : []
      return [...applied, ...fold(relevant)]
    },
    async append(input) {
      for (;;) {
        await reconcile()
        const fact = parseLeadFact({ type: input.type, version: 1, actor: "system", payload: input.payload })
        if (holds(fact)) return false
        const result = await deps.writer.appendGuarded({
          aggregateId: LEAD_AGGREGATE_ID,
          type: fact.type,
          version: 1,
          timestamp: now(),
          actor: "system",
          sessionId: JOURNAL_SESSION_ID,
          payload: fact.payload,
          expectedSeq: state.lastSeq + 1,
        })
        if (result.kind === "stored") {
          fold(result.events)
          return true
        }
      }
    },
    state: () => state,
  }
}
