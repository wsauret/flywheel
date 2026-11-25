import { describe, expect, it } from "bun:test";
import { createWatchStream, WATCH_LIMITS, type WatchEvent, type WatchLimiterState, type WatchOverLimit, type WatchPushMode } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/execution/watch-stream.js";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const feed = (watch: ReturnType<typeof createWatchStream>, text: string, now: number, mode?: WatchPushMode): void => watch.push(bytes(text), now, mode);

function stream(position = 0, options: { readonly accepts?: () => boolean; readonly limiter?: WatchLimiterState } = {}) {
  const events: WatchEvent[] = [];
  const stops: WatchOverLimit[] = [];
  const watch = createWatchStream({
    position,
    ...(options.limiter ? { limiter: options.limiter } : {}),
    deliver: (event) => {
      if (options.accepts?.() === false) return false;
      events.push(event);
      return true;
    },
    overLimit: (evidence) => { stops.push(evidence); },
  });
  return { watch, events, stops };
}

describe("watch stream", () => {
  it("batches the lines that arrive within 200 ms of the first into one event keyed by the position where they end", () => {
    const { watch, events } = stream();
    feed(watch, "one\n", 0);
    feed(watch, "two\nthr", 150);
    watch.tick(199);
    expect(events).toEqual([]);
    watch.tick(200);
    expect(events).toEqual([{ text: "one\ntwo", position: 8, dropped: 0 }]);
    feed(watch, "ee\n", 300);
    watch.tick(500);
    expect(events[1]).toEqual({ text: "three", position: 14, dropped: 0 });
  });

  it("starts a successor at the given position and counts positions from there", () => {
    const { watch, events } = stream(100);
    feed(watch, "after handover\n", 0);
    watch.tick(200);
    expect(events).toEqual([{ text: "after handover", position: 115, dropped: 0 }]);
  });

  it("cuts a line at 500 characters and an event at 3,000, each with a marker", () => {
    const { watch, events } = stream();
    feed(watch, `${"a".repeat(WATCH_LIMITS.lineChars + 20)}\n`, 0);
    watch.tick(200);
    expect(events[0]?.text).toBe(`${"a".repeat(500)}...(truncated)`);
    const lines = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(2, "0")}${"b".repeat(98)}`);
    feed(watch, `${lines.join("\n")}\n`, 1_000);
    watch.tick(1_200);
    const text = events[1]?.text ?? "";
    expect(text.endsWith("\n...(truncated)")).toBe(true);
    expect(text.length).toBe(WATCH_LIMITS.eventChars + "\n...(truncated)".length);
  });

  it("removes control characters and keeps the last state of a progress line", () => {
    const { watch, events } = stream();
    feed(watch, "\u001b[31mred\u001b[0m\n10%\r50%\r100%\n", 0);
    watch.tick(200);
    expect(events[0]?.text).toBe("red\n100%");
  });

  it("passes a burst of 10, then one event every 2 seconds, and states the count of dropped events in the next one", () => {
    const { watch, events } = stream();
    // One event every 200 ms: the burst covers 200 to 2,000 ms, one token
    // returns at 2,200 ms, and the next at 4,200 ms.
    const eventAt = (now: number): void => { feed(watch, "x\n", now - WATCH_LIMITS.batchMs); watch.tick(now); };
    for (let now = 200; now <= 2_000; now += 200) eventAt(now);
    expect(events).toHaveLength(10);
    eventAt(2_200);
    eventAt(2_400);
    eventAt(2_600);
    expect(events).toHaveLength(11);
    eventAt(4_200);
    expect(events).toHaveLength(12);
    expect(events[11]?.dropped).toBe(2);
    expect(events[10]?.dropped).toBe(0);
    // The dropped events advanced the position: nothing is read twice.
    expect(events[11]?.position).toBe(14 * 2);
  });

  it("reports a source that stays over the limit for more than 30 seconds once, and delivers nothing after", () => {
    const { watch, events, stops } = stream();
    let now = 0;
    for (; now <= 40_000; now += 250) {
      feed(watch, "x\n", now);
      watch.tick(now + WATCH_LIMITS.batchMs);
    }
    expect(stops).toHaveLength(1);
    expect(stops[0]?.overLimitMs).toBeGreaterThan(WATCH_LIMITS.stopAfterMs);
    expect(stops[0]?.dropped).toBeGreaterThan(0);
    const count = events.length;
    feed(watch, "y\n", 60_000);
    watch.tick(60_500);
    expect(events).toHaveLength(count);
    expect(stops).toHaveLength(1);
  });

  it("does not stop a source whose drops end before 30 seconds", () => {
    const { watch, stops } = stream();
    let now = 0;
    for (let index = 0; index < 15; index += 1, now += 250) { feed(watch, "x\n", now); watch.tick(now + 200); }
    for (now = 10_000; now < 60_000; now += 2_500) { feed(watch, "x\n", now); watch.tick(now + 200); }
    expect(stops).toEqual([]);
  });

  it("keeps blank lines and indentation, and closes a batch whose window passed before it adds the next line", () => {
    const { watch, events } = stream();
    feed(watch, "  indented\n\n\tlast\n", 0);
    // The pump pushes before it ticks: a line read after the window belongs to the next event.
    feed(watch, "later\n", 250);
    expect(events).toEqual([{ text: "  indented\n\n\tlast", position: 18, dropped: 0 }]);
    watch.tick(450);
    expect(events[1]).toEqual({ text: "later", position: 24, dropped: 0 });
  });

  it("marks an event whose lines reach exactly 3,000 characters and leave a line out", () => {
    const { watch, events } = stream();
    const lines = [...Array.from({ length: 5 }, () => "c".repeat(499)), "d".repeat(500)];
    // Five lines of 499, one of 500, and five newlines join to exactly 3,000.
    feed(watch, `${lines.join("\n")}\nleft out\n`, 0);
    watch.tick(200);
    expect(events[0]?.text).toBe(`${lines.join("\n")}\n...(truncated)`);
  });

  it("never cuts a line or an event inside a surrogate pair", () => {
    const { watch, events } = stream();
    feed(watch, `${"a".repeat(499)}\u{1F600}tail\n`, 0);
    watch.tick(200);
    expect(events[0]?.text).toBe(`${"a".repeat(499)}...(truncated)`);
  });

  it("keeps a refused event's lines and position, and stops reading at the line it could not add", () => {
    let accepts = false;
    const { watch, events } = stream(0, { accepts: () => accepts });
    feed(watch, "one\n", 0);
    watch.tick(200);
    expect(events).toEqual([]);
    expect(watch.settledPosition()).toBe(0);
    expect(watch.delivered()).toBe(0);
    feed(watch, "two\nthree\n", 300);
    expect(watch.readPosition()).toBe(4);
    accepts = true;
    watch.tick(400);
    expect(events).toEqual([{ text: "one", position: 4, dropped: 0 }]);
  });

  it("reads a backlog into events of at most 3,000 characters, each through the rate limit, and loses no line to a cut", () => {
    const { watch, events } = stream();
    const lines = Array.from({ length: 70 }, (_, index) => `${String(index).padStart(3, "0")}${"e".repeat(96)}`);
    feed(watch, `${lines.join("\n")}\n`, 0, "backlog");
    watch.finish(0);
    expect(events.map((event) => event.text).join("\n")).toBe(lines.join("\n"));
    expect(events.every((event) => event.text.length <= WATCH_LIMITS.eventChars)).toBe(true);
    expect(events.at(-1)?.position).toBe(70 * 100);
  });

  it("lets a successor take over the rate limit, so a handover grants no new burst and keeps the drops it owes", () => {
    const first = stream();
    for (let now = 200; now <= 2_200; now += 200) { feed(first.watch, "x\n", now - WATCH_LIMITS.batchMs); first.watch.tick(now); }
    expect(first.events).toHaveLength(11);
    feed(first.watch, "x\n", 2_400);
    first.watch.tick(2_600);
    expect(first.watch.pendingDropped()).toBe(1);

    const successor = stream(first.watch.settledPosition(), { limiter: first.watch.limiter() });
    feed(successor.watch, "y\n", 2_700);
    successor.watch.tick(2_900);
    expect(successor.events).toEqual([]);
    feed(successor.watch, "z\n", 4_300);
    successor.watch.tick(4_500);
    expect(successor.events).toEqual([{ text: "z", position: first.watch.settledPosition() + 4, dropped: 2 }]);
  });

  it("keeps the unfinished line for the last notice, and the settled position before the open batch", () => {
    const { watch } = stream();
    feed(watch, "sent\n", 0);
    watch.tick(200);
    feed(watch, "pending\npartial", 300);
    expect(watch.settledPosition()).toBe(5);
    expect(watch.unfinished()).toBe("partial");
  });
});
