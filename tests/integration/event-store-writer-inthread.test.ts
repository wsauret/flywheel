import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js"
import { asAsyncEventWriter, type EventStoreAppend } from "../../src/infra/event-store-types.js"

const TMP_ROOT = path.join(os.tmpdir(), `flywheel-event-store-writer-inthread-${process.pid}-${Date.now()}`)
const RUN_WRITER_STRESS = process.env.FLYWHEEL_EVENT_STORE_STRESS === "1"
const writerStressTest = RUN_WRITER_STRESS ? test : test.skip

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

function workspaceDbPath(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, ".flywheel", "flywheel.sqlite")
}

function telemetryFact(sessionId: string, sequence: number): EventStoreAppend {
  return {
    aggregateId: `session:${sessionId}`,
    type: "model.stream.event_observed",
    version: 1,
    timestamp: Date.now(),
    actor: "provider",
    sessionId,
    payload: {
      requestId: `request-${sessionId}`,
      conversationId: `conversation-${sessionId}`,
      turn: 1,
      sequence,
      source: "normalized",
      kind: "tool.input.delta",
      elapsedMs: sequence,
      sincePreviousMs: 1,
      metadata: {
        toolUseId: `tool-${sequence % 16}`,
        partialJson: {
          chars: 96,
          bytes: 96,
          xxhash32: Math.trunc(sequence).toString(16),
          preview: `{"path":"src/example-${sequence}.ts","old":"before","new":"after"}`,
        },
      },
    },
  }
}

function telemetryBatch(sessionId: string, startSequence: number, count: number): EventStoreAppend[] {
  return Array.from({ length: count }, (_, index) => telemetryFact(sessionId, startSequence + index))
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)
  return sorted[index]!
}

function assertContiguous(events: { position: number; seq: number; id: string }[], expectedCount: number): void {
  expect(events).toHaveLength(expectedCount)
  expect(new Set(events.map((event) => event.id)).size).toBe(expectedCount)
  for (let index = 0; index < events.length; index += 1) {
    expect(events[index]?.seq).toBe(index)
  }
}

function walBytes(dbPath: string): number {
  const walPath = `${dbPath}-wal`
  return fs.existsSync(walPath) ? fs.statSync(walPath).size : 0
}

describe("event-store in-thread writer", () => {
  test("persists a 50,000-fact telemetry burst without gaps", async () => {
    const dbPath = workspaceDbPath()
    const store = createSqliteEventStore(dbPath)
    const writer = asAsyncEventWriter(store)
    const sessionId = "burst"
    const totalFacts = 50_000
    const batchSize = 1_000
    const ackLatencies: number[] = []

    try {
      for (let sequence = 0; sequence < totalFacts; sequence += batchSize) {
        const started = performance.now()
        await writer.appendBatch(telemetryBatch(sessionId, sequence, Math.min(batchSize, totalFacts - sequence)))
        ackLatencies.push(performance.now() - started)
      }

      const events = store.read({ aggregateId: `session:${sessionId}` })
      assertContiguous(events, totalFacts)
      expect(store.currentPosition()).toBe(totalFacts)
      expect(percentile(ackLatencies, 0.95)).toBeLessThan(1_000)
    } finally {
      store.close()
    }
  }, 30_000)

  writerStressTest("sustains the ingestion SLA in-thread", async () => {
    const dbPath = workspaceDbPath()
    const store = createSqliteEventStore(dbPath)
    const writer = asAsyncEventWriter(store)
    const durationMs = Number(process.env.FLYWHEEL_EVENT_STORE_STRESS_MS ?? 60_000)
    const producerCount = 4
    const batchSize = 128
    const ackLatencies: number[] = []
    const writtenBySession = new Map<string, number>()
    let totalFacts = 0

    async function producer(producerIndex: number, deadline: number): Promise<void> {
      const sessionId = `stress-${producerIndex}`
      let sequence = 0
      while (performance.now() < deadline) {
        const started = performance.now()
        await writer.appendBatch(telemetryBatch(sessionId, sequence, batchSize))
        ackLatencies.push(performance.now() - started)
        sequence += batchSize
        totalFacts += batchSize
      }
      writtenBySession.set(sessionId, sequence)
    }

    try {
      const started = performance.now()
      const deadline = started + durationMs
      await Promise.all(Array.from({ length: producerCount }, (_, index) => producer(index, deadline)))
      const elapsedSeconds = (performance.now() - started) / 1_000

      expect(totalFacts / elapsedSeconds).toBeGreaterThanOrEqual(5_000)
      expect(percentile(ackLatencies, 0.95)).toBeLessThanOrEqual(100)
      expect(percentile(ackLatencies, 0.99)).toBeLessThanOrEqual(250)
      expect(walBytes(dbPath)).toBeLessThanOrEqual(512 * 1024 * 1024)

      for (const [sessionId, count] of writtenBySession) {
        assertContiguous(store.read({ aggregateId: `session:${sessionId}` }), count)
      }
      expect(store.currentPosition()).toBe(totalFacts)

      const db = new Database(dbPath)
      try {
        const checkpointStarted = performance.now()
        db.exec("PRAGMA wal_checkpoint(PASSIVE)")
        expect(performance.now() - checkpointStarted).toBeLessThanOrEqual(500)
      } finally {
        db.close()
      }
    } finally {
      store.close()
    }
  }, 90_000)
})
