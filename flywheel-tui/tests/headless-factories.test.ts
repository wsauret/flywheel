import { describe, it, expect, beforeEach } from "bun:test"
import { EventBus } from "../src/infra/event-bus"
import {
  resetSessionFactories,
  createWorkflowSession,
  destroyWorkflowSession,
} from "../src/orchestration/workflow-session"
import { provideHeadlessFactories } from "../src/orchestration/headless/factories"
import type { FlywheelEvent } from "../src/infra/events"

// ---------------------------------------------------------------------------
// Headless factory wiring tests
// ---------------------------------------------------------------------------

describe("provideHeadlessFactories", () => {
  beforeEach(() => {
    resetSessionFactories()
  })

  it("wires headless factories so createWorkflowSession succeeds", () => {
    provideHeadlessFactories()

    const session = createWorkflowSession({ description: "test workflow" })
    expect(session).toBeDefined()
    expect(session.store).toBeDefined()
    expect(session.adapter).toBeDefined()
    expect(session.eventBus).toBeDefined()
    expect(session.timer).toBeDefined()

    destroyWorkflowSession(session)
  })

  it("session store returns valid modelActivity", () => {
    provideHeadlessFactories()

    const session = createWorkflowSession({ description: "state test" })
    const state = session.store.getState()

    expect(state).toHaveProperty("modelActivity")
    expect(typeof state.modelActivity).toBe("string")

    destroyWorkflowSession(session)
  })

  it("events emitted on bus arrive at adapter", () => {
    const logs: string[] = []
    provideHeadlessFactories({
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })

    const bus = new EventBus()
    const session = createWorkflowSession({
      description: "event routing test",
      eventBus: bus,
    })

    // Emit a queue:initialized event — logged at all levels
    const event: FlywheelEvent = {
      type: "queue:initialized",
      timestamp: new Date().toISOString(),
      workflowId: "wf-test-1",
      stepIds: ["s1", "s2"],
    }
    bus.emit(event)

    expect(logs.some((l) => l.includes("Queue initialized"))).toBe(true)

    destroyWorkflowSession(session)
  })

  it("passes adapter options through", () => {
    const logs: string[] = []
    provideHeadlessFactories({
      logLevel: "minimal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })

    const bus = new EventBus()
    const session = createWorkflowSession({
      description: "options passthrough",
      eventBus: bus,
    })

    // Emit a normal-level event — should be filtered at minimal
    const event: FlywheelEvent = {
      type: "subprocess:completed",
      timestamp: new Date().toISOString(),
      workflowId: "wf-test-2",
      exitCode: 0,
    }
    bus.emit(event)

    // At minimal level, subprocess:completed is filtered out
    const hasSubprocessCompleted = logs.some((l) => l.includes("Subprocess completed"))
    expect(hasSubprocessCompleted).toBe(false)

    destroyWorkflowSession(session)
  })

  it("resetSessionFactories clears headless factories", () => {
    provideHeadlessFactories()
    resetSessionFactories()

    expect(() => {
      createWorkflowSession({ description: "should fail" })
    }).toThrow(/factories not provided/)
  })
})
