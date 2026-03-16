import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createTestStore } from "../src/tui/routes/work/context/ui-state/store";
import { timerService } from "../src/tui/shared/services/timer";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";

function createHarness() {
  const bus = new EventBus();
  const store = createTestStore("test-plan");
  const adapter = createOpenTUIAdapter(store);
  adapter.connect(bus);
  adapter.start();
  return { bus, store, adapter };
}

function ts(): string {
  return new Date().toISOString();
}

describe("OpenTUI Adapter — output formatting", () => {
  beforeEach(() => timerService.reset());
  afterEach(() => timerService.reset());

  // ── NDJSON parsing ──

  describe("NDJSON parsing (formatted mode)", () => {
    it("extracts text from assistant NDJSON", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("Hello world");
    });

    it("formats tool_use from assistant NDJSON", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/index.ts" } },
          ],
        },
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toContain("▸ Read");
      expect(lines[0].data).toContain("src/index.ts");
    });

    it("skips system NDJSON lines", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({ type: "system", data: "init config" });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      expect(store.getState().outputLines).toHaveLength(0);
    });

    it("skips tool_result NDJSON lines", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({ type: "tool_result", content: "..." });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      expect(store.getState().outputLines).toHaveLength(0);
    });

    it("passes through non-JSON text (plain text fallback)", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "hello world\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("hello world\n");
    });

    it("extracts result text", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({
        type: "result",
        result: "Task done",
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("Task done\n");
    });
  });

  // ── Line buffering ──

  describe("line buffering", () => {
    it("buffers incomplete lines across chunks", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "buffered" }] },
      });

      // Send in two chunks — first half, then second half with newline
      const half = Math.floor(ndjson.length / 2);
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson.slice(0, half),
        timestamp: ts(),
      });
      // No output yet — incomplete line
      expect(store.getState().outputLines).toHaveLength(0);

      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson.slice(half) + "\n",
        timestamp: ts(),
      });
      // Now the complete line should appear
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("buffered");
    });

    it("handles multiple lines in a single chunk", () => {
      const { bus, store } = createHarness();
      const line1 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      });
      const line2 = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: line1 + "\n" + line2 + "\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(2);
      expect(lines[0].data).toBe("first");
      expect(lines[1].data).toBe("second");
    });

    it("resets buffer on phase:started", () => {
      const { bus, store } = createHarness();
      // Send an incomplete chunk
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: '{"type":"assistant"',
        timestamp: ts(),
      });
      expect(store.getState().outputLines).toHaveLength(0);

      // Start a new phase — should reset buffer
      bus.emit({
        type: "phase:started",
        workflowId: "w1",
        phaseIndex: 0,
        phaseName: "Build",
        timestamp: ts(),
      });

      // Send a fresh complete line
      const ndjson = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "fresh" }] },
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("fresh");
    });
  });

  // ── stderr passthrough ──

  describe("stderr passthrough", () => {
    it("passes stderr through without parsing", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stderr",
        data: "error: something failed\n",
        timestamp: ts(),
      });
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe("error: something failed\n");
      expect(lines[0].stream).toBe("stderr");
    });
  });

  // ── Raw mode ──

  describe("raw mode", () => {
    it("toggleRawMode toggles state and returns new value", () => {
      const store = createTestStore("test");
      const adapter = createOpenTUIAdapter(store);
      expect(adapter.rawMode).toBe(false);
      expect(adapter.toggleRawMode()).toBe(true);
      expect(adapter.rawMode).toBe(true);
      expect(adapter.toggleRawMode()).toBe(false);
      expect(adapter.rawMode).toBe(false);
    });

    it("raw mode passes NDJSON through without parsing", () => {
      const { bus, store, adapter } = createHarness();
      adapter.toggleRawMode(); // turn on

      const ndjson = JSON.stringify({
        type: "system",
        data: "init config",
      });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      // In formatted mode this would be skipped; in raw mode it passes through
      const lines = store.getState().outputLines;
      expect(lines).toHaveLength(1);
      expect(lines[0].data).toBe(ndjson + "\n");
    });

    it("toggling back to formatted mode resumes parsing", () => {
      const { bus, store, adapter } = createHarness();
      adapter.toggleRawMode(); // on
      adapter.toggleRawMode(); // off

      const ndjson = JSON.stringify({ type: "system", data: "init" });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      // System lines should be filtered out in formatted mode
      expect(store.getState().outputLines).toHaveLength(0);
    });
  });
});
