import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { asAsyncEventReadSurface, CorruptEventRowError, type EventReader, type EventStore, type StoredFact } from "../../../../../src/infra/event-store-types.ts"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.ts"
import { releaseHeldProjections } from "../../../../../src/infra/projection-registry.ts"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.ts"
import type { ExperimentFact, ExperimentInitializedFact } from "../../../../../src/orchestration/modules/experiments/facts.ts"
import { createExperimentProjection } from "../../../../../src/orchestration/modules/experiments/projection.ts"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"

const stores: EventStore[] = []
const directories: string[] = []

afterEach(() => {
  for (const store of stores) {
    releaseHeldProjections(asAsyncEventReadSurface(store))
    store.close()
  }
  stores.length = 0
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.length = 0
})

function storePair(): [EventStore, EventStore] {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-experiment-projection-"))
  directories.push(directory)
  const dbFile = resolveEventStoreDbFile(directory)
  const left = createSqliteEventStore(dbFile)
  const right = createSqliteEventStore(dbFile)
  stores.push(left, right)
  return [left, right]
}

function append(store: EventStore, sessionId: string, fact: ExperimentFact): StoredFact {
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

  test("makes a raw-corrupt session snapshot unavailable", async () => {
    const corrupt = new CorruptEventRowError({ aggregateId: "session:bad", seq: 1, type: "experiment.initialized", version: 1, timestamp: 1, actor: "flywheel", sessionId: "bad", eventId: "bad-row", position: 1, rawPayload: "{" }, "invalid JSON")
    const reader: EventReader = {
      ...inMemoryEventReader([]),
      currentPosition: () => 1,
      read: () => { throw corrupt },
      readTolerant: () => [corrupt],
    }

    expect(await createExperimentProjection(asAsyncEventReadSurface(reader), "bad").replay()).toBeUndefined()
    releaseHeldProjections(asAsyncEventReadSurface(reader))
  })
})
