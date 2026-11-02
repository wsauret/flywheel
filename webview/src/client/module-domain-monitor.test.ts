import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { MODULE_DOMAIN_BINDINGS } from "../../../src/protocol/client/module-domain.js"
import type { FrontendExperimentView } from "../../../src/protocol/modules/experiments.js"
import { sessionDomainCursor } from "../../../src/protocol/runtime-ui-protocol-types.js"
import { workflowViewCursor } from "../../../src/protocol/modules/workflows.js"
import { createModuleDomainMonitor } from "./module-domain-monitor.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { backgroundReads } from "../../../src/protocol/client/background-reads.js"
import { spyOn } from "bun:test"
import type { RuntimeClientDiagnostic } from "../../../src/protocol/runtime-client-diagnostics.js"

const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

const binding = MODULE_DOMAIN_BINDINGS.experiment_view
const experimentViewCursor = (sessionId: string) => sessionDomainCursor("experiment_view", sessionId)

function view(name: string, runs = 0): FrontendExperimentView {
  return {
    name,
    metric: { name: "latency", unit: "ms" },
    secondaryMetrics: [],
    direction: "lower",
    segment: 0,
    baseline: runs === 0 ? null : 10,
    best: runs === 0 ? null : 9,
    confidence: null,
    runCounts: { total: runs, kept: runs, discarded: 0, crashed: 0, checksFailed: 0 },
    runs: Array.from({ length: runs }, (_, index) => ({
      run: index + 1, segment: 0, commit: `c${index}`, metric: 10 - index, metrics: {}, status: "keep" as const, description: `run ${index + 1}`, confidence: null, durationMs: 100,
    })),
    active: true,
    running: false,
  }
}

type Scripted = { readonly [sessionId: string]: readonly { readonly view: FrontendExperimentView | null; readonly position?: number }[] }

/** A connection whose snapshot answers are scripted per session, in call order. */
function fakeConnection(scripted: Scripted) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const calls = new Map<string, number>()
  const query = runtimeQuery({ experimentViewSnapshot: async (request) => {
    const answers = scripted[request.sessionId] ?? []
    const index = calls.get(request.sessionId) ?? 0
    calls.set(request.sessionId, index + 1)
    const spec = answers[Math.min(index, answers.length - 1)]
    if (!spec) throw new Error(`no view scripted for ${request.sessionId}`)
    return { snapshotPosition: spec.position ?? 100, experimentView: spec.view }
  } })
  const connection: Pick<RuntimeConnection, "query" | "subscribe" | "onLane"> = {
    query,
    onLane: lanes.onLane,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  /** The lane breaks and the next one opens. */
  const reconnect = (): void => {
    lanes.end()
    for (const listener of listeners) listener(LANE_BREAK)
    lanes.open()
  }
  return {
    connection,
    reconnect,
    emit: (event: FrontendEvent) => {
      for (const listener of listeners) listener(event)
    },
    calls: (sessionId: string) => calls.get(sessionId) ?? 0,
    get subscribers() {
      return listeners.size
    },
  }
}

const updated = (sessionId: string, position: number, next: FrontendExperimentView): FrontendEvent => ({
  type: "patch",
  patch: { cursor: experimentViewCursor(sessionId), position, prevPosition: position - 1, payload: { kind: "experiment_view.updated", experimentView: next } },
})

