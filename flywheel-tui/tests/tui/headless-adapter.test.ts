import { describe, it, expect, beforeEach } from "bun:test"
import { HeadlessAdapter } from "../../src/tui/adapters/headless"
import { EventBus } from "../../src/events/event-bus"
import type { FlywheelEvent } from "../../src/events/types"

describe("HeadlessAdapter", () => {
  let adapter: HeadlessAdapter
  let bus: EventBus
  let logs: string[]

  function emit(event: FlywheelEvent) {
    bus.emit(event)
  }

  const ts = "2026-01-01T00:00:00Z"
  const wfId = "wf-1"

  beforeEach(() => {
    logs = []
    bus = new EventBus()
  })

  // ── adapterType ──

  it("has adapterType 'headless'", () => {
    adapter = new HeadlessAdapter({ timestamps: false })
    expect(adapter.adapterType).toBe("headless")
  })

  // ── minimal log level ──

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

    it("logs queue initialized", () => {
      emit({ type: "queue:initialized", workflowId: wfId, stepIds: ["s1"], timestamp: ts })
      expect(logs.some((l) => l.includes("Queue initialized"))).toBe(true)
    })

    it("logs queue completed", () => {
      emit({ type: "queue:completed", workflowId: wfId, stepsCompleted: 1, timestamp: ts })
      expect(logs.some((l) => l.includes("Queue completed"))).toBe(true)
    })

    it("logs queue failed", () => {
      emit({ type: "queue:failed", workflowId: wfId, reason: "boom", stepsCompleted: 0, timestamp: ts })
      expect(logs.some((l) => l.includes("FAILED") && l.includes("boom"))).toBe(true)
    })

    it("does NOT log queue:step-started in minimal mode", () => {
      emit({ type: "queue:step-started", workflowId: wfId, stepId: "s1", stepType: "work", stepTitle: "Install", timestamp: ts })
      expect(logs.some((l) => l.includes("Install"))).toBe(false)
    })

    it("logs approval requests in minimal mode", () => {
      emit({ type: "approval:requested", workflowId: wfId, stepIndex: 0, description: "Deploy?", timestamp: ts })
      expect(logs.some((l) => l.includes("APPROVAL") && l.includes("Deploy?"))).toBe(true)
    })
  })

  // ── normal log level ──

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

    it("logs queue:step-started", () => {
      emit({ type: "queue:step-started", workflowId: wfId, stepId: "s1", stepType: "work", stepTitle: "Install deps", timestamp: ts })
      expect(logs.some((l) => l.includes("Install deps"))).toBe(true)
    })

    it("logs worker:output", () => {
      emit({ type: "worker:output", workflowId: wfId, stream: "stdout", data: "hello world\n", timestamp: ts })
      expect(logs.some((l) => l.includes("hello world"))).toBe(true)
    })

    it("does NOT log dispatcher:invoked in normal mode", () => {
      emit({ type: "dispatcher:invoked", workflowId: wfId, stepIndex: 0, timestamp: ts })
      expect(logs.some((l) => l.includes("Dispatcher invoked"))).toBe(false)
    })
  })

  // ── verbose log level ──

  describe("verbose log level", () => {
    beforeEach(() => {
      adapter = new HeadlessAdapter({
        logLevel: "verbose",
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
    })

    it("logs dispatcher:invoked", () => {
      emit({ type: "dispatcher:invoked", workflowId: wfId, stepIndex: 0, timestamp: ts })
      expect(logs.some((l) => l.includes("Dispatcher invoked"))).toBe(true)
    })

    it("logs evaluator:completed", () => {
      emit({
        type: "evaluator:completed",
        workflowId: wfId,
        result: { passed: true, reasoning: "looks good", score: 0.9 },
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("PASS") && l.includes("looks good"))).toBe(true)
    })

    it("logs evaluator:completed as FAIL when not passed", () => {
      emit({
        type: "evaluator:completed",
        workflowId: wfId,
        result: { passed: false, reasoning: "needs work", score: 0.3 },
        timestamp: ts,
      })
      expect(logs.some((l) => l.includes("FAIL") && l.includes("needs work"))).toBe(true)
    })
  })

  // ── timestamps ──

  describe("timestamps", () => {
    it("includes ISO timestamps when enabled", () => {
      adapter = new HeadlessAdapter({
        timestamps: true,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
      emit({ type: "queue:completed", workflowId: wfId, stepsCompleted: 1, timestamp: ts })
      expect(logs.some((l) => /\[\d{4}-\d{2}-\d{2}T/.test(l))).toBe(true)
    })

    it("omits timestamps when disabled", () => {
      adapter = new HeadlessAdapter({
        timestamps: false,
        logger: (msg) => logs.push(msg),
      })
      adapter.connect(bus)
      adapter.start()
      emit({ type: "queue:completed", workflowId: wfId, stepsCompleted: 1, timestamp: ts })
      expect(logs.every((l) => !l.startsWith("["))).toBe(true)
    })
  })

  // ── lifecycle ──

  describe("lifecycle", () => {
    it("connect + start + stop + disconnect works cleanly", () => {
      adapter = new HeadlessAdapter({ timestamps: false, logger: (msg) => logs.push(msg) })
      adapter.connect(bus)
      expect(adapter.isConnected()).toBe(true)

      adapter.start()
      expect(adapter.isRunning()).toBe(true)

      adapter.stop()
      expect(adapter.isRunning()).toBe(false)

      adapter.disconnect()
      expect(adapter.isConnected()).toBe(false)
    })
  })
})
