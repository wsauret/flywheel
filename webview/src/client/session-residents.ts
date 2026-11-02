import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { ResidentLanes } from "../../../src/protocol/client/residency.js"
import type { ReadingState } from "../../../src/protocol/client/reading-state.js"
import type { LocalChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import { createSessionChangesController, type SessionChangesController } from "../../../src/protocol/client/session-changes.js"
import { createTranscriptStore, type TranscriptChange, type TranscriptStore } from "../../../src/protocol/client/transcript-store.js"
import type { HydratedOutputBlockBody } from "../../../src/protocol/transcript-protocol-types.js"
import { CHAT_SLOT } from "./active-model.js"
import { createSessionModuleMonitors, type SessionModuleMonitors } from "./module-domain-views.js"
import { createSeatReading, type SeatReading } from "./session-seat.js"
import type { createWebTranscript } from "./tool-runs.js"
import type { createTurnFolds } from "./turn-folds.js"
import type { HeldRoles } from "./session-roles.js"

/** How many recently shown sessions a web client keeps resident. */
export const WEB_RESIDENT_SESSIONS = 8
/** How many bytes of opened bodies the residents keep together. A body can
 *  be a whole file or an image, and each resident window already has its own
 *  block bound, so this bounds what eight windows of opened rows can hold. */
const RESIDENT_BODY_BYTES = 16 * 1024 * 1024

const measured = new WeakMap<HydratedOutputBlockBody, number>()
function bodyBytes(body: HydratedOutputBlockBody): number {
  let bytes = measured.get(body)
  if (bytes === undefined) {
    bytes = JSON.stringify(body).length
    measured.set(body, bytes)
  }
  return bytes
}
const residentBodyBytes = (resident: ResidentSession): number =>
  resident.transcript.mutationEvidence.heldBytes + Object.values(resident.transcript.view.bodies).reduce((total, body) => total + bodyBytes(body), 0)

/** Keeps the opened bodies of all residents, least recently used first,
 *  within the shared budget: the hidden resident used least recently drops
 *  all of its bodies first, until the rest fit. The shown session keeps its
 *  own. A row the person left open reads its body again when its session is
 *  shown. */
export function trimResidentBodies(residents: readonly ResidentSession[], shown: ResidentSession | undefined): void {
  let total = residents.reduce((sum, resident) => sum + residentBodyBytes(resident), 0)
  for (const resident of residents) {
    if (total <= RESIDENT_BODY_BYTES) return
    const bytes = resident === shown ? 0 : residentBodyBytes(resident)
    if (bytes === 0) continue
    total -= bytes
    resident.transcript.releaseBodies()
  }
}

/** What the page's surfaces leave in a resident session when the person
 *  leaves it, which they restore when the person returns. */
export interface SessionMemory {
  reader?: import("../../../src/protocol/client/transcript-store.js").TranscriptReader
  /** Group keys and inferred fold openness survive coordinate recovery and
   *  navigation while this session stays resident. */
  presentation?: {
    readonly transcript: ReturnType<typeof createWebTranscript>
    readonly turnFolds: ReturnType<typeof createTurnFolds>
  }
  /** The reader's place, and how many messages the reader had seen, so a
   *  return counts only what arrived since as new. */
  place?: { readonly reading: ReadingState; readonly seenMessages: number }
  /** The message the person was writing, with its files. */
  draft?: LocalChatSubmission["input"]
}

/** Everything a page keeps for one session it showed recently: the
 *  transcript window with its opened bodies, the changes, the workflow view,
 *  the seat, the session's module views, and what the surfaces left in it.
 *  Each reader follows its own cursor through the lanes the residency hands
 *  it, so a hidden session stays current on an unbroken lane and goes dormant
 *  when the lane breaks. A return shows all of it at once. */
export interface ResidentSession {
  readonly transcript: TranscriptStore
  readonly changes: SessionChangesController
  readonly modules: SessionModuleMonitors
  readonly seat: SeatReading
  readonly memory: SessionMemory
  /** Marks the session as shown or hidden. A hidden session's changes reach
   *  only the readers that every session needs, never the page's render. */
  show(shown: boolean): void
  dispose(): void
}

export interface ResidentSessionOptions {
  readonly connection: Pick<RuntimeConnection, "query" | "dispatch" | "watchOutput">
  readonly lanes: ResidentLanes
  readonly sessionId: string
  readonly roles?: Pick<HeldRoles, "get" | "subscribe">
  /** The session was just created, so its transcript is empty. */
  readonly knownEmpty?: boolean
  /** Hears every transcript change, shown or hidden, so the page's local
   *  messages retire whichever session the runtime adopts them in. */
  readonly transcriptChanged: (change: TranscriptChange, store: TranscriptStore) => void
  /** Hears evidence residency changes, including in hidden sessions. */
  readonly evidenceChanged?: () => void
  /** Hears a change of a shown session's views. */
  readonly changed: () => void
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
}

export function createResidentSession(options: ResidentSessionOptions): ResidentSession {
  const { sessionId, lanes } = options
  const connection = { query: options.connection.query, dispatch: options.connection.dispatch, watchOutput: options.connection.watchOutput, subscribe: lanes.subscribe, onLane: lanes.onLane }
  const diagnostic = options.onDiagnostic === undefined ? {} : { onDiagnostic: options.onDiagnostic }
  let shown = false
  const changed = (): void => { if (shown) options.changed() }

  const memory: SessionMemory = {}
  const transcript = createTranscriptStore({ connection, sessionId, reader: () => memory.reader, ...(options.knownEmpty === true ? { knownEmpty: true } : {}), ...diagnostic })
  const stopTranscript = transcript.onChange((change) => {
    options.transcriptChanged(change, transcript)
    changed()
  })
  const stopEvidence = transcript.mutationEvidence.onChange(() => {
    options.evidenceChanged?.()
    changed()
  })
  const changes = createSessionChangesController({ client: connection, sessionId })
  const stopChanges = changes.onChange(changed)
  void changes.start()
  const modules = createSessionModuleMonitors({ connection, sessionId, onChange: changed })
  const seat = createSeatReading({ connection, sessionId, slot: () => CHAT_SLOT, roles: options.roles, changed })
  return {
    transcript,
    changes,
    modules,
    seat,
    memory,
    show(next) {
      shown = next
      seat.show(next)
    },
    dispose() {
      shown = false
      stopTranscript()
      stopEvidence()
      transcript.dispose()
      stopChanges()
      changes.dispose()
      modules.dispose()
      seat.dispose()
    },
  }
}
