import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, type EventReader, type LocalSqliteEventStore, type StoredFact } from "../../../../../../src/infra/substrate/store/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../../src/infra/platform/files/paths.js"
import { createSqliteEventStore } from "../../../../../../src/infra/substrate/store/sqlite-event-store.js"
import type { ExperimentFact, ExperimentInitializedFact } from "../../../../../../src/orchestration/modules/experiments/state/facts.js"
import { createExperimentProjection, type ExperimentSnapshot } from "../../../../../../src/orchestration/modules/experiments/state/projection.js"
import * as resultAnalysis from "../../../../../../src/orchestration/modules/experiments/state/result-analysis.js"
import { createExperimentsRuntime } from "../../../../../../src/orchestration/modules/experiments/runtime.js"
import { createSessionFactWriter } from "../../../../../../src/orchestration/session/persistence/session-fact-writer.js"
import { inMemoryEventReader } from "../../../../../helpers/in-memory-event-reader.js"
import { moduleRuntimeServices } from "../../../../../helpers/module-runtime-services.js"

const stores: LocalSqliteEventStore[] = []
const directories: string[] = []

afterEach(() => {
  for (const store of stores) store.close()
  stores.length = 0
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

function storePair(): [LocalSqliteEventStore, LocalSqliteEventStore] {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-experiment-projection-"))
  directories.push(directory)
  const dbFile = resolveEventStoreDbFile(directory)
  const left = createSqliteEventStore(dbFile)
  const right = createSqliteEventStore(dbFile)
  stores.push(left, right)
  return [left, right]
}

function append(store: LocalSqliteEventStore, sessionId: string, fact: ExperimentFact): StoredFact {
  return store.append({
    aggregateId: `session:${sessionId}`,
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  })
}

function mode(active = true): ExperimentFact {
  return { type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active, workDir: active ? "/repo" : null } }
}

function initialized(segment: number, name = `segment-${segment}`, maxIterations = 20): ExperimentInitializedFact {
  return {
    type: "experiment.initialized",
    version: 1,
    actor: "flywheel",
    payload: {
      segment,
      name,
      metricName: "latency_ms",
      metricUnit: "ms",
      direction: "lower",
      measureCommand: "bun run measure",
      checksCommand: "bun run check",
      workDir: "/repo",
      maxIterations,
      protectedPaths: [".experiment/**"],
      sealedPaths: ["secret/**"],
    },
  }
}

/** The guard of the session's experiments runtime, over `store`. */
function runtimeGuard(store: LocalSqliteEventStore, sessionId: string) {
  const runtime = createExperimentsRuntime(moduleRuntimeServices({
    sessionId,
    projectionReader: asAsyncEventReadSurface(store),
    sessionEventWriter: createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) }),
    runOwnedCommand: async () => { throw new Error("no command runs in this test") },
  }))
  if (!runtime) throw new Error("expected an experiments runtime")
  return runtime.guard
}

/** The whole-history analysis that the fold must equal: every run of the current segment, analysed at once. */
function wholeHistoryAnalysis(snapshot: ExperimentSnapshot) {
  const runs = [...snapshot.runs]
  const direction = snapshot.configuration?.direction ?? "lower"
  return {
    baselineMetric: resultAnalysis.findBaselineMetric(runs, snapshot.currentSegment),
    bestMetric: resultAnalysis.findBestMetric(runs, snapshot.currentSegment, direction),
    confidence: resultAnalysis.computeConfidence(runs, snapshot.currentSegment, direction),
  }
}

function run(runNumber: number, segment: number, metric: number, status: "keep" | "discard" = "keep"): ExperimentFact {
  return {
    type: "experiment.run.recorded",
    version: 1,
    actor: "flywheel",
    payload: {
      run: runNumber,
      segment,
      commit: `commit${runNumber}`,
      metric,
      metrics: { memory_mb: 20 + runNumber },
      status,
      description: `run ${runNumber}`,
      confidence: runNumber >= 3 ? 2 : null,
      durationMs: 100,
    },
  }
}

