import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TranscriptLogger, createTranscriptLogger, deleteTranscript } from "../src/orchestration/session/transcript";
import { EventBus } from "../src/protocol/event-bus";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-test-"));
  // Create the sessions directory
  fs.mkdirSync(path.join(tmpDir, ".flywheel", "sessions"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function readLines(filePath: string): object[] {
  const content = fs.readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content.split("\n").map((line) => JSON.parse(line));
}

describe("TranscriptLogger", () => {
  test("creates transcript file on construction", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-1",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });
    expect(fs.existsSync(logger.getFilePath())).toBe(true);
    logger.dispose();
  });

  test("logs custom entries", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-2",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });

    logger.logEntry("prompt:assembled", { prompt: "Do something", stepId: "s1" });
    logger.logEntry("handoff:read", { summary: "Step completed", artifacts: ["file.ts"] });
    logger.flush();
    logger.dispose();

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(2);
    expect((lines[0] as any).type).toBe("prompt:assembled");
    expect((lines[0] as any).prompt).toBe("Do something");
    expect((lines[1] as any).type).toBe("handoff:read");
    expect((lines[1] as any).summary).toBe("Step completed");
  });

  test("logs EventBus events via subscribeTo", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-3",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });
    const bus = new EventBus();
    logger.subscribeTo(bus);

    bus.emit({
      type: "queue:step-started",
      workflowId: "w1",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Research codebase",
      timestamp: "2026-01-01T00:00:00Z",
    });

    bus.emit({
      type: "worker:output",
      workflowId: "w1",
      stream: "stdout",
      data: '{"type":"text","content":"Hello world"}',
      timestamp: "2026-01-01T00:00:01Z",
    });

    logger.flush();
    logger.dispose();

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(2);
    expect((lines[0] as any).type).toBe("queue:step-started");
    expect((lines[0] as any).stepTitle).toBe("Research codebase");
    expect((lines[1] as any).type).toBe("worker:output");
    expect((lines[1] as any).data).toContain("Hello world");
  });

  test("append-only: multiple dispose/create cycles append to same file", () => {
    const opts = { sessionId: "test-session-4", baseDir: tmpDir, flushIntervalMs: 50 };

    // First logger
    const logger1 = createTranscriptLogger(opts);
    logger1.logEntry("session:started", { phase: "plan" });
    logger1.flush();
    logger1.dispose();

    // Second logger (simulates resume)
    const logger2 = createTranscriptLogger(opts);
    logger2.logEntry("session:resumed", { phase: "work" });
    logger2.flush();
    logger2.dispose();

    const lines = readLines(logger1.getFilePath());
    expect(lines.length).toBe(2);
    expect((lines[0] as any).type).toBe("session:started");
    expect((lines[1] as any).type).toBe("session:resumed");
  });

  test("entries have ts field", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-5",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });

    logger.logEntry("test:event", { value: 42 });
    logger.flush();
    logger.dispose();

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(1);
    expect((lines[0] as any).ts).toBeDefined();
    // Should be a valid ISO string
    expect(new Date((lines[0] as any).ts).toISOString()).toBe((lines[0] as any).ts);
  });

  test("handles numeric timestamps from events", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-6",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });
    const bus = new EventBus();
    logger.subscribeTo(bus);

    bus.emit({
      type: "worker:output",
      workflowId: "w1",
      stream: "stdout",
      data: "chunk",
      timestamp: "2026-01-15T12:00:00Z",
    });

    logger.flush();
    logger.dispose();

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(1);
    expect((lines[0] as any).ts).toBe("2026-01-15T12:00:00Z");
  });

  test("does not write after dispose", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-7",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });

    logger.logEntry("before:dispose", {});
    logger.flush();
    logger.dispose();

    logger.logEntry("after:dispose", {});
    logger.flush();

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(1);
    expect((lines[0] as any).type).toBe("before:dispose");
  });

  test("unsubscribes from EventBus on dispose", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-session-8",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });
    const bus = new EventBus();
    logger.subscribeTo(bus);

    bus.emit({
      type: "queue:initialized",
      workflowId: "w1",
      stepIds: ["s1"],
      timestamp: "2026-01-01T00:00:00Z",
    });

    logger.flush();
    logger.dispose();

    // Emit after dispose — should not be logged
    bus.emit({
      type: "queue:completed",
      workflowId: "w1",
      stepsCompleted: 1,
      timestamp: "2026-01-01T00:01:00Z",
    });

    const lines = readLines(logger.getFilePath());
    expect(lines.length).toBe(1);
  });
});

describe("deleteTranscript", () => {
  test("deletes the transcript file", () => {
    const logger = createTranscriptLogger({
      sessionId: "test-delete-1",
      baseDir: tmpDir,
      flushIntervalMs: 50,
    });
    logger.logEntry("test", {});
    logger.flush();
    logger.dispose();

    expect(fs.existsSync(logger.getFilePath())).toBe(true);
    deleteTranscript("test-delete-1", tmpDir);
    expect(fs.existsSync(logger.getFilePath())).toBe(false);
  });

  test("does not throw if file does not exist", () => {
    expect(() => deleteTranscript("nonexistent", tmpDir)).not.toThrow();
  });
});
