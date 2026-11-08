import { asAsyncEventReadSurface, type AsyncEventReadSurface, type EventReader, type StoredFact } from "../../../infra/event-store-types.js"
import { errorDetail, errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { experimentsProtocol, type FrontendExperimentRun, type FrontendExperimentView } from "../../../protocol/modules/experiments.js"
import { sessionDomainCursor, type RuntimeUiPatch, type RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import type { ModuleBackgroundReaders, ModuleProtocolRuntime, ModuleProtocolServices } from "../../app-service/module-protocol-host.js"
import { createSessionViewProjection, type SessionViewProjection, type ViewedSessionStore } from "../../app-service/session-view-projection.js"
import { experimentsRuntime } from "./runtime.js"
import type { ChatRunner } from "../../chat/runner-types.js"
import type { ExperimentOperationState, ExperimentOperationView } from "./operation-owner.js"
import { createExperimentProjection, EXPERIMENT_FACT_TYPES, type ExperimentProjection, type ExperimentSnapshot } from "./projection.js"
import type { SessionEntry } from "../../session-store/types.js"

const experimentViewCursor = (sessionId: string) => sessionDomainCursor("experiment_view", sessionId)

/** The module's protocol runtime: a live session is served by the held
 *  projection, an inactive one by the background Worker's durable reader.
 *  The cursor is captured before the asynchronous read so concurrent patches
 *  remain eligible for delivery after the snapshot. */
export function createExperimentsProtocol(services: ModuleProtocolServices): ModuleProtocolRuntime<typeof experimentsProtocol> {
  const projection = createExperimentViewProtocolProjection({ sessionStore: services.sessionStore, reader: services.projectionReader, onStored: services.onStored, publish: services.publish })
  return {
    serve: {
      async experimentViewSnapshot({ sessionId }) {
        const snapshotPosition = services.snapshotPosition({ kind: "cursor", cursor: experimentViewCursor(sessionId) })
        const inactive = services.hasLiveSession(sessionId) ? null : (await services.background("experiment_view", sessionId)).experimentView
        const experimentView = services.hasLiveSession(sessionId) ? await projection.snapshot(sessionId) : inactive
        return { experimentView, snapshotPosition }
      },
    },
    mutate: {},
    dispose: projection.dispose,
  }
}

/** History only, so `running` is always false. */
export function experimentsBackgroundReaders(reader: EventReader): ModuleBackgroundReaders<typeof experimentsProtocol> {
  const read = createExperimentViewProtocolReader(asAsyncEventReadSurface(reader))
  return { experiment_view: async (sessionId) => ({ experimentView: await read(sessionId) }) }
}

/** Serves the `experiment_view` domain for live sessions. Durable rows come
 *  from the held experiment projection; `running` comes only from the
 *  session's live experiment operation and is false once the runner is
 *  gone. Nothing is built until the first `snapshot` or the first stored
 *  experiment fact: startup never reads an experiment aggregate or subscribes
 *  to the session store for this domain. */
export interface ExperimentViewProtocolProjection {
  /** The current view of one live session; null when the session is not live
   *  or has no experiment history. Arms the projection. */
  snapshot(sessionId: string): Promise<FrontendExperimentView | null>
  dispose(): void
}

export interface ExperimentViewProtocolProjectionDeps {
  readonly sessionStore: ViewedSessionStore
  readonly reader: AsyncEventReadSurface
  /** The store's post-commit broadcast (RuntimeEventStore.onStored). */
  readonly onStored: (listener: (events: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
}

const EXPERIMENT_FACT_TYPE_SET: ReadonlySet<string> = new Set(EXPERIMENT_FACT_TYPES)
const log = Log.create({ service: "experiment-view-protocol" })

interface TrackedSession {
  readonly projection: ExperimentProjection
  runner: ChatRunner | null
  unsubscribeRunner: () => void
  execution: ExperimentOperationView | null
  unsubscribeExecution: () => void
  running: boolean
}

interface ArmedProjection {
  readonly sessions: SessionViewProjection<FrontendExperimentView>
  /** Views again the tracked sessions whose experiment facts were stored. */
  readonly changed: (sessionIds: ReadonlySet<string>) => void
  /** Publishes the views of the sessions whose facts armed the projection. */
  readonly announce: (sessionIds: ReadonlySet<string>) => void
  readonly dispose: () => void
}

export function createExperimentViewProtocolProjection(deps: ExperimentViewProtocolProjectionDeps): ExperimentViewProtocolProjection {
  let armed: ArmedProjection | null = null
  let disposed = false

  // A client reads a session that has no runtime from history, so that read
  // never reaches this process. The session's first experiment fact is then
  // the first sign here that a client can show its experiment, and it arms
  // the projection as a read does.
  const unsubscribeStored = deps.onStored((events) => {
    if (disposed) return
    const sessionIds = new Set(events.flatMap((event) => EXPERIMENT_FACT_TYPE_SET.has(event.type) ? [event.sessionId] : []))
    if (sessionIds.size === 0) return
    if (armed) {
      armed.changed(sessionIds)
      return
    }
    armed = arm(deps)
    armed.announce(sessionIds)
  })

  return {
    async snapshot(sessionId) {
      if (disposed) return null
      armed ??= arm(deps)
      return armed.sessions.snapshot(sessionId)
    },
    dispose() {
      disposed = true
      unsubscribeStored()
      armed?.dispose()
      armed = null
    },
  }
}

function arm(deps: ExperimentViewProtocolProjectionDeps): ArmedProjection {
  const tracked = new Map<string, TrackedSession>()

  function track(sessionId: string): TrackedSession {
    let session = tracked.get(sessionId)
    if (!session) {
      session = {
        projection: createExperimentProjection(deps.reader, sessionId),
        runner: null,
        unsubscribeRunner: () => {},
        execution: null,
        unsubscribeExecution: () => {},
        running: false,
      }
      tracked.set(sessionId, session)
    }
    return session
  }

  function release(sessionId: string): TrackedSession | undefined {
    const session = tracked.get(sessionId)
    if (!session) return undefined
    session.unsubscribeExecution()
    session.unsubscribeRunner()
    tracked.delete(sessionId)
    return session
  }

  async function refresh(sessionId: string): Promise<void> {
    const entry = deps.sessionStore.get(sessionId)
    sessions.set(sessionId, entry ? await view(sessionId, entry) : null)
  }

  /** Follow the runner's execution owner as runners attach and detach. A
   *  runner that leaves takes `running` with it: history alone never runs. */
  function bindExecution(sessionId: string, session: TrackedSession, entry: SessionEntry): void {
    const runner = entry.kind === "chat" ? entry.runner ?? null : null
    if (runner !== session.runner) {
      session.unsubscribeRunner()
      session.runner = runner
      session.unsubscribeRunner = runner?.onModuleRuntimesChange?.(() => { void refresh(sessionId) }) ?? (() => {})
    }
    const execution = runner?.moduleRuntimes?.get(experimentsRuntime)?.operation ?? null
    if (execution === session.execution) return
    session.unsubscribeExecution()
    session.execution = execution
    session.unsubscribeExecution = execution
      ? execution.subscribe((state) => {
        const running = commandRuns(state)
        if (running === session.running) return
        session.running = running
        void refresh(sessionId)
      })
      : () => {}
    const running = execution ? commandRuns(execution.snapshot()) : false
    if (running !== session.running) {
      session.running = running
    }
  }

  async function view(sessionId: string, entry: SessionEntry): Promise<FrontendExperimentView | null> {
    if (entry.kind !== "chat") return null
    const session = track(sessionId)
    bindExecution(sessionId, session, entry)
    return durableView(session, sessionId)
  }

  const sessions = createSessionViewProjection<FrontendExperimentView>({
    sessionStore: deps.sessionStore,
    publish: deps.publish,
    label: "experiment-view-protocol",
    cursor: experimentViewCursor,
    payloads: {
      updated: (experimentView) => ({ kind: "experiment_view.updated", experimentView }),
      removed: () => ({ kind: "experiment_view.removed" }),
    },
    view,
    same: sameView,
    // A departing session keeps its durable rows on the cursor with running
    // false; the background lane answers later snapshots for it.
    departed(sessionId) {
      const session = release(sessionId)
      if (!session) return null
      session.running = false
      return durableView(session, sessionId)
    },
  })

  return {
    sessions,
    // Experiment facts arrive by push at their commit. Each fact family is
    // rare (one per mode change, initialization, or logged run), so re-viewing
    // a tracked session through `replay()` folds only the facts just pushed.
    changed(sessionIds) {
      for (const sessionId of sessionIds) if (tracked.has(sessionId)) void refresh(sessionId)
    },
    // The seed records the view of each live session as delivered, but no
    // read of this process delivered these sessions' views, so each goes out
    // once after the seed.
    announce(sessionIds) {
      for (const sessionId of sessionIds) {
        void sessions.run(sessionId, async () => {
          sessions.prime(sessionId, null)
          await refresh(sessionId)
        })
      }
    },
    dispose() {
      sessions.dispose()
      for (const sessionId of tracked.keys()) release(sessionId)
    },
  }
}

/** A stopped run's command still executes in the worktree until it returns. */
function commandRuns(state: ExperimentOperationState<unknown>): boolean {
  return state.status === "running" || state.status === "abandoned"
}

/** A read failure is one session's problem: log it and publish no view for
 *  that session, so a malformed aggregate cannot take down the domain. */
async function durableView(session: TrackedSession, sessionId: string): Promise<FrontendExperimentView | null> {
  try {
    const snapshot = await session.projection.replay()
    return snapshot ? experimentViewFromSnapshot(snapshot, session.running) : null
  } catch (err) {
    log.error("experiment view read failed", { sessionId, error: errorMessage(err), errorDetail: errorDetail(err) })
    return null
  }
}

/** The wire view of one durable snapshot. A session that was never
 *  initialized and is not in active mode has no experiment, so no view. */
export function experimentViewFromSnapshot(snapshot: ExperimentSnapshot, running: boolean): FrontendExperimentView | null {
  const configuration = snapshot.configuration
  if (!configuration && !snapshot.mode.active) return null
  const runs = snapshot.runs.map(toFrontendRun)
  const current = runs.filter((run) => run.segment === snapshot.currentSegment)
  return {
    name: configuration?.name ?? null,
    metric: { name: configuration?.metricName ?? "metric", unit: configuration?.metricUnit ?? "" },
    secondaryMetrics: snapshot.secondaryMetrics.map((metric) => ({ name: metric.name, unit: metric.unit })),
    direction: configuration?.direction ?? "lower",
    segment: snapshot.currentSegment,
    baseline: snapshot.baselineMetric,
    best: snapshot.bestMetric,
    confidence: snapshot.confidence,
    runCounts: {
      total: current.length,
      kept: current.filter((run) => run.status === "keep").length,
      discarded: current.filter((run) => run.status === "discard").length,
      crashed: current.filter((run) => run.status === "crash").length,
      checksFailed: current.filter((run) => run.status === "checks_failed").length,
    },
    runs,
    active: snapshot.mode.active,
    running,
  }
}

function toFrontendRun(run: ExperimentSnapshot["runs"][number]): FrontendExperimentRun {
  return {
    run: run.run,
    segment: run.segment,
    commit: run.commit,
    metric: run.metric,
    metrics: { ...run.metrics },
    status: run.status,
    description: run.description,
    confidence: run.confidence,
    durationMs: run.durationMs,
  }
}

/** A reader for the background lane: one held projection per asked session,
 *  history only, so `running` is always false. */
export function createExperimentViewProtocolReader(reader: AsyncEventReadSurface): (sessionId: string) => Promise<FrontendExperimentView | null> {
  const projections = new Map<string, ExperimentProjection>()
  return async (sessionId) => {
    let projection = projections.get(sessionId)
    if (!projection) {
      projection = createExperimentProjection(reader, sessionId)
      projections.set(sessionId, projection)
    }
    const snapshot = await projection.replay()
    return snapshot ? experimentViewFromSnapshot(snapshot, false) : null
  }
}

function sameView(a: FrontendExperimentView, b: FrontendExperimentView): boolean {
  if (a === b) return true
  if (a.name !== b.name || a.active !== b.active || a.running !== b.running || a.segment !== b.segment) return false
  if (a.baseline !== b.baseline || a.best !== b.best || a.confidence !== b.confidence || a.direction !== b.direction) return false
  if (a.metric.name !== b.metric.name || a.metric.unit !== b.metric.unit) return false
  if (a.secondaryMetrics.length !== b.secondaryMetrics.length || a.runs.length !== b.runs.length) return false
  if (!a.secondaryMetrics.every((metric, index) => metric.name === b.secondaryMetrics[index]?.name && metric.unit === b.secondaryMetrics[index]?.unit)) return false
  return a.runs.every((run, index) => {
    const other = b.runs[index]
    return other !== undefined && run.run === other.run && run.segment === other.segment && run.commit === other.commit
      && run.metric === other.metric && run.status === other.status && run.description === other.description
      && run.confidence === other.confidence && run.durationMs === other.durationMs
  })
}
