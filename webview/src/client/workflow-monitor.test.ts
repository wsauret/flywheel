import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendEvent, RuntimeQuery } from "../../../src/protocol/app-service-types.js"
import type { FrontendAttempt, LoadedWorkflowView } from "../../../src/protocol/workflow-view-protocol-types.js"
import { workflowLiveCursor, workflowViewCursor } from "../../../src/protocol/modules/workflows.js"
import { MODULE_DOMAIN_BINDINGS } from "../../../src/protocol/client/module-domain.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"
import { createModuleDomainMonitor } from "./module-domain-monitor.js"
import { fakeLanes, LANE_BREAK } from "../../../tests/helpers/fake-lanes.js"
import { plainAgentTree } from "../../../tests/helpers/workflow-view.js"
import { createWorkflowInspections, type WorkflowReading } from "../modules/workflows/inspection.js"

const SESSION = "s1"
const settle = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve)
  })

const attempt = (name: string, status: FrontendAttempt["status"]): FrontendAttempt => ({ id: name, definitionId: name, briefId: `fly.${name}`, name, status, history: [] })

function view(attempts: readonly FrontendAttempt[], state: LoadedWorkflowView["state"] = "running"): LoadedWorkflowView {
  return { attempts, attemptsStatus: "loaded", state, tree: plainAgentTree(attempts) }
}

function fakeConnection(views: Array<{ attempts: FrontendAttempt[]; state?: LoadedWorkflowView["state"]; position?: number }>) {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const connectionLanes = fakeLanes()
  let calls = 0
  const connection = fakeRuntimeConnection({
    queries: {
      workflowViewSnapshot: () => {
        const spec = views[Math.min(calls, views.length - 1)]
        calls += 1
        if (!spec) throw new Error("no view scripted")
        return {
          snapshotPosition: spec.position ?? 100,
          view: view(spec.attempts, spec.state),
        }
      },
    },
  }, {
    ...connectionLanes.client,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  /** The connection lane breaks and the next one opens. */
  const reconnect = (): void => {
    connectionLanes.end()
    for (const listener of listeners) listener(LANE_BREAK)
    connectionLanes.open()
  }

  return {
    connection,
    reconnect,
    emit: (event: FrontendEvent) => {
      for (const listener of listeners) listener(event)
    },
    get calls() {
      return calls
    },
  }
}

describe("workflow monitor", () => {
  test("applies an ordered update", async () => {
    const fake = fakeConnection([{ attempts: [attempt("plan", "running")] }])
    const monitor = createModuleDomainMonitor({ binding: MODULE_DOMAIN_BINDINGS.workflow_view, connection: fake.connection, ownerId: SESSION })
    await settle()

    fake.emit({
      type: "patch",
      patch: {
        cursor: workflowViewCursor(SESSION),
        position: 101,
        prevPosition: 100,
        payload: { kind: "workflow_view.updated", workflowView: view([attempt("plan", "completed"), attempt("build", "running")]) },
      },
    })
    assert.equal(monitor.view?.attempts.length, 2)
    assert.equal(monitor.view?.attempts[0]?.status, "completed")
    monitor.dispose()
  })

  test("ignores a patch that is already behind the snapshot", async () => {
    const fake = fakeConnection([{ attempts: [attempt("plan", "running")], position: 100 }])
    const monitor = createModuleDomainMonitor({ binding: MODULE_DOMAIN_BINDINGS.workflow_view, connection: fake.connection, ownerId: SESSION })
    await settle()

    fake.emit({
      type: "patch",
      patch: {
        cursor: workflowViewCursor(SESSION),
        position: 99,
        prevPosition: 98,
        payload: { kind: "workflow_view.updated", workflowView: view([], "idle") },
      },
    })
    assert.equal(monitor.view?.attempts.length, 1, "a stale patch must not blank the attempt list")
    monitor.dispose()
  })

  test("clears the view when the workflow is removed", async () => {
    const fake = fakeConnection([{ attempts: [attempt("plan", "running")] }])
    const monitor = createModuleDomainMonitor({ binding: MODULE_DOMAIN_BINDINGS.workflow_view, connection: fake.connection, ownerId: SESSION })
    await settle()
    fake.emit({
      type: "patch",
      patch: { cursor: workflowViewCursor(SESSION), position: 101, prevPosition: 100, payload: { kind: "workflow_view.removed" } },
    })
    assert.equal(monitor.view, null)
    monitor.dispose()
  })

  test("reseeds on reconnect rather than trusting what it held", async () => {
    const fake = fakeConnection([
      { attempts: [attempt("plan", "running")] },
      { attempts: [attempt("plan", "completed"), attempt("build", "running")], position: 200 },
    ])
    const monitor = createModuleDomainMonitor({ binding: MODULE_DOMAIN_BINDINGS.workflow_view, connection: fake.connection, ownerId: SESSION })
    await settle()
    fake.reconnect()
    await settle()
    assert.equal(monitor.view?.attempts.length, 2)
    monitor.dispose()
  })

  test("stops applying after dispose", async () => {
    const fake = fakeConnection([{ attempts: [attempt("plan", "running")] }])
    const monitor = createModuleDomainMonitor({ binding: MODULE_DOMAIN_BINDINGS.workflow_view, connection: fake.connection, ownerId: SESSION })
    await settle()
    monitor.dispose()
    fake.emit({
      type: "patch",
      patch: { cursor: workflowViewCursor(SESSION), position: 101, prevPosition: 100, payload: { kind: "workflow_view.removed" } },
    })
    assert.equal(monitor.view?.attempts.length, 1)
  })
})

test("passive workflow readers share run cursors, never hold a session, apply live patches, and release the final subscription", async () => {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const reads: RuntimeQuery[] = []
  const running = { attemptId: "a", sessionId: "member", operations: 1, duration: 0, revision: 1 }
  // A passive reader reads only these three, and never dispatches: the fake
  // connection refuses every other query and every mutation.
  const connection = fakeRuntimeConnection({
    onQuery: (query) => { reads.push(query) },
    queries: {
      workflowDetail: (query) => { assert.equal(query.workflowId, "run"); return { snapshotPosition: 4, view: null } },
      workflowViewSnapshot: (query) => { assert.equal(query.workflowId, "run"); return { snapshotPosition: 4, view: view([attempt("plan", "running")]) } },
      workflowLiveSnapshot: (query) => { assert.equal(query.workflowId, "run"); return { snapshotPosition: 4, view: { agents: [running] } } },
    },
  }, {
    ...fakeLanes().client,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  const inspections = createWorkflowInspections(connection)
  let reading: WorkflowReading | undefined
  const first = inspections.subscribe("run", next => { reading = next })
  const second = inspections.subscribe("run", () => {})
  try {
    await settle()
    assert.deepEqual(reads.map(query => query.type).sort(), ["workflowDetail", "workflowLiveSnapshot", "workflowViewSnapshot"].sort())
    assert.equal(listeners.size, 3)
    assert.deepEqual(reading?.live, [running])
    const parked = { ...running, interruptedAt: 9, revision: 2 }
    const event: FrontendEvent = { type: "patch", patch: { cursor: workflowLiveCursor("run"), position: 5, prevPosition: 4, payload: { kind: "workflow_live.changed", agents: [parked] } } }
    for (const listener of listeners) listener(event)
    assert.deepEqual(reading?.live, [parked])
    first()
    assert.equal(listeners.size, 3)
    second()
    assert.equal(listeners.size, 0)
  } finally { inspections.dispose() }
})

