import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Imports under test (will exist after Step 1.4)
// ---------------------------------------------------------------------------

import {
  createSession,
  readSession,
  updateSession,
  listSessions,
  deleteSession,
} from "../src/session/persistence";
import { CliSessionSchema, type CliSession } from "../src/schemas/session";
import type { SessionLifecycleState } from "../src/session/state-machine";

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
function minimalSession(overrides?: Partial<CliSession>): CliSession {
  return {
    planPath: "plans/test.md",
    statePath: ".flywheel/state/test.state.md",
    contextPath: ".flywheel/context/test.ctx.md",
    currentPhase: 0,
    lastUpdated: new Date().toISOString(),
    workflowId: crypto.randomUUID(),
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

    // Verify file exists
    const filePath = path.join(baseDir, ".flywheel", "sessions", `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
  });

  it("stores data that can be read back as valid CliSession", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();

    const id = createSession(data, baseDir);
    const read = readSession(id, baseDir);

    expect(read).not.toBeNull();
    expect(read!.planPath).toBe(data.planPath);
    expect(read!.statePath).toBe(data.statePath);
    expect(read!.contextPath).toBe(data.contextPath);
    expect(read!.currentPhase).toBe(data.currentPhase);
    expect(read!.workflowId).toBe(data.workflowId);
  });

  it("stores optional fields when provided", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession({
      sessionLifecycleState: "work:active",
      name: "My Session",
      createdAt: "2026-03-15T12:00:00.000Z",
      repo: "flywheel/flywheel-tui",
      branch: "main",
      totalCost: 1.5,
    } as CliSession);

    const id = createSession(data, baseDir);
    const read = readSession(id, baseDir);

    expect(read).not.toBeNull();
    expect(read!.sessionLifecycleState).toBe("work:active");
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
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "bad-uuid.json"),
      "NOT VALID JSON {{{",
    );

    const result = readSession("bad-uuid", baseDir);
    expect(result).toBeNull();
  });

  it("returns null for JSON that fails Zod validation", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Valid JSON but not a valid CliSession (missing required fields)
    fs.writeFileSync(
      path.join(sessionsDir, "invalid.json"),
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
    const parseResult = CliSessionSchema.safeParse(read);
    expect(parseResult.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legacy sessions (optional fields missing)
// ---------------------------------------------------------------------------

describe("legacy session compatibility", () => {
  it("parses sessions without new optional fields", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Write a legacy session (no sessionLifecycleState, name, etc.)
    const legacyData = {
      planPath: "plans/old.md",
      statePath: ".flywheel/state/old.state.md",
      contextPath: ".flywheel/context/old.ctx.md",
      currentPhase: 2,
      lastUpdated: "2026-01-01T00:00:00.000Z",
      workflowId: crypto.randomUUID(),
    };
    fs.writeFileSync(
      path.join(sessionsDir, "legacy-id.json"),
      JSON.stringify(legacyData),
    );

    const read = readSession("legacy-id", baseDir);
    expect(read).not.toBeNull();
    expect(read!.planPath).toBe("plans/old.md");
    expect(read!.currentPhase).toBe(2);
    // Optional fields should be undefined
    expect(read!.sessionLifecycleState).toBeUndefined();
    expect(read!.name).toBeUndefined();
    expect(read!.createdAt).toBeUndefined();
    expect(read!.repo).toBeUndefined();
    expect(read!.branch).toBeUndefined();
    expect(read!.totalCost).toBeUndefined();
  });

  it("strict mode rejects unknown fields", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    const dataWithUnknown = {
      ...minimalSession(),
      unknownField: "should cause rejection",
    };
    fs.writeFileSync(
      path.join(sessionsDir, "unknown-field.json"),
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
    const data = minimalSession({ currentPhase: 0 });
    const id = createSession(data, baseDir);

    updateSession(id, { currentPhase: 3 }, baseDir);

    const read = readSession(id, baseDir);
    expect(read).not.toBeNull();
    expect(read!.currentPhase).toBe(3);
    expect(read!.planPath).toBe(data.planPath); // unchanged
    expect(read!.workflowId).toBe(data.workflowId); // unchanged
  });

  it("updates lastUpdated automatically", () => {
    const baseDir = makeTmpDir();
    const originalDate = "2026-01-01T00:00:00.000Z";
    const data = minimalSession({ lastUpdated: originalDate });
    const id = createSession(data, baseDir);

    updateSession(id, { currentPhase: 5 }, baseDir);

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
      { sessionLifecycleState: "work:active" as SessionLifecycleState },
      baseDir,
    );

    const read = readSession(id, baseDir);
    expect(read!.sessionLifecycleState).toBe("work:active");
  });

  it("throws when session does not exist", () => {
    const baseDir = makeTmpDir();
    expect(() => {
      updateSession("non-existent", { currentPhase: 1 }, baseDir);
    }).toThrow();
  });

  it("atomic write leaves no .tmp files", () => {
    const baseDir = makeTmpDir();
    const data = minimalSession();
    const id = createSession(data, baseDir);

    updateSession(id, { currentPhase: 10 }, baseDir);

    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    const files = fs.readdirSync(sessionsDir);
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
    const id1 = createSession(minimalSession({ planPath: "plan-A.md" }), baseDir);
    const id2 = createSession(minimalSession({ planPath: "plan-B.md" }), baseDir);

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
        sessionLifecycleState: "work:active",
      } as CliSession),
      baseDir,
    );
    createSession(
      minimalSession({
        sessionLifecycleState: "work:active",
      } as CliSession),
      baseDir,
    );
    createSession(
      minimalSession({
        sessionLifecycleState: "completed",
      } as CliSession),
      baseDir,
    );
    createSession(minimalSession(), baseDir); // no lifecycle state

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(4);

    const active = result.sessions.filter(
      (s) => s.data.sessionLifecycleState === "work:active",
    );
    const completed = result.sessions.filter(
      (s) => s.data.sessionLifecycleState === "completed",
    );
    const noState = result.sessions.filter(
      (s) => s.data.sessionLifecycleState === undefined,
    );

    expect(active).toHaveLength(2);
    expect(completed).toHaveLength(1);
    expect(noState).toHaveLength(1);
  });

  it("corrupt JSON files don't break list (per-file error isolation)", () => {
    const baseDir = makeTmpDir();

    // Create one valid session
    const validId = createSession(minimalSession({ planPath: "valid.md" }), baseDir);

    // Manually create corrupt files
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.writeFileSync(
      path.join(sessionsDir, "corrupt-1.json"),
      "NOT JSON AT ALL {{{",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "corrupt-2.json"),
      JSON.stringify({ invalid: true }), // valid JSON, invalid schema
    );

    const result = listSessions(baseDir);

    // Valid session still returned
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(validId);
    expect(result.sessions[0].data.planPath).toBe("valid.md");

    // Errors are reported but don't crash the listing
    expect(result.errors).toHaveLength(2);
    expect(result.errors.some((e) => e.file.includes("corrupt-1.json"))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.file.includes("corrupt-2.json"))).toBe(
      true,
    );
  });

  it("ignores non-.json files in sessions directory", () => {
    const baseDir = makeTmpDir();
    const sessionsDir = path.join(baseDir, ".flywheel", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Create a non-json file
    fs.writeFileSync(path.join(sessionsDir, "README.md"), "# Sessions");
    // Create a valid session
    createSession(minimalSession(), baseDir);

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

describe("deleteSession", () => {
  it("removes the session file", () => {
    const baseDir = makeTmpDir();
    const id = createSession(minimalSession(), baseDir);

    const deleted = deleteSession(id, baseDir);
    expect(deleted).toBe(true);

    const read = readSession(id, baseDir);
    expect(read).toBeNull();
  });

  it("returns false for non-existent session", () => {
    const baseDir = makeTmpDir();
    const deleted = deleteSession("non-existent", baseDir);
    expect(deleted).toBe(false);
  });

  it("session no longer appears in list after deletion", () => {
    const baseDir = makeTmpDir();
    const id1 = createSession(minimalSession({ planPath: "a.md" }), baseDir);
    const id2 = createSession(minimalSession({ planPath: "b.md" }), baseDir);

    deleteSession(id1, baseDir);

    const result = listSessions(baseDir);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].id).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// Schema extension tests
// ---------------------------------------------------------------------------

describe("CliSessionSchema extensions", () => {
  it("accepts all new optional fields", () => {
    const data = {
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      contextPath: ".flywheel/context/test.ctx.md",
      currentPhase: 0,
      lastUpdated: new Date().toISOString(),
      workflowId: crypto.randomUUID(),
      sessionLifecycleState: "work:active",
      name: "Test Session",
      createdAt: "2026-03-15T12:00:00.000Z",
      repo: "flywheel/flywheel-tui",
      branch: "feature/sessions",
      totalCost: 2.75,
    };

    const result = CliSessionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("validates sessionLifecycleState against the enum", () => {
    const data = {
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      contextPath: ".flywheel/context/test.ctx.md",
      currentPhase: 0,
      lastUpdated: new Date().toISOString(),
      workflowId: crypto.randomUUID(),
      sessionLifecycleState: "invalid-state",
    };

    const result = CliSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("validates totalCost is non-negative", () => {
    const data = {
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      contextPath: ".flywheel/context/test.ctx.md",
      currentPhase: 0,
      lastUpdated: new Date().toISOString(),
      workflowId: crypto.randomUUID(),
      totalCost: -1,
    };

    const result = CliSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("still passes with only required fields (backward compat)", () => {
    const data = {
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      contextPath: ".flywheel/context/test.ctx.md",
      currentPhase: 0,
      lastUpdated: new Date().toISOString(),
      workflowId: crypto.randomUUID(),
    };

    const result = CliSessionSchema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("still rejects unknown fields (strict mode)", () => {
    const data = {
      planPath: "plans/test.md",
      statePath: ".flywheel/state/test.state.md",
      contextPath: ".flywheel/context/test.ctx.md",
      currentPhase: 0,
      lastUpdated: new Date().toISOString(),
      workflowId: crypto.randomUUID(),
      totallyUnknownField: "nope",
    };

    const result = CliSessionSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});