describe("module domain monitor", () => {
  test("failed reads retain their views, retry with backoff on the same connection, and share one failure episode", async () => {
    const timers: { callback: () => void; delay: number }[] = []
    // A real handle, already cleared, stands in for each manually delivered timer.
    const inert = setTimeout(() => {}, 0)
    clearTimeout(inert)
    const clock = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(globalThis.setTimeout, {
      apply(_target, _receiver, [callback, delay]: Parameters<typeof setTimeout>) {
        timers.push({ callback: () => callback(), delay: delay ?? 0 })
        return inert
      },
    }))
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(() => {})
    const fake = fakeConnection({ a: [{ view: view("a", 1) }], b: [{ view: view("b", 1) }] })
    const originalQuery = fake.connection.query
    const failed = new Set<string>()
    fake.connection.query = async (query) => {
      if ("sessionId" in query && query.sessionId === "a") attempts++
      if ("sessionId" in query && failed.has(query.sessionId)) throw new Error("read unavailable")
      return originalQuery(query)
    }
    const diagnostics: string[] = []
    let attempts = 0
    const recorded: RuntimeClientDiagnostic[] = []
    const reads = backgroundReads(fake.connection)
    reads.diagnose(message => { diagnostics.push(message) }, record => { recorded.push(record) })
    const a = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "a" })
    const b = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "b" })
    try {
      await settle()
      failed.add("a"); failed.add("b")
      fake.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 200, prevPosition: 0, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
      await settle()
      assert.equal(a.view?.runs.length, 1)
      assert.equal(b.view?.runs.length, 1)
      assert.equal(reads.failing, true)
      const first = timers.shift()
      assert.ok(first && first.delay >= 125 && first.delay <= 250)
      first.callback()
      await settle()
      const second = timers.pop()
      assert.ok(second && second.delay >= 250 && second.delay <= 500)
      assert.equal(diagnostics.filter(message => message.endsWith("read failed")).length, 2, "repeats do not write another diagnostic")
      failed.delete("a")
      second.callback()
      await settle()
      assert.equal(reads.failing, true, "another failed reader still owns the notice")
      failed.delete("b")
      timers.shift()?.callback()
      await settle()
      assert.equal(reads.failing, false)
      assert.deepEqual(recorded.filter(record => record.kind === "background_read").map(record => ({ phase: record.phase, repeats: record.repeats })), [
        { phase: "failed", repeats: 0 }, { phase: "failed", repeats: 0 },
        { phase: "recovered", repeats: 1 }, { phase: "recovered", repeats: 0 },
      ])
      timers.length = 0
      failed.add("a")
      fake.emit({ type: "patch", patch: { cursor: experimentViewCursor("a"), position: 500, prevPosition: 499, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
      await settle()
      let backoff = timers.shift()
      while (backoff && backoff.delay <= 2_000) {
        backoff.callback()
        await settle()
        backoff = timers.shift()
      }
      assert.ok(backoff && backoff.delay > 2_000)
      const beforeGap = attempts
      for (let position = 600; position < 603; position++) {
        fake.emit(updated("a", position, view("a", 2)))
        const gap = timers.shift()
        assert.ok(gap && gap.delay === 2_000)
        gap.callback()
        await settle()
        assert.equal(attempts, beforeGap, "continuing cursor gaps must wait for the reader's backoff")
      }
      failed.delete("a")
      backoff.callback()
      await settle()
      assert.equal(attempts, beforeGap + 1, "gap recovery and timer recovery coalesce into one read")
    } finally {
      a.dispose(); b.dispose()
      clock.mockRestore(); clear.mockRestore()
    }
  })
  test("seeds from the selected session's snapshot through the registry binding, null when the session has no view", async () => {
    const fake = fakeConnection({ s1: [{ view: view("alpha", 2) }], s2: [{ view: null }] })
    const first = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "s1" })
    const second = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "s2" })
    await settle()
    assert.equal(first.view?.name, "alpha")
    assert.equal(first.view?.runs.length, 2)
    assert.equal(second.view, null)
    first.dispose()
    second.dispose()
  })

  test("clears the view when the runtime removes it", async () => {
    const fake = fakeConnection({ s1: [{ view: view("alpha", 1) }] })
    const monitor = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "s1" })
    await settle()
    fake.emit({ type: "patch", patch: { cursor: experimentViewCursor("s1"), position: 101, prevPosition: 100, payload: { kind: "experiment_view.removed" } } })
    assert.equal(monitor.view, null)
    monitor.dispose()
  })

  test("reseeds on reconnect rather than trusting what it held", async () => {
    const fake = fakeConnection({ s1: [{ view: view("alpha", 1) }, { view: view("alpha", 4), position: 200 }] })
    const monitor = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "s1" })
    await settle()
    fake.reconnect()
    await settle()
    assert.equal(fake.calls("s1"), 2)
    assert.equal(monitor.view?.runs.length, 4)
    monitor.dispose()
  })

  test("never applies another session's patches or a foreign domain", async () => {
    const fake = fakeConnection({ s1: [{ view: view("alpha", 1) }] })
    const monitor = createModuleDomainMonitor({ binding, connection: fake.connection, ownerId: "s1" })
    await settle()
    fake.emit(updated("s2", 101, view("beta", 9)))
    fake.emit({
      type: "patch",
      patch: { cursor: workflowViewCursor("s1"), position: 101, prevPosition: 100, payload: { kind: "workflow_view.removed" } },
    })
    assert.equal(monitor.view?.name, "alpha")
    assert.equal(monitor.view?.runs.length, 1)
    monitor.dispose()
  })

  test("switching sessions disposes the old monitor so its late snapshot and patches leak nowhere", async () => {
    let answerFirst: (() => void) | undefined
    const slow = fakeConnection({ s1: [{ view: view("alpha", 5) }], s2: [{ view: view("beta", 1) }] })
    const original = slow.connection.query.bind(slow.connection)
    slow.connection.query = async (query) => {
      const result = await original(query)
      if ("sessionId" in query && query.sessionId === "s1") await new Promise<void>((resolve) => { answerFirst = resolve })
      return result
    }
    const first = createModuleDomainMonitor({ binding, connection: slow.connection, ownerId: "s1" })
    await settle()
    first.dispose()
    const second = createModuleDomainMonitor({ binding, connection: slow.connection, ownerId: "s2" })
    await settle()
    answerFirst?.()
    await settle()
    assert.equal(first.view, null, "a disposed monitor must not adopt a snapshot that answered late")
    assert.equal(second.view?.name, "beta")
    slow.emit(updated("s1", 101, view("alpha", 6)))
    assert.equal(first.view, null)
    assert.equal(second.view?.runs.length, 1)
    assert.equal(slow.subscribers, 1, "only the live monitor stays subscribed")
    second.dispose()
    assert.equal(slow.subscribers, 0)
  })
})
