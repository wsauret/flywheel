import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, test } from "node:test"

import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"
import { AccountAttachFailedError } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeConnection } from "../../../../src/protocol/client/connection.js"
import { RUNTIME_LIVENESS_POLICY } from "../../../../src/protocol/runtime-liveness.js"
import { heartbeatRuntime, heldBackoff, unixSocketLayer, waitFor } from "./_connection-fixtures.js"

/** The reconnect backoff steps, in milliseconds, that a connection asks for
 *  while three lanes in a row each hear one heartbeat and then fail: after
 *  a heartbeat interval by the connection's clock when the lane served,
 *  or at once. With the jitter at its floor, the steps are 125, 250, and
 *  500 ms as the backoff grows. */
async function backoffStepsOfFailingLanes(options: { readonly servedBeforeFailing: boolean }): Promise<readonly number[]> {
  const runtime = await heartbeatRuntime()
  let clock = 0
  const requested: number[] = []
  const connection = createRuntimeConnection({
    socket: runtime.client,
    random: () => 0,
    now: () => clock,
    waitForBackoff: async (milliseconds) => { requested.push(milliseconds) },
    faultAfterMs: 60_000,
  })
  const dialed = (lane: number) => () => runtime.connections() === lane
  const connected = () => connection.state === "connected"
  try {
    connection.subscribe(() => {})
    for (let lane = 1; lane <= 3; lane += 1) {
      await waitFor(dialed(lane))
      await runtime.heartbeat()
      await waitFor(connected)
      if (options.servedBeforeFailing) clock += RUNTIME_LIVENESS_POLICY.heartbeatIntervalMs
      await runtime.failLane()
    }
    await waitFor(dialed(4))
    return requested
  } finally {
    await connection.close()
    await runtime.close()
  }
}

