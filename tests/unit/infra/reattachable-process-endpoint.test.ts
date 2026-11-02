import { describe, expect, test } from "bun:test"
import { createMessagePortProcessEndpoint, type InternalProcessEndpoint } from "../../../src/infra/internal-process-channel.js"
import { createReattachableProcessEndpoint } from "../../../src/infra/reattachable-process-endpoint.js"

function pair(): readonly [InternalProcessEndpoint<unknown, unknown>, InternalProcessEndpoint<unknown, unknown>] {
  const channel = new MessageChannel()
  return [
    createMessagePortProcessEndpoint({ port: channel.port1, decode: (value) => value }),
    createMessagePortProcessEndpoint({ port: channel.port2, decode: (value) => value }),
  ]
}

function manualClock() {
  const timers = new Set<() => void>()
  return {
    setTimer: (fire: () => void) => {
      const timer = (): void => fire()
      timers.add(timer)
      return () => { timers.delete(timer) }
    },
    fire() {
      const due = Array.from(timers)
      timers.clear()
      for (const run of due) run()
    },
    get pending() { return timers.size },
  }
}

describe("message dispatch", () => {
  test("a handler subscribed while a message is dispatched sees the next message, not that one", async () => {
    const [endpoint, peer] = pair()
    const late: unknown[] = []
    const stop = endpoint.onMessage((message) => {
      stop()
      endpoint.onMessage((next) => { late.push(next) })
      expect(message).toEqual({ n: 1 })
    })
    await peer.send({ n: 1 })
    await peer.send({ n: 2 })
    await Bun.sleep(5)
    expect(late).toEqual([{ n: 2 }])
    // An open port slows every later file of the same test process on Windows.
    endpoint.close("done")
    await peer.closed
  })

  test("the reattachable endpoint gives a handler subscribed during dispatch only later messages", async () => {
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 1_000 })
    const [transport, peer] = pair()
    endpoint.attach(transport)
    const late: unknown[] = []
    const stop = endpoint.onMessage(() => {
      stop()
      endpoint.onMessage((next) => { late.push(next) })
    })
    await peer.send({ n: 1 })
    await peer.send({ n: 2 })
    await Bun.sleep(5)
    expect(late).toEqual([{ n: 2 }])
    // An open port slows every later file of the same test process on Windows.
    endpoint.close("done")
    await peer.closed
  })
})

describe("reattachable process endpoint", () => {
  test("a lost transport detaches, sends wait, and a new transport carries them", async () => {
    const clock = manualClock()
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 1_000, ...clock })
    const received: unknown[] = []
    endpoint.onMessage((message) => { received.push(message) })
    const detached: string[] = []
    let reattached = 0
    endpoint.onDetach((reason) => { detached.push(reason.message) })
    endpoint.onReattach(() => { reattached += 1 })

    const [first, firstPeer] = pair()
    endpoint.attach(first)
    await firstPeer.send({ n: 1 })
    await Bun.sleep(5)
    expect(received).toEqual([{ n: 1 }])

    firstPeer.close("socket reset")
    await first.closed
    expect(endpoint.attached).toBe(false)
    expect(detached).toEqual(["internal process endpoint peer closed"])
    expect(clock.pending).toBe(1)

    let delivered = false
    const waiting = endpoint.send({ n: 2 }).then(() => { delivered = true })
    await Bun.sleep(5)
    expect(delivered).toBe(false)

    const [second, secondPeer] = pair()
    const seen: unknown[] = []
    secondPeer.onMessage((message) => { seen.push(message) })
    endpoint.attach(second)
    await waiting
    await Bun.sleep(5)
    expect(seen).toEqual([{ n: 2 }])
    expect(reattached).toBe(1)
    expect(clock.pending).toBe(0)
    let closed = false
    void endpoint.closed.then(() => { closed = true })
    await Bun.sleep(1)
    expect(closed).toBe(false)
    endpoint.close("done")
  })

  test("the deadline passing with nothing reattached closes the endpoint with the cause", async () => {
    const clock = manualClock()
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 250, ...clock })
    const [first, firstPeer] = pair()
    endpoint.attach(first)
    firstPeer.close("socket reset")
    await first.closed
    const pending = endpoint.send({ n: 2 })
    const outcome = Promise.allSettled([pending])
    clock.fire()
    await endpoint.closed
    let reason = ""
    endpoint.onClose((error) => { reason = error.message })
    expect(reason).toContain("not reattached within 250ms")
    expect(reason).toContain("peer closed")
    expect((await outcome)[0]?.status).toBe("rejected")
  })

  test("attaching over a live transport supersedes it and an explicit close closes the transport", async () => {
    const clock = manualClock()
    const endpoint = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs: 1_000, ...clock })
    const [first] = pair()
    const [second] = pair()
    endpoint.attach(first)
    endpoint.attach(second)
    await first.closed
    expect(endpoint.attached).toBe(true)
    endpoint.close("generation ended")
    await second.closed
    await endpoint.closed
    await expect(endpoint.send({})).rejects.toThrow("generation ended")
  })
})
