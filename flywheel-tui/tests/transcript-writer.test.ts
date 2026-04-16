/**
 * Tests for TranscriptWriter — persists raw NDJSON events to transcript files.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import {
  createTranscriptWriter,
  type TranscriptWriter,
} from "../src/orchestration/session/transcript-writer";
import type { NDJSONEvent } from "../src/infra/ndjson-event-types";
import { TRACES_DIR } from "../src/infra/paths";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-transcript-writer-test-${process.pid}-${Date.now()}`,
);

let tmpDir: string;

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEvent(overrides: Partial<NDJSONEvent> = {}): NDJSONEvent {
  return {
    type: "assistant",
    data: { message: "hello" },
    raw: JSON.stringify({ type: "assistant", message: "hello" }),
    ...overrides,
  };
}

function transcriptFilePath(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.ndjson`);
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// File creation
// ---------------------------------------------------------------------------

describe("TranscriptWriter — file creation", () => {
  it("creates .ndjson file on first handleEvent call", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });
    const filePath = transcriptFilePath("s1", tmpDir);

    writer.handleEvent(makeEvent());
    writer.dispose();

    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("file path resolves to .flywheel/traces/<session-id>.ndjson", () => {
    const writer = createTranscriptWriter({ sessionId: "my-session", baseDir: tmpDir });
    writer.handleEvent(makeEvent());
    writer.dispose();

    const expected = path.resolve(tmpDir, TRACES_DIR, "my-session.ndjson");
    expect(fs.existsSync(expected)).toBe(true);
  });

  it("creates traces directory if it does not exist", () => {
    const freshDir = makeTmpDir();
    const tracesPath = path.resolve(freshDir, TRACES_DIR);
    expect(fs.existsSync(tracesPath)).toBe(false);

    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: freshDir });
    writer.handleEvent(makeEvent());
    writer.dispose();

    expect(fs.existsSync(tracesPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event appending
// ---------------------------------------------------------------------------

describe("TranscriptWriter — event appending", () => {
  it("appends event.raw + newline per event", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });
    const event1 = makeEvent({ raw: '{"type":"assistant","msg":"one"}' });
    const event2 = makeEvent({ raw: '{"type":"assistant","msg":"two"}' });

    writer.handleEvent(event1);
    writer.handleEvent(event2);
    writer.dispose();

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(2);
    expect(lines[0]).toBe('{"type":"assistant","msg":"one"}');
    expect(lines[1]).toBe('{"type":"assistant","msg":"two"}');
  });

  it("handles events with empty raw gracefully (skip)", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });

    writer.handleEvent(makeEvent({ raw: "" }));
    writer.handleEvent(makeEvent({ raw: '{"valid":"event"}' }));
    writer.handleEvent(makeEvent({ raw: "" }));
    writer.dispose();

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('{"valid":"event"}');
  });
});

// ---------------------------------------------------------------------------
// Event count
// ---------------------------------------------------------------------------

describe("TranscriptWriter — getEventCount", () => {
  it("returns correct count", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });

    expect(writer.getEventCount()).toBe(0);

    writer.handleEvent(makeEvent());
    expect(writer.getEventCount()).toBe(1);

    writer.handleEvent(makeEvent());
    writer.handleEvent(makeEvent());
    expect(writer.getEventCount()).toBe(3);

    writer.dispose();
  });

  it("does not count events with empty raw", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });

    writer.handleEvent(makeEvent({ raw: "" }));
    writer.handleEvent(makeEvent());
    expect(writer.getEventCount()).toBe(1);

    writer.dispose();
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("TranscriptWriter — dispose", () => {
  it("dispose flushes buffered events to disk", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.handleEvent(makeEvent({ raw: '{"flushed":true}' }));
    writer.dispose();

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('{"flushed":true}');
  });

  it("dispose guards against double-call", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.handleEvent(makeEvent());

    // Should not throw on double dispose
    writer.dispose();
    writer.dispose();

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
  });

  it("handleEvent after dispose is a no-op", () => {
    const writer = createTranscriptWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.handleEvent(makeEvent({ raw: '{"before":true}' }));
    writer.dispose();

    // This should not throw or write
    writer.handleEvent(makeEvent({ raw: '{"after":true}' }));

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('{"before":true}');
  });
});

// ---------------------------------------------------------------------------
// DebouncedWriter integration
// ---------------------------------------------------------------------------

describe("TranscriptWriter — debounced writes", () => {
  it("uses DebouncedWriter for flush scheduling", async () => {
    // Write events, wait for debounce interval, verify file was written
    const writer = createTranscriptWriter({
      sessionId: "s1",
      baseDir: tmpDir,
      debounceMs: 50,
    });

    writer.handleEvent(makeEvent({ raw: '{"debounced":true}' }));

    // Wait for debounce to fire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const lines = readLines(transcriptFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(lines[0]).toBe('{"debounced":true}');

    writer.dispose();
  });
});
