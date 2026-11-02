import { describe, expect, test } from "bun:test"
import { connectProjectExecutionChannel, serveProjectExecutionChannel } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { deferred, endpointPair, markerEvent, responseFrame, runtimeHarness } from "./project-execution-channel-fixtures.js"

describe("project execution channel event batching", () => {
  test("sends the events of one tick as one transport message, in order, and bounds each message", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    // The frames each transport message carried; a message without frames counts as none.
    const sent: number[] = []
    const stop = serveProjectExecutionChannel(harness.runtime, {
      ...serverEndpoint,
      async send(message) {
        sent.push(typeof message === "object" && message !== null && "frames" in message && Array.isArray(message.frames) ? message.frames.length : 0)
        await serverEndpoint.send(message)
      },
    })
    const client = connectProjectExecutionChannel(clientEndpoint)
    const positions: number[] = []
    let expected = 160
    let arrived = deferred<void>()
    client.subscribe((event) => {
      if (event.type === "patch") positions.push(event.patch.position)
      if (positions.length === expected) arrived.resolve()
    })

    // A 160-agent fan-out publishes one patch per agent in one tick.
    for (let position = 1; position <= 160; position += 1) harness.emit(markerEvent(position))
    await arrived.promise
    expect(sent).toEqual([160])
    expect(positions).toEqual(Array.from({ length: 160 }, (_, index) => index + 1))

    // A backlog larger than one batch goes as several bounded messages.
    sent.length = 0
    positions.length = 0
    expected = 4
    arrived = deferred<void>()
    const title = "x".repeat(200_000)
    for (let position = 1; position <= 2; position += 1) {
      harness.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "executor" }, position, prevPosition: position - 1, payload: { kind: "executor.changed", executor: { kind: "serving" } } } })
      harness.emit({ type: "patch", patch: { cursor: { scope: "session", domain: "session", sessionId: `s-${position}` }, position, prevPosition: 0, payload: { kind: "session.updated", row: { id: `s-${position}`, kind: "chat", title, lifecycleState: "inactive", notices: [], inputMode: { kind: "chat" }, lastUpdated: "now", executionCwd: "/project", totalsLoading: true } } } })
    }
    await arrived.promise
    expect(positions).toEqual([1, 1, 2, 2])
    expect(sent).toEqual([3, 1])

    await client.close()
    await stop()
  })

  test("a turn's burst from the runtime UI bus stays one message while an earlier send is pending, and a reply never waits for the turn", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const bus = createRuntimeUiBus()
    // Once set, the query publishes a patch, then answers within the same turn.
    let publishInQuery = false
    let turnEndedBeforeReply: boolean | undefined
    let turnEnded = false
    const query = runtimeQuery({
      commandUsageSnapshot: async () => {
        if (publishInQuery) {
          bus.publish({ cursor: { scope: "workspace", domain: "executor" }, payload: { kind: "executor.changed", executor: { kind: "serving" } } })
          turnEnded = false
          setImmediate(() => { turnEnded = true })
        }
        return { snapshotPosition: 7, usage: { uses: [] } }
      },
    })
    const runtime = {
      query,
      dispatch: runtimeDispatch({}),
      watchOutput() {},
      hideSession: async () => {},
      subscribe(listener: (event: FrontendEvent) => void) {
        bus.addListener(listener)
        return () => bus.removeListener(listener)
      },
    }
    // Each message as its frame count, or its kind when it carries no frames.
    const sent: Array<number | string> = []
    let hold: Promise<void> | undefined
    const stop = serveProjectExecutionChannel(runtime, {
      ...serverEndpoint,
      async send(message) {
        const frame = responseFrame(message)
        if (frame.kind === "result") turnEndedBeforeReply = turnEnded
        sent.push(typeof message === "object" && message !== null && "frames" in message && Array.isArray(message.frames) ? message.frames.length : frame.kind)
        const gate = hold
        hold = undefined
        await gate
        await serverEndpoint.send(message)
      },
    })
    const client = connectProjectExecutionChannel(clientEndpoint)
    let received = 0
    let target = 0
    let arrived = deferred<void>()
    client.subscribe(() => { if (++received === target) arrived.resolve() })
    function expectEvents(count: number) {
      received = 0
      target = count
      arrived = deferred<void>()
    }
    function burst() {
      for (let index = 0; index < 160; index += 1) bus.publish({ cursor: { scope: "session", domain: "session", sessionId: `s-${index}` }, payload: { kind: "session.removed" } })
    }

    // A burst published while an events send is pending, which completes
    // while the bus is still handing the burst over.
    expectEvents(161)
    const first = deferred<void>()
    hold = first.promise
    bus.publish({ cursor: { scope: "workspace", domain: "executor" }, payload: { kind: "executor.changed", executor: { kind: "serving" } } })
    while (sent.length === 0) await new Promise<void>((resolve) => { setImmediate(resolve) })
    burst()
    first.resolve()
    await arrived.promise
    expect(sent).toEqual([1, 160])

    // A burst published while a reply is sending.
    sent.length = 0
    expectEvents(160)
    const reply = deferred<void>()
    hold = reply.promise
    const answered = client.query({ type: "commandUsageSnapshot" })
    while (sent.length === 0) await new Promise<void>((resolve) => { setImmediate(resolve) })
    burst()
    reply.resolve()
    await answered
    await arrived.promise
    expect(sent).toEqual(["result", 160])

    // A reply queued while the query's patch waits for its turn goes before
    // that turn ends.
    sent.length = 0
    expectEvents(1)
    publishInQuery = true
    await client.query({ type: "commandUsageSnapshot" })
    await arrived.promise
    expect(sent).toEqual(["result", 1])
    expect(turnEndedBeforeReply).toBe(false)

    await client.close()
    await stop()
    await bus.clear()
  })
})
