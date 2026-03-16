import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus, createFlywheelEmitter } from "../src/events/event-bus";
import { MockAdapter } from "../src/tui/adapters/mock";
import type { FlywheelEvent } from "../src/events/types";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  const makeEvent = (type: FlywheelEvent["type"] = "workflow:started"): FlywheelEvent => ({
    type: "workflow:started",
    workflowId: "test-id",
    planPath: "test.md",
    timestamp: new Date().toISOString(),
  });

  // -- subscribe --

  it("subscribe receives emitted events", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));
    const event = makeEvent();
    bus.emit(event);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
  });

  it("subscribe returns unsubscribe closure", () => {
    const received: FlywheelEvent[] = [];
    const unsub = bus.subscribe((e) => received.push(e));
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
    unsub();
    bus.emit(makeEvent());
    expect(received).toHaveLength(1); // no new events after unsubscribe
  });

  it("multiple subscribers all receive events", () => {
    const a: FlywheelEvent[] = [];
    const b: FlywheelEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));
    bus.emit(makeEvent());
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  // -- emit --

  it("emit with no subscribers does not throw", () => {
    expect(() => bus.emit(makeEvent())).not.toThrow();
  });

  // -- once --

  it("once listener fires only once", () => {
    const received: FlywheelEvent[] = [];
    bus.once((e) => received.push(e));
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });

  it("once returns unsubscribe that prevents firing", () => {
    const received: FlywheelEvent[] = [];
    const unsub = bus.once((e) => received.push(e));
    unsub();
    bus.emit(makeEvent());
    expect(received).toHaveLength(0);
  });

  // -- subscribeToType (typed listeners) --

  it("typed listener receives only matching events", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("workflow:started", (e) => received.push(e));

    bus.emit(makeEvent());
    bus.emit({
      type: "workflow:completed",
      workflowId: "test-id",
      timestamp: new Date().toISOString(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("workflow:started");
  });

  it("typed listener unsubscribe works", () => {
    const received: FlywheelEvent[] = [];
    const unsub = bus.subscribeToType("workflow:started", (e) => received.push(e));
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
    unsub();
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });

  // -- onceType --

  it("onceType fires only once for matching type", () => {
    const received: FlywheelEvent[] = [];
    bus.onceType("workflow:started", (e) => received.push(e));
    bus.emit(makeEvent());
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });

  // -- error isolation --

  it("error in one listener does not prevent others", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe((e) => received.push(e));
    // Should not throw
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });

  it("error in typed listener does not prevent catch-all", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("workflow:started", () => {
      throw new Error("bad typed listener");
    });
    bus.subscribe((e) => received.push(e));
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createFlywheelEmitter
// ---------------------------------------------------------------------------

describe("createFlywheelEmitter", () => {
  it("emits workflow:started with correct fields", () => {
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emitter.workflowStarted("wf-1", "plan.md");

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("workflow:started");
    if (received[0].type === "workflow:started") {
      expect(received[0].workflowId).toBe("wf-1");
      expect(received[0].planPath).toBe("plan.md");
      expect(received[0].timestamp).toBeTruthy();
    }
  });

  it("emits worker:retrying with correct fields", () => {
    const bus = new EventBus();
    const emitter = createFlywheelEmitter(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emitter.workerRetrying("wf-1", 2, 5, "transient error");

    expect(received).toHaveLength(1);
    if (received[0].type === "worker:retrying") {
      expect(received[0].attempt).toBe(2);
      expect(received[0].maxAttempts).toBe(5);
      expect(received[0].reason).toBe("transient error");
    }
  });
});

// ---------------------------------------------------------------------------
// MockAdapter integration
// ---------------------------------------------------------------------------

describe("MockAdapter", () => {
  let bus: EventBus;
  let adapter: MockAdapter;

  beforeEach(() => {
    bus = new EventBus();
    adapter = new MockAdapter();
  });

  it("records events after connect", () => {
    adapter.connect(bus);
    bus.emit({
      type: "workflow:started",
      workflowId: "test",
      planPath: "test.md",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("workflow:started");
  });

  it("stops recording after disconnect", () => {
    adapter.connect(bus);
    bus.emit({
      type: "workflow:started",
      workflowId: "test",
      planPath: "test.md",
      timestamp: new Date().toISOString(),
    });
    adapter.disconnect();
    bus.emit({
      type: "workflow:completed",
      workflowId: "test",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(1);
  });

  it("reset clears events and re-subscribes", () => {
    adapter.connect(bus);
    bus.emit({
      type: "workflow:started",
      workflowId: "test",
      planPath: "test.md",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(1);

    adapter.reset();
    expect(adapter.events).toHaveLength(0);

    // Should still receive events after reset
    bus.emit({
      type: "workflow:completed",
      workflowId: "test",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(1);
  });

  it("isConnected returns correct state", () => {
    expect(adapter.isConnected()).toBe(false);
    adapter.connect(bus);
    expect(adapter.isConnected()).toBe(true);
    adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });

  it("isRunning returns correct state", () => {
    expect(adapter.isRunning()).toBe(false);
    adapter.start();
    expect(adapter.isRunning()).toBe(true);
    adapter.stop();
    expect(adapter.isRunning()).toBe(false);
  });

  it("connect guards against double-connect", () => {
    adapter.connect(bus);
    bus.emit({
      type: "workflow:started",
      workflowId: "test",
      planPath: "test.md",
      timestamp: new Date().toISOString(),
    });

    // Connect again — should disconnect first, not duplicate subscriptions
    const bus2 = new EventBus();
    adapter.connect(bus2);

    // Old bus should not trigger events
    bus.emit({
      type: "workflow:completed",
      workflowId: "test",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(1); // only the first event before reconnect

    // New bus should work
    bus2.emit({
      type: "phase:started",
      workflowId: "test",
      phaseIndex: 0,
      phaseName: "Phase 1",
      timestamp: new Date().toISOString(),
    });
    expect(adapter.events).toHaveLength(2);
  });

  it("adapterType is mock", () => {
    expect(adapter.adapterType).toBe("mock");
  });
});
