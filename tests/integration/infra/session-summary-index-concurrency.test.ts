import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { configureSqliteEventStore } from "../../../src/infra/sqlite-event-store-core.js"
import { terminateWorker } from "../../../src/infra/worker-termination.js"
import { usageV4Fact } from "../../fixtures/session-summary-history.js"

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

test("two Workers commit one shared summary prefix exactly once", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "session-summary-workers-"))
  directories.push(directory)
  const eventDbFile = path.join(directory, "flywheel.sqlite")
  const summaryDbFile = path.join(directory, "session-summary.sqlite")
  const fact = usageV4Fact(1, "session-a", "request-a")
  const db = new Database(eventDbFile, { create: true })
  try {
    configureSqliteEventStore(db)
    db.query("insert into event_sequence (aggregate_id, seq) values (?, ?)").run(fact.aggregateId, fact.seq)
    db.query(`
      insert into event (
        position, id, aggregate_id, seq, type, version, timestamp, actor,
        session_id, run_id, parent_event_id, caused_by_event_id, payload
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?)
    `).run(
      fact.position,
      fact.id,
      fact.aggregateId,
      fact.seq,
      fact.type,
      fact.version,
      fact.timestamp,
      fact.actor,
      fact.sessionId,
      JSON.stringify(fact.payload),
    )
  } finally {
    db.close()
  }

  const first = monitoredWorker()
  const second = monitoredWorker()
  try {
    first.worker.postMessage({ kind: "start", eventDbFile, summaryDbFile }, [])
    second.worker.postMessage({ kind: "start", eventDbFile, summaryDbFile }, [])
    await Promise.all([first.wait("page-ready"), second.wait("page-ready")])
    first.worker.postMessage({ kind: "release" }, [])
    second.worker.postMessage({ kind: "release" }, [])
    const results = await Promise.all([first.wait("result"), second.wait("result")])
    expect(results).toEqual([
      { kind: "result", status: "ready", throughPosition: 1, totalCost: 2, totalTokens: 110 },
      { kind: "result", status: "ready", throughPosition: 1, totalCost: 2, totalTokens: 110 },
    ])
  } finally {
    await Promise.all([terminateWorker(first.worker), terminateWorker(second.worker)])
  }
}, 15_000)

interface WorkerMessage {
  readonly kind: string
  readonly status?: string
  readonly throughPosition?: number
  readonly totalCost?: number
  readonly totalTokens?: number
  readonly error?: string
}

interface MonitoredWorker {
  readonly worker: Worker
  readonly wait: (kind: string) => Promise<WorkerMessage>
}

function parseWorkerMessage(value: unknown): WorkerMessage | undefined {
  if (typeof value !== "object" || value === null || !("kind" in value) || typeof value.kind !== "string") return undefined
  return {
    kind: value.kind,
    ...("status" in value && typeof value.status === "string" ? { status: value.status } : {}),
    ...("throughPosition" in value && typeof value.throughPosition === "number" ? { throughPosition: value.throughPosition } : {}),
    ...("totalCost" in value && typeof value.totalCost === "number" ? { totalCost: value.totalCost } : {}),
    ...("totalTokens" in value && typeof value.totalTokens === "number" ? { totalTokens: value.totalTokens } : {}),
    ...("error" in value && typeof value.error === "string" ? { error: value.error } : {}),
  }
}

function monitoredWorker(): MonitoredWorker {
  const worker = new Worker(new URL("../../helpers/session-summary-index-worker.ts", import.meta.url).href)
  const messages: WorkerMessage[] = []
  const waiters = new Set<() => void>()
  worker.addEventListener("message", (event: MessageEvent) => {
    const message = parseWorkerMessage(event.data)
    if (!message) return
    messages.push(message)
    for (const wake of waiters) wake()
  })
  return {
    worker,
    async wait(kind) {
      for (;;) {
        const index = messages.findIndex((message) => message.kind === kind || message.kind === "failed")
        if (index >= 0) {
          const [message] = messages.splice(index, 1)
          if (!message) throw new Error("Worker message disappeared")
          if (message.kind === "failed") throw new Error(message.error ?? "Session summary Worker failed")
          return message
        }
        await new Promise<void>((resolve) => {
          const wake = () => {
            waiters.delete(wake)
            resolve()
          }
          waiters.add(wake)
        })
      }
    },
  }
}
