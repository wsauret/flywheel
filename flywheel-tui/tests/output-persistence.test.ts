import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { createOutputPersistence } from "../src/orchestration/session/output-persistence";
import { toSnapshot, fromSnapshot, type OutputSnapshot } from "../src/orchestration/session/output-schemas";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-output-test-${process.pid}-${Date.now()}`,
);

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Block factories (standalone — NOT from TUI types)
function textBlock(content = "hello") {
  return { kind: "text" as const, content, timestamp: Date.now() };
}

function toolBlock(name = "read", detail = "a.ts") {
  return { kind: "tool" as const, name, detail, timestamp: Date.now() };
}

function agentBlock(status: "active" | "completed" | "error" = "completed") {
  return {
    kind: "agent" as const,
    id: "a1",
    agentLabel: "Coder",
    description: "Writing code",
    status,
    children: [toolBlock()],
    timestamp: Date.now(),
  };
}

function systemBlock(message = "started") {
  return { kind: "system" as const, message, timestamp: Date.now() };
}

function contextGroupBlock() {
  return {
    kind: "contextGroup" as const,
    tools: [toolBlock("glob", "**/*.ts")],
    timestamp: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// save + load round-trip
// ---------------------------------------------------------------------------

describe("createOutputPersistence — save + load", () => {
  it("saves blocks and loads them back", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const blocks = [textBlock("output"), toolBlock(), systemBlock()];
    persistence.save(blocks);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(3);
    expect(loaded[0].kind).toBe("text");
    expect(loaded[1].kind).toBe("tool");
    expect(loaded[2].kind).toBe("system");
  });

  it("writes to .flywheel/sessions/<id>/output.json", () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    persistence.save([textBlock()]);

    const filePath = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
      "output.json",
    );
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("overwrites previous output on save", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    persistence.save([textBlock("first")]);
    persistence.save([textBlock("second"), textBlock("third")]);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);
    expect((loaded[0] as any).content).toBe("second");
  });

  it("normalizes active AgentBlock to paused on save", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    persistence.save([agentBlock("active")]);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as any).status).toBe("paused");
  });
});

// ---------------------------------------------------------------------------
// load — error handling
// ---------------------------------------------------------------------------

describe("createOutputPersistence — load error handling", () => {
  it("returns empty array when file does not exist", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("returns empty array for corrupt JSON", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    // Write corrupt file manually (directory-per-session layout)
    const sessionDir = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "output.json"), "NOT VALID JSON {{{");

    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("returns empty array for valid JSON that is not an array", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const sessionDir = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "output.json"), JSON.stringify({ not: "an array" }));

    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("filters out invalid items from array, keeps valid ones", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const sessionDir = path.join(
      baseDir,
      ".flywheel",
      "sessions",
      sessionId,
    );
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "output.json"),
      JSON.stringify([
        { kind: "text", content: "valid", timestamp: 100 },
        { kind: "bogus" },
        { kind: "system", message: "also valid", timestamp: 200 },
      ]),
    );

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].kind).toBe("text");
    expect(loaded[1].kind).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe("createOutputPersistence — delete", () => {
  it("removes the output file", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    persistence.save([textBlock()]);
    const deleted = await persistence.delete();
    expect(deleted).toBe(true);

    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });

  it("returns false when file does not exist", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const deleted = await persistence.delete();
    expect(deleted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Size cap (10MB default)
// ---------------------------------------------------------------------------

describe("createOutputPersistence — size cap", () => {
  it("truncates oldest blocks when output exceeds maxSizeBytes", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    // Very low cap for testing: 500 bytes
    const persistence = createOutputPersistence({
      sessionId,
      baseDir,
      maxSizeBytes: 500,
    });

    // Generate blocks that exceed the cap
    const blocks = [];
    for (let i = 0; i < 50; i++) {
      blocks.push(textBlock(`block-${i}-${"x".repeat(20)}`));
    }

    persistence.save(blocks);

    // Read back — should be truncated (fewer blocks than original)
    const loaded = await persistence.load();
    expect(loaded.length).toBeLessThan(50);
    expect(loaded.length).toBeGreaterThan(0);

    // The kept blocks should be the LATEST (from the end), not the oldest
    const lastLoaded = loaded[loaded.length - 1] as any;
    expect(lastLoaded.content).toContain("block-49");
  });

  it("does not truncate when under the cap", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    // Large cap
    const persistence = createOutputPersistence({
      sessionId,
      baseDir,
      maxSizeBytes: 10 * 1024 * 1024,
    });

    const blocks = [textBlock("small"), systemBlock("tiny")];
    persistence.save(blocks);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// createFlusher (debounced flush)
// ---------------------------------------------------------------------------

describe("createOutputPersistence — createFlusher", () => {
  it("debounced flush writes blocks after interval", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    let currentBlocks = [textBlock("initial")];
    const flusher = persistence.createFlusher(() => currentBlocks, {
      intervalMs: 20,
    });

    flusher.schedule();
    await wait(60);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as any).content).toBe("initial");

    flusher.dispose();
  });

  it("uses latest blocks at flush time", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    let currentBlocks = [textBlock("v1")];
    const flusher = persistence.createFlusher(() => currentBlocks, {
      intervalMs: 20,
    });

    flusher.schedule();
    // Change blocks before flush fires
    currentBlocks = [textBlock("v2"), textBlock("v3")];

    await wait(60);

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(2);
    expect((loaded[0] as any).content).toBe("v2");

    flusher.dispose();
  });

  it("manual flush writes immediately", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    let currentBlocks = [textBlock("urgent")];
    const flusher = persistence.createFlusher(() => currentBlocks, {
      intervalMs: 60000, // Very long interval
    });

    flusher.schedule();
    await flusher.flush();

    const loaded = await persistence.load();
    expect(loaded).toHaveLength(1);
    expect((loaded[0] as any).content).toBe("urgent");

    flusher.dispose();
  });

  it("defaults to 5s interval", () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    // Just verify it doesn't throw — we can't easily test the 5s default
    // without waiting, but the API should accept no options
    const flusher = persistence.createFlusher(() => []);
    flusher.dispose();
  });

  it("dispose cancels pending writes", async () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    let currentBlocks = [textBlock("should not persist")];
    const flusher = persistence.createFlusher(() => currentBlocks, {
      intervalMs: 30,
    });

    flusher.schedule();
    flusher.dispose();

    await wait(80);

    const loaded = await persistence.load();
    expect(loaded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Async reads (Bun.file)
// ---------------------------------------------------------------------------

describe("createOutputPersistence — async reads", () => {
  it("load uses async reading (returns a Promise)", () => {
    const baseDir = makeTmpDir();
    const sessionId = crypto.randomUUID();
    const persistence = createOutputPersistence({ sessionId, baseDir });

    const result = persistence.load();
    // Should be a Promise (not synchronous)
    expect(result).toBeInstanceOf(Promise);
  });
});
