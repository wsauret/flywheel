import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect"
import { Rpc, RpcClient, RpcGroup, RpcSerialization } from "effect/unstable/rpc"
import { Socket } from "effect/unstable/socket"
import { AccountAttachFailedError, type FrontendEvent, type FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeConnection } from "../../../../src/protocol/client/connection.js"
import { explainedByConnection, laneEndCause, lostWithLane } from "../../../../src/protocol/client/connection-failures.js"
import { CONTROL_RPC_DEADLINE_MS } from "../../../../src/infra/with-deadline.js"
import { RuntimeCallTimeout } from "../../../../src/protocol/runtime-client-deadlines.js"
import { RuntimeClientDiagnosticSchema } from "../../../../src/protocol/runtime-client-diagnostics.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../../src/protocol/runtime-liveness.js"
import { RuntimeProtocolError } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { outputCursor } from "../../../../src/protocol/output-protocol-types.js"
import { heartbeatRuntime, heldBackoff, SERVED_VERSION, servedRuntime, waitFor, withHeldDeadlines } from "./_connection-fixtures.js"
import { runtimeDispatch } from "../../../helpers/runtime-dispatch.js"

const settled = (promise: Promise<unknown>) => promise.then((value) => ({ ok: true as const, value }), (cause: unknown) => ({ ok: false as const, cause }))

