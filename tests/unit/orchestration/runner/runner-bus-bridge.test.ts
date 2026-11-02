import { describe, expect, it } from "bun:test"

import type { TurnParkedContext } from "../../../../src/infra/agent-loop-events.js"
import { createEmit, EventBus } from "../../../../src/infra/event-bus.js"
import { FLYWHEEL_EVENT_TYPES, type FlywheelEvent } from "../../../../src/infra/events.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { createRunnerBusBridge } from "../../../../src/orchestration/runner/bus-bridge.js"

function harness(isLive?: () => boolean) {
  const bus = new EventBus()
  const emit = createEmit(bus)
  const events: FlywheelEvent[] = []
  bus.subscribeToTypes(FLYWHEEL_EVENT_TYPES, (e) => events.push(e), { delivery: "direct", deliveryClass: "critical", label: "runner-bus-bridge-test" })
  const bridge = createRunnerBusBridge({ emit, sessionId: "s1", isLive })
  return { bridge, events }
}

function parkedContext(overrides: Partial<TurnParkedContext> = {}): TurnParkedContext {
  return {
    handoffWritten: false,
    turnCount: 0,
    activeBackgroundCount: 0,
    parkedOnBackgroundWork: false,
    waitRequested: false,
    userResumeRequired: false,
    park: "idle",
    ...overrides,
  }
}

describe("createRunnerBusBridge", () => {
  it("forwards a runtime event as its semantic bus event with the configured sessionId", () => {
    const { bridge, events } = harness()
    const ev = createRuntimeEvent("model.text.completed", { type: "model.text.completed" })
    bridge.onEvent(ev)
    expect(events).toEqual([
      expect.objectContaining({ type: "model.text.completed", sessionId: "s1", data: ev.data }),
    ])
  })

  it("onTurnParked emits agent.turn.parked with lifecycle data in the envelope", () => {
    const { bridge, events } = harness()
    const parked = parkedContext({ handoffWritten: true, turnCount: 2, activeBackgroundCount: 1, park: "waiting_on_work" })
    bridge.lifecycle.onTurnParked(parked)
    expect(events).toEqual([
      expect.objectContaining({
        type: "agent.turn.parked",
        sessionId: "s1",
        data: parked,
        timestamp: expect.any(Number),
      }),
    ])
    expect(events.some((event) => "ctx" in event)).toBe(false)
  })

  it("onTurnResumed emits an empty data envelope", () => {
    const { bridge, events } = harness()
    bridge.lifecycle.onTurnResumed()
    expect(events).toEqual([
      expect.objectContaining({ type: "agent.turn.resumed", sessionId: "s1", data: {} }),
    ])
  })

  it("onLogicalTurnStarted emits agent.logical_turn.started with origin and reason", () => {
    const { bridge, events } = harness()
    bridge.lifecycle.onLogicalTurnStarted({ origin: "user", reason: "queued_input" })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(
      expect.objectContaining({
        type: "agent.logical_turn.started",
        sessionId: "s1",
        data: { origin: "user", reason: "queued_input" },
        timestamp: expect.any(Number),
      }),
    )
  })

  it("isLive returning false short-circuits all callbacks", () => {
    const { bridge, events } = harness(() => false)
    bridge.onEvent(createRuntimeEvent("model.text.completed", { type: "model.text.completed" }))
    bridge.lifecycle.onTurnParked(parkedContext())
    bridge.lifecycle.onTurnResumed()
    bridge.lifecycle.onLogicalTurnStarted({ origin: "user", reason: "queued_input" })
    expect(events.length).toBe(0)
  })

  it("isLive is re-evaluated per call (lazy)", () => {
    let live = false
    const { bridge, events } = harness(() => live)
    bridge.onEvent(createRuntimeEvent("model.text.completed", { type: "model.text.completed" }))
    expect(events.length).toBe(0)
    live = true
    bridge.lifecycle.onTurnParked(parkedContext())
    expect(events.length).toBe(1)
    live = false
    bridge.lifecycle.onTurnResumed()
    expect(events.length).toBe(1)
  })

})
