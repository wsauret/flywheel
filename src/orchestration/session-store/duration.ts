import { CorruptEventRowError, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../infra/event-store-types.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import { Log } from "../../infra/log.js"
import type { SessionEntry } from "./types.js"
import { parseSessionRuntimeFact } from "../session/session-runtime-event-types.js"

/** The one version of `session.duration.recorded` this build writes and reads. */
const DURATION_FACT_VERSION = 1
const log = Log.create({ service: "session-duration" })

export function currentAccumulatedActiveMs(entry: SessionEntry): number {
  return entry.streamingStartedAt === null
    ? entry.accumulatedActiveMs
    : entry.accumulatedActiveMs + Math.max(0, Date.now() - entry.streamingStartedAt)
}

export async function recordSessionDuration(store: AsyncEventStateReadSurface, writer: AsyncEventWriter, sessionId: string, accumulatedActiveMs: number): Promise<void> {
  const latest = await latestRecordedDuration(store, sessionId)
  if (latest === undefined) return
  await appendLongerDuration(writer, sessionId, latest.accumulatedActiveMs, accumulatedActiveMs)
}

async function appendLongerDuration(writer: AsyncEventWriter, sessionId: string, latest: number, accumulatedActiveMs: number): Promise<void> {
  const duration = Math.round(accumulatedActiveMs)
  if (duration <= latest) return

  await writer.append({
    aggregateId: `session:${sessionId}`,
    type: "session.duration.recorded",
    version: DURATION_FACT_VERSION,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId,
    payload: { accumulatedActiveMs: duration },
  })
  await writer.pruneSupersededEvents(`session:${sessionId}`, "session.duration.recorded")
}

/** A provider request starts only inside an open episode: the active clock
 *  runs from the start of a logical turn, before its first request. */
const EPISODE_START_FACT_TYPES = ["model.requested"] as const
/** Facts that only the session's own running loop writes, so the newest one
 *  is no later than the exit that cut the episode. A tool result is not one
 *  of them: recovery repairs results, and a workflow that outlives its parent
 *  records the result of the parent's call. */
export const EPISODE_EVIDENCE_FACT_TYPES = ["model.requested", "model.request.dispatched", "model.response_received", "tool.input.completed"] as const

/**
 * Folds the episode that an unclean exit cut into the session's recorded
 * duration, and returns the milliseconds it added.
 *
 * The runtime records the duration each time an episode ends, so a provider
 * request after the newest record belongs to an episode that never ended: the
 * exit cut it. That episode ran at least from its first request to the
 * newest fact its loop wrote, and this span is what the fold adds. The span
 * is a lower bound: it omits the start of the turn before its first request
 * and the time between the last fact and the exit. It never counts time the
 * session did not run, so the recorded duration never exceeds the active
 * time and never decreases. The fold needs no write while the session runs.
 *
 * A session with no request after its newest record was idle at the exit,
 * and the fold adds nothing. The fold appends a record, so a second fold of
 * the same cut finds no request after it and adds nothing.
 */
export async function recordCutEpisode(store: AsyncEventStateReadSurface, writer: AsyncEventWriter, sessionId: string): Promise<number> {
  const latest = await latestRecordedDuration(store, sessionId)
  if (latest === undefined) return 0
  const afterPosition = latest.position
  const [first] = (await store.readSlice({ sessionId, types: EPISODE_START_FACT_TYPES, afterPosition, order: "asc", limit: 1 })).facts
  if (!first || first instanceof CorruptEventRowError) return 0
  const last = await readEpisodeEvidenceEnd(store, { sessionIds: [sessionId], afterPosition })
  if (last === undefined) return 0
  const cut = Math.max(0, last - first.timestamp)
  await appendLongerDuration(writer, sessionId, latest.accumulatedActiveMs, latest.accumulatedActiveMs + cut)
  return cut
}

/** The latest running-loop evidence before a cut, excluding recovery and externally settled results. */
export async function readEpisodeEvidenceEnd(store: AsyncEventStateReadSurface, input: {
  readonly sessionIds: readonly string[]
  readonly aggregateId?: string
  readonly afterPosition: number
  readonly beforePosition?: number
}): Promise<number | undefined> {
  const bounds = { afterPosition: input.afterPosition, beforePosition: input.beforePosition, order: "desc" as const, limit: 1 }
  const queries = input.sessionIds.map((sessionId) => ({ ...bounds, sessionId, types: EPISODE_EVIDENCE_FACT_TYPES }))
  const pages = await Promise.all([
    ...queries.map((query) => store.readSlice(query, true)),
    ...(input.aggregateId ? [store.readSlice({ ...bounds, aggregateId: input.aggregateId }, true)] : []),
  ])
  const times = pages.flatMap(({ facts }) => facts[0] && !(facts[0] instanceof CorruptEventRowError) ? [facts[0].timestamp] : [])
  return times.length ? Math.max(...times) : undefined
}

interface RecordedDuration {
  readonly accumulatedActiveMs: number
  /** Workspace position of the record, 0 when the session has none. */
  readonly position: number
}

/** The session's last recorded duration, 0 at position 0 when none is
 *  recorded. Undefined when the latest row has a version this build does
 *  not know, which a newer build wrote: this build never records over that
 *  row, because the prune after its own write would delete it. A row of this
 *  build's version that fails its strict parse throws an InvariantViolation. */
async function latestRecordedDuration(store: AsyncEventStateReadSurface, sessionId: string): Promise<RecordedDuration | undefined> {
  const event = (await store.readLatestByAggregateAndTypes(`session:${sessionId}`, ["session.duration.recorded"])).at(-1)
  if (!event) return { accumulatedActiveMs: 0, position: 0 }
  if (event.version !== DURATION_FACT_VERSION) {
    log.warn("session duration row has a shape this release cannot read; it is left in place", { sessionId, version: event.version, position: event.position })
    return undefined
  }
  const fact = parseProjectionFact(event, parseSessionRuntimeFact)
  if (fact.type !== "session.duration.recorded") throw new Error(`Unexpected duration fact type: ${fact.type}`)
  return { accumulatedActiveMs: fact.payload.accumulatedActiveMs, position: event.position }
}
