import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, describe, test } from "node:test"

import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"
import type { RuntimeEventFrame } from "../../../../src/protocol/app-service-types.js"
import { createRuntimeConnection } from "../../../../src/protocol/client/connection.js"
import { heartbeatRuntime, unixSocketLayer, waitFor } from "./_connection-fixtures.js"

/** A socket that accepts a connection and then says nothing, which is the shape
 *  of every runtime that is alive and simply has nothing to send yet. */
function silentServer() {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-client-"))
  const path = join(dir, "ide.sock")
  const sockets: net.Socket[] = []
  const waiters = new Map<number, () => void>()
  const server = net.createServer((socket) => {
    sockets.push(socket)
    waiters.get(sockets.length)?.()
    waiters.delete(sockets.length)
  })
  server.listen(path)
  return {
    path,
    waitForConnections: (expected: number) => {
      if (sockets.length >= expected) return Promise.resolve()
      return new Promise<void>((resolve) => { waiters.set(expected, resolve) })
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => {
          rmSync(dir, { recursive: true, force: true })
          resolve()
        })
      }),
  }
}

test("unsupported events do not reconnect or cancel reads and report once per session", async () => {
  const server = await heartbeatRuntime()
  const diagnostics: string[] = []
  const connection = createRuntimeConnection({ socket: server.client, onDiagnostic: (message) => diagnostics.push(message) })
  const received: RuntimeEventFrame[] = []
  const unsubscribe = connection.subscribe((event) => { if (event.type !== "runtime.startup" && event.type !== "runtime.health") received.push(event) })
  try {
    await server.emit({ type: "runtime.connected" })
    await waitFor(() => connection.state === "connected")
    const unsupported = {
      type: "patch",
      patch: { cursor: { scope: "session", domain: "future-changes", sessionId: "session-a" }, position: 1, prevPosition: 0, payload: { kind: "future.changed", content: "not diagnostic data" } },
    }
    await server.emit(unsupported)
    await server.emit(unsupported)
    await server.emit({ ...unsupported, patch: { ...unsupported.patch, cursor: { ...unsupported.patch.cursor, sessionId: "session-b" } } })
    const known = { type: "patch", patch: { cursor: { scope: "session", domain: "changes", sessionId: "session-a" }, position: 2, prevPosition: 0, payload: { kind: "changes.changed" } } }
    await server.emit(known)
    await waitFor(() => received.some((event) => event.type === "patch"))
    assert.deepEqual(await connection.query({ type: "commandUsageSnapshot" }), { usage: { uses: [] }, snapshotPosition: 0 })
    const unsupportedReports = () => server.reports.filter((report) => typeof report === "object" && report !== null && "kind" in report && report.kind === "unsupported_patch")
    await waitFor(() => unsupportedReports().length === 2)
    assert.deepEqual(received.filter((event) => event.type === "patch"), [known])
    assert.equal(server.connections(), 1)
    assert.equal(connection.state, "connected")
    assert.equal(diagnostics.includes("runtime event lane ended"), false)
    assert.equal(JSON.stringify(server.reports).includes("not diagnostic data"), false)
    assert.deepEqual(unsupportedReports(), [
      { kind: "unsupported_patch", cursor: { scope: "session", domain: "future-changes", sessionId: "session-a" }, payloadKind: "future.changed" },
      { kind: "unsupported_patch", cursor: { scope: "session", domain: "future-changes", sessionId: "session-b" }, payloadKind: "future.changed" },
    ])
  } finally {
    unsubscribe()
    await connection.close()
    await server.close()
  }
})

