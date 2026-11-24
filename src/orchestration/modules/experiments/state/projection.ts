import type { AsyncEventReadSurface, CorruptEventRowError, StoredFact } from "../../../../infra/event-store-types.js"
import { createEventProjection } from "../../../../infra/event-projection.js"
import { heldProjection } from "../../../../infra/projection-registry.js"
import { emptyExperimentState, recordExperimentRun, startExperimentSegment } from "./state-reconstruction.js"
import type { ExperimentMetric, ExperimentRun, ExperimentState } from "./types.js"
import {
  parseExperimentFact,
  type ExperimentInitializedFact,
} from "./facts.js"

export const EXPERIMENT_FACT_TYPES = [
  "experiment.mode.changed",
  "experiment.initialized",
  "experiment.run.recorded",
  "experiment.resumed",
] as const

type ExperimentConfiguration = ExperimentInitializedFact["payload"]

interface ExperimentMode {
  readonly active: boolean
  readonly workDir: string | null
}

export interface ExperimentSnapshot {
  readonly mode: ExperimentMode
  readonly configuration: ExperimentConfiguration | null
  readonly segments: readonly ExperimentConfiguration[]
  readonly runs: readonly ExperimentRun[]
  /** The canonical segment identifier recorded by the current initialization. */
  readonly currentSegment: number
  readonly secondaryMetrics: readonly ExperimentMetric[]
  readonly resumedTurns: number
  readonly baselineMetric: number | null
  readonly bestMetric: number | null
  readonly confidence: number | null
  readonly protectedPaths: readonly string[]
  readonly sealedPaths: readonly string[]
  /** Advances with each change of the mode or the configuration, the only
   *  inputs of the charter policy and the experiment prompt fragment. Equal
   *  revisions of one session mean equal inputs. */
  readonly guardRevision: number
}

/** The analysis advances as each fact lands, and every array that a snapshot
 *  holds is replaced rather than changed, so a snapshot is O(1) and keeps the
 *  values it was taken with. */
interface ExperimentProjectionState {
  available: boolean
  mode: ExperimentMode
  configurations: readonly ExperimentConfiguration[]
  analysis: ExperimentState
  resumedTurns: number
  guardRevision: number
}

export interface ExperimentProjection {
  snapshot(): ExperimentSnapshot | undefined
  replay(): Promise<ExperimentSnapshot | undefined>
  apply(event: StoredFact): Promise<ExperimentSnapshot | undefined>
}

/** Every chat runner constructs one of these, so the held projection is
 *  resolved on the first read rather than at construction: a runner that never
 *  touches experiments never replays the aggregate. */
export function createExperimentProjection(reader: AsyncEventReadSurface, sessionId: string): ExperimentProjection {
  const projection = () => heldProjection(reader, `experiment:${sessionId}`, () => createEventProjection(reader, {
    name: `experiment:${sessionId}`,
    aggregateId: `session:${sessionId}`,
    factTypes: EXPERIMENT_FACT_TYPES,
    initialState,
    reduce,
    reduceCorruptRow,
  }))
  return {
    snapshot: () => snapshot(projection().getState()),
    replay: async () => snapshot(await projection().replay()),
    apply: async (event) => snapshot(await projection().apply(event)),
  }
}

function initialState(): ExperimentProjectionState {
  return {
    available: true,
    mode: { active: false, workDir: null },
    configurations: [],
    analysis: emptyExperimentState(),
    resumedTurns: 0,
    guardRevision: 0,
  }
}

function reduce(state: ExperimentProjectionState, event: StoredFact): ExperimentProjectionState {
  if (!state.available) return state

  let fact
  try {
    fact = parseExperimentFact({
      type: event.type,
      version: event.version,
      actor: event.actor,
      payload: event.payload,
    })
  } catch {
    state.available = false
    return state
  }

  switch (fact.type) {
    case "experiment.mode.changed":
      state.mode = { ...fact.payload }
      state.guardRevision += 1
      break
    case "experiment.initialized": {
      const configuration = {
        ...fact.payload,
        protectedPaths: [...fact.payload.protectedPaths],
        sealedPaths: [...fact.payload.sealedPaths],
      }
      state.configurations = [...state.configurations, configuration]
      startExperimentSegment(state.analysis, configuration.segment, configuration.direction)
      state.guardRevision += 1
      break
    }
    case "experiment.run.recorded":
      recordExperimentRun(state.analysis, {
        ...fact.payload,
        metrics: { ...fact.payload.metrics },
        timestamp: event.timestamp,
      })
      break
    case "experiment.resumed":
      state.resumedTurns += 1
      break
  }
  return state
}

function reduceCorruptRow(state: ExperimentProjectionState, _corrupt: CorruptEventRowError): ExperimentProjectionState {
  state.available = false
  return state
}

function snapshot(state: ExperimentProjectionState): ExperimentSnapshot | undefined {
  if (!state.available) return undefined
  const { analysis } = state
  const configuration = state.configurations.at(-1) ?? null
  return {
    mode: state.mode,
    configuration,
    segments: state.configurations,
    runs: analysis.results,
    currentSegment: analysis.currentSegment,
    secondaryMetrics: analysis.secondaryMetrics,
    resumedTurns: state.resumedTurns,
    baselineMetric: analysis.baselineMetric,
    bestMetric: analysis.bestMetric,
    confidence: analysis.confidence,
    protectedPaths: configuration?.protectedPaths ?? [],
    sealedPaths: configuration?.sealedPaths ?? [],
    guardRevision: state.guardRevision,
  }
}
