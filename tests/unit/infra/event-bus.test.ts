import { beforeEach, describe, expect, it, mock, spyOn } from "bun:test"
import { heapStats } from "bun:jsc"
import { DebugLog } from "../../../src/infra/debug-log.js"
import { EventBus, createEmit } from "../../../src/infra/event-bus.js"
import type { FlywheelEvent } from "../../../src/infra/events.js"

function makeEvent(sessionId = "s1"): FlywheelEvent {
  return {
    id: `event-${sessionId}`,
    type: "workflow.run.initialized",
    version: 1,
    sessionId,
    data: { attemptIds: ["s1"] },
    timestamp: Date.now(),
  }
}

function agentRunStartedEvent(sessionId: string): FlywheelEvent {
  return {
    id: `agent-${sessionId}`,
    type: "agent.run.started",
    version: 1,
    sessionId,
    data: { stepIndex: 0 },
    timestamp: Date.now(),
  }
}

describe("EventBus", () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  it("typed and wildcard subscribers receive emitted events after drain", async () => {
    const typed: FlywheelEvent[] = []
    const wildcard: FlywheelEvent[] = []
    bus.subscribe((event) => wildcard.push(event))
    bus.subscribeToType("workflow.run.initialized", (event) => typed.push(event), { deliveryClass: "ui", label: "typed-test" })

    const event = makeEvent()
    bus.emit(event)
    await bus.drain()

    expect(typed).toEqual([event])
    expect(wildcard).toEqual([event])
  })

  it("drain waits for async subscriber completion", async () => {
    const completed: string[] = []
    bus.subscribeToType("workflow.run.initialized", async (event) => {
      await Promise.resolve()
      completed.push(event.sessionId)
    }, { deliveryClass: "durable", label: "async-test" })

    bus.emit(makeEvent("async"))
    const result = await bus.drain()

    expect(result).toEqual({ kind: "drained" })
    expect(completed).toEqual(["async"])
  })

  it("subscribeToTypes preserves cross-type order for async listeners", async () => {
    const started: string[] = []
    let releaseFirst: () => void = () => {}
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve })

    bus.subscribeToTypes(["workflow.run.initialized", "agent.run.started"], async (event) => {
      started.push(`${event.type}:${event.sessionId}`)
      if (event.sessionId === "first") {
        await firstReleased
      }
    }, { deliveryClass: "durable", label: "ordered-types-test" })

    bus.emit(makeEvent("first"))
    bus.emit(agentRunStartedEvent("second"))
    const blocked = await bus.drain({ classes: ["durable"], timeoutMs: 10 })
    expect(blocked.kind).toBe("timed_out")

    expect(started).toEqual(["workflow.run.initialized:first"])

    releaseFirst()
    await bus.drain()

    expect(started).toEqual(["workflow.run.initialized:first", "agent.run.started:second"])
  })

  it("type groups do not retain unrelated events behind a blocked listener", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    bus.subscribeToTypes(["workflow.run.initialized"], () => blocked, { deliveryClass: "durable" })
    bus.emit(makeEvent("blocked"))
    for (let index = 0; index < 20; index++) bus.emit(agentRunStartedEvent(String(index)))
    try {
      expect(await bus.drain({ classes: ["durable"], timeoutMs: 1 })).toEqual({ kind: "timed_out", pending: 1 })
    } finally {
      release()
      await bus.dispose()
    }
  })

  it("a bus holds no queue storage for its capacity until deliveries back up", async () => {
    // A process holds one bus per running agent with a durable and a diagnostic
    // group. A queue preallocated to the 2048-delivery capacity costs about
    // 34 KiB; a subscription's delivery fiber costs about 11 KiB.
    const retainedPerBus = async (open: (idle: EventBus) => void): Promise<number> => {
      const count = 50
      Bun.gc(true)
      const before = heapStats().heapSize
      const buses = Array.from({ length: count }, () => {
        const idle = new EventBus()
        open(idle)
        return idle
      })
      Bun.gc(true)
      const retained = (heapStats().heapSize - before) / count
      await Promise.all(buses.map((idle) => idle.dispose()))
      return retained
    }
    expect(await retainedPerBus(() => {})).toBeLessThan(4 * 1024)
    expect(await retainedPerBus((idle) => {
      idle.subscribeToTypes(["agent.run.started"], () => {}, { deliveryClass: "durable" })
      idle.subscribeToTypes(["agent.run.started"], () => {}, { deliveryClass: "diagnostic" })
    })).toBeLessThan(48 * 1024)
  })

  it("a disposed bus refuses a late first wildcard subscription without opening its delivery", async () => {
    spyOn(DebugLog, "isOpen").mockReturnValue(true)
    const record = spyOn(DebugLog, "record").mockImplementation(() => {})
    try {
      for (const deliveryClass of ["diagnostic", "ui"] as const) {
        record.mockClear()
        const count = 50
        const buses = Array.from({ length: count }, () => new EventBus())
        await Promise.all(buses.map((disposed) => disposed.dispose()))
        Bun.gc(true)
        const before = heapStats().heapSize
        const unsubscribes = buses.map((disposed) => disposed.subscribe(() => {}, { deliveryClass }))
        Bun.gc(true)
        expect((heapStats().heapSize - before) / count).toBeLessThan(2 * 1024)
        for (const unsubscribe of unsubscribes) unsubscribe()
        for (const disposed of buses) {
          disposed.subscribe(() => {}, { deliveryClass })()
          disposed.subscribeToType("agent.run.started", () => {}, { deliveryClass })()
          disposed.subscribeToTypes(["agent.run.started"], () => {}, { deliveryClass })()
        }
        expect(record.mock.calls.filter(([input]) => input.type === "log.info")).toHaveLength(count)
      }
    } finally {
      mock.restore()
    }
  })

  it("cooperative producers pause at the watermark and retain accepted event order", async () => {
    const constrained = new EventBus({ capacity: 4 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const accepted: string[] = []
    const received: string[] = []
    constrained.subscribeToTypes(["workflow.run.initialized", "agent.run.started"], async (event) => {
      await blocked
      received.push(event.sessionId)
    }, { deliveryClass: "durable" })
    const producers = Array.from({ length: 10 }, async (_, producer) => {
      for (let index = 0; index < 30; index++) {
        const id = `${producer}:${index}`
        accepted.push(id)
        constrained.emit(index % 2 ? makeEvent(id) : agentRunStartedEvent(id))
        const pressure = constrained.waitForCapacity()
        if (pressure) await pressure
      }
    })
    try {
      // Each already-active synchronous producer can contribute one last item.
      expect(accepted).toHaveLength(4 + 9)
      expect(await constrained.drain({ classes: ["durable"], timeoutMs: 1 })).toEqual({ kind: "timed_out", pending: 13 })
    } finally {
      release()
      await Promise.all(producers)
      await constrained.dispose()
    }
    expect(received).toEqual(accepted)
    expect(received).toHaveLength(300)
  })

  it("cancels one producer's capacity wait without cancelling accepted delivery", async () => {
    const constrained = new EventBus({ capacity: 1 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    constrained.subscribeToType("workflow.run.initialized", () => blocked)
    constrained.emit(makeEvent())
    const controller = new AbortController()
    const cancelled = constrained.waitForCapacity(controller.signal)
    const stillWaiting = constrained.waitForCapacity()
    controller.abort(new Error("cancel producer"))
    try {
      await expect(cancelled).rejects.toThrow("cancel producer")
      expect(await constrained.drain({ timeoutMs: 1 })).toEqual({ kind: "timed_out", pending: 1 })
    } finally {
      release()
      await stillWaiting
      await constrained.dispose()
    }
    expect(constrained.waitForCapacity()).toBeUndefined()
  })

  it("unsubscribe stops later delivery", async () => {
    const received: FlywheelEvent[] = []
    const unsub = bus.subscribeToType("workflow.run.initialized", (event) => received.push(event), { deliveryClass: "ui", label: "typed-test" })
    bus.emit(makeEvent("first"))
    await bus.drain()
    unsub()
    bus.emit(makeEvent("second"))
    await bus.drain()

    expect(received.map((event) => event.sessionId)).toEqual(["first"])
  })

  it("subscriber failures are isolated and the throwing subscriber stays alive", async () => {
    const throwing: string[] = []
    const other: string[] = []
    let fail = true
    bus.subscribeToType("workflow.run.initialized", (event) => {
      throwing.push(event.sessionId)
      if (fail) {
        fail = false
        throw new Error("bad listener")
      }
    }, { deliveryClass: "ui", label: "throwing" })
    bus.subscribeToType("workflow.run.initialized", (event) => other.push(event.sessionId), { deliveryClass: "ui", label: "other" })

    bus.emit(makeEvent("one"))
    bus.emit(makeEvent("two"))
    await bus.drain()

    expect(throwing).toEqual(["one", "two"])
    expect(other).toEqual(["one", "two"])
  })

  it("direct critical subscribers run in the emit tick", () => {
    const received: string[] = []
    bus.subscribeToType("workflow.run.initialized", (event) => received.push(event.sessionId), { delivery: "direct", deliveryClass: "critical", label: "direct" })

    bus.emit(makeEvent("same-tick"))

    expect(received).toEqual(["same-tick"])
  })

  // Overflow is forced by construction: capacity 1, a permanently blocked
  // diagnostic subscriber, three emits. The contract is that the dropping
  // diagnostic path never backpressures reliable ui delivery, and the stuck
  // diagnostic waiter times out instead of holding dispose forever.
  it("diagnostic overflow does not backpressure ui delivery and dispose has a diagnostic deadline", async () => {
    const constrained = new EventBus({ capacity: 1 })
    const received: string[] = []
    constrained.subscribeToType("workflow.run.initialized", () => new Promise(() => {}), { deliveryClass: "diagnostic", label: "blocked-diagnostic" })
    constrained.subscribeToType("workflow.run.initialized", (event) => received.push(event.sessionId), { deliveryClass: "ui", label: "ui" })

    constrained.emit(makeEvent("one"))
    constrained.emit(makeEvent("two"))
    constrained.emit(makeEvent("three"))
    await constrained.drain({ classes: ["ui"] })

    expect(received).toEqual(["one", "two", "three"])
    expect((await constrained.drain({ classes: ["diagnostic"], timeoutMs: 1 })).kind).toBe("timed_out")

    const started = Date.now()
    await constrained.dispose()
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it("createEmit builds the internal event envelope", async () => {
    const emit = createEmit(bus)
    const received: FlywheelEvent[] = []
    bus.subscribeToType("agent.run.started", (event) => received.push(event), { deliveryClass: "ui", label: "agent-started-test" })

    emit("agent.run.started", { sessionId: "s1", data: { stepIndex: 0 } })
    await bus.drain()

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ type: "agent.run.started", sessionId: "s1", data: { stepIndex: 0 } })
    expect(received[0]?.id).toEqual(expect.any(String))
  })

})
