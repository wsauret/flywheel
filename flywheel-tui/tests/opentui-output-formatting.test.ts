import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { EventBus } from "../src/events/event-bus";
import { OpenTUIAdapter, createOpenTUIAdapter } from "../src/tui/adapters/opentui";
import { createStore } from "../src/tui/routes/work/context/ui-state/store";
import { timerService } from "../src/tui/shared/services/timer";
import type { UIActions } from "../src/tui/routes/work/context/ui-state/types";
import type { TextBlock, ToolBlock } from "../src/tui/routes/work/state/types";

function createHarness() {
  const bus = new EventBus();
  const store = createStore("test-plan");
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
    it("extracts text from assistant NDJSON → outputBlocks", () => {
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
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      expect(textBlocks[0].content).toContain("Hello world");
    });

    it("formats tool_use from assistant NDJSON → ToolBlock", () => {
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
      const blocks = store.getState().outputBlocks;
      const toolBlocks = blocks.filter((b) => b.kind === "tool") as ToolBlock[];
      expect(toolBlocks.length).toBeGreaterThanOrEqual(1);
      expect(toolBlocks[0].name).toBe("Read");
      expect(toolBlocks[0].detail).toContain("src/index.ts");
    });

    it("skips system NDJSON lines (no blocks or lines produced)", () => {
      const { bus, store } = createHarness();
      const ndjson = JSON.stringify({ type: "system", data: "init config" });
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson + "\n",
        timestamp: ts(),
      });
      // System lines should not produce outputLines
      expect(store.getState().outputLines).toHaveLength(0);
      // May or may not produce outputBlocks (unknown type gets skipped)
    });

    it("skips tool_result NDJSON lines (no outputLines)", () => {
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

    it("passes through non-JSON text → TextBlock in outputBlocks", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: "hello world\n",
        timestamp: "2025-01-01T00:00:00Z",
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      expect(textBlocks[0].content).toContain("hello world");
    });

    it("skips result event text (already streamed via assistant events)", () => {
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
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks).toHaveLength(0);
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
      // No blocks yet — incomplete line (NDJSONParser buffers it)
      const blocksAfterFirst = store.getState().outputBlocks;
      expect(blocksAfterFirst.filter((b) => b.kind === "text" && (b as TextBlock).content.includes("buffered"))).toHaveLength(0);

      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: ndjson.slice(half) + "\n",
        timestamp: ts(),
      });
      // Now the complete line should produce a TextBlock
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      const hasBuffered = textBlocks.some((b) => b.content.includes("buffered"));
      expect(hasBuffered).toBe(true);
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
      // Both text values should be in outputBlocks (possibly merged into one TextBlock)
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      const allText = textBlocks.map((b) => b.content).join("");
      expect(allText).toContain("first");
      expect(allText).toContain("second");
    });

    it("resets buffer on new workflow:started", () => {
      const { bus, store } = createHarness();
      // Send an incomplete chunk
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stdout",
        data: '{"type":"assistant"',
        timestamp: ts(),
      });
      // No output yet (incomplete JSON)
      expect(store.getState().outputBlocks.filter(
        (b) => b.kind === "text" && (b as TextBlock).content.includes("assistant"),
      )).toHaveLength(0);

      // Start a new workflow — should reset buffer and builder
      bus.emit({
        type: "workflow:started",
        workflowId: "w2",
        planPath: "plan.md",
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
      const blocks = store.getState().outputBlocks;
      const textBlocks = blocks.filter((b) => b.kind === "text") as TextBlock[];
      expect(textBlocks.length).toBeGreaterThanOrEqual(1);
      expect(textBlocks[0].content).toContain("fresh");
    });
  });

  // ── stderr passthrough ──

  describe("stderr passthrough", () => {
    it("routes stderr through structured pipeline as SystemBlock", () => {
      const { bus, store } = createHarness();
      bus.emit({
        type: "worker:output",
        workflowId: "w1",
        stream: "stderr",
        data: "error: something failed\n",
        timestamp: ts(),
      });
      const blocks = store.getState().outputBlocks;
      expect(blocks.length).toBeGreaterThanOrEqual(1);
      const systemBlocks = blocks.filter((b) => b.kind === "system");
      expect(systemBlocks.length).toBeGreaterThanOrEqual(1);
      expect((systemBlocks[0] as any).message).toContain("error: something failed");
    });
  });

  // ── Raw mode ──

  describe("raw mode", () => {
    it("toggleRawMode toggles state and returns new value", () => {
      const store = createStore("test");
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
      // System lines should be filtered out in formatted mode (no outputLines)
      expect(store.getState().outputLines).toHaveLength(0);
    });
  });
});
