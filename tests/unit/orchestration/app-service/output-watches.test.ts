import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { Rpc, RpcTest } from "effect/rpc"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { runtimeHandlers } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../../src/protocol/runtime-liveness.js"
import { RuntimeProtocolRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"

describe("output watches", () => {
  test("the union counts each session once however many connections watch it, and changes only when a session enters or leaves it", () => {
    const unions: string[][] = []
    const watches = createOutputWatches({ onUnionChange: (sessionIds) => { unions.push([...sessionIds].sort()) } })
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    watches.state(terminal, ["a", "b"])
    watches.state(browser, ["b"])
    watches.state(terminal, ["b", "a"])
    watches.state(terminal, ["a"])
    watches.state(browser, ["c"])
    expect(unions).toEqual([["a", "b"], ["a", "c"]])
  })

  test("a connection that ends leaves the union at once", () => {
    const unions: string[][] = []
    const watches = createOutputWatches({ onUnionChange: (sessionIds) => { unions.push([...sessionIds].sort()) } })
    const terminal = new Rpc.ServerClient(1)
    const browser = new Rpc.ServerClient(2)
    watches.state(terminal, ["a"])
    watches.state(browser, ["a", "b"])
    expect(watches.watches(browser, "b")).toBe(true)
    expect(watches.watches(terminal, "b")).toBe(false)
    watches.drop(browser)
    expect(watches.watches(browser, "a")).toBe(false)
    watches.drop(terminal)
    watches.drop(terminal)
    expect(unions).toEqual([["a"], ["a", "b"], ["a"], []])
  })

  test("a connection that watches sessions the union already holds states nothing to the executor", () => {
    let unionSizes = 0
    const watches = createOutputWatches({ onUnionChange: (sessionIds) => { unionSizes += sessionIds.length } })
    const many = new Rpc.ServerClient(1)
    const few = new Rpc.ServerClient(2)
    watches.state(many, Array.from({ length: 500 }, (_, index) => `s${index}`))
    unionSizes = 0
    // A connection that names sessions the union already holds changes nothing.
    for (let index = 0; index < 50; index++) watches.state(few, [`s${index}`])
    expect(unionSizes).toBe(0)
  })

  test("the protocol boundary states a connection's watch before it forwards the read that the connection sent next, and the end of its lane drops its set", async () => {
    const order: string[] = []
    const watches = createOutputWatches({ onUnionChange: (sessionIds) => { order.push(`watch ${sessionIds.join(",")}`) } })
    const unused = () => Promise.reject(new Error("not under test"))
    const layer = runtimeHandlers({
      client: {
        dispatch: unused, disconnect: () => {}, subscribe: () => () => {},
        query: (query) => {
          order.push(`query ${query.type}`)
          return new Promise(() => {})
        },
      },
      outputWatches: watches,
    }, { debug() {}, info() {}, error() {}, warn() {} }, { version: "0.1.0" })
    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* RpcTest.makeClient(RuntimeProtocolRpc)
      const lane = yield* Stream.runDrain(client.RuntimeEvents({ protocolVersion: RUNTIME_PROTOCOL_VERSION })).pipe(Effect.forkScoped)
      yield* Effect.forkScoped(client.RuntimeDispatch({ type: "output.watch", sessionIds: ["s"] }))
      yield* Effect.forkScoped(client.RuntimeQuery({ type: "outputWindow", sessionId: "s", request: { range: { anchor: { kind: "tail" }, maxBlocks: 1, maxBytes: 1 } } }))
      while (order.length < 2) yield* Effect.yieldNow
      expect(order).toEqual(["watch s", "query outputWindow"])
      yield* Fiber.interrupt(lane)
      while (order.length < 3) yield* Effect.yieldNow
    }).pipe(Effect.scoped, Effect.provide(layer)))
    expect(order).toEqual(["watch s", "query outputWindow", "watch "])
  })
})
