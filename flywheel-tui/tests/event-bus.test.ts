import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus, createEmit, type EmitFn } from "../src/infra/event-bus";
import { MockAdapter } from "./helpers/mock-adapter";
import type { FlywheelEvent, EngineNDJSON } from "../src/infra/events";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  const makeEvent = (type: FlywheelEvent["type"] = "queue:initialized"): FlywheelEvent => ({
    type: "queue:initialized",
    workflowId: "test-id",
    stepIds: ["s1"],
    timestamp: Date.now(),
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

  // -- subscribeToType (typed listeners) --

  it("typed listener receives only matching events", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("queue:initialized", (e) => received.push(e));

    bus.emit(makeEvent());
    bus.emit({
      type: "queue:completed",
      workflowId: "test-id",
      stepsCompleted: 1,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("queue:initialized");
  });

  it("typed listener unsubscribe works", () => {
    const received: FlywheelEvent[] = [];
    const unsub = bus.subscribeToType("queue:initialized", (e) => received.push(e));
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
    unsub();
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
    bus.subscribeToType("queue:initialized", () => {
      throw new Error("bad typed listener");
    });
    bus.subscribe((e) => received.push(e));
    bus.emit(makeEvent());
    expect(received).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createEmit — generic typed emitter
// ---------------------------------------------------------------------------

describe("createEmit", () => {
  it("emits engine:started with correct fields via createEmit", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emit("engine:started", { workflowId: "w1", stepIndex: 0 });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("engine:started");
    if (received[0].type === "engine:started") {
      expect(received[0].workflowId).toBe("w1");
      expect(received[0].stepIndex).toBe(0);
      expect(typeof received[0].timestamp).toBe("number");
    }
  });

  it("emits queue:initialized with correct fields", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emit("queue:initialized", { workflowId: "wf-1", stepIds: ["s1", "s2"] });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("queue:initialized");
    if (received[0].type === "queue:initialized") {
      expect(received[0].workflowId).toBe("wf-1");
      expect(received[0].stepIds).toEqual(["s1", "s2"]);
      expect(received[0].timestamp).toBeTruthy();
    }
  });

  it("emits budget:exhausted with correct fields", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emit("budget:exhausted", { workflowId: "wf-1", reason: "Invocation limit reached" });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("budget:exhausted");
    if (received[0].type === "budget:exhausted") {
      expect(received[0].workflowId).toBe("wf-1");
      expect(received[0].reason).toBe("Invocation limit reached");
      expect(received[0].timestamp).toBeTruthy();
    }
  });

  it("emits subprocess:retrying with correct fields", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    emit("subprocess:retrying", { workflowId: "wf-1", attempt: 2, maxAttempts: 5, reason: "transient error" });

    expect(received).toHaveLength(1);
    if (received[0].type === "subprocess:retrying") {
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
      type: "queue:initialized",
      workflowId: "test",
      stepIds: ["s1"],
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("queue:initialized");
  });

  it("stops recording after disconnect", () => {
    adapter.connect(bus);
    bus.emit({
      type: "queue:initialized",
      workflowId: "test",
      stepIds: ["s1"],
      timestamp: Date.now(),
    });
    adapter.disconnect();
    bus.emit({
      type: "queue:completed",
      workflowId: "test",
      stepsCompleted: 1,
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(1);
  });

  it("reset clears events and re-subscribes", () => {
    adapter.connect(bus);
    bus.emit({
      type: "queue:initialized",
      workflowId: "test",
      stepIds: ["s1"],
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(1);

    adapter.reset();
    expect(adapter.events).toHaveLength(0);

    // Should still receive events after reset
    bus.emit({
      type: "queue:completed",
      workflowId: "test",
      stepsCompleted: 1,
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(1);
  });

  it("connect guards against double-connect", () => {
    adapter.connect(bus);
    bus.emit({
      type: "queue:initialized",
      workflowId: "test",
      stepIds: ["s1"],
      timestamp: Date.now(),
    });

    // Connect again — should disconnect first, not duplicate subscriptions
    const bus2 = new EventBus();
    adapter.connect(bus2);

    // Old bus should not trigger events
    bus.emit({
      type: "queue:completed",
      workflowId: "test",
      stepsCompleted: 1,
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(1); // only the first event before reconnect

    // New bus should work
    bus2.emit({
      type: "queue:initialized",
      workflowId: "test-2",
      stepIds: ["s2"],
      timestamp: Date.now(),
    });
    expect(adapter.events).toHaveLength(2);
  });

});

// ---------------------------------------------------------------------------
// engine:ndjson event type
// ---------------------------------------------------------------------------

describe("engine:ndjson event", () => {
  it("subscribeToType receives engine:ndjson with correct payload", () => {
    const bus = new EventBus();
    const received: EngineNDJSON[] = [];
    bus.subscribeToType("engine:ndjson", (e) => received.push(e));

    const ndjsonEvent: NDJSONEvent = {
      type: "assistant",
      data: { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      raw: '{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}',
    };

    bus.emit({
      type: "engine:ndjson",
      workflowId: "wf-test",
      ndjsonEvent,
      timestamp: Date.now(),
    });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("engine:ndjson");
    expect(received[0].workflowId).toBe("wf-test");
    expect(received[0].ndjsonEvent).toBe(ndjsonEvent);
    expect(received[0].ndjsonEvent.type).toBe("assistant");
  });

  it("createEmit emits engine:ndjson with correct fields", () => {
    const bus = new EventBus();
    const emit = createEmit(bus);
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const ndjsonEvent: NDJSONEvent = {
      type: "result",
      data: { type: "result", subtype: "success" },
      raw: '{"type":"result","subtype":"success"}',
    };

    emit("engine:ndjson", { workflowId: "wf-emit", ndjsonEvent });

    expect(received).toHaveLength(1);
    expect(received[0].type).toBe("engine:ndjson");
    if (received[0].type === "engine:ndjson") {
      expect(received[0].workflowId).toBe("wf-emit");
      expect(received[0].ndjsonEvent).toBe(ndjsonEvent);
      expect(typeof received[0].timestamp).toBe("number");
    }
  });

  it("catch-all subscriber receives engine:ndjson alongside typed subscriber", () => {
    const bus = new EventBus();
    const catchAll: FlywheelEvent[] = [];
    const typed: EngineNDJSON[] = [];

    bus.subscribe((e) => catchAll.push(e));
    bus.subscribeToType("engine:ndjson", (e) => typed.push(e));

    const ndjsonEvent: NDJSONEvent = {
      type: "system",
      data: { type: "system", init: true },
      raw: '{"type":"system","init":true}',
    };

    bus.emit({
      type: "engine:ndjson",
      workflowId: "wf-both",
      ndjsonEvent,
      timestamp: Date.now(),
    });

    expect(catchAll).toHaveLength(1);
    expect(typed).toHaveLength(1);
    expect(catchAll[0]).toBe(typed[0]);
  });

  it("MockAdapter records engine:ndjson events", () => {
    const bus = new EventBus();
    const adapter = new MockAdapter();
    adapter.connect(bus);

    const ndjsonEvent: NDJSONEvent = {
      type: "tool_result",
      data: { type: "tool_result", content: "ok" },
      raw: '{"type":"tool_result","content":"ok"}',
    };

    bus.emit({
      type: "engine:ndjson",
      workflowId: "wf-mock",
      ndjsonEvent,
      timestamp: Date.now(),
    });

    expect(adapter.events).toHaveLength(1);
    expect(adapter.events[0].type).toBe("engine:ndjson");
    adapter.disconnect();
  });
});