describe("runtime connection lanes", () => {
  test("dispatch preserves admitted request and destination IDs through the production RPC boundary", async () => {
    const mutations: readonly FrontendMutation[] = [
      { type: "side-question.ask", sessionId: "parent", question: "Why?" },
      { type: "side-question.keep", sessionId: "parent", exchangeId: "exchange" },
      { type: "session.fork", sessionId: "parent" },
      { type: "settings.set_persistent_processes", expected: false, enabled: true },
      { type: "auth.profile.create", scope: { kind: "defaults" }, displayName: "New" },
      { type: "auth.profile.rename", scope: { kind: "defaults" }, id: "missing", displayName: "New" },
      { type: "background.warm" },
    ]
    // The runtime's own answer to each mutation is what the connection must return.
    const dispatch = runtimeDispatch({
      "side-question.ask": async () => ({ ok: true, requestId: "admitted-request" }),
      "side-question.keep": async () => ({ ok: true, destinationSessionId: "durable-fork" }),
      "session.fork": async () => ({ ok: true, sessionId: "kernel-fork" }),
      "settings.set_persistent_processes": async () => ({ ok: false, error: "Changed", kind: "stale" }),
      "auth.profile.create": async () => ({ id: "profile", displayName: "New" }),
      "auth.profile.rename": async () => ({ ok: false, error: "Auth profile management is unavailable" }),
      "background.warm": async () => undefined,
    })
    const runtime = await servedRuntime({}, dispatch)
    const connection = createRuntimeConnection({ socket: runtime.client })
    try {
      for (const mutation of mutations) assert.deepEqual(await connection.dispatch(mutation), await dispatch(mutation))
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("the subscription is the first write of a lane, and a call the lane opens with follows it with no wait for the runtime", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client })
    const lanes: number[] = []
    try {
      connection.onLane((lane) => {
        lanes.push(lane)
        void connection.query({ type: "commandUsageSnapshot" })
      })
      connection.subscribe(() => {})
      await waitFor(() => runtime.arrivals.length === 2)
      assert.deepEqual(runtime.arrivals, ["events", "query:commandUsageSnapshot"])
      // The runtime has sent no frame: the lane opened on the write alone.
      assert.equal(connection.state, "connecting")
      assert.deepEqual(lanes, [1])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("the output watch statement leads the burst a lane opens with, and the transcript read follows it", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client })
    try {
      connection.onLane(() => { void settled(connection.query({ type: "commandUsageSnapshot" })) })
      connection.onLane(() => {
        connection.watchOutput("s")
        void settled(connection.query({ type: "outputWindow", sessionId: "s", request: { range: { anchor: { kind: "tail" }, maxBlocks: 1, maxBytes: 1 } } }))
      })
      connection.subscribe(() => {})
      await waitFor(() => runtime.arrivals.length === 4)
      assert.deepEqual(runtime.arrivals, ["events", "dispatch:output.watch:s", "query:outputWindow", "query:commandUsageSnapshot"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("watch changes coalesce into one whole-set statement that goes out before the next call", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client })
    try {
      connection.subscribe(() => {})
      await waitFor(() => runtime.arrivals.length === 1)
      const releaseA = connection.watchOutput("a")
      connection.watchOutput("b")
      const second = connection.watchOutput("b")
      void settled(connection.query({ type: "commandUsageSnapshot" }))
      await waitFor(() => runtime.arrivals.length === 3)
      assert.deepEqual(runtime.arrivals.slice(1), ["dispatch:output.watch:a,b", "query:commandUsageSnapshot"])
      // One of two watches of b ends: the set is the same, so nothing goes out.
      second()
      releaseA()
      releaseA()
      await waitFor(() => runtime.arrivals.length === 4)
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(runtime.arrivals.slice(3), ["dispatch:output.watch:b"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane's end clears its watches, and each lane states what its receivers watch on it", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    const releases: Array<() => void> = []
    try {
      connection.onLane((lane) => { if (lane <= 2) releases.push(connection.watchOutput(`s${lane}`)) })
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => runtime.arrivals.includes("dispatch:output.watch:s1"))
      runtime.endLatest()
      await waitFor(() => runtime.arrivals.includes("dispatch:output.watch:s2"))
      // The watch of the first lane ended with it: its release states nothing.
      releases[0]!()
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(runtime.arrivals.filter((arrival) => arrival.startsWith("dispatch:")), ["dispatch:output.watch:s1", "dispatch:output.watch:s2"])
      runtime.endLatest()
      await waitFor(() => runtime.arrivals.filter((arrival) => arrival === "events").length === 3)
      await new Promise((resolve) => setImmediate(resolve))
      // The third lane's receivers watch nothing, and it starts with no set.
      assert.equal(runtime.arrivals.filter((arrival) => arrival.startsWith("dispatch:")).length, 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("the runtime sends each connection the output deltas of the sessions it watches, and every connection each output invalidation", async () => {
    const runtime = await servedRuntime()
    const terminal = createRuntimeConnection({ socket: runtime.client })
    const browser = createRuntimeConnection({ socket: runtime.client })
    const delta = (sessionId: string): FrontendEvent => ({ type: "patch", patch: { cursor: outputCursor(sessionId), position: 1, prevPosition: 0, payload: { kind: "output.delta", delta: { blocks: [], streamingToolTextOps: [] } } } })
    const marker: FrontendEvent = { type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position: 1, prevPosition: 0, payload: { kind: "executor.changed", executor: { kind: "serving" } } } }
    // What each connection heard on the output cursors, and whether the marker that follows them arrived.
    const heard = (connection: typeof terminal) => {
      const output: string[] = []
      const record = { output, marked: false }
      connection.subscribe((event) => {
        if (event.type !== "patch") return
        if (event.patch.payload.kind === "executor.changed") record.marked = true
        else if (event.patch.cursor.scope === "session" && event.patch.cursor.domain === "output") record.output.push(`${event.patch.payload.kind} ${event.patch.cursor.sessionId}`)
      })
      return record
    }
    try {
      const terminalHeard = heard(terminal)
      const browserHeard = heard(browser)
      terminal.watchOutput("a")
      browser.watchOutput("b")
      await waitFor(() => runtime.unions.at(-1)?.length === 2)
      runtime.emit(delta("a"))
      runtime.emit(delta("b"))
      runtime.emit({ type: "patch", patch: { cursor: outputCursor("a"), position: 2, prevPosition: 1, payload: { kind: "runtime.invalidate", reason: "rebase" } } })
      runtime.emit(marker)
      await waitFor(() => terminalHeard.marked && browserHeard.marked)
      assert.deepEqual(terminalHeard.output, ["output.delta a", "runtime.invalidate a"])
      assert.deepEqual(browserHeard.output, ["output.delta b", "runtime.invalidate a"])
    } finally {
      await terminal.close()
      await browser.close()
      await runtime.close()
    }
  })

  test("a listener added during a lane hears that lane once, and every later lane once", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      const heard: number[] = []
      connection.onLane((lane) => heard.push(lane))
      assert.deepEqual(heard, [1])
      runtime.endLatest()
      await waitFor(() => heard.length === 2)
      assert.deepEqual(heard, [1, 2])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("the runtime's first frame is consumed, not forwarded, and a fault clears only once the runtime answers", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client })
    const events: FrontendEvent[] = []
    let opened = false
    try {
      connection.fault("the runtime said no")
      connection.onLane(() => { opened = true })
      connection.subscribe((event) => events.push(event))
      await waitFor(() => opened)
      assert.equal(connection.health.kind, "faulted")
      await runtime.emit({ type: "runtime.connected" })
      await waitFor(() => connection.state === "connected")
      assert.equal(connection.health.kind, "healthy")
      assert.deepEqual(events.map((event) => event.type), ["runtime.health"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a call made between lanes answers on the next lane", async () => {
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: backoff.waitForBackoff })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.endLatest()
      await waitFor(() => backoff.waiting() === 1)
      const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(runtime.arrivals.filter((arrival) => arrival === "query:commandUsageSnapshot").length, 0)
      backoff.release()
      assert.deepEqual(await answer, { ok: true, value: { usage: { uses: [] }, snapshotPosition: 0 } })
      assert.deepEqual(runtime.arrivals.slice(-2), ["events", "query:commandUsageSnapshot"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a call made between lanes fails with the cause of the attempt that failed, as a lane failure", async () => {
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    let dials = 0
    const refused = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new AccountAttachFailedError("the project could not open") }) }))))
    const socket = Layer.unwrap(Effect.sync(() => (dials++ === 0 ? runtime.client : refused)))
    const connection = createRuntimeConnection({ socket, random: () => 0, waitForBackoff: backoff.waitForBackoff })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.endLatest()
      await waitFor(() => backoff.waiting() === 1)
      const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
      backoff.release()
      const outcome = await answer
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(lostWithLane(outcome.cause), true)
      assert.match(String(outcome.cause), /the project could not open/)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a hold made between lanes is dropped when the next lane opens, because its holder holds again there", async () => {
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: backoff.waitForBackoff })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.endLatest()
      await waitFor(() => backoff.waiting() === 1)
      const hold = settled(connection.dispatch({ type: "session.activate", sessionId: "s" }))
      backoff.release()
      const outcome = await hold
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(lostWithLane(outcome.cause), true)
      await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(runtime.arrivals.includes("dispatch:session.activate"), false)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  // A socket whose run ends with no typed error, such as a relay channel
  // that breaks under a dropped connection, ends the lane as surely as a
  // close does. The call it carried is lost with the lane, so its owner
  // treats it as it treats any call a lane took down, and the lane-end
  // record still names the defect.
  test("a call in flight when its socket's run fails with no typed error is lost with the lane", async () => {
    const written = Promise.withResolvers<void>()
    // The run fails once the client has sent the call and waits on it.
    const breaking = Layer.succeed(Socket.Socket)(Socket.make({
      runRaw: () => Effect.promise(() => written.promise).pipe(Effect.andThen(Effect.sleep("20 millis")), Effect.andThen(Effect.die(new Error("the relay channel broke")))),
      writer: Effect.succeed(() => Effect.sync(() => written.resolve())),
    }))
    const connection = createRuntimeConnection({ socket: breaking })
    try {
      const outcome = await settled(connection.dispatch({ type: "chat.open" }))
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(lostWithLane(outcome.cause), true)
      assert.deepEqual(laneEndCause(outcome.cause), { kind: "defect" })
    } finally {
      await connection.close()
    }
  })

  test("a read in flight when a reconnect ends its lane fails as lost with the lane", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      // A half-open socket takes the read and answers nothing.
      runtime.muteLatest()
      const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
      connection.reconnect()
      const outcome = await answer
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(lostWithLane(outcome.cause), true)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a runtime of another protocol refuses the attach with its release; the connection shows that and attaches once the runtime speaks its protocol", async () => {
    const runtime = await heartbeatRuntime()
    runtime.serve({ version: "9.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 })
    const backoff = heldBackoff()
    const laneEnds: unknown[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      waitForBackoff: backoff.waitForBackoff,
      onDiagnostic: (message, detail) => { if (message === "runtime event lane ended") laneEnds.push(detail) },
    })
    try {
      connection.subscribe(() => {})
      await waitFor(() => backoff.waiting() === 1)
      const health = connection.health
      assert.equal(health.kind, "faulted")
      if (health.kind !== "faulted") return
      assert.deepEqual(health.refusal, { kind: "protocol-mismatch", version: "9.0.0", protocolVersion: RUNTIME_PROTOCOL_VERSION + 1 })
      // The refusal repeats at the next attempt, and the connection reports
      // the run once.
      backoff.release()
      await waitFor(() => backoff.waiting() === 1 && runtime.arrivals.filter((arrival) => arrival === "events").length === 2)
      assert.deepEqual(laneEnds, [{ kind: "refused" }])
      // The runtime updates to this client's release, and the next attach is admitted.
      runtime.serve({ version: SERVED_VERSION, protocolVersion: RUNTIME_PROTOCOL_VERSION })
      backoff.release()
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      assert.deepEqual(connection.health, { kind: "healthy" })
      assert.deepEqual(runtime.arrivals.filter((arrival) => arrival === "events"), ["events", "events", "events"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("the runtime refuses an attach of a later protocol in band, whatever fields that client adds, names its own release, and fails the read written after it with the lane", async () => {
    // The runtime's bundle check waits until the read has arrived, so the
    // read arrives while the subscription is not registered yet. A runtime
    // that serves no client admits every bundle and checks the protocol next.
    const own = Promise.withResolvers<string | undefined>()
    const runtime = await servedRuntime({ clientIdentity: () => own.promise })
    // A later client's attach: a protocol version this runtime does not
    // speak, and a field this runtime does not know.
    const later = RpcGroup.make(
      Rpc.make("RuntimeQuery", { payload: Schema.Unknown, success: Schema.Unknown, error: RuntimeProtocolError }),
      Rpc.make("RuntimeEvents", { payload: Schema.Unknown, success: Schema.Unknown, error: RuntimeProtocolError, stream: true }),
    )
    const client = ManagedRuntime.make(RpcClient.layerProtocolSocket().pipe(Layer.provide(runtime.client), Layer.provide(RpcSerialization.layerMsgPack)))
    try {
      const [refusal, read] = await client.runPromise(Effect.scoped(Effect.flatMap(RpcClient.make(later), (rpc) => Effect.all([
        Stream.runDrain(rpc.RuntimeEvents({ protocolVersion: RUNTIME_PROTOCOL_VERSION + 1, clientIdentity: "b".repeat(64), attachedFrom: "a later field" })).pipe(Effect.flip),
        rpc.RuntimeQuery({ type: "commandUsageSnapshot" }).pipe(Effect.flip),
        Effect.promise(() => waitFor(() => runtime.arrivals.includes("query:commandUsageSnapshot"))).pipe(Effect.andThen(Effect.sync(() => own.resolve(undefined)))),
      ], { concurrency: "unbounded" }))))
      assert.ok(refusal instanceof RuntimeProtocolError)
      assert.equal(refusal.kind, "protocol-mismatch")
      assert.deepEqual(refusal.runtime, { version: SERVED_VERSION, protocolVersion: RUNTIME_PROTOCOL_VERSION })
      // The read waited for the subscription and fails with its refusal,
      // which the connection's health shows, so no receiver shows the read.
      assert.equal(lostWithLane(read), true)
    } finally {
      await client.dispose()
      await runtime.close()
    }
  })

  test("a refused attach fails a read its lane opened with as lost with the lane, so no receiver shows it", async () => {
    // The runtime's identity check waits until the read has arrived, so the
    // read arrives while the subscription is not registered yet.
    const own = Promise.withResolvers<string | undefined>()
    const runtime = await servedRuntime({ clientIdentity: () => own.promise })
    const connection = createRuntimeConnection({ socket: runtime.client, clientIdentity: "b".repeat(64), onClientMismatch: () => {} })
    const reads: Array<Promise<{ ok: boolean; cause?: unknown }>> = []
    try {
      connection.onLane(() => { reads.push(settled(connection.query({ type: "commandUsageSnapshot" }))) })
      connection.subscribe(() => {})
      await waitFor(() => runtime.arrivals.includes("query:commandUsageSnapshot"))
      own.resolve("a".repeat(64))
      const outcome = await reads[0]
      assert.equal(outcome?.ok, false)
      assert.equal(lostWithLane(outcome?.cause), true)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("an attempt whose socket never opens seeds nothing, and a call that waited fails with the open failure", async () => {
    const backoff = heldBackoff()
    const socket = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("nothing listens there") }) }))))
    const connection = createRuntimeConnection({ socket, random: () => 0, waitForBackoff: backoff.waitForBackoff })
    const lanes: number[] = []
    try {
      connection.onLane((lane) => lanes.push(lane))
      connection.subscribe(() => {})
      const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
      await waitFor(() => backoff.waiting() === 1)
      const outcome = await answer
      assert.equal(outcome.ok, false)
      if (outcome.ok) return
      assert.equal(lostWithLane(outcome.cause), true)
      assert.match(String(outcome.cause), /SocketOpenError/)
      assert.deepEqual(lanes, [])
    } finally {
      await connection.close()
    }
  })

  test("a call with no listener goes straight to the runtime", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client })
    try {
      assert.deepEqual(await connection.query({ type: "commandUsageSnapshot" }), { usage: { uses: [] }, snapshotPosition: 0 })
      assert.deepEqual(runtime.arrivals, ["query:commandUsageSnapshot"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("each lane reports one attach record with durations and kinds only", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    try {
      connection.onLane(() => { void settled(connection.query({ type: "commandUsageSnapshot" })) })
      connection.subscribe(() => {})
      await runtime.emit({ type: "runtime.connected" })
      await waitFor(() => runtime.reports.length === 1)
      const [first] = runtime.reports
      assert.ok(typeof first === "object" && first !== null)
      assert.deepEqual(Object.keys(first).sort(), ["answerMs", "attempts", "backoffMs", "burst", "dialMs", "kind", "previousEnd"])
      assert.deepEqual({ ...first, answerMs: 0, dialMs: 0 }, { kind: "lane_attach", previousEnd: "first", attempts: 1, backoffMs: 0, dialMs: 0, answerMs: 0, burst: 1 })
      assert.deepEqual(Schema.decodeUnknownSync(RuntimeClientDiagnosticSchema)(first), first)

      runtime.endLatest()
      await waitFor(() => runtime.connections() === 2)
      // The ended lane's stream may still take a frame before its end
      // reaches the runtime, so the runtime answers until the new lane hears.
      for (let frames = 0; frames < 100 && runtime.reports.length < 2; frames += 1) {
        await runtime.emit({ type: "runtime.connected" })
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      assert.deepEqual(runtime.reports.map((report) => typeof report === "object" && report !== null && "previousEnd" in report ? report.previousEnd : undefined), ["first", "ended"])
      const second = runtime.reports[1]
      assert.ok(typeof second === "object" && second !== null && "previousCause" in second)
      assert.deepEqual(second.previousCause, { kind: "closed", code: 1000 })
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  for (const scenario of [
    { name: "abnormal close", cause: new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1006, closeReason: "not diagnostic content" }) }), expected: { kind: "closed", code: 1006 } },
    { name: "read error", cause: new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: new Error("read") }) }), expected: { kind: "read-error" } },
    { name: "write error", cause: new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: new Error("write") }) }), expected: { kind: "write-error" } },
    { name: "refusal", cause: new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new AccountAttachFailedError("denied") }) }), expected: { kind: "refused" } },
    { name: "defect", cause: new Error("unexpected"), expected: { kind: "defect" } },
    { name: "requested", expected: { kind: "requested" } },
    { name: "probe", probe: true, expected: { kind: "probe" } },
    { name: "silence", silence: true, expected: { kind: "silent" } },
    { name: "suspension", silence: true, suspended: true, expected: { kind: "requested" } },
  ]) {
    test(`the next attach identifies the previous lane's ${scenario.name} and end-time visibility`, async () => {
      // Every lane is heard through the runtime's greeting, so no frame the
      // test emits can reach a lane that is ending instead of the next one.
      const runtime = await heartbeatRuntime({ greets: true })
      const silenceDeadlineMs = 200
      let clock = 0
      const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
      const page = { visibilityState: "visible" }
      Object.defineProperty(globalThis, "document", { configurable: true, value: page })
      const diagnostics: { message: string; detail: unknown }[] = []
      const connection = createRuntimeConnection({
        socket: runtime.client, now: () => clock, random: () => 0, waitForBackoff: async () => {},
        resumeProbeDeadlineMs: 5,
        ...("silence" in scenario ? { liveness: { heartbeatIntervalMs: 5, silenceDeadlineMs } } : {}),
        onDiagnostic: (message, detail) => { diagnostics.push({ message, detail }) },
      })
      try {
        // The silence deadlines are held, so a lane goes silent only when the
        // test expires its deadline. A silence scenario expires the first
        // lane's, and the next lane's never passes.
        await withHeldDeadlines(silenceDeadlineMs, async (expire) => {
          // The page hides and the clock moves in the step that hears the
          // silent lane's only frame, so the lane ends with them in place.
          // Only what was reported before the next lane answered belongs to
          // the first lane.
          let firstLaneDiagnostics: typeof diagnostics | undefined
          connection.onStateChange((state) => {
            if (state !== "connected" || !("silence" in scenario)) return
            if (clock !== 0) {
              firstLaneDiagnostics ??= [...diagnostics]
              return
            }
            page.visibilityState = "hidden"
            clock = "suspended" in scenario ? 1_000 : silenceDeadlineMs
          })
          connection.subscribe(() => {})
          await waitFor(() => runtime.reports.length === 1)
          page.visibilityState = "hidden"
          if ("cause" in scenario) runtime.endLatest(scenario.cause)
          // Only the first lane's deadline exists until the next lane dials,
          // and the dial count is read in the same step as each expiry, so no
          // expiry reaches the next lane. A woken deadline checks the real
          // time and waits again for what remains, so expiry repeats until
          // the lane ends a whole deadline after its frame.
          else if ("silence" in scenario) await waitFor(() => runtime.connections() === 2 || (expire(), false))
          else if ("probe" in scenario) { runtime.muteLatest(); connection.resume() }
          else connection.reconnect()
          await waitFor(() => runtime.connections() === 2)
          page.visibilityState = "visible"
          await waitFor(() => runtime.reports.length === 2)
          const record = Schema.decodeUnknownSync(RuntimeClientDiagnosticSchema)(runtime.reports[1])
          assert.equal(record.kind, "lane_attach")
          if (record.kind !== "lane_attach") throw new Error("expected lane attach")
          assert.deepEqual(record.previousCause, scenario.expected)
          assert.equal(record.previousVisibility, "hidden")
          if (scenario.name === "abnormal close") {
            assert.equal(JSON.stringify(diagnostics).includes("not diagnostic content"), false)
            assert.deepEqual(diagnostics, [{ message: "runtime event lane ended", detail: { kind: "closed", code: 1006 } }])
          }
          if (scenario.name === "silence") {
            assert.deepEqual(firstLaneDiagnostics, [{ message: "runtime event lane ended", detail: { kind: "silent" } }])
          }
          if (scenario.name === "suspension") assert.deepEqual(firstLaneDiagnostics, [])
          assert.equal(record.previousEnd, scenario.name === "requested" || scenario.name === "suspension" ? "requested" : scenario.name === "probe" ? "probe" : "failed")
        })
      } finally {
        await connection.close()
        await runtime.close()
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument)
        else Reflect.deleteProperty(globalThis, "document")
      }
    })
  }
})