test("a lane the runtime closes cleanly, as a planned stop does, attaches again without a report, and a failed lane is reported", async () => {
  const server = await heartbeatRuntime()
  const diagnostics: string[] = []
  const connection = createRuntimeConnection({ socket: server.client, random: () => 0, waitForBackoff: async () => {}, onDiagnostic: (message) => diagnostics.push(message) })
  const unsubscribe = connection.subscribe(() => {})
  try {
    await server.heartbeat()
    await waitFor(() => connection.state === "connected")
    server.endLatest()
    await waitFor(() => server.connections() === 2)
    // The ended lane's stream may still take a frame before its end reaches
    // the runtime, so the runtime beats until the new lane hears one.
    for (let beats = 0; beats < 100 && connection.state !== "connected"; beats += 1) {
      await server.heartbeat()
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(connection.state, "connected")
    assert.deepEqual(diagnostics, [])

    await server.failLane()
    await waitFor(() => server.connections() === 3)
    assert.deepEqual(diagnostics, ["runtime event lane ended"])
  } finally {
    unsubscribe()
    await connection.close()
    await server.close()
  }
})

test("a read made while a cleanly closed lane is released answers on the next lane, not with a defect", async () => {
  const server = await heartbeatRuntime()
  const connection = createRuntimeConnection({ socket: server.client, random: () => 0, waitForBackoff: async () => {} })
  let read: Promise<unknown> | undefined
  // A receiver re-reads when the lane is voided, a turn later, as the
  // session changes intake does.
  const unsubscribe = connection.subscribe((event) => {
    if (event.type === "patch" && event.patch.payload.kind === "runtime.invalidate" && read === undefined) {
      queueMicrotask(() => { read = connection.query({ type: "commandUsageSnapshot" }).then(() => undefined, (cause: unknown) => cause) })
    }
  })
  try {
    await server.heartbeat()
    await waitFor(() => connection.state === "connected")
    server.endLatest()
    await waitFor(() => read !== undefined)
    assert.equal(await read, undefined)
  } finally {
    unsubscribe()
    await connection.close()
    await server.close()
  }
})

/** Settles to true if the promise finished inside the bound. Used instead of a
 *  bare await so a hang fails the test rather than the whole run. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  try {
    return await Promise.race([promise.then(() => true, () => true), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("runtime connection find-or-start", () => {
  /** A dial where nothing listens, as a socket path whose runtime has gone reads. */
  const nothingListening = Layer.effect(Socket.Socket)(Socket.fromTransformStream(Effect.fail(new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause: new Error("connect ENOENT") }) }))))

  test("a lane that finds nothing listening after it had connected asks the host to find or start the runtime before it reconnects", async () => {
    const runtime = await heartbeatRuntime()
    let listening = true
    let ensures = 0
    const socket = Layer.unwrap(Effect.sync(() => listening ? runtime.client : nothingListening))
    const connection = createRuntimeConnection({ socket, random: () => 0, ensureRuntime: async () => { ensures += 1; listening = true } })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      // The runtime goes away: the lane drops, and the next dial finds nothing.
      listening = false
      connection.reconnect()
      await waitFor(() => ensures === 1 && runtime.connections() === 2)
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      assert.equal(ensures, 1)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a lane that has never connected leaves the first start to the host that opened it", async () => {
    let ensures = 0
    let dials = 0
    const socket = Layer.unwrap(Effect.sync(() => { dials += 1; return nothingListening }))
    const connection = createRuntimeConnection({ socket, random: () => 0, ensureRuntime: async () => { ensures += 1 } })
    try {
      connection.subscribe(() => {})
      // A lane that finds or starts the runtime does so before it dials again.
      await waitFor(() => dials >= 2)
      assert.equal(ensures, 0)
    } finally {
      await connection.close()
    }
  })

  test("a find-or-start that fails is a fault in its own words", async () => {
    const runtime = await heartbeatRuntime()
    let listening = true
    const socket = Layer.unwrap(Effect.sync(() => listening ? runtime.client : nothingListening))
    const connection = createRuntimeConnection({ socket, random: () => 0, ensureRuntime: async () => { throw new Error("the registered account service did not start listening within 75 seconds") } })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      listening = false
      connection.reconnect()
      await waitFor(() => connection.health.kind === "faulted")
      assert.deepEqual(connection.health, { kind: "faulted", since: connection.health.kind === "faulted" ? connection.health.since : 0, cause: "the registered account service did not start listening within 75 seconds" })
    } finally {
      await connection.close()
      await runtime.close()
    }
  })
})

describe("runtime connection client identity", () => {
  const identity = "a".repeat(64)

  test("the page's identity rides on every event attach", async () => {
    const runtime = await heartbeatRuntime({ identity })
    const connection = createRuntimeConnection({ socket: runtime.client, clientIdentity: identity })
    try {
      connection.subscribe(() => {})
      await runtime.heartbeat()
      await waitFor(() => connection.state === "connected")
      assert.deepEqual(runtime.attaches, [identity])
    } finally {
      await connection.close()
      await runtime.close()
    }
  })

  test("a refused identity reports the mismatch once and never reattaches", async () => {
    const runtime = await heartbeatRuntime({ identity })
    let mismatches = 0
    const events: string[] = []
    const connection = createRuntimeConnection({
      socket: runtime.client,
      clientIdentity: "0".repeat(64),
      random: () => 0,
      onClientMismatch: () => { mismatches += 1 },
    })
    try {
      connection.subscribe((event) => { events.push(event.type) })
      await waitFor(() => mismatches === 1)
      // A reattach would dial a second socket; the backoff for attempt zero
      // is at most 250ms, so this window would show one.
      await new Promise((resolve) => setTimeout(resolve, 400))
      assert.equal(mismatches, 1)
      assert.equal(runtime.connections(), 1)
      assert.deepEqual(runtime.attaches, ["0".repeat(64)])
      assert.equal(events.includes("runtime.connected"), false)
    } finally {
      await connection.close()
      await runtime.close()
    }
  })
})

describe("runtime connection lifecycle", () => {
  const server = silentServer()
  after(() => server.close())

  test("close settles while the event lane is still open", async () => {
    // The regression this exists for: a healthy subscription never ends on its
    // own, because the runtime heartbeats into it for as long as it lives.
    // Waiting for the stream to finish before closing is waiting for something
    // that cannot happen, and the editor host hangs on deactivate.
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    connection.subscribe(() => {})

    assert.equal(await settlesWithin(connection.close(), 5_000), true, "close must not wait on the event lane")
    assert.equal(connection.state, "closed")
  })

  test("close settles when nothing ever subscribed", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    assert.equal(await settlesWithin(connection.close(), 5_000), true)
  })

  test("close is idempotent", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    connection.subscribe(() => {})
    await connection.close()
    assert.equal(await settlesWithin(connection.close(), 5_000), true)
  })

  test("rejects calls made after close rather than hanging on a dead runtime", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    await connection.close()
    await assert.rejects(() => connection.query({ type: "snapshot" }), /closed/)
  })

  test("reports state transitions to listeners", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    const seen: string[] = []
    connection.onStateChange((state) => seen.push(state))
    await connection.close()
    assert.deepEqual(seen, ["closed"])
  })

  test("dropping the last subscriber releases the event loop", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    const unsubscribe = connection.subscribe(() => {})
    unsubscribe()
    // With no subscriber the loop must stop rather than stay parked on a
    // subscription nothing reads.
    assert.equal(await settlesWithin(connection.close(), 5_000), true)
  })

  test("an immediate replacement subscriber starts a fresh event lane", async () => {
    const connection = createRuntimeConnection({ socket: unixSocketLayer(server.path) })
    const unsubscribe = connection.subscribe(() => {})
    await server.waitForConnections(1)

    unsubscribe()
    const unsubscribeReplacement = connection.subscribe(() => {})
    await server.waitForConnections(2)

    unsubscribeReplacement()
    await connection.close()
  })
})
