import { describe, expect, test } from "bun:test"
import { withSnapshotHydrationLimit } from "../../../../src/tui/hooks/snapshot-hydration-limit.js"
import type { AttachedRuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

type Deferred = { promise: Promise<void>; resolve: () => void }

function deferred(): Deferred {
  // SAFETY: the Promise executor runs synchronously, so resolve is assigned before return.
  let resolve!: () => void
  const promise = new Promise<void>((r) => { resolve = r })
  return { promise, resolve }
}

function gateFor(gates: ReadonlyMap<string, Deferred>, id: string): Deferred {
  const gate = gates.get(id)
  if (!gate) throw new Error(`no in-flight gate for ${id}`)
  return gate
}

function createFakeClient(onStart: (sessionId: string, gate: Deferred) => void): Pick<AttachedRuntimeClient, "subscribe" | "query" | "onLane"> {
  const start = async (sessionId: string) => {
    const gate = deferred()
    onStart(sessionId, gate)
    await gate.promise
  }
  // Each snapshot load waits on its gate, then answers an empty snapshot.
  const sessionsSnapshot = async (request: { readonly sessionIds: readonly string[] }) => {
    await start(request.sessionIds[0] ?? "")
    return { views: [], snapshotPosition: 0 }
  }
  return {
    subscribe: () => () => {},
    onLane: fakeLanes().onLane,
    query: runtimeQuery({
      statusSnapshot: sessionsSnapshot,
      budgetSnapshot: sessionsSnapshot,
      questionSnapshot: sessionsSnapshot,
      workflowViewSnapshot: async (request) => {
        await start(request.workflowId)
        return { view: null, snapshotPosition: 0 }
      },
    }),
  }
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

describe("withSnapshotHydrationLimit", () => {
  test("caps in-flight snapshot loads across all four domains", async () => {
    const inFlight = new Map<string, Deferred>()
    const client = withSnapshotHydrationLimit(createFakeClient((id, gate) => inFlight.set(id, gate)), 2)

    const calls = [
      client.query({ type: "statusSnapshot", sessionIds: ["a"] }),
      client.query({ type: "budgetSnapshot", sessionIds: ["b"] }),
      client.query({ type: "workflowViewSnapshot", workflowId: "c" }),
      client.query({ type: "questionSnapshot", sessionIds: ["d"] }),
    ]
    await settle()
    expect([...inFlight.keys()]).toEqual(["a", "b"])

    gateFor(inFlight, "a").resolve()
    await settle()
    expect([...inFlight.keys()]).toEqual(["a", "b", "c"])

    for (const gate of inFlight.values()) gate.resolve()
    await settle()
    expect([...inFlight.keys()]).toEqual(["a", "b", "c", "d"])
    gateFor(inFlight, "d").resolve()
    await Promise.all(calls)
  })

  test("admits waiters in FIFO order and releases permits on failure", async () => {
    const started: string[] = []
    const gates = new Map<string, Deferred>()
    const base = createFakeClient((id, gate) => {
      started.push(id)
      gates.set(id, gate)
    })
    const failing: Pick<AttachedRuntimeClient, "subscribe" | "query" | "onLane"> = {
      ...base,
      query: async (query) => {
        if (query.type === "statusSnapshot") {
          started.push(query.sessionIds[0] ?? "")
          throw new Error("boom")
        }
        return base.query(query)
      },
    }
    const client = withSnapshotHydrationLimit(failing, 1)

    const first = client.query({ type: "statusSnapshot", sessionIds: ["fail"] })
    const second = client.query({ type: "workflowViewSnapshot", workflowId: "next" })
    await expect(first).rejects.toThrow("boom")
    await settle()
    expect(started).toEqual(["fail", "next"])

    gateFor(gates, "next").resolve()
    await second
  })

  test("passes results and subscribe through untouched", async () => {
    let subscribed = 0
    const base = createFakeClient((_, gate) => gate.resolve())
    const client = withSnapshotHydrationLimit({ ...base, subscribe: () => { subscribed++; return () => {} } }, 4)
    client.subscribe(() => {})
    expect(subscribed).toBe(1)
    expect(await client.query({ type: "workflowViewSnapshot", workflowId: "s" })).toEqual({ view: null, snapshotPosition: 0 })
  })
})
