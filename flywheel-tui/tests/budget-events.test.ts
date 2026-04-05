import { describe, it, expect, beforeEach } from "bun:test"
import { EventBus } from "../src/protocol/event-bus"
import { HeadlessAdapter } from "./helpers/headless-adapter"
import type {
  FlywheelEvent,
  BudgetWarning,
  BudgetExhausted,
} from "../src/protocol/events"

const ts = "2026-01-01T00:00:00Z"
const wfId = "wf-budget-1"

// ---------------------------------------------------------------------------
// Budget event round-trip through EventBus
// ---------------------------------------------------------------------------

describe("Budget events — EventBus round-trip", () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
  })

  it("budget:warning round-trips through bus.emit → listener", () => {
    const received: FlywheelEvent[] = []
    bus.subscribe((e) => received.push(e))

    const event: BudgetWarning = {
      type: "budget:warning",
      workflowId: wfId,
      metric: "invocations",
      used: 8,
      limit: 10,
      remaining: 2,
      timestamp: ts,
    }
    bus.emit(event)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(event)
    expect(received[0].type).toBe("budget:warning")
  })

  it("budget:exhausted round-trips through bus.emit → listener", () => {
    const received: FlywheelEvent[] = []
    bus.subscribe((e) => received.push(e))

    const event: BudgetExhausted = {
      type: "budget:exhausted",
      workflowId: wfId,
      reason: "Invocation limit reached (10/10)",
      timestamp: ts,
    }
    bus.emit(event)

    expect(received).toHaveLength(1)
    expect(received[0]).toBe(event)
    expect(received[0].type).toBe("budget:exhausted")
  })

  it("budget:warning carries correct fields", () => {
    const received: FlywheelEvent[] = []
    bus.subscribe((e) => received.push(e))

    bus.emit({
      type: "budget:warning",
      workflowId: wfId,
      metric: "tokens",
      used: 90000,
      limit: 100000,
      remaining: 10000,
      timestamp: ts,
    } satisfies BudgetWarning)

    const evt = received[0] as BudgetWarning
    expect(evt.workflowId).toBe(wfId)
    expect(evt.metric).toBe("tokens")
    expect(evt.used).toBe(90000)
    expect(evt.limit).toBe(100000)
    expect(evt.remaining).toBe(10000)
    expect(evt.timestamp).toBe(ts)
  })

  it("budget:exhausted carries correct fields", () => {
    const received: FlywheelEvent[] = []
    bus.subscribe((e) => received.push(e))

    bus.emit({
      type: "budget:exhausted",
      workflowId: wfId,
      reason: "Wall clock limit exceeded",
      timestamp: ts,
    } satisfies BudgetExhausted)

    const evt = received[0] as BudgetExhausted
    expect(evt.workflowId).toBe(wfId)
    expect(evt.reason).toBe("Wall clock limit exceeded")
    expect(evt.timestamp).toBe(ts)
  })

  it("subscribeToType works for budget:warning", () => {
    const received: FlywheelEvent[] = []
    bus.subscribeToType("budget:warning", (e) => received.push(e))

    // Emit a non-matching event first
    bus.emit({
      type: "workflow:started",
      workflowId: wfId,
      planPath: "test.md",
      timestamp: ts,
    })

    // Emit the matching event
    bus.emit({
      type: "budget:warning",
      workflowId: wfId,
      metric: "wall_clock",
      used: 55,
      limit: 60,
      remaining: 5,
      timestamp: ts,
    } satisfies BudgetWarning)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("budget:warning")
  })

  it("subscribeToType works for budget:exhausted", () => {
    const received: FlywheelEvent[] = []
    bus.subscribeToType("budget:exhausted", (e) => received.push(e))

    bus.emit({
      type: "workflow:failed",
      workflowId: wfId,
      reason: "something else",
      timestamp: ts,
    })

    bus.emit({
      type: "budget:exhausted",
      workflowId: wfId,
      reason: "Budget exhausted",
      timestamp: ts,
    } satisfies BudgetExhausted)

    expect(received).toHaveLength(1)
    expect(received[0].type).toBe("budget:exhausted")
  })
})

// ---------------------------------------------------------------------------
// HeadlessAdapter — budget event handling
// ---------------------------------------------------------------------------

describe("HeadlessAdapter — budget events", () => {
  let adapter: HeadlessAdapter
  let bus: EventBus
  let logs: string[]

  function emit(event: FlywheelEvent) {
    bus.emit(event)
  }

  beforeEach(() => {
    logs = []
    bus = new EventBus()
  })

  describe("normal log level", () => {
    beforeEach(() => {
      adapter = new HeadlessAdapter({
        logLevel: "normal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
    })

    it("logs budget:warning with metric details", () => {
      emit({
        type: "budget:warning",
        workflowId: wfId,
        metric: "invocations",
        used: 8,
        limit: 10,
        remaining: 2,
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("Budget warning") && l.includes("invocations") && l.includes("8/10"))).toBe(true)
    })

    it("logs budget:exhausted", () => {
      emit({
        type: "budget:exhausted",
        workflowId: wfId,
        reason: "Invocation limit reached",
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("EXHAUSTED") && l.includes("Invocation limit reached"))).toBe(true)
    })
  })

  describe("minimal log level", () => {
    beforeEach(() => {
      adapter = new HeadlessAdapter({
        logLevel: "minimal",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
    })

    it("does NOT log budget:warning in minimal mode", () => {
      emit({
        type: "budget:warning",
        workflowId: wfId,
        metric: "tokens",
        used: 90000,
        limit: 100000,
        remaining: 10000,
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("Budget warning"))).toBe(false)
    })

    it("still logs budget:exhausted in minimal mode (always visible)", () => {
      emit({
        type: "budget:exhausted",
        workflowId: wfId,
        reason: "Token limit reached",
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("EXHAUSTED") && l.includes("Token limit reached"))).toBe(true)
    })
  })

  describe("handles all event types without throwing (exhaustiveness)", () => {
    beforeEach(() => {
      adapter = new HeadlessAdapter({
        logLevel: "verbose",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
    })

    it("handles question:asked without throwing", () => {
      expect(() =>
        emit({
          type: "question:asked",
          requestId: "q-1",
          questions: [],
          timestamp: ts,
        })
      ).not.toThrow()
    })

    it("handles question:replied without throwing", () => {
      expect(() =>
        emit({
          type: "question:replied",
          requestId: "q-1",
          answers: [],
          timestamp: ts,
        })
      ).not.toThrow()
    })

    it("handles question:rejected without throwing", () => {
      expect(() =>
        emit({
          type: "question:rejected",
          requestId: "q-1",
          timestamp: ts,
        })
      ).not.toThrow()
    })

  })
})