describe("runtime connection resume", () => {
  // A page coming back to the foreground may hold a socket that died while it
  // was suspended. That socket delivers no close event, so the state still
  // says connected, and its silence deadline may be most of a minute away.
  test("a fresh-looking lane that answers a round trip is left alone", async () => {
    const runtime = await heartbeatRuntime()
    let now = 1_000_000
    const connection = createRuntimeConnection({ socket: runtime.client, now: () => now })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      now += 4_000
      connection.resume()
      await new Promise((resolve) => setTimeout(resolve, 25))
      assert.equal(connection.state, "connected")
      assert.equal(runtime.connections(), 1)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a fresh-looking lane whose socket died silently reattaches", async () => {
    // The heartbeat the client just heard may have been buffered while the
    // page was away, so recency alone proves nothing about the socket now.
    const runtime = await heartbeatRuntime()
    let now = 1_000_000
    const connection = createRuntimeConnection({ socket: runtime.client, now: () => now, random: () => 0 })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.severLatest()
      now += 1_000
      connection.resume()
      await waitFor(() => runtime.connections() === 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a fresh-looking lane that takes writes and answers nothing reattaches after one round trip", async () => {
    // A half-open socket accepts the probe and never answers it. The person
    // who chose the placement waits for the probe deadline, not a call deadline.
    const runtime = await heartbeatRuntime()
    let now = 1_000_000
    const connection = createRuntimeConnection({ socket: runtime.client, now: () => now, random: () => 0, resumeProbeDeadlineMs: 20 })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      runtime.muteLatest()
      now += 1_000
      connection.resume()
      await waitFor(() => runtime.connections() === 2, 500)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a connected lane silent past two heartbeats reattaches at once", async () => {
    const runtime = await heartbeatRuntime()
    let now = 1_000_000
    const connection = createRuntimeConnection({ socket: runtime.client, now: () => now, random: () => 0 })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      now += 11_000
      connection.resume()
      await waitFor(() => runtime.connections() === 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane waiting out a backoff redials at once", async () => {
    // The phone's failed-start row ("Tap to try again") retries through this
    // path: the start failed, the lane waits out its backoff, and the person
    // chooses the placement again.
    const runtime = await heartbeatRuntime()
    let backoffStarted = false
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      faultAfterMs: 60_000,
      // A backoff that ends only when something wakes the lane.
      waitForBackoff: async (_milliseconds, woken) => {
        backoffStarted = true
        await woken
      },
    })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      await runtime.failLane()
      await waitFor(() => backoffStarted)
      assert.equal(runtime.connections(), 1)
      connection.resume()
      await waitFor(() => runtime.connections() === 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane that is still connecting is dropped and redialed", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, now: () => 0 })
    try {
      connection.subscribe(() => {})
      await waitFor(() => runtime.connections() === 1)
      assert.equal(connection.state, "connecting")
      connection.resume()
      await waitFor(() => runtime.connections() === 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })
})

describe("runtime connection health", () => {
  // Recovery is not a state a person sees. The connection reports healthy until
  // recovery has failed for the fault window, then faulted; a fresh attach
  // clears the fault the moment the runtime answers again.
  test("a lane down past the fault window faults without a cause, and the next attach clears it", async () => {
    const runtime = await heartbeatRuntime()
    const seen: string[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      liveness: { heartbeatIntervalMs: 20, silenceDeadlineMs: 60 },
      faultAfterMs: 40,
    })
    connection.onHealthChange((health) => seen.push(health.kind === "faulted" ? `faulted:${health.cause ?? "-"}` : "healthy"))
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      assert.equal(connection.health.kind, "healthy")
      assert.deepEqual(seen, [])
      // Silence past the deadline breaks the lane. The window's end sends an
      // attach that hears nothing, so the fault lands a heartbeat later.
      await waitFor(() => connection.health.kind === "faulted", 2_000)
      assert.deepEqual(seen, ["faulted:-"])
      await waitFor(() => runtime.connections() === 2, 2_000)
      // A live runtime heartbeats on every interval. One heartbeat alone can
      // reach the broken lane's reader, which still drains the shared queue.
      await waitFor(() => {
        void runtime.heartbeat()
        return connection.health.kind === "healthy"
      }, 2_000)
      assert.deepEqual(seen, ["faulted:-", "healthy"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane silent past its deadline is already past the fault window, so the attach after it is the evidence", async () => {
    // The shape of a stopped account service: the lane hears nothing until
    // its silence deadline, and the next attach waits on a dial the service
    // never answers. The runtime has not answered since its last frame, which
    // is longer ago than the fault window, so the fault lands one heartbeat
    // interval after that attach and does not wait for it to end.
    const runtime = await heartbeatRuntime()
    // A dial that never connects, so the attach on it never ends on its own:
    // a fault that waited for the attach to end would never land.
    const unanswered = Layer.effect(Socket.Socket)(Effect.never)
    let dials = 0
    const connection = createRuntimeConnection({
      socket: Layer.unwrap(Effect.sync(() => {
        dials += 1
        return dials === 1 ? runtime.client : unanswered
      })),
      random: () => 0,
      liveness: { heartbeatIntervalMs: 20, silenceDeadlineMs: 400 },
      faultAfterMs: 100,
    })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      const lastFrameAt = Date.now()
      await waitFor(() => connection.health.kind === "faulted", 10_000)
      assert.equal(dials, 2)
      assert.ok(connection.health.kind === "faulted" && connection.health.since <= lastFrameAt)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane still waiting out its backoff when the fault window ends redials at once, and a runtime that answers that attach never faults", async () => {
    // The shape of a machine that froze for longer than the fault window:
    // each attach failed at once, the backoff grew, and the machine came back
    // while the next wait still had seconds to run. The fault must not show
    // for a runtime that would answer the attach the wait holds back.
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const seen: string[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      waitForBackoff: backoff.waitForBackoff,
      liveness: { heartbeatIntervalMs: 2_000, silenceDeadlineMs: 6_000 },
      faultAfterMs: 20,
    })
    connection.onHealthChange((health) => seen.push(health.kind))
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      await runtime.failLane()
      await waitFor(() => backoff.waiting() === 1)
      // The runtime answers again; the backoff alone holds the attach back.
      await runtime.heartbeat()
      await waitFor(() => connection.health.kind === "faulted" || (runtime.connections() === 2 && connection.state === "connected"))
      assert.deepEqual(seen, [])
      assert.equal(connection.state, "connected")
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a runtime the host sees appear ends a fault that rested on its absence, and the connection attaches at once with no notice", async () => {
    // The shape of a machine that restarted: attaches went unanswered while
    // the project slept, so the connection faulted. Then the machine list
    // shows the project open. The fault described the runtime that was not
    // there, so it ends, and the attach goes out now, not after a backoff.
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const seen: string[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      waitForBackoff: backoff.waitForBackoff,
      liveness: { heartbeatIntervalMs: 20, silenceDeadlineMs: 5_000 },
      faultAfterMs: 40,
    })
    connection.onHealthChange((health) => seen.push(health.kind))
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      await runtime.failLane()
      await waitFor(() => backoff.waiting() === 1)
      // The window's end cuts the wait short, and the attach after it is the
      // evidence: nothing reaches the runtime, so it never answers.
      await waitFor(() => runtime.connections() === 2)
      runtime.muteLatest()
      await waitFor(() => connection.health.kind === "faulted", 2_000)
      connection.appeared()
      assert.equal(connection.health.kind, "healthy")
      await waitFor(() => runtime.connections() === 3, 500)
      // The muted lane's server side can still take a heartbeat off the
      // shared queue, so the runtime sends until the new lane hears one.
      for (let sent = 0; sent < 10 && connection.state !== "connected"; sent++) {
        await runtime.heartbeat()
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.equal(connection.state, "connected")
      assert.deepEqual(seen, ["faulted", "healthy"])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a runtime the host sees appear keeps a fault the runtime stated in its own words", async () => {
    const runtime = await heartbeatRuntime()
    const connection = createRuntimeConnection({ socket: runtime.client, random: () => 0, waitForBackoff: heldBackoff().waitForBackoff })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      connection.fault("Module services failed to settle")
      connection.appeared()
      assert.equal(connection.health.kind === "faulted" ? connection.health.cause : undefined, "Module services failed to settle")
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("an attach sent when the fault window ends that does not answer within a heartbeat interval faults", async () => {
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      waitForBackoff: backoff.waitForBackoff,
      liveness: { heartbeatIntervalMs: 20, silenceDeadlineMs: 6_000 },
      faultAfterMs: 20,
    })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      await runtime.failLane()
      await waitFor(() => connection.health.kind === "faulted")
      // The fault waited for the attach the window's end sent.
      assert.equal(runtime.connections(), 2)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("an attach sent after the fault window that fails raises the fault from that failure, not from a timer, and the next attempt waits out its backoff", async () => {
    // The machine is still frozen when the window ends: the attach the
    // window's end sends is refused at once. That refusal is the evidence.
    // The heartbeat interval is far longer than the test, so a fault that
    // waited on a timer would not show at all.
    const runtime = await heartbeatRuntime()
    const backoff = heldBackoff()
    let refusing = false
    const refused = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("write EPIPE") }) }))))
    const connection = createRuntimeConnection({
      socket: Layer.unwrap(Effect.sync(() => refusing ? refused : runtime.client)),
      random: () => 0,
      waitForBackoff: backoff.waitForBackoff,
      liveness: { heartbeatIntervalMs: 60_000, silenceDeadlineMs: 120_000 },
      faultAfterMs: 20,
    })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      refusing = true
      await runtime.failLane()
      await waitFor(() => connection.health.kind === "faulted")
      // The window's end cut the first backoff short; the refusal made the
      // fault, so the attempt after it waits out an ordinary backoff.
      await waitFor(() => backoff.waiting() === 2)
      assert.equal(connection.health.kind, "faulted")
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane that served for a heartbeat interval before it broke reattaches at the first backoff step, so consecutive replacements never fault", async () => {
    // The shape of a runtime that served each lane and was then replaced,
    // as a planned replacement does. A backoff that kept growing across
    // served lanes would wait long enough to fault.
    assert.deepEqual(await backoffStepsOfFailingLanes({ servedBeforeFailing: true }), [125, 125, 125])
  })

  test("a lane ended on request redials at once, and every other end waits the backoff as before", async () => {
    // A page that returns asks for a fresh lane, and nothing failed that a
    // wait could protect. A lane the runtime ends, as a planned replacement
    // does for every client at once, keeps its jittered wait.
    const runtime = await heartbeatRuntime()
    let clock = 1_000_000
    const waits: number[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      random: () => 0,
      now: () => clock,
      waitForBackoff: async (milliseconds) => { waits.push(milliseconds) },
      faultAfterMs: 60_000,
    })
    const connected = () => connection.state === "connected"
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(connected)

      connection.reconnect()
      await waitFor(() => runtime.connections() === 2)
      assert.deepEqual(waits, [])

      // The redial after a request that fails at once waits the first step.
      await runtime.heartbeat()
      await waitFor(connected)
      await runtime.failLane()
      await waitFor(() => runtime.connections() === 3)
      assert.deepEqual(waits, [125])

      await runtime.heartbeat()
      await waitFor(connected)
      clock += RUNTIME_LIVENESS_POLICY.heartbeatIntervalMs * 3
      connection.resume()
      await waitFor(() => runtime.connections() === 4)
      assert.deepEqual(waits, [125])

      await runtime.heartbeat()
      await waitFor(connected)
      runtime.endLatest()
      await waitFor(() => runtime.connections() === 5)
      assert.deepEqual(waits, [125, 125])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a runtime that accepts each lane and fails it at once is redialed with a growing backoff", async () => {
    // A backoff that started again after any frame would dial a failing
    // runtime at the first step forever.
    assert.deepEqual(await backoffStepsOfFailingLanes({ servedBeforeFailing: false }), [125, 250, 500])
  })

  test("an attach the runtime refused faults at once with the runtime's words", async () => {
    // The refusal arrives as the socket layer's open failure, wrapped the way
    // Effect wraps a dial error; the connection reads the cause through it.
    const refused = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.fail(new Socket.SocketError({
      reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new AccountAttachFailedError("Module services failed to settle") }),
    }))))
    const connection = createRuntimeConnection({ socket: refused, random: () => 0, faultAfterMs: 60_000 })
    try {
      connection.subscribe(() => {})
      await waitFor(() => connection.health.kind === "faulted", 2_000)
      assert.equal(connection.health.kind === "faulted" ? connection.health.cause : undefined, "Module services failed to settle")
    } finally {
      await connection.close()
    }
  })

  test("a reported cause faults at once and is not replaced by the window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-client-health-"))
    const connection = createRuntimeConnection({ socket: unixSocketLayer(join(dir, "absent.sock")), random: () => 0, faultAfterMs: 30 })
    const events: string[] = []
    try {
      connection.subscribe((event) => { if (event.type === "runtime.health") events.push(event.health.kind) })
      await waitFor(() => connection.state === "recovering", 2_000)
      connection.fault("Module services failed to settle")
      assert.deepEqual(connection.health, { kind: "faulted", since: connection.health.kind === "faulted" ? connection.health.since : -1, cause: "Module services failed to settle" })
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.equal(connection.health.kind === "faulted" ? connection.health.cause : undefined, "Module services failed to settle")
      assert.deepEqual(events, ["faulted"])
    } finally {
      await connection.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
