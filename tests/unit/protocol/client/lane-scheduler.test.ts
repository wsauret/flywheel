import assert from "node:assert/strict"
import { test } from "node:test"

import { Effect, ManagedRuntime } from "effect"
import { createRuntimeConnection } from "../../../../src/protocol/client/connection.js"
import { laneSchedulerLayer } from "../../../../src/protocol/client/lane-scheduler.js"
import { heartbeatRuntime } from "./_connection-fixtures.js"

/** A browser's globals as the scheduler sees them: no `setImmediate`, and a
 *  timer that a page holds to 4 ms or more once it is nested. */
const browser = {
  MessageChannel: globalThis.MessageChannel,
  setTimeout: (task: () => void, ms: number) => globalThis.setTimeout(task, Math.max(ms, 4)),
}

test("in a browser, the burst a lane opens with yields without the nested-timer clamp", async () => {
  const runtime = ManagedRuntime.make(laneSchedulerLayer(browser))
  try {
    const burst = Effect.forEach(Array.from({ length: 27 }), () => Effect.yieldNow, { discard: true })
    // The first burst starts the channel; a page has done that long before
    // a reattach.
    await runtime.runPromise(burst)
    // A burst takes well under 1 ms through the channel, and more than 100 ms
    // through a clamped timer. A process that the machine deschedules or
    // collects during the burst only adds time, so one of up to three bursts
    // under the limit is the scheduler's own cost.
    const limit = 10
    let elapsed = Number.POSITIVE_INFINITY
    for (let measurement = 0; measurement < 3 && elapsed >= limit; measurement++) {
      const startedAt = performance.now()
      // One yield per call a reattach writes: the RPC client yields once for
      // each request it sends.
      await runtime.runPromise(burst)
      elapsed = performance.now() - startedAt
    }
    assert.ok(elapsed < limit, `27 yields took ${elapsed} ms`)
  } finally {
    await runtime.dispose()
  }
})

test("a connection in a browser yields through a MessageChannel task", async () => {
  let posted = 0
  class CountedChannel extends MessageChannel {
    constructor() {
      super()
      const post = this.port2.postMessage.bind(this.port2)
      this.port2.postMessage = (message: unknown) => {
        posted += 1
        post(message)
      }
    }
  }
  const runtime = await heartbeatRuntime()
  const connection = createRuntimeConnection({ socket: runtime.client, schedulerHost: { MessageChannel: CountedChannel } })
  try {
    await connection.query({ type: "commandUsageSnapshot" })
    assert.ok(posted > 0, "the connection never yielded through the channel")
  } finally {
    await connection.close()
    await runtime.close()
  }
})

test("where the host has setImmediate, the scheduler yields through the host's own", async () => {
  let immediates = 0
  const host = {
    MessageChannel: globalThis.MessageChannel,
    setImmediate: (task: () => void) => { immediates += 1; globalThis.setImmediate(task) },
  }
  const runtime = ManagedRuntime.make(laneSchedulerLayer(host))
  try {
    await runtime.runPromise(Effect.yieldNow)
    assert.ok(immediates > 0, "the scheduler never asked the host for a task")
  } finally {
    await runtime.dispose()
  }
})