describe("createExperimentProjection", () => {
  test("replays construction history, applies live facts, and observes another connection", async () => {
    const [reader, writer] = storePair()
    append(writer, "s1", mode())
    append(writer, "s1", initialized(0))
    append(writer, "s1", run(1, 0, 10))

    const projection = createExperimentProjection(asAsyncEventReadSurface(reader), "s1")
    await projection.replay()
    expect(projection.snapshot()?.runs.map((entry) => entry.metric)).toEqual([10])
    expect(projection.snapshot()?.baselineMetric).toBe(10)
    expect(projection.snapshot()?.bestMetric).toBe(10)
    expect(projection.snapshot()?.protectedPaths).toEqual([".experiment/**"])

    await projection.apply(append(writer, "s1", { type: "experiment.resumed", version: 1, actor: "flywheel", payload: { turn: 1, reason: "turn_end" } }))
    expect(projection.snapshot()?.resumedTurns).toBe(1)

    append(writer, "s1", run(2, 0, 8))
    expect((await projection.replay())?.runs.map((entry) => entry.metric)).toEqual([10, 8])
    expect(createExperimentProjection(asAsyncEventReadSurface(reader), "s1").snapshot()?.runs.map((entry) => entry.metric)).toEqual([10, 8])
  })

  test("makes only a schema-invalid or unsupported session snapshot unavailable", async () => {
    const [store] = storePair()
    append(store, "good", initialized(0))
    append(store, "bad", initialized(0))
    store.append({ aggregateId: "session:bad", type: "experiment.run.recorded", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: "bad", payload: { ...(run(1, 0, 10).payload), status: "invented" } })
    store.append({ aggregateId: "session:unsupported", type: "experiment.mode.changed", version: 2, timestamp: Date.now(), actor: "flywheel", sessionId: "unsupported", payload: { active: true, workDir: "/repo" } })

    expect(await createExperimentProjection(asAsyncEventReadSurface(store), "bad").replay()).toBeUndefined()
    expect(await createExperimentProjection(asAsyncEventReadSurface(store), "unsupported").replay()).toBeUndefined()
    expect((await createExperimentProjection(asAsyncEventReadSurface(store), "good").replay())?.configuration?.name).toBe("segment-0")
  })

  test("snapshot() equals the whole-history analysis after replay and after each applied run", async () => {
    const [reader, writer] = storePair()
    append(writer, "s1", mode())
    append(writer, "s1", initialized(1))
    for (const [index, metric] of [12, 9, 11, 7].entries()) append(writer, "s1", run(index + 1, 1, metric, index === 2 ? "discard" : "keep"))
    append(writer, "s1", initialized(2))
    append(writer, "s1", run(5, 2, 20))
    const projection = createExperimentProjection(asAsyncEventReadSurface(reader), "s1")

    const replayed = await projection.replay()
    if (!replayed) throw new Error("expected a snapshot")
    expect(replayed).toMatchObject(wholeHistoryAnalysis(replayed))
    for (const [index, metric] of [18, 25, 15, 30].entries()) {
      const applied = await projection.apply(append(writer, "s1", run(index + 6, 2, metric, index === 1 ? "discard" : "keep")))
      if (!applied) throw new Error("expected a snapshot")
      expect(applied).toMatchObject(wholeHistoryAnalysis(applied))
    }
    expect(projection.snapshot()?.confidence).not.toBeNull()
    expect(projection.snapshot()?.secondaryMetrics).toEqual([{ name: "memory_mb", unit: "mb" }])
  })

  test("the guard revision advances with the mode and the configuration only", async () => {
    const [reader, writer] = storePair()
    const projection = createExperimentProjection(asAsyncEventReadSurface(reader), "s1")
    const revision = async () => (await projection.replay())?.guardRevision

    const initial = await revision()
    append(writer, "s1", mode())
    const active = await revision()
    append(writer, "s1", initialized(1))
    const configured = await revision()
    append(writer, "s1", run(1, 1, 10))
    append(writer, "s1", { type: "experiment.resumed", version: 1, actor: "flywheel", payload: { turn: 1, reason: "turn_end" } })
    const afterRun = await revision()
    append(writer, "s1", mode(false))

    expect(new Set([initial, active, configured, await revision()]).size).toBe(4)
    expect(afterRun).toBe(configured)
    expect(createExperimentProjection(asAsyncEventReadSurface(reader), "s1").snapshot()?.guardRevision).toBe(await revision())
  })

  for (const runCount of [10, 1_000]) {
    test(`guard() after ${runCount} recorded runs analyses no run, and recording one run analyses only its segment, once`, async () => {
      const [store] = storePair()
      append(store, "s1", mode())
      append(store, "s1", initialized(1))
      for (let index = 1; index <= runCount; index += 1) append(store, "s1", run(index, 1, 100 - (index % 7)))
      append(store, "s1", initialized(2))
      append(store, "s1", run(runCount + 1, 2, 60))
      append(store, "s1", run(runCount + 2, 2, 55))
      const guard = runtimeGuard(store, "s1")
      const before = await guard()

      const best = spyOn(resultAnalysis, "findBestMetric")
      const confidence = spyOn(resultAnalysis, "computeConfidence")
      try {
        for (let call = 0; call < 5; call += 1) expect(await guard()).toEqual(before)
        expect(best).toHaveBeenCalledTimes(0)
        expect(confidence).toHaveBeenCalledTimes(0)

        append(store, "s1", run(runCount + 3, 2, 50))
        expect((await guard())?.revision).toBe(before?.revision)
        expect(best.mock.calls.map(([runs]) => runs.length)).toEqual([3])
        expect(confidence.mock.calls.map(([runs]) => runs.length)).toEqual([3])
      } finally {
        best.mockRestore()
        confidence.mockRestore()
      }
    })
  }

  test("makes a raw-corrupt session snapshot unavailable", async () => {
    const corrupt = new CorruptEventRowError({ aggregateId: "session:bad", seq: 1, type: "experiment.initialized", version: 1, timestamp: 1, actor: "flywheel", sessionId: "bad", eventId: "bad-row", position: 1, rawPayload: "{" }, "invalid JSON")
    const reader: EventReader = {
      ...inMemoryEventReader([]),
      currentPosition: () => 1,
      read: () => { throw corrupt },
      readTolerant: () => [corrupt],
    }

    expect(await createExperimentProjection(asAsyncEventReadSurface(reader), "bad").replay()).toBeUndefined()
  })
})
