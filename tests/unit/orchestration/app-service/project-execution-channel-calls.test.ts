import { describe, expect, test } from "bun:test"
import { pack } from "msgpackr"
import { connectProjectExecutionChannel, PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS } from "../../../../src/orchestration/app-service/project-execution-channel.js"
import { deferred, endpointPair, manualClock, markerEvent, markerPosition, requestFrame } from "./project-execution-channel-fixtures.js"

describe("project execution call deadlines and capacity", () => {
  test("keeps an expired read correlated until its late reply arrives", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const requests: Array<{ id: string }> = []
    const firstRequest = deferred<void>()
    const secondRequest = deferred<void>()
    peer.onMessage((value) => {
      requests.push(requestFrame(value))
      if (requests.length === 1) firstRequest.resolve()
      if (requests.length === 2) secondRequest.resolve()
    })
    const timer = manualClock()
    const client = connectProjectExecutionChannel(clientEndpoint, { clock: timer.clock })

    const expired = client.query({ type: "commandUsageSnapshot" })
    await firstRequest.promise
    timer.expireAll()
    await expect(expired).rejects.toThrow("didn't respond")

    await peer.send({
      kind: "result",
      id: requests[0]!.id,
      result: { snapshotPosition: 1, usage: { uses: [] } },
    })
    const next = client.query({ type: "commandUsageSnapshot" })
    await secondRequest.promise
    await peer.send({
      kind: "result",
      id: requests[1]!.id,
      result: { snapshotPosition: 2, usage: { uses: [] } },
    })
    await expect(next).resolves.toEqual({ snapshotPosition: 2, usage: { uses: [] } })
    await client.close()
  })

  test("counts timed-out work against client capacity until its reply arrives", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const requests: Array<{ id: string }> = []
    const capacityReached = deferred<void>()
    const extraRequest = deferred<void>()
    peer.onMessage((value) => {
      requests.push(requestFrame(value))
      if (requests.length === PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS) capacityReached.resolve()
      if (requests.length === PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS + 1) extraRequest.resolve()
    })
    const timer = manualClock()
    const client = connectProjectExecutionChannel(clientEndpoint, { clock: timer.clock })
    const expired = Array.from({ length: PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS }, () =>
      client.query({ type: "commandUsageSnapshot" }).catch((cause: unknown) => cause))
    await capacityReached.promise
    timer.expireAll()
    await Promise.all(expired)

    const admitted = client.query({ type: "commandUsageSnapshot" })
    expect(requests).toHaveLength(PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS)

    const replyProcessed = deferred<void>()
    client.subscribe((event) => {
      if (markerPosition(event) === 1) replyProcessed.resolve()
    })
    await peer.send({
      kind: "result",
      id: requests[0]!.id,
      result: { snapshotPosition: 1, usage: { uses: [] } },
    })
    await peer.send({ kind: "events", frames: [pack(markerEvent(1))] })
    await replyProcessed.promise
    await extraRequest.promise
    expect(requests).toHaveLength(PROJECT_EXECUTION_MAX_OUTSTANDING_CALLS + 1)
    peer.close()
    await expect(admitted).rejects.toThrow("closed")
  })

  test("queues a burst in FIFO order and expires queued reads without sending them", async () => {
    const [peer, endpoint] = endpointPair()
    const requests: Array<{ id: string }> = []
    const frames: unknown[] = []
    const full = deferred<void>()
    const admitted = deferred<void>()
    peer.onMessage(value => {
      frames.push(value)
      requests.push(requestFrame(value))
      if (requests.length === 64) full.resolve()
      if (requests.length === 66) admitted.resolve()
    })
    const timer = manualClock()
    const client = connectProjectExecutionChannel(endpoint, { clock: timer.clock })
    const occupying = Array.from({ length: 64 }, (_, index) => client.dispatch({ type: "session.close", sessionId: `${index}` }).catch(() => undefined))
    await full.promise
    const expired = client.query({ type: "commandUsageSnapshot" }).catch(cause => cause)
    timer.expireAll()
    expect(await expired).toMatchObject({ name: "RuntimeCallTimeout" })
    const queued = [client.dispatch({ type: "session.close", sessionId: "first" }), client.query({ type: "commandUsageSnapshot" })]
    expect(requests).toHaveLength(64)
    for (const request of requests.slice(0, 2)) await peer.send({ kind: "result", id: request.id, result: { ok: true } })
    await admitted.promise
    expect(frames.slice(64)).toMatchObject([
      { kind: "dispatch", mutation: { sessionId: "first" } },
      { kind: "query", query: { type: "commandUsageSnapshot" } },
    ])
    const result = { snapshotPosition: 7, usage: { uses: [] } }
    await peer.send({ kind: "result", id: requests[64]!.id, result: { ok: true } })
    await peer.send({ kind: "result", id: requests[65]!.id, result })
    expect(await Promise.all(queued)).toEqual([{ ok: true }, result])
    await client.close()
    await Promise.all(occupying)
  })

  test("does not apply a local deadline to mutations", async () => {
    const [peer, clientEndpoint] = endpointPair()
    const request = deferred<{ id: string }>()
    peer.onMessage((value) => request.resolve(requestFrame(value)))
    const timer = manualClock()
    const client = connectProjectExecutionChannel(clientEndpoint, { clock: timer.clock })
    const mutation = client.dispatch({ type: "session.close", sessionId: "session-1" })
    const sent = await request.promise
    timer.expireAll()
    await peer.send({ kind: "result", id: sent.id, result: { ok: true, sessionRemoved: true } })
    await expect(mutation).resolves.toEqual({ ok: true, sessionRemoved: true })
    await client.close()
  })
})
