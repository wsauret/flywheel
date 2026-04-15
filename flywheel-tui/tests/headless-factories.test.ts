import { describe, it, expect } from "bun:test"
import { EventBus } from "../src/infra/event-bus"
import { HeadlessAdapter } from "../src/orchestration/headless/headless-adapter"
import type { HeadlessAdapterOptions } from "../src/orchestration/headless/headless-adapter"
import type { WorkflowSessionFactories, WorkflowAdapter } from "../src/orchestration/session-store-types"
import type { FlywheelEvent } from "../src/infra/events"

function headlessFactories(opts?: HeadlessAdapterOptions): WorkflowSessionFactories {
  return { createAdapter: () => new HeadlessAdapter(opts) }
}

function wireAdapter(factories: WorkflowSessionFactories, bus?: EventBus): { adapter: WorkflowAdapter; eventBus: EventBus } {
  const adapter = factories.createAdapter({ updateEntry: () => {} })
  const eventBus = bus ?? new EventBus()
  adapter.connect(eventBus)
  return { adapter, eventBus }
}

// ---------------------------------------------------------------------------
// Headless factory wiring tests
// ---------------------------------------------------------------------------

describe("createHeadlessFactories", () => {
  it("creates adapter and connects to bus", () => {
    const { adapter, eventBus } = wireAdapter(headlessFactories())
    expect(adapter).toBeDefined()
    expect(eventBus).toBeDefined()
    adapter.disconnect()
  })

  it("events emitted on bus arrive at adapter", () => {
    const logs: string[] = []
    const bus = new EventBus()
    const { adapter } = wireAdapter(headlessFactories({
      logger: (msg) => logs.push(msg),
      timestamps: false,
    }), bus)

    const event: FlywheelEvent = {
      type: "queue:initialized",
      timestamp: Date.now(),
      workflowId: "wf-test-1",
      stepIds: ["s1", "s2"],
    }
    bus.emit(event)

    expect(logs.some((l) => l.includes("Queue initialized"))).toBe(true)
    adapter.disconnect()
  })

  it("passes adapter options through", () => {
    const logs: string[] = []
    const bus = new EventBus()
    const { adapter } = wireAdapter(headlessFactories({
      logLevel: "minimal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    }), bus)

    const event: FlywheelEvent = {
      type: "subprocess:completed",
      timestamp: Date.now(),
      workflowId: "wf-test-2",
      exitCode: 0,
    }
    bus.emit(event)

    const hasSubprocessCompleted = logs.some((l) => l.includes("Subprocess completed"))
    expect(hasSubprocessCompleted).toBe(false)
    adapter.disconnect()
  })
})
