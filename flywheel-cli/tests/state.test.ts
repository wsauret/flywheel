import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  parseStateFile,
  serializeStateFile,
  serializeStateFileRaw,
  writeStateFileAtomic,
  recoverStaleTmpFiles,
  acquireLock,
  lockPathFor,
  checkActiveSkillSession,
} from "../src/state";
import { migrateStateFile, StateFileSchema } from "../src/schemas/state";
import type { ParsedStateFile } from "../src/state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TMP_DIR = path.join(os.tmpdir(), `flywheel-test-${process.pid}-${Date.now()}`);

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  // Clean up tmp dir after all tests
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// 2.1 State file round-trip tests
// ---------------------------------------------------------------------------

describe("State file reader", () => {
  it("parses sample.state.md fixture", () => {
    const content = readFixture("sample.state.md");
    const parsed = parseStateFile(content);

    // Frontmatter
    expect(parsed.frontmatter.plan).toBe(
      "docs/plans/feat-tdd-solid-dry-planning-integration.md",
    );
    expect(parsed.frontmatter.status).toBe("in_progress");
    expect(parsed.frontmatter.schema_version).toBe(3);
    expect(parsed.frontmatter.writer).toBe("skill");
    expect(parsed.frontmatter.last_written_at).toBe("2026-03-14T18:30:00.000Z");

    // Title
    expect(parsed.title).toBe("TDD + SOLID + DRY Planning Integration");

    // Phases
    expect(parsed.phases).toHaveLength(5);
    expect(parsed.phases[0].name).toBe("Schema definitions and validation");
    expect(parsed.phases[0].status).toBe("completed");
    expect(parsed.phases[0].annotations["parallel-group"]).toBe("1");
    expect(parsed.phases[0].annotations.commit).toBe("abc1234");

    expect(parsed.phases[1].name).toBe("Event bus implementation");
    expect(parsed.phases[1].status).toBe("completed");
    expect(parsed.phases[1].annotations["parallel-group"]).toBe("1");
    expect(parsed.phases[1].annotations.commit).toBe("def5678");

    expect(parsed.phases[2].name).toBe("State management and configuration");
    expect(parsed.phases[2].status).toBe("pending");
    expect(Object.keys(parsed.phases[2].annotations)).toHaveLength(0);

    expect(parsed.phases[3].name).toBe("Controller integration");
    expect(parsed.phases[3].status).toBe("in_progress");

    expect(parsed.phases[4].name).toBe("TUI adapter layer");
    expect(parsed.phases[4].status).toBe("pending");
  });

  it("parses partial.state.md (missing sections)", () => {
    const content = readFixture("partial.state.md");
    const parsed = parseStateFile(content);

    expect(parsed.frontmatter.plan).toBe("docs/plans/some-plan.md");
    expect(parsed.phases).toHaveLength(1);
    expect(parsed.phases[0].name).toBe("Initial setup");
    expect(parsed.phases[0].status).toBe("pending");

    // Missing sections should be empty
    expect(parsed.keyDecisions).toHaveLength(0);
    expect(parsed.errorLog).toHaveLength(0);
  });

  it("parses Error Log table with escaped pipes and newlines", () => {
    const content = readFixture("sample.state.md");
    const parsed = parseStateFile(content);

    expect(parsed.errorLog).toHaveLength(4);

    // Normal row
    expect(parsed.errorLog[0].error).toBe("Build failed with missing import");
    expect(parsed.errorLog[0].attempt).toBe("1");
    expect(parsed.errorLog[0].approach).toBe(
      "Added missing import for ExecutionStatus",
    );
    expect(parsed.errorLog[0].outcome).toBe("Resolved");

    // Row with escaped pipe
    expect(parsed.errorLog[2].error).toBe("Pipe char | in error msg");

    // Row with <br> (newline)
    expect(parsed.errorLog[3].error).toBe("Multi-line\nerror message");
  });

  it("parses empty Error Log table (header only)", () => {
    const content = readFixture("coercion-traps.state.md");
    const parsed = parseStateFile(content);
    expect(parsed.errorLog).toHaveLength(0);
  });

  it("parses key decisions", () => {
    const content = readFixture("sample.state.md");
    const parsed = parseStateFile(content);
    expect(parsed.keyDecisions).toHaveLength(2);
    expect(parsed.keyDecisions[0]).toContain("Zod strict mode");
    expect(parsed.keyDecisions[1]).toContain("Synchronous event bus");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: parse -> serialize -> parse (semantic equality)
// ---------------------------------------------------------------------------

describe("State file round-trip", () => {
  it("parse -> serialize -> parse produces semantically equal result", () => {
    const content = readFixture("sample.state.md");
    const parsed1 = parseStateFile(content);

    // Serialize with raw (preserving frontmatter) then re-parse
    const serialized = serializeStateFileRaw(parsed1, parsed1.frontmatter);
    const parsed2 = parseStateFile(serialized);

    // Semantic equality checks
    expect(parsed2.title).toBe(parsed1.title);
    expect(parsed2.phases).toHaveLength(parsed1.phases.length);
    for (let i = 0; i < parsed1.phases.length; i++) {
      expect(parsed2.phases[i].name).toBe(parsed1.phases[i].name);
      expect(parsed2.phases[i].status).toBe(parsed1.phases[i].status);
      expect(parsed2.phases[i].annotations).toEqual(
        parsed1.phases[i].annotations,
      );
    }
    expect(parsed2.keyDecisions).toEqual(parsed1.keyDecisions);
    expect(parsed2.errorLog).toEqual(parsed1.errorLog);
  });

  it("round-trip with boolean-like strings preserves them as strings", () => {
    const content = readFixture("coercion-traps.state.md");
    const parsed1 = parseStateFile(content);

    // Verify YAML JSON_SCHEMA prevents coercion
    expect(parsed1.frontmatter.plan).toBe("docs/plans/true.md");
    expect(parsed1.frontmatter.status).toBe("yes");

    // Phase names with boolean-like values
    expect(parsed1.phases[0].name).toBe("yes");
    expect(parsed1.phases[1].name).toBe("no");
    expect(parsed1.phases[2].name).toBe("true");
    expect(parsed1.phases[3].name).toBe("false");
    expect(parsed1.phases[4].name).toBe("null");

    // Round-trip
    const serialized = serializeStateFileRaw(parsed1, parsed1.frontmatter);
    const parsed2 = parseStateFile(serialized);

    // Frontmatter values preserved as strings
    expect(parsed2.frontmatter.plan).toBe("docs/plans/true.md");
    expect(parsed2.frontmatter.status).toBe("yes");
    expect(typeof parsed2.frontmatter.status).toBe("string");
  });

  it("round-trip with date-like strings preserves them as strings", () => {
    const content = readFixture("coercion-traps.state.md");
    const parsed1 = parseStateFile(content);

    // commit annotation has a date-like value "2026-03-14"
    expect(parsed1.phases[0].annotations.commit).toBe("2026-03-14");

    const serialized = serializeStateFileRaw(parsed1, parsed1.frontmatter);
    const parsed2 = parseStateFile(serialized);
    expect(parsed2.phases[0].annotations.commit).toBe("2026-03-14");
  });

  it("round-trip with pipe characters in error log", () => {
    const state: ParsedStateFile = {
      frontmatter: { plan: "test.md", schema_version: 3 },
      title: "Test",
      phases: [],
      keyDecisions: [],
      errorLog: [
        {
          error: "Error with | pipe",
          attempt: "1",
          approach: "Fixed | it",
          outcome: "OK",
        },
      ],
    };

    const serialized = serializeStateFileRaw(state);
    const parsed = parseStateFile(serialized);
    expect(parsed.errorLog[0].error).toBe("Error with | pipe");
    expect(parsed.errorLog[0].approach).toBe("Fixed | it");
  });
});

// ---------------------------------------------------------------------------
// migrateStateFile tests
// ---------------------------------------------------------------------------

describe("migrateStateFile", () => {
  it("input without writer gets 'skill' default", () => {
    const raw = {
      schema_version: 1,
      plan_path: "some-plan.md",
      last_written_at: "2026-03-14T00:00:00Z",
      phases: [],
    };
    const migrated = migrateStateFile(raw);
    expect(migrated.writer).toBe("skill");
  });

  it("input without last_written_at gets mtime", () => {
    const mtime = new Date("2026-01-15T12:00:00Z");
    const raw = {
      schema_version: 1,
      plan_path: "some-plan.md",
      writer: "skill",
      phases: [],
    };
    const migrated = migrateStateFile(raw, mtime);
    expect(migrated.last_written_at).toBe("2026-01-15T12:00:00.000Z");
  });

  it("preserves existing writer when present", () => {
    const raw = {
      schema_version: 1,
      plan_path: "some-plan.md",
      writer: "controller",
      last_written_at: "2026-03-14T00:00:00Z",
      phases: [],
    };
    const migrated = migrateStateFile(raw);
    expect(migrated.writer).toBe("controller");
  });

  it("migrated output validates with StateFileSchema", () => {
    const raw = {
      schema_version: 1,
      plan_path: "some-plan.md",
      phases: [],
    };
    const migrated = migrateStateFile(raw, new Date("2026-01-01T00:00:00Z"));
    const result = StateFileSchema.safeParse(migrated);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Atomic write tests
// ---------------------------------------------------------------------------

describe("writeStateFileAtomic", () => {
  it("writes file atomically (no partial writes)", () => {
    const dir = ensureTmpDir();
    const filePath = path.join(dir, "test.state.md");

    const state: ParsedStateFile = {
      frontmatter: {
        plan: "test.md",
        schema_version: 3,
        writer: "controller",
        last_written_at: "2026-03-14T00:00:00.000Z",
      },
      title: "Test Plan",
      phases: [
        { name: "Phase 1", status: "completed", annotations: {} },
      ],
      keyDecisions: ["Used TDD"],
      errorLog: [],
    };

    writeStateFileAtomic(filePath, state);

    expect(fs.existsSync(filePath)).toBe(true);
    const content = fs.readFileSync(filePath, "utf-8");
    expect(content).toContain("# Execution State: Test Plan");
    expect(content).toContain("- [x] Phase 1: Phase 1");
    expect(content).toContain("- Used TDD");
  });

  it("no .tmp files remain after successful write", () => {
    const dir = ensureTmpDir();
    const filePath = path.join(dir, "test.state.md");

    const state: ParsedStateFile = {
      frontmatter: { plan: "test.md", schema_version: 3 },
      title: "Test",
      phases: [],
      keyDecisions: [],
      errorLog: [],
    };

    writeStateFileAtomic(filePath, state);

    const files = fs.readdirSync(dir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("sets writer to controller and updates last_written_at", () => {
    const dir = ensureTmpDir();
    const filePath = path.join(dir, "test.state.md");

    const state: ParsedStateFile = {
      frontmatter: { plan: "test.md", schema_version: 3, writer: "skill" },
      title: "Test",
      phases: [],
      keyDecisions: [],
      errorLog: [],
    };

    writeStateFileAtomic(filePath, state);

    const content = fs.readFileSync(filePath, "utf-8");
    const reparsed = parseStateFile(content);
    expect(reparsed.frontmatter.writer).toBe("controller");
    expect(typeof reparsed.frontmatter.last_written_at).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 2.3 Stale .tmp recovery tests
// ---------------------------------------------------------------------------

describe("recoverStaleTmpFiles", () => {
  it("promotes .tmp with newer last_written_at than current state", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");

    // Write current state file with old timestamp
    const oldState = `---
plan: test.md
schema_version: 3
writer: skill
last_written_at: "2026-03-14T00:00:00.000Z"
---

# Execution State: Test

## Progress
- [ ] Phase 1: Old

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;
    fs.writeFileSync(statePath, oldState);

    // Write a .tmp with newer timestamp
    const tmpPath = `${statePath}.__flywheel__.${process.pid}.${Date.now()}.abcdef01.tmp`;
    const newState = `---
plan: test.md
schema_version: 3
writer: controller
last_written_at: "2026-03-15T00:00:00.000Z"
---

# Execution State: Test

## Progress
- [x] Phase 1: New

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;
    fs.writeFileSync(tmpPath, newState);

    const result = recoverStaleTmpFiles(statePath);

    expect(result.promoted).toBe(true);
    expect(result.promotedFrom).toBe(tmpPath);

    // The state file should now have the newer content
    const content = fs.readFileSync(statePath, "utf-8");
    const parsed = parseStateFile(content);
    expect(parsed.frontmatter.last_written_at).toBe("2026-03-15T00:00:00.000Z");
  });

  it("discards .tmp with older last_written_at than current state", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");

    // Current state file has newer timestamp
    const currentState = `---
plan: test.md
schema_version: 3
writer: controller
last_written_at: "2026-03-16T00:00:00.000Z"
---

# Execution State: Test

## Progress

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;
    fs.writeFileSync(statePath, currentState);

    // Write .tmp with older timestamp
    const tmpPath = `${statePath}.__flywheel__.${process.pid}.${Date.now()}.abcdef02.tmp`;
    const oldTmp = `---
plan: test.md
schema_version: 3
writer: skill
last_written_at: "2026-03-14T00:00:00.000Z"
---

# Execution State: Test

## Progress

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;
    fs.writeFileSync(tmpPath, oldTmp);

    const result = recoverStaleTmpFiles(statePath);

    expect(result.promoted).toBe(false);
    expect(result.discarded).toContain(tmpPath);
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it("returns empty result when no .tmp files exist", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");
    fs.writeFileSync(statePath, "---\nplan: test.md\n---\n");

    const result = recoverStaleTmpFiles(statePath);
    expect(result.promoted).toBe(false);
    expect(result.discarded).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });

  it("only matches files with .__flywheel__. sentinel", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");
    fs.writeFileSync(statePath, "---\nplan: test.md\n---\n");

    // Create a non-flywheel .tmp file (should be ignored)
    const nonFlywheelTmp = `${statePath}.some-other.tmp`;
    fs.writeFileSync(nonFlywheelTmp, "garbage");

    const result = recoverStaleTmpFiles(statePath);
    expect(result.promoted).toBe(false);
    expect(result.discarded).toHaveLength(0);

    // Non-flywheel tmp should still exist
    expect(fs.existsSync(nonFlywheelTmp)).toBe(true);
  });

  it("caps at 10 .tmp files, warns and discards older ones", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");
    fs.writeFileSync(statePath, "---\nplan: test.md\nschema_version: 3\n---\n");

    // Create 12 tmp files with staggered timestamps
    for (let i = 0; i < 12; i++) {
      const ts = `2026-03-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`;
      const tmpPath = `${statePath}.__flywheel__.${process.pid}.${Date.now() + i}.${String(i).padStart(8, "0")}.tmp`;
      fs.writeFileSync(
        tmpPath,
        `---\nplan: test.md\nschema_version: 3\nlast_written_at: "${ts}"\n---\n\n## Progress\n\n## Error Log\n| Error | Attempt | Approach | Outcome |\n|-------|---------|----------|---------|`,
      );
      // Ensure different mtimes
    }

    const result = recoverStaleTmpFiles(statePath);

    // Should have warnings about skipped files
    expect(result.warnings.some((w) => w.includes("exceeds cap"))).toBe(true);
  });

  it("promotes .tmp when state file does not exist", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");
    // Do NOT create the state file

    const tmpPath = `${statePath}.__flywheel__.${process.pid}.${Date.now()}.abcdef03.tmp`;
    const tmpContent = `---
plan: test.md
schema_version: 3
writer: controller
last_written_at: "2026-03-15T00:00:00.000Z"
---

# Execution State: Test

## Progress

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`;
    fs.writeFileSync(tmpPath, tmpContent);

    const result = recoverStaleTmpFiles(statePath);
    expect(result.promoted).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it("compares by last_written_at timestamp, not phase count", () => {
    const dir = ensureTmpDir();
    const statePath = path.join(dir, "plan.state.md");

    // Current: 5 phases but old timestamp
    fs.writeFileSync(statePath, `---
plan: test.md
schema_version: 3
last_written_at: "2026-03-10T00:00:00.000Z"
---

# Execution State: Test

## Progress
- [x] Phase 1: A
- [x] Phase 2: B
- [x] Phase 3: C
- [x] Phase 4: D
- [x] Phase 5: E

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`);

    // Tmp: only 2 phases but newer timestamp
    const tmpPath = `${statePath}.__flywheel__.${process.pid}.${Date.now()}.deadbeef.tmp`;
    fs.writeFileSync(tmpPath, `---
plan: test.md
schema_version: 3
last_written_at: "2026-03-15T00:00:00.000Z"
---

# Execution State: Test

## Progress
- [x] Phase 1: A
- [ ] Phase 2: B

## Error Log
| Error | Attempt | Approach | Outcome |
|-------|---------|----------|---------|
`);

    const result = recoverStaleTmpFiles(statePath);
    expect(result.promoted).toBe(true);

    // Verify the state file now has 2 phases (from the tmp)
    const content = fs.readFileSync(statePath, "utf-8");
    const parsed = parseStateFile(content);
    expect(parsed.phases).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 2.4 Write lock tests
// ---------------------------------------------------------------------------

describe("Write lock", () => {
  it("acquires and releases lock", () => {
    const dir = ensureTmpDir();
    const lock = acquireLock("test-plan", dir);

    expect(fs.existsSync(lock.lockPath)).toBe(true);

    // Verify lock content
    const content = JSON.parse(fs.readFileSync(lock.lockPath, "utf-8"));
    expect(content.pid).toBe(process.pid);
    expect(typeof content.timestamp).toBe("number");
    expect(content.hostname).toBe(os.hostname());

    lock.release();
    expect(fs.existsSync(lock.lockPath)).toBe(false);
  });

  it("release is idempotent", () => {
    const dir = ensureTmpDir();
    const lock = acquireLock("test-plan", dir);

    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });

  it("lockPathFor returns correct path", () => {
    const result = lockPathFor("my-plan", "/base");
    expect(result).toBe("/base/.flywheel/my-plan.write.lock");
  });

  it("throws when lock is already held by another (non-stale) process", () => {
    const dir = ensureTmpDir();
    const lock1 = acquireLock("test-plan", dir);

    expect(() => {
      acquireLock("test-plan", dir);
    }).toThrow(/Write lock held by another process/);

    lock1.release();
  });

  it("cleans up stale lock (dead PID + old timestamp + same host)", () => {
    const dir = ensureTmpDir();
    const lockPath_ = lockPathFor("test-plan", dir);

    // Create .flywheel directory
    fs.mkdirSync(path.dirname(lockPath_), { recursive: true });

    // Create a stale lock (PID 999999 is very unlikely to be alive)
    const staleLock = {
      pid: 999999,
      timestamp: Date.now() - 600_000, // 10 minutes ago
      hostname: os.hostname(),
    };
    fs.writeFileSync(lockPath_, JSON.stringify(staleLock));

    // Should acquire successfully after detecting stale lock
    const lock = acquireLock("test-plan", dir, { staleThresholdMs: 300_000 });
    expect(fs.existsSync(lock.lockPath)).toBe(true);

    // Verify the new lock has current PID
    const content = JSON.parse(fs.readFileSync(lock.lockPath, "utf-8"));
    expect(content.pid).toBe(process.pid);

    lock.release();
  });

  it("creates .flywheel directory if it doesn't exist", () => {
    const dir = ensureTmpDir();
    const flywheelDir = path.join(dir, ".flywheel");
    expect(fs.existsSync(flywheelDir)).toBe(false);

    const lock = acquireLock("test-plan", dir);
    expect(fs.existsSync(flywheelDir)).toBe(true);

    lock.release();
  });
});

// ---------------------------------------------------------------------------
// Active skill session check
// ---------------------------------------------------------------------------

describe("checkActiveSkillSession", () => {
  it("returns null when no session file exists", () => {
    const dir = ensureTmpDir();
    const result = checkActiveSkillSession(dir);
    expect(result).toBeNull();
  });

  it("returns warning when active_skill: work-implementation is found", () => {
    const dir = ensureTmpDir();
    const sessionDir = path.join(dir, ".flywheel");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.md"),
      "---\nactive_skill: work-implementation\n---\n",
    );

    const result = checkActiveSkillSession(dir);
    expect(result).toContain("Active skill session detected");
    expect(result).toContain("Do NOT run flywheel CLI concurrently");
  });

  it("returns null when session exists but no active skill", () => {
    const dir = ensureTmpDir();
    const sessionDir = path.join(dir, ".flywheel");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.md"),
      "---\nactive_skill: none\n---\n",
    );

    const result = checkActiveSkillSession(dir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Lock cleanup handlers
// ---------------------------------------------------------------------------

describe("Lock cleanup handlers", () => {
  it("SIGTERM listener is registered on acquire", () => {
    const dir = ensureTmpDir();
    const initialListeners = process.listenerCount("SIGTERM");
    const lock = acquireLock("cleanup-test", dir);

    expect(process.listenerCount("SIGTERM")).toBe(initialListeners + 1);

    lock.release();

    // After release, listener should be removed
    expect(process.listenerCount("SIGTERM")).toBe(initialListeners);
  });

  it("uncaughtException listener is registered on acquire", () => {
    const dir = ensureTmpDir();
    const initialListeners = process.listenerCount("uncaughtException");
    const lock = acquireLock("cleanup-test-2", dir);

    expect(process.listenerCount("uncaughtException")).toBe(
      initialListeners + 1,
    );

    lock.release();
    expect(process.listenerCount("uncaughtException")).toBe(initialListeners);
  });

  it("unhandledRejection listener is registered on acquire", () => {
    const dir = ensureTmpDir();
    const initialListeners = process.listenerCount("unhandledRejection");
    const lock = acquireLock("cleanup-test-3", dir);

    expect(process.listenerCount("unhandledRejection")).toBe(
      initialListeners + 1,
    );

    lock.release();
    expect(process.listenerCount("unhandledRejection")).toBe(initialListeners);
  });
});
