import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import {
  createSession,
  readSession,
  updateSession,
  listSessions,
} from "../src/orchestration/session/persistence";
import { SessionSchema, type Session } from "../src/orchestration/session/schemas";
import type { SessionState } from "../src/orchestration/session/state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-session-test-${process.pid}-${Date.now()}`,
);

/** Create an isolated tmp dir for a single test. */
function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid session data (required fields only). */
function minimalSession(overrides?: Partial<Session>): Session {
  return {
    label: "plans/test.md",
    planPath: "plans/test.md",
    lastUpdated: new Date().toISOString(),
    budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
    budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
    kind: "workflow" as const,
    command: "work" as const,
    ...overrides,
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
// createSession + readSession round-trip
// ---------------------------------------------------------------------------

describe("createSession", () => {
  it("creates a session file in .flywheel/sessions/", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();

    const id = createSession(data, baseDir);

    // Verify UUID format
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    // Verify file exists (directory-per-session layout)
    const filePath = path.join(baseDir, ".flywheel", "sessions", id, "session.json");
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("stores data that can be read back as valid Session", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();

    const id = createSession(data, baseDir);
    const read = readSession(id, baseDir);

    expect(read).not.toBeNull();
    expect(read!.planPath).toBe(data.planPath);
    expect(read!.label).toBe(data.label);
  });

  it("stores optional fields when provided", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession({
      state: "active",
      name: "My Session",
      createdAt: "2026-03-15T12:00:00.000Z",
      repo: "flywheel/flywheel-tui",
      branch: "main",
      totalCost: 1.5,
    } as Session);

    const id = createSession(data, baseDir);
    const read = readSession(id, baseDir);

    expect(read).not.toBeNull();
    expect(read!.state).toBe("active");
    expect(read!.name).toBe("My Session");
    expect(read!.createdAt).toBe("2026-03-15T12:00:00.000Z");
    expect(read!.repo).toBe("flywheel/flywheel-tui");
    expect(read!.branch).toBe("main");
    expect(read!.totalCost).toBe(1.5);
  });

  it("creates .flywheel/sessions/ directory if it doesn't exist", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    expect(fs.existsSync(sessionsDir)).toBe(false);

    createSession(minimalSession(), baseDir);

    expect(fs.existsSync(sessionsDir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readSession
// ---------------------------------------------------------------------------

describe("readSession", () => {
  it("returns null for non-existent session", () => {
    const baseDir = makeTmpDir();
    const result = readSession("non-existent-uuid", baseDir);
    expect(result).toBeNull();
  });

  it("returns null for corrupt JSON", () => {
    const baseDir = makeTmpDir();
    const sessionDir = path.join(baseDir, ".flywheel", "sessions", "bad-uuid");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      "NOT VALID JSON {{{",
    );

    const result = readSession("bad-uuid", baseDir);
    expect(result).toBeNull();
  });

  it("returns null for JSON that fails Zod validation", () => {
    const baseDir = makeTmpDir();
    const sessionDir = path.join(baseDir, ".flywheel", "sessions", "invalid");
    fs.mkdirSync(sessionDir, { recursive: true });

    // Valid JSON but not a valid Session (missing required fields)
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify({ foo: "bar" }),
    );

    const result = readSession("invalid", baseDir);
    expect(result).toBeNull();
  });

  it("reads back data with correct Zod-validated schema", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();
    const id = createSession(data, baseDir);

    const read = readSession(id, baseDir);
    // Verify it truly passes Zod validation (not just a loose parse)
    const parseResult = SessionSchema.safeParse(read);
    expect(parseResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("schema validation", () => {
  it("strict mode rejects unknown fields", () => {
    const baseDir = makeTmpDir();
    const sessionDir = path.join(baseDir, ".flywheel", "sessions", "unknown-field");
    fs.mkdirSync(sessionDir, { recursive: true });

    const dataWithUnknown = {
      ...minimalSession(),
      unknownField: "should cause rejection",
    };
    fs.writeFileSync(
      path.join(sessionDir, "session.json"),
      JSON.stringify(dataWithUnknown),
    );

    const read = readSession("unknown-field", baseDir);
    expect(read).toBeNull(); // strict() rejects unknown keys
  });
});

// ---------------------------------------------------------------------------
// updateSession
// ---------------------------------------------------------------------------

describe("updateSession", () => {
  it("updates specific fields while preserving others", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();
    const id = createSession(data, baseDir);

    updateSession(id, { name: "Updated Name" }, baseDir);

    const read = readSession(id, baseDir);
    expect(read).not.toBeNull();
    expect(read!.name).toBe("Updated Name");
    expect(read!.planPath).toBe(data.planPath); // unchanged
    expect(read!.label).toBe(data.label); // unchanged
  });

  it("updates lastUpdated automatically", () => {
    const baseDir = makeTmpDir();
    const originalDate = "2026-01-01T00:00:00.000Z";
    const data = minimalSession({ lastUpdated: originalDate });
    const id = createSession(data, baseDir);

    updateSession(id, { totalCost: 5.0 }, baseDir);

    const read = readSession(id, baseDir);
    expect(read).not.toBeNull();
    expect(read!.lastUpdated).not.toBe(originalDate);
  });

  it("can set optional lifecycle state", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();
    const id = createSession(data, baseDir);

    updateSession(
      id,
      { state: "active" as SessionState },
      baseDir,
    );

    const read = readSession(id, baseDir);
    expect(read!.state).toBe("active");
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    expect(() => {
      updateSession("non-existent", { totalCost: 1 }, baseDir);
    }).toThrow();
  });

  it("atomic write leaves no .tmp files", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();
    const id = createSession(data, baseDir);

    updateSession(id, { totalCost: 10 }, baseDir);

    const sessionDir = path.join(baseDir, ".flywheel", "sessions", id);
    const files = fs.readdirSync(sessionDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listSessions
// ---------------------------------------------------------------------------

describe("listSessions", () => {
  it("returns empty map when no sessions exist", () => {
    const baseDir = makeTmpDir();
    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns empty map when .flywheel/sessions/ doesn't exist", () => {
    const baseDir = makeTmpDir();
    // Don't create the directory at all
    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("lists sessions with their IDs", () => {
    const baseDir = makeTmpDir();
    const id1 = createSession(minimalSession({ label: "plan-A.md", planPath: "plan-A.md" }), baseDir);
    const id2 = createSession(minimalSession({ label: "plan-B.md", planPath: "plan-B.md" }), baseDir);

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(2);

    const ids = result.sessions.map((s) => s.id);
    expect(ids).toContain(id1);
    expect(ids).toContain(id2);

    const planPaths = result.sessions.map((s) => s.data.planPath);
    expect(planPaths).toContain("plan-A.md");
    expect(planPaths).toContain("plan-B.md");
  });

  it("groups sessions by lifecycle state", () => {
    const baseDir = makeTmpDir();

    createSession(
      minimalSession({
        state: "active",
      } as Session),
      baseDir,
    );
    createSession(
      minimalSession({
        state: "active",
      } as Session),
      baseDir,
    );
    createSession(
      minimalSession({
        state: "completed",
      } as Session),
      baseDir,
    );
    createSession(minimalSession(), baseDir); // no lifecycle state

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(4);

    const active = result.sessions.filter(
      (s) => s.data.state === "active",
    );
    const completed = result.sessions.filter(
      (s) => s.data.state === "completed",
    );

    // Session created without explicit state gets default "active" from schema
    expect(active).toHaveLength(3);
    expect(completed).toHaveLength(1);
  });

  it("corrupt JSON files don't break list (per-file error isolation)", () => {
    const baseDir = makeTmpDir();

    // Create one valid session
    const validId = createSession(minimalSession({ label: "valid.md", planPath: "valid.md" }), baseDir);

    // Manually create corrupt session directories
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    const corrupt1Dir = path.join(sessionsDir, "corrupt-1");
    const corrupt2Dir = path.join(sessionsDir, "corrupt-2");
    fs.mkdirSync(corrupt1Dir, { recursive: true });
    fs.mkdirSync(corrupt2Dir, { recursive: true });
    fs.writeFileSync(
      path.join(corrupt1Dir, "session.json"),
      "NOT JSON AT ALL {{{",
    );
    fs.writeFileSync(
      path.join(corrupt2Dir, "session.json"),
      JSON.stringify({ invalid: true }), // valid JSON, invalid schema
    );

    const result = listSessions(baseDir);

    // Valid session still returned
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(validId);
    const validData = result.sessions[0].data;
    expect(validData.kind === "workflow" && validData.planPath).toBe("valid.md");

    // Errors are reported but don't crash the listing
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.file.includes("corrupt-1"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.file.includes("corrupt-2"))).toBe(
      true,
    );
  });

  it("ignores non-directory entries in sessions directory", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a non-directory file (listSessions now reads directories, not flat files)
    fs.writeFileSync(path.join(sessionsDir, "README.md"), "# Sessions");
    // Create a valid session
    createSession(minimalSession(), baseDir);

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Schema extension tests
// ---------------------------------------------------------------------------

describe("SessionSchema extensions", () => {
  it("accepts all optional fields alongside required fields", () => {
    const data = {
      label: "plans/test.md",
      planPath: "plans/test.md",
        lastUpdated: new Date().toISOString(),
      state: "active",
      name: "Test Session",
      createdAt: "2026-03-15T12:00:00.000Z",
      repo: "flywheel/flywheel-tui",
      branch: "feature/sessions",
      totalCost: 2.75,
      budgetLimits: { max_invocations: 0, max_tokens: null, wall_clock_deadline: null },
      budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
      kind: "workflow" as const,
      command: "work" as const,
    };

    const result = SessionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates state against the enum", () => {
    const data = {
      ...minimalSession(),
      state: "invalid-state",
    };

    const result = SessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("validates totalCost is non-negative", () => {
    const data = {
      ...minimalSession(),
      totalCost: -1,
    };

    const result = SessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("requires budget, kind, and command fields", () => {
    const data = {
      label: "plans/test.md",
      lastUpdated: new Date().toISOString(),
    };

    const result = SessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("still rejects unknown fields (strict mode)", () => {
    const data = {
      ...minimalSession(),
      totallyUnknownField: "nope",
    };

    const result = SessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
