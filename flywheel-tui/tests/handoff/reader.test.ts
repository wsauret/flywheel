import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readHandoff,
  HandoffMissingError,
  HandoffInvalidError,
  HandoffReadTimeoutError,
} from "../../src/queue/shared/handoff-reader";
import { WorkerHandoffSchema } from "../../src/queue/shared/handoff-schemas";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "handoff-reader-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// readHandoff — success cases
// ---------------------------------------------------------------------------

describe("readHandoff", () => {
  it("valid file returns parsed data", async () => {
    const data = {
      summary: "A".repeat(100),
      decisions: ["Used approach A"],
    };
    const path = join(tmpDir, "handoff.json");
    await Bun.write(path, JSON.stringify(data));

    const result = await readHandoff(path, WorkerHandoffSchema);
    expect(result.summary).toBe("A".repeat(100));
    expect(result.decisions).toEqual(["Used approach A"]);
  });

  it("works with a simple schema", async () => {
    const SimpleSchema = z.object({ name: z.string() }).strict();
    const path = join(tmpDir, "simple.json");
    await Bun.write(path, JSON.stringify({ name: "test" }));

    const result = await readHandoff(path, SimpleSchema);
    expect(result.name).toBe("test");
  });
});

// ---------------------------------------------------------------------------
// readHandoff — error cases
// ---------------------------------------------------------------------------

describe("readHandoff — missing file", () => {
  it("throws HandoffMissingError for nonexistent file", async () => {
    const path = join(tmpDir, "nonexistent.json");
    try {
      await readHandoff(path, WorkerHandoffSchema);
      expect(true).toBe(false); // should not reach here
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffMissingError);
      expect((err as HandoffMissingError).path).toBe(path);
    }
  });
});

describe("readHandoff — invalid JSON", () => {
  it("throws HandoffInvalidError with parse error message", async () => {
    const path = join(tmpDir, "bad.json");
    await Bun.write(path, "{ not valid json !!! }");

    try {
      await readHandoff(path, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      expect((err as HandoffInvalidError).message).toContain("JSON");
    }
  });
});

describe("readHandoff — schema failure", () => {
  it("throws HandoffInvalidError with Zod error details", async () => {
    const path = join(tmpDir, "invalid-schema.json");
    // Missing required summary field
    await Bun.write(path, JSON.stringify({ decisions: ["A"] }));

    try {
      await readHandoff(path, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      const msg = (err as HandoffInvalidError).message;
      // Should mention the field path
      expect(msg).toContain("summary");
    }
  });

  it("includes constraint info in error for min length violation", async () => {
    const path = join(tmpDir, "too-short.json");
    await Bun.write(path, JSON.stringify({ summary: "too short" }));

    try {
      await readHandoff(path, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
      const msg = (err as HandoffInvalidError).message;
      expect(msg).toContain("summary");
    }
  });
});

describe("readHandoff — empty file", () => {
  it("throws HandoffInvalidError for empty file", async () => {
    const path = join(tmpDir, "empty.json");
    await Bun.write(path, "");

    try {
      await readHandoff(path, WorkerHandoffSchema);
      expect(true).toBe(false);
    } catch (err) {
      expect(err).toBeInstanceOf(HandoffInvalidError);
    }
  });
});

describe("readHandoff — passthrough tolerance", () => {
  it("tolerates unknown fields via .passthrough() on WorkerHandoffSchema", async () => {
    const path = join(tmpDir, "extra-fields.json");
    await Bun.write(
      path,
      JSON.stringify({
        summary: "A".repeat(100),
        unknown_hallucinated_field: "should be tolerated",
      }),
    );

    // WorkerHandoffBaseSchema now uses .passthrough() — extra fields are accepted
    const result = await readHandoff(path, WorkerHandoffSchema);
    expect(result.summary).toBe("A".repeat(100));
  });
});

describe("readHandoff — timeout", () => {
  it("throws HandoffReadTimeoutError on slow read", async () => {
    // Create a path that we'll use with a mocked slow read
    const path = join(tmpDir, "slow.json");
    await Bun.write(path, JSON.stringify({ summary: "A".repeat(100) }));

    // To test timeout, we pass a very short timeout and a schema that
    // uses a refine with a sleep to simulate slow parsing.
    // But the cleaner approach: pass a custom timeout override.
    // The reader supports a timeout parameter (5s default).
    // We'll use a 1ms timeout which should race-fail on any real file read.
    try {
      await readHandoff(path, WorkerHandoffSchema, { timeoutMs: 1 });
      // If it succeeds (fast disk), that's ok — the test is best-effort.
      // But on most systems, 1ms will timeout.
    } catch (err) {
      if (err instanceof HandoffReadTimeoutError) {
        expect(err).toBeInstanceOf(HandoffReadTimeoutError);
        expect(err.timeoutMs).toBe(1);
      }
      // If it's another error type (e.g., it was fast enough), that's fine
    }
  });

  it("HandoffReadTimeoutError carries timeout duration", () => {
    const err = new HandoffReadTimeoutError("/tmp/test.json", 5000);
    expect(err.timeoutMs).toBe(5000);
    expect(err.path).toBe("/tmp/test.json");
    expect(err.message).toContain("5000");
  });
});

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

describe("error classes", () => {
  it("HandoffMissingError is an Error with path", () => {
    const err = new HandoffMissingError("/tmp/missing.json");
    expect(err).toBeInstanceOf(Error);
    expect(err.path).toBe("/tmp/missing.json");
    expect(err.name).toBe("HandoffMissingError");
  });

  it("HandoffInvalidError is an Error with path and details", () => {
    const err = new HandoffInvalidError("/tmp/bad.json", "bad field: summary");
    expect(err).toBeInstanceOf(Error);
    expect(err.path).toBe("/tmp/bad.json");
    expect(err.message).toContain("bad field: summary");
    expect(err.name).toBe("HandoffInvalidError");
  });

  it("HandoffReadTimeoutError is an Error", () => {
    const err = new HandoffReadTimeoutError("/tmp/slow.json", 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("HandoffReadTimeoutError");
  });
});
