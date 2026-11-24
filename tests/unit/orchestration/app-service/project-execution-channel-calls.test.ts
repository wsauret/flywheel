import { describe, expect, test } from "bun:test"
import { pack } from "msgpackr"
import { connectProjectExecutionChannel, serveProjectExecutionChannel } from "../../../../src/orchestration/app-service/executor/project-execution-channel.js"
import { deferred, endpointPair, manualClock, markerEvent, markerPosition, requestFrame, runtimeHarness } from "./project-execution-channel-fixtures.js"

/** How many calls a client sends before it queues the rest, read from a
 *  burst far larger than that bound. A watch statement bypasses the call
 *  queue, so it arrives after every request that the client sent before it. */
async function clientCapacity(): Promise<number> {
  const burst = 1024
  const [peer, endpoint] = endpointPair()
  let sent = 0
  const flushed = deferred<void>()
  peer.onMessage((value) => {
    if (typeof value === "object" && value !== null && "kind" in value && value.kind === "watch") flushed.resolve()
    else sent += 1
  })
  const client = connectProjectExecutionChannel(endpoint, { clock: manualClock().clock })
  const calls = Array.from({ length: burst }, (_, index) => client.dispatch({ type: "session.close", sessionId: `${index}` }).catch(() => undefined))
  client.watchOutput([])
  await flushed.promise
  await client.close()
  await Promise.all(calls)
  expect(sent).toBeGreaterThan(0)
  expect(sent).toBeLessThan(burst)
  return sent
}

describe("project execution call deadlines and capacity", () => {
  test("a query that the account withdraws aborts on the executor, and the executor's late answer is dropped", async () => {
    const [serverEndpoint, clientEndpoint] = endpointPair()
    const harness = runtimeHarness()
    const started = deferred<AbortSignal>()
    const finish = deferred<void>()
    const stop = serveProjectExecutionChannel({
      ...harness.runtime,
      query: async (request, options) => {
        started.resolve(options?.signal ?? new AbortController().signal)
        await finish.promise
        return harness.runtime.query(request)
      },
    }, serverEndpoint)
    const client = connectProjectExecutionChannel(clientEndpoint)
    const withdrawal = new AbortController()
    const withdrawn = client.query({ type: "commandUsageSnapshot" }, { signal: withdrawal.signal }).then(() => undefined, (error: unknown) => error)
    const executorSignal = await started.promise
    withdrawal.abort()
    expect(await withdrawn).toMatchObject({ name: "AbortError" })
    const aborted = deferred<void>()
    if (executorSignal.aborted) aborted.resolve()
    else executorSignal.addEventListener("abort", () => aborted.resolve(), { once: true })
    await aborted.promise
    finish.resolve()
    // The withdrawn call keeps its slot until the late answer, and the channel goes on serving.
    expect(await client.query({ type: "commandUsageSnapshot" })).toMatchObject({ snapshotPosition: 7 })
    await client.close()
    await stop()
  })

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
    const capacity = await clientCapacity()
    const [peer, clientEndpoint] = endpointPair()
    const requests: Array<{ id: string }> = []
    const capacityReached = deferred<void>()
    const extraRequest = deferred<void>()
    peer.onMessage((value) => {
      requests.push(requestFrame(value))
      if (requests.length === capacity) capacityReached.resolve()
      if (requests.length === capacity + 1) extraRequest.resolve()
    })
    const timer = manualClock()
    const client = connectProjectExecutionChannel(clientEndpoint, { clock: timer.clock })
    const expired = Array.from({ length: capacity }, () =>
      client.query({ type: "commandUsageSnapshot" }).catch((cause: unknown) => cause))
    await capacityReached.promise
    timer.expireAll()
    await Promise.all(expired)

    const admitted = client.query({ type: "commandUsageSnapshot" })
    expect(requests).toHaveLength(capacity)

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
    expect(requests).toHaveLength(capacity + 1)
    peer.close()
    await expect(admitted).rejects.toThrow("closed")
  })

  test("queues a burst in FIFO order and expires queued reads without sending them", async () => {
    const capacity = await clientCapacity()
    const [peer, endpoint] = endpointPair()
    const requests: Array<{ id: string }> = []
    const frames: unknown[] = []
    const full = deferred<void>()
    const admitted = deferred<void>()
    peer.onMessage(value => {
      frames.push(value)
      requests.push(requestFrame(value))
      if (requests.length === capacity) full.resolve()
      if (requests.length === capacity + 2) admitted.resolve()
    })
    const timer = manualClock()
    const client = connectProjectExecutionChannel(endpoint, { clock: timer.clock })
    const occupying = Array.from({ length: capacity }, (_, index) => client.dispatch({ type: "session.close", sessionId: `${index}` }).catch(() => undefined))
    await full.promise
    const expired = client.query({ type: "commandUsageSnapshot" }).catch(cause => cause)
    timer.expireAll()
    expect(await expired).toMatchObject({ name: "RuntimeCallTimeout" })
    const queued = [client.dispatch({ type: "session.close", sessionId: "first" }), client.query({ type: "commandUsageSnapshot" })]
    expect(requests).toHaveLength(capacity)
    for (const request of requests.slice(0, 2)) await peer.send({ kind: "result", id: request.id, result: { ok: true } })
    await admitted.promise
    expect(frames.slice(capacity)).toMatchObject([
      { kind: "dispatch", mutation: { sessionId: "first" } },
      { kind: "query", query: { type: "commandUsageSnapshot" } },
    ])
    const result = { snapshotPosition: 7, usage: { uses: [] } }
    await peer.send({ kind: "result", id: requests[capacity]!.id, result: { ok: true } })
    await peer.send({ kind: "result", id: requests[capacity + 1]!.id, result })
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
