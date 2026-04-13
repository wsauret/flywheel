import { describe, it, expect } from "bun:test"
import { EventBus } from "../src/infra/event-bus"
import {
  createWorkflowSession,
  destroyWorkflowSession,
} from "../src/orchestration/workflow-session"
import { createHeadlessAdapter } from "../src/orchestration/headless/headless-adapter"
import type { WorkflowSessionFactories } from "../src/orchestration/workflow-session"
import type { FlywheelEvent } from "../src/infra/events"

function headlessFactories(opts?: Parameters<typeof createHeadlessAdapter>[0]): WorkflowSessionFactories {
  return { createAdapter: () => createHeadlessAdapter(opts) }
}

// ---------------------------------------------------------------------------
// Headless factory wiring tests
// ---------------------------------------------------------------------------

/** No-op updateEntry for headless tests. */
const noopUpdateEntry = () => {}

describe("createHeadlessFactories", () => {
  it("creates factories so createWorkflowSession succeeds", () => {
    const factories = headlessFactories()

    const session = createWorkflowSession({ description: "test workflow", factories, updateEntry: noopUpdateEntry })
    expect(session).toBeDefined()
    expect(session.adapter).toBeDefined()
    expect(session.eventBus).toBeDefined()

    destroyWorkflowSession(session)
  })

  it("events emitted on bus arrive at adapter", () => {
    const logs: string[] = []
    const factories = headlessFactories({
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })

    const bus = new EventBus()
    const session = createWorkflowSession({
      description: "event routing test",
      eventBus: bus,
      factories,
      updateEntry: noopUpdateEntry,
    })

    // Emit a queue:initialized event — logged at all levels
    const event: FlywheelEvent = {
      type: "queue:initialized",
      timestamp: Date.now(),
      workflowId: "wf-test-1",
      stepIds: ["s1", "s2"],
    }
    bus.emit(event)

    expect(logs.some((l) => l.includes("Queue initialized"))).toBe(true)

    destroyWorkflowSession(session)
  })

  it("passes adapter options through", () => {
    const logs: string[] = []
    const factories = headlessFactories({
      logLevel: "minimal",
      logger: (msg) => logs.push(msg),
      timestamps: false,
    })

    const bus = new EventBus()
    const session = createWorkflowSession({
      description: "options passthrough",
      eventBus: bus,
      factories,
      updateEntry: noopUpdateEntry,
    })

    // Emit a normal-level event — should be filtered at minimal
    const event: FlywheelEvent = {
      type: "subprocess:completed",
      timestamp: Date.now(),
      workflowId: "wf-test-2",
      exitCode: 0,
    }
    bus.emit(event)

    // At minimal level, subprocess:completed is filtered out
    const hasSubprocessCompleted = logs.some((l) => l.includes("Subprocess completed"))
    expect(hasSubprocessCompleted).toBe(false)

    destroyWorkflowSession(session)
  })
})