describe("runtime connection read deadlines", () => {
  // A read whose deadline passes while the lane delivers nothing, not even a
  // heartbeat, failed because the connection does not answer. The lane ends
  // at its silence deadline, or the runtime answers again, and the fault
  // notice names a silence that lasts. So no reader shows a failure of its
  // own for it.
  test("a read that times out while the lane hears nothing is the connection's silence, not the read's failure", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.muteLatest()
      await withHeldDeadlines(CONTROL_RPC_DEADLINE_MS, async (expire) => {
        const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
        await new Promise((resolve) => setTimeout(resolve, 10))
        expire()
        const outcome = await answer
        assert.equal(outcome.ok, false)
        if (outcome.ok) return
        assert.equal(explainedByConnection(outcome.cause), true)
        assert.equal(lostWithLane(outcome.cause), false)
      })
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a read that times out while the lane still hears the runtime is the read's own failure", async () => {
    const runtime = await heartbeatRuntime({ answersQueries: false })
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: async () => {} })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      await withHeldDeadlines(CONTROL_RPC_DEADLINE_MS, async (expire) => {
        const answer = settled(connection.query({ type: "commandUsageSnapshot" }))
        await waitFor(() => runtime.arrivals.includes("query:commandUsageSnapshot"))
        await runtime.heartbeat()
        await new Promise((resolve) => setTimeout(resolve, 10))
        expire()
        const outcome = await answer
        assert.equal(outcome.ok, false)
        if (outcome.ok) return
        assert.ok(outcome.cause instanceof RuntimeCallTimeout)
        assert.equal(explainedByConnection(outcome.cause), false)
      })
    } finally {
      await connection.close()
      await runtime.close()
    }
  })
})
