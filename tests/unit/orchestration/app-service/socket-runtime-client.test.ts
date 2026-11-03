import { describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime } from "effect"
import { RpcServer } from "effect/rpc"
import { layerMsgPack } from "../../../../src/protocol/rpc-msgpack.js"

import type { FrontendEvent, FrontendMutation, MutationResult, RuntimeTransportHealth } from "../../../../src/protocol/app-service-types.js"
import { ServeStartupFailure } from "../../../../src/protocol/serve-handshake.js"
import { RuntimeProtocolRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { bunSocketServerLayer } from "../../../../src/orchestration/app-service/bun-socket-rpc.js"
import { runtimeHandlers } from "../../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createOutputWatches } from "../../../../src/orchestration/app-service/output-watches.js"
import { runtimeProtocolSocketServer } from "../../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { createSocketRuntimeClient } from "../../../../src/orchestration/app-service/socket-runtime-client.js"
import { DebugLog } from "../../../../src/infra/debug-log.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

type UsageRecordResult = MutationResult<Extract<FrontendMutation, { readonly type: "command_usage.record" }>>

/** A runtime served over a real Bun unix socket that holds every dispatch
 *  until the test answers it, so a call can be in flight at the moment the
 *  client starts to close. */
async function heldRuntime() {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-client-"))
  const socketPath = join(dir, "serve.sock")
  const listeners = new Set<(event: FrontendEvent) => void>()
  const dispatched = Promise.withResolvers<FrontendMutation>()
  const answer = Promise.withResolvers<UsageRecordResult>()
  const service: Parameters<typeof runtimeHandlers>[0]["client"] = {
    query: () => Promise.reject(new Error("not under test")),
    disconnect: () => {},
    dispatch: runtimeDispatch({ "command_usage.record": (mutation) => {
      dispatched.resolve(mutation)
      return answer.promise
    } }),
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const listening = Promise.withResolvers<void>()
  const log = { debug: () => {}, info: () => {}, error: () => {}, warn: () => {} }
  const server = ManagedRuntime.make(RpcServer.layer(RuntimeProtocolRpc).pipe(
    Layer.provide(runtimeHandlers({ client: service, outputWatches: createOutputWatches({ onUnionChange: () => {} }) }, log, { version: "0.1.0" })),
    Layer.provide(runtimeProtocolSocketServer),
    Layer.provide(layerMsgPack),
    Layer.provide(bunSocketServerLayer({ path: socketPath, onListening: () => listening.resolve() })),
  ))
  await server.runPromise(Effect.void)
  await listening.promise
  return {
    socketPath,
    dispatched: dispatched.promise,
    answer: (result: UsageRecordResult) => answer.resolve(result),
    /** The service shuts down: every connection closes and the socket goes. */
    stop: () => server.dispose(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

async function attachedClient(runtime: Awaited<ReturnType<typeof heldRuntime>>) {
  const ensures = { count: 0 }
  const client = createSocketRuntimeClient({
    socketPath: runtime.socketPath,
    ensureRuntime: async () => { ensures.count += 1 },
  })
  const connected = Promise.withResolvers<void>()
  client.subscribe(() => {})
  client.onLane(() => { connected.resolve() })
  await connected.promise
  // A terminal has read from its runtime long before a person can type a
  // command. Only the answer's arrival matters here, not its content.
  await client.query({ type: "commandUsageSnapshot" }).catch(() => {})
  return { client, ensures }
}

describe("socket runtime client shutdown", () => {
  test("a client that starts closing finishes the call already crossing", async () => {
    // The terminal closes its client the moment exit begins, in the same
    // turn the exit command records its own use.
    const runtime = await heldRuntime()
    const diagnostics = spyOn(DebugLog, "record").mockImplementation(() => {})
    const { client } = await attachedClient(runtime)
    try {
      await client.query({ type: "commandUsageSnapshot" }).catch(() => {})
      const attaches = diagnostics.mock.calls.filter(([record]) => record.type === "runtime.client.socket_attached")
      expect(attaches).toEqual([[{
        type: "runtime.client.socket_attached",
        payload: { socketPath: runtime.socketPath, lane: 1 },
      }]])
      const record = client.dispatch({ type: "command_usage.record", name: "exit" })
      const closing = client.close()

      expect(await runtime.dispatched).toEqual({ type: "command_usage.record", name: "exit" })
      runtime.answer({ ok: true })

      await expect(record).resolves.toEqual({ ok: true })
      await closing
    } finally {
      await client.close()
      await runtime.stop()
      runtime.cleanup()
      diagnostics.mockRestore()
    }
  })

  test("a client that starts closing never ensures a runtime again when the service goes away with it", async () => {
    // The race: a signal ends the terminal and its account service at the
    // same moment. The service closes the lane while the terminal is still
    // finishing its exit, and a terminal that recovers the lane launches a
    // new service that outlives both of them.
    const runtime = await heldRuntime()
    const { client, ensures } = await attachedClient(runtime)
    try {
      // A service that stops mid-call fails the call; only its settling matters.
      const record = client.dispatch({ type: "command_usage.record", name: "exit" }).catch(() => undefined)
      await runtime.dispatched
      const attachedEnsures = ensures.count
      expect(attachedEnsures).toBeGreaterThan(0)
      const closing = client.close()

      await runtime.stop()

      await record
      await closing
      expect(ensures.count).toBe(attachedEnsures)
      await expect(client.dispatch({ type: "command_usage.record", name: "late" })).rejects.toThrow(/closed/)
      expect(ensures.count).toBe(attachedEnsures)
    } finally {
      await client.close()
      await runtime.stop()
      runtime.cleanup()
    }
  })
})

describe("socket runtime client start failure", () => {
  // The notice names the remedy for the refusal, so the refusal has to reach
  // the fault that every surface renders.
  test("a start that the service refused faults at once with the refusal it named", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-socket-client-"))
    const refusal = { kind: "claim-settling", path: join(dir, "serve.start.lock.reclaim.9a77") } as const
    const client = createSocketRuntimeClient({
      socketPath: join(dir, "serve.sock"),
      ensureRuntime: async () => { throw new ServeStartupFailure("Failed to acquire lock 'serve.start.lock' after 9 attempts", refusal) },
    })
    const faulted = Promise.withResolvers<RuntimeTransportHealth>()
    client.subscribe((event) => { if (event.type === "runtime.health" && event.health.kind === "faulted") faulted.resolve(event.health) })
    try {
      expect(await faulted.promise).toMatchObject({ kind: "faulted", cause: "Failed to acquire lock 'serve.start.lock' after 9 attempts", refusal })
    } finally {
      await client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
