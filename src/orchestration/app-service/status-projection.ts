import type { StoredFact } from "../../infra/event-store-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { SessionEntry } from "../session-store/types.js"
import { entryActivity } from "../session-store/activity.js"
import { createSessionViewProjection, type ViewedSessionStore } from "./session-view-projection.js"
import { isActiveActivity } from "../../protocol/app-service-types.js"
import { statusCursor, type StatusView } from "../../protocol/status-protocol-types.js"
import type { RuntimePosition, RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { CommandKeeper } from "./command-keeper.js"
import { toReplyWaitViews, type OpenReplyWaitView } from "../session/reply-waits.js"
import { displayedReplyWait } from "../../protocol/client/session-controls.js"
import type { ProcessorClaims } from "../agent-runtime/tools/processor-claims.js"

const log = Log.create({ service: "status-projection" })

export interface StatusProjection {
  snapshot(sessionId: string): Promise<StatusView | null>
  /** Projects the session again from what it is now and publishes what
   *  changed: for a change its store entry does not show, such as the end
   *  of a planned continuation. */
  refresh(sessionId: string): void
  dispose(): void
}

export interface StatusProjectionDeps {
  readonly sessionStore: ViewedSessionStore
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch
  readonly flushOutput: (sessionId: string) => Promise<void>
  readonly outputPosition: (sessionId: string) => RuntimePosition
  /** Whether a successor will continue the session a planned replacement
   *  cut (`awaitsPlannedContinuation`). */
  readonly awaitsContinuation: (sessionId: string) => Promise<boolean>
  /** The active time the session's facts record, which a session no runner
   *  holds shows. */
  readonly recordedActiveMs: (sessionId: string) => Promise<number>
  /** Committed facts. The turn-end record and the child pause that answer
   *  `awaitsContinuation` can land after the runner last changed. */
  readonly onStored: (listener: (facts: readonly StoredFact[]) => void) => () => void
  /** The running commands a previous build handed to a session no runner
   *  holds that the executor's keeper holds, and the keeper's word that they
   *  changed. */
  readonly handedOver: {
    commands(sessionId: string): Promise<StatusView["activeBackgroundCommands"]>
    readonly onChange: CommandKeeper["onChange"]
  }
  /** The sessions a session waits on for a reply now, from the waits it
   *  stores, with their names, and the word that they changed, which no
   *  store change carries. The projection reads them again only after that
   *  word. */
  readonly replyWaits: {
    addressees(sessionId: string): Promise<readonly OpenReplyWaitView[]>
    onChange(listener: (sessionId: string) => void): () => void
  }
  /** The tool calls of each session's shell commands that processor
   *  admission holds, and the word that they changed, which no store change
   *  carries (PI-AGENT-052). */
  readonly processorHolds: Pick<ProcessorClaims, "heldToolCallIds" | "onHoldsChanged">
}

/** The turn a session shows: its activity, and whether the turn is parked
 *  on background work. A session at rest that a successor will continue
 *  after a planned replacement shows `waiting`, as a turn that has sent its
 *  request does, from the cut until the successor resumes it: the
 *  replacement is invisible, so no surface shows the session idle or offers
 *  Resume for it (PI-REMOTE-012). While such a session stores a reply wait,
 *  its turn shows parked on the wait, which the successor's run registers
 *  again, so its card and its viewer name the wait across the replacement
 *  (`replyWaitLabel`). A waiter that a person interrupted owes no
 *  continuation, so its turn shows parked on nothing. */
export async function presentedTurn(status: Pick<StatusView, "activity" | "waitingOnBackgroundWork" | "replyWaits">, awaitsContinuation: () => Promise<boolean>): Promise<Pick<StatusView, "activity" | "waitingOnBackgroundWork">> {
  const { activity, waitingOnBackgroundWork, replyWaits } = status
  if ((activity !== "idle" && activity !== "absent") || !await awaitsContinuation()) return { activity, waitingOnBackgroundWork }
  return { activity: "waiting", waitingOnBackgroundWork: waitingOnBackgroundWork || replyWaits.length > 0 }
}

/** The status stream of every live session, and of a session no runner
 *  holds while a successor owes it a continuation or a command handed to it
 *  runs: the first keeps a working status from the cut, across the release
 *  of its runner by the service that cut it, until the successor resumes it,
 *  and the second shows the command with its Stop. */
export function createStatusProjection(deps: StatusProjectionDeps): StatusProjection {
  const displayedStatus = new Map<string, { key: string; startedAt: number }>()
  const displayedStart = (sessionId: string, turn: Pick<StatusView, "activity" | "waitingOnBackgroundWork">, replyWaits: readonly OpenReplyWaitView[], activityStartedAt: number | null): number | null => {
    const replyWait = turn.waitingOnBackgroundWork ? displayedReplyWait(replyWaits, (wait) => wait.isParent) : undefined
    const sourceStart = replyWait === undefined ? activityStartedAt : Math.max(replyWait.openedAtMs, activityStartedAt ?? replyWait.openedAtMs)
    if (sourceStart === null) {
      displayedStatus.delete(sessionId)
      return null
    }
    const key = JSON.stringify([turn.activity, turn.waitingOnBackgroundWork, replyWait?.sessionId])
    const previous = displayedStatus.get(sessionId)
    if (previous?.key === key) return previous.startedAt
    // An older wait can become visible when the selected wait closes.
    const startedAt = previous === undefined || sourceStart > previous.startedAt ? sourceStart : Date.now()
    displayedStatus.set(sessionId, { key, startedAt })
    return startedAt
  }
  // A continuation that cannot be read shows the session as its runner
  // reports it, and never fails the status stream.
  const readContinuation = async <T>(sessionId: string, read: () => Promise<T>, unread: T): Promise<T> => {
    try {
      return await read()
    } catch (error) {
      log.warn("a session's planned continuation could not be read; its status shows its own activity", { sessionId, error: errorMessage(error) })
      return unread
    }
  }
  // The reply waits of each session as last read. Only their own change
  // signal changes them, so a status change of the entry, which a streaming
  // run makes several times per step, reuses the read. A failed read is
  // read again. The names in a kept read are the session metadata at the
  // last reply-wait change: no client renders them, so a rename does not
  // read them again.
  const replyWaitReads = new Map<string, Promise<readonly OpenReplyWaitView[]>>()
  const replyWaitsOf = (sessionId: string): Promise<readonly OpenReplyWaitView[]> => {
    const held = replyWaitReads.get(sessionId)
    if (held) return held
    const read = deps.replyWaits.addressees(sessionId)
    replyWaitReads.set(sessionId, read)
    read.catch(() => { if (replyWaitReads.get(sessionId) === read) replyWaitReads.delete(sessionId) })
    return read
  }
  const view = async (sessionId: string, entry: SessionEntry): Promise<StatusView> => {
    const replyWaits = await replyWaitsOf(sessionId)
    const turn = await presentedTurn({ activity: entryActivity(entry), waitingOnBackgroundWork: entry.waitingOnBackgroundWork, replyWaits }, () => readContinuation(sessionId, () => deps.awaitsContinuation(sessionId), false))
    if (turn.activity === "idle") await deps.flushOutput(sessionId)
    const sourceStart = turn.activity === entryActivity(entry) || (turn.waitingOnBackgroundWork && replyWaits.length > 0) ? entry.activityStartedAt : null
    const startedAt = displayedStart(sessionId, turn, replyWaits, sourceStart)
    return statusView(sessionId, entry, deps.outputPosition, turn, replyWaits, startedAt, deps.processorHolds.heldToolCallIds(sessionId))
  }
  // The sessions no runner holds whose working status this projection last
  // projected: a fact of such a session, such as a person's turn end over
  // the planned cut, can end its continuation.
  const continuingUnheld = new Set<string>()
  const unheld = async (sessionId: string): Promise<StatusView | null> => {
    const continuing = await readContinuation(sessionId, () => deps.awaitsContinuation(sessionId), false)
    if (continuing) continuingUnheld.add(sessionId)
    else continuingUnheld.delete(sessionId)
    const handedOver = await deps.handedOver.commands(sessionId)
    if (!continuing && handedOver.length === 0) {
      displayedStatus.delete(sessionId)
      replyWaitReads.delete(sessionId)
      return null
    }
    const replyWaits = await replyWaitsOf(sessionId)
    const turn = await presentedTurn({ activity: "idle", waitingOnBackgroundWork: false, replyWaits }, async () => continuing)
    return unheldStatus(turn, await deps.recordedActiveMs(sessionId), handedOver, deps.processorHolds.heldToolCallIds(sessionId), replyWaits, displayedStart(sessionId, turn, replyWaits, null))
  }
  const projection = createSessionViewProjection<StatusView>({
    sessionStore: deps.sessionStore,
    publish: deps.publish,
    label: "status-protocol",
    cursor: statusCursor,
    payloads: {
      updated: (status) => ({ kind: "status.updated", status }),
      removed: () => ({ kind: "status.removed" }),
    },
    view,
    inputs: (_sessionId, entry) => statusInputs(entry),
    departed: (sessionId) => {
      displayedStatus.delete(sessionId)
      return unheld(sessionId)
    },
    same: sameStatus,
  })
  const refresh = (sessionId: string): void => {
    void projection.run(sessionId, async () => {
      const entry = deps.sessionStore.get(sessionId)
      projection.set(sessionId, entry === undefined ? await unheld(sessionId) : await projection.project(sessionId, entry, { fresh: true }))
    }).catch((error: unknown) => { recordBackgroundFailure(log, "status refresh", { sessionId }, error) })
  }
  const unsubscribeHandedOver = deps.handedOver.onChange(refresh)
  const unsubscribeProcessorHolds = deps.processorHolds.onHoldsChanged(refresh)
  const unsubscribeReplyWaits = deps.replyWaits.onChange((sessionId) => {
    replyWaitReads.delete(sessionId)
    refresh(sessionId)
  })
  // The facts of a session at rest refresh it: a cut's turn-end record, or
  // its child's pause, can land after the runner reported rest, and the
  // session shows working from then on; a person's turn end over the cut
  // ends that, whether or not a runner holds the session. A running
  // session's facts change nothing its status reads, and its next store
  // change projects it again.
  const unsubscribeStored = deps.onStored((facts) => {
    for (const sessionId of new Set(facts.map((fact) => fact.sessionId))) {
      const entry = deps.sessionStore.get(sessionId)
      if (entry === undefined ? continuingUnheld.has(sessionId) : !isActiveActivity(entryActivity(entry))) refresh(sessionId)
    }
  })
  return {
    snapshot(sessionId) {
      // A snapshot delivers status too. Order it with updates and publish
      // differences so all clients retain the same settlement barrier.
      return projection.run(sessionId, async () => {
        const entry = deps.sessionStore.get(sessionId)
        const status = entry ? await projection.project(sessionId, entry) : await unheld(sessionId)
        projection.set(sessionId, status)
        return status
      })
    },
    refresh,
    dispose() {
      unsubscribeHandedOver()
      unsubscribeProcessorHolds()
      unsubscribeReplyWaits()
      unsubscribeStored()
      continuingUnheld.clear()
      displayedStatus.clear()
      replyWaitReads.clear()
      projection.dispose()
    },
  }
}

/** The status of a session no runner holds: the turn it shows
 *  (`presentedTurn`), running only the commands handed to it, which
 *  processor admission can hold, with no settlement barrier. Its stored
 *  reply waits stay listed: its next run registers them again. */
function unheldStatus(turn: Pick<StatusView, "activity" | "waitingOnBackgroundWork">, accumulatedActiveMs: number, handedOver: StatusView["activeBackgroundCommands"], processorHeldToolCallIds: readonly string[], replyWaits: readonly OpenReplyWaitView[], activityStartedAt: number | null): StatusView {
  return {
    ...turn,
    activityStartedAt,
    settledOutputPosition: null,
    connectionState: "connected",
    activeSubagentCount: 0,
    activeBackgroundCommands: handedOver,
    activeForegroundBashToolCallIds: [],
    processorHeldToolCallIds,
    startedAt: 0,
    streamingStartedAt: null,
    accumulatedActiveMs,
    compactionStartedAt: null,
    replyWaits: toReplyWaitViews(replyWaits),
  }
}

function statusView(sessionId: string, entry: SessionEntry, outputPosition: StatusProjectionDeps["outputPosition"], turn: Pick<StatusView, "activity" | "waitingOnBackgroundWork">, replyWaits: readonly OpenReplyWaitView[], activityStartedAt: number | null, processorHeldToolCallIds: readonly string[]): StatusView {
  return {
    ...turn,
    activityStartedAt,
    settledOutputPosition: turn.activity === "idle" ? outputPosition(sessionId) : null,
    ...entryStatus(entry),
    processorHeldToolCallIds,
    replyWaits: toReplyWaitViews(replyWaits),
  }
}

/** The status fields that a session's store entry holds as they are. */
function entryStatus(entry: SessionEntry): Omit<StatusView, "activity" | "waitingOnBackgroundWork" | "activityStartedAt" | "settledOutputPosition" | "replyWaits" | "processorHeldToolCallIds"> {
  return {
    connectionState: entry.connectionState,
    activeSubagentCount: entry.activeSubagents.size,
    activeBackgroundCommands: entry.activeBackgroundCommands,
    activeForegroundBashToolCallIds: entry.activeForegroundBashToolCallIds,
    startedAt: entry.startedAt,
    streamingStartedAt: entry.streamingStartedAt,
    accumulatedActiveMs: entry.accumulatedActiveMs,
    compactionStartedAt: entry.compactionStartedAt,
  }
}

/** The entry values a status reads. A session at rest has none: its status
 *  also reads its settled output position and the continuation a successor
 *  owes it, which no store change shows. Reply waits and handed-over
 *  commands derive the status again through their own change signals. */
function statusInputs(entry: SessionEntry): readonly unknown[] | undefined {
  const activity = entryActivity(entry)
  if (activity === "idle" || activity === "absent") return undefined
  return [activity, entry.waitingOnBackgroundWork, entry.activityStartedAt, ...Object.values(entryStatus(entry))]
}

function sameStatus(a: StatusView, b: StatusView): boolean {
  return a.activity === b.activity
    && a.activityStartedAt === b.activityStartedAt
    && a.settledOutputPosition === b.settledOutputPosition
    && a.connectionState === b.connectionState
    && a.activeSubagentCount === b.activeSubagentCount
    && a.waitingOnBackgroundWork === b.waitingOnBackgroundWork
    && sameBackgroundCommands(a.activeBackgroundCommands, b.activeBackgroundCommands)
    && sameIds(a.activeForegroundBashToolCallIds, b.activeForegroundBashToolCallIds)
    && sameIds(a.processorHeldToolCallIds, b.processorHeldToolCallIds)
    && a.startedAt === b.startedAt
    && a.streamingStartedAt === b.streamingStartedAt
    && a.accumulatedActiveMs === b.accumulatedActiveMs
    && a.compactionStartedAt === b.compactionStartedAt
    && sameIds(a.replyWaits.map((wait) => wait.sessionId), b.replyWaits.map((wait) => wait.sessionId))
}

function sameBackgroundCommands(a: StatusView["activeBackgroundCommands"], b: StatusView["activeBackgroundCommands"]): boolean {
  // Descriptor fields are constant per id, so the id list is the identity.
  return a === b || (a.length === b.length && a.every((command, index) => command.id === b[index]?.id))
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a === b || (a.length === b.length && a.every((id, index) => id === b[index]))
}
