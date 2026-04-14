import { describe, it, expect, beforeEach } from "bun:test"
import { EventBus } from "../src/infra/event-bus"
import { HeadlessAdapter } from "./helpers/headless-adapter"
import type {
  FlywheelEvent,
  BudgetExhausted,
} from "../src/infra/events"

const ts = Date.now()
const wfId = "wf-budget-1"

// ---------------------------------------------------------------------------
// Budget event round-trip through EventBus
// ---------------------------------------------------------------------------

describe("Budget events — EventBus round-trip", () => {
  let bus: EventBus

  beforeEach(() => {
    bus = new EventBus()
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

  it("subscribeToType works for budget:exhausted", () => {
    const received: FlywheelEvent[] = []
    bus.subscribeToType("budget:exhausted", (e) => received.push(e))

    bus.emit({
      type: "queue:completed",
      workflowId: wfId,
      stepsCompleted: 1,
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
