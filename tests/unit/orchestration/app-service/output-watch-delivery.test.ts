import { expect, test } from "bun:test"
import { Rpc } from "effect/rpc"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection.js"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { connectProjectExecutionChannel, serveProjectExecutionChannel } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output.js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { batch, outputProjectionRuntime, textBlock, upsertChange } from "./_output-projection-fixtures.js"
import { endpointPair, markerPosition } from "./project-execution-channel-fixtures.js"
import { never } from "./_project-control-client-fixture.js"

const runtime = outputProjectionRuntime()

/** The account's watch owner, the private execution channel, and the
 *  executor's output publisher, wired as a project runs them, with the
 *  executor's sessions written by hand. */
async function project() {
  const store = createSessionStore(runtime, runtime.runSync(EventReaderService))
  const bus = createRuntimeUiBus()
  const projection = createOutputProjection({ sessionStore: store, shipped: createShippedOutput({ publish: bus.publish }) })
  const [serverEndpoint, clientEndpoint] = endpointPair()
  let applied = Promise.withResolvers<void>()
  const stop = serveProjectExecutionChannel({
    query: never, dispatch: never, hideSession: never,
    subscribe(listener) { bus.addListener(listener); return () => bus.removeListener(listener) },
    watchOutput(sessionIds) {
      projection.watch(sessionIds)
      applied.resolve()
    },
  }, serverEndpoint)
  const execution = connectProjectExecutionChannel(clientEndpoint)
  const watches = createOutputWatches({ onUnionChange: execution.watchOutput })
  // What reaches the account from the executor: every output change it
  // shipped, and the marker that ends each write.
  const shipped: { sessionId: string; kinds: string[] }[] = []
  let marked = Promise.withResolvers<void>()
  execution.subscribe((event: FrontendEvent) => {
    if (markerPosition(event) !== undefined) marked.resolve()
    if (event.type !== "patch" || event.patch.cursor.scope !== "session" || event.patch.payload.kind !== "output.delta") return
    shipped.push({ sessionId: event.patch.cursor.sessionId, kinds: event.patch.payload.delta.blocks.map((change) => change.kind) })
  })
  /** Runs `change`, a change of the union, and waits until the executor applied it. */
  const statement = async (change: () => void): Promise<void> => {
    applied = Promise.withResolvers()
    change()
    await applied.promise
  }
  let turn = 0
  return {
    shipped,
    watch: (connection: Rpc.ServerClient, sessionIds: readonly string[]) => statement(() => watches.state(connection, sessionIds)),
    leave: (connection: Rpc.ServerClient) => statement(() => watches.drop(connection)),
    open(sessionId: string) { store.openSessionRuntime({ sessionId, conversationId: `conv-${sessionId}` }) },
    /** Every session writes one more block, and the account hears what
     *  shipped: the marker the executor publishes last arrives after it. */
    async write(sessionIds: readonly string[]) {
      turn++
      for (const sessionId of sessionIds) {
        const block = { ...textBlock(sessionId), content: `${sessionId} ${turn}` }
        store.updateChatEntry(sessionId, { outputBlocks: [block], visibleMessageCountSuffix: 1, outputChanges: batch([upsertChange(0, block)]) })
        await projection.flush(sessionId)
      }
      marked = Promise.withResolvers()
      bus.publish({ cursor: { scope: "workspace", domain: "executor" }, payload: { kind: "executor.changed", executor: { kind: "serving" } } })
      await marked.promise
    },
    async close() {
      await execution.close()
      await stop()
      projection.dispose()
    },
  }
}

test("only the sessions some connection watches ship output, and a connection that opens a session follows it until it lets go", async () => {
  const p = await project()
  const terminal = new Rpc.ServerClient(1)
  const browser = new Rpc.ServerClient(2)
  try {
    p.open("root")
    p.open("child")
    await p.watch(terminal, ["root"])
    await p.write(["root", "child"])
    expect(p.shipped.map((entry) => entry.sessionId)).toEqual(["root"])

    p.shipped.length = 0
    await p.watch(browser, ["child"])
    await p.write(["root", "child"])
    // The child's first change after the watch ships whole over the read the browser made.
    expect(p.shipped).toEqual([{ sessionId: "root", kinds: ["edit"] }, { sessionId: "child", kinds: ["upsert"] }])

    p.shipped.length = 0
    await p.leave(browser)
    await p.write(["root", "child"])
    expect(p.shipped.map((entry) => entry.sessionId)).toEqual(["root"])
  } finally {
    await p.close()
  }
})
