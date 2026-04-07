import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../src/infra/event-bus";
import { BaseEventConsumer } from "../src/infra/base-event-consumer";
import type { FlywheelEvent } from "../src/infra/events";

/** Concrete subclass for testing */
class TestConsumer extends BaseEventConsumer {
  events: FlywheelEvent[] = [];

  protected handleEvent(event: FlywheelEvent): void {
    this.events.push(event);
  }
}

const makeEvent = (): FlywheelEvent => ({
  type: "queue:initialized",
  workflowId: "test-id",
  stepIds: ["s1"],
  timestamp: new Date().toISOString(),
});

describe("BaseEventConsumer", () => {
  let bus: EventBus;
  let consumer: TestConsumer;

  beforeEach(() => {
    bus = new EventBus();
    consumer = new TestConsumer();
  });

  // -- connect / disconnect --

  it("connect(bus) subscribes to the EventBus", () => {
    consumer.connect(bus);
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(1);
  });

  it("disconnect() unsubscribes and nulls bus reference", () => {
    consumer.connect(bus);
    consumer.disconnect();
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(0);
    expect(consumer.isConnected()).toBe(false);
  });

  it("double-connect disconnects first, then reconnects", () => {
    consumer.connect(bus);
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(1);

    // Connect again — should disconnect first (no duplicate listeners)
    const bus2 = new EventBus();
    consumer.connect(bus2);

    // Old bus should no longer deliver
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(1);

    // New bus should deliver
    bus2.emit(makeEvent());
    expect(consumer.events).toHaveLength(2);
  });

  // -- start / stop --

  it("start() / stop() toggle running state", () => {
    expect(consumer.isRunning()).toBe(false);
    consumer.start();
    expect(consumer.isRunning()).toBe(true);
    consumer.stop();
    expect(consumer.isRunning()).toBe(false);
  });

  // -- isRunning / isConnected --

  it("isRunning() reflects lifecycle state", () => {
    expect(consumer.isRunning()).toBe(false);
    consumer.start();
    expect(consumer.isRunning()).toBe(true);
  });

  it("isConnected() reflects lifecycle state", () => {
    expect(consumer.isConnected()).toBe(false);
    consumer.connect(bus);
    expect(consumer.isConnected()).toBe(true);
    consumer.disconnect();
    expect(consumer.isConnected()).toBe(false);
  });

  // -- events reach handleEvent --

  it("events emitted on bus reach handleEvent()", () => {
    consumer.connect(bus);
    const e1 = makeEvent();
    const e2 = makeEvent();
    bus.emit(e1);
    bus.emit(e2);
    expect(consumer.events).toHaveLength(2);
    expect(consumer.events[0]).toBe(e1);
    expect(consumer.events[1]).toBe(e2);
  });

  it("disconnect after events stops further delivery", () => {
    consumer.connect(bus);
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(1);
    consumer.disconnect();
    bus.emit(makeEvent());
    expect(consumer.events).toHaveLength(1);
  });
});
