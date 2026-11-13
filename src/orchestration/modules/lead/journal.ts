import { capturedFacts, type AsyncEventReadSurface, type AsyncGuardedEventAppender, type StoredFact } from "../../../infra/event-store-types.js"
import { LEAD_AGGREGATE_ID, parseLeadFact, type LeadFact } from "./facts.js"

/** The session id that every lead fact carries: the aggregate is the project's, not one session's. */
const JOURNAL_SESSION_ID = "lead"

interface LeadForward {
  readonly leadSessionId: string
  readonly targetSessionId: string
  readonly newChat: boolean
  readonly sourceEntryIds: readonly string[]
}

/** What the `lead` aggregate states, folded from its facts in sequence order. */
interface LeadJournalState {
  readonly lastSeq: number
  readonly designated: string | null
  readonly dismissed: boolean
  /** Each started chat and the ids of the person's entries that started it. */
  readonly started: ReadonlyMap<string, readonly string[]>
  readonly forwards: readonly LeadForward[]
  /** Each started chat's newest read result entry. */
  readonly readMarks: ReadonlyMap<string, string>
}

/** One lead fact as a caller states it: its type and its payload. */
type LeadFactInput = LeadFact extends infer Fact ? Fact extends LeadFact ? Pick<Fact, "type" | "payload"> : never : never

export interface LeadJournal {
  /** Folds what was committed since the last read and answers the facts it applied. */
  reconcile(): Promise<readonly StoredFact[]>
  /** Folds a committed batch of the store's broadcast and answers the lead facts it applied. */
  observe(events: readonly StoredFact[]): Promise<readonly StoredFact[]>
  /** Appends one fact, unless the state already holds it. Answers whether it appended. */
  append(fact: LeadFactInput): Promise<boolean>
  state(): LeadJournalState
}

interface LeadJournalDeps {
  readonly reader: AsyncEventReadSurface
  readonly writer: AsyncGuardedEventAppender
  readonly now?: () => number
}

const EMPTY_STATE: LeadJournalState = { lastSeq: -1, designated: null, dismissed: false, started: new Map(), forwards: [], readMarks: new Map() }

const sameIds = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((id, index) => right[index] === id)

function reduce(state: LeadJournalState, fact: LeadFact, seq: number): LeadJournalState {
  switch (fact.type) {
    case "lead.chat.designated":
      return { ...state, lastSeq: seq, designated: fact.payload.sessionId, dismissed: false }
    case "lead.chat.dismissed":
      return { ...state, lastSeq: seq, dismissed: state.dismissed || fact.payload.sessionId === state.designated }
    case "lead.chat.started":
      return { ...state, lastSeq: seq, started: new Map([...state.started, [fact.payload.sessionId, fact.payload.sourceEntryIds]]) }
    case "lead.request.forwarded":
      return { ...state, lastSeq: seq, forwards: [...state.forwards, fact.payload] }
    case "lead.result.read":
      return { ...state, lastSeq: seq, readMarks: new Map([...state.readMarks, [fact.payload.sessionId, fact.payload.entryId]]) }
  }
}

/** Whether appending `fact` would leave the state as it is. */
function holds(state: LeadJournalState, fact: LeadFact): boolean {
  switch (fact.type) {
    case "lead.chat.designated":
      return state.designated === fact.payload.sessionId && !state.dismissed
    case "lead.chat.dismissed":
      return state.designated !== fact.payload.sessionId || state.dismissed
    case "lead.chat.started":
      return state.started.has(fact.payload.sessionId)
    case "lead.request.forwarded":
      return state.forwards.some((forward) => forward.targetSessionId === fact.payload.targetSessionId && sameIds(forward.sourceEntryIds, fact.payload.sourceEntryIds))
    case "lead.result.read":
      return state.readMarks.get(fact.payload.sessionId) === fact.payload.entryId
  }
}

/** Owns strict replay, sequence-guarded appends, and the one in-memory state of the `lead` aggregate. */
export function createLeadJournal(deps: LeadJournalDeps): LeadJournal {
  const now = deps.now ?? Date.now
  let state = EMPTY_STATE
  let position = 0
  let replay = Promise.resolve<readonly StoredFact[]>([])

  const fold = (events: readonly StoredFact[]): StoredFact[] => {
    const applied: StoredFact[] = []
    for (const event of events) {
      if (event.aggregateId !== LEAD_AGGREGATE_ID || event.seq <= state.lastSeq) continue
      if (event.seq !== state.lastSeq + 1) throw new Error(`The lead journal skips from sequence ${state.lastSeq} to ${event.seq}`)
      state = reduce(state, parseLeadFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload }), event.seq)
      applied.push(event)
    }
    return applied
  }

  const reconcile = (): Promise<readonly StoredFact[]> => {
    const next = replay.then(async () => {
      const upper = await deps.reader.capturePosition()
      const applied: StoredFact[] = []
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
        if (holds(state, fact)) return false
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
