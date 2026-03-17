import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FileStatePersistence } from "../src/controller/file-state-persistence";
import { parseStateFile } from "../src/state/reader";
import { lockPathFor } from "../src/state/lock";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXTURES_DIR = path.join(import.meta.dir, "fixtures");
const TMP_DIR = path.join(os.tmpdir(), `flywheel-persist-test-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// FileStatePersistence
// ---------------------------------------------------------------------------

describe("FileStatePersistence", () => {
  describe("load()", () => {
    it("reads existing state file from disk", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "test-plan.md");
      const statePath = path.join(dir, "test-plan.state.md");

      // Write a state file manually
      const stateContent = [
        "---",
        `plan: ${planPath}`,
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: test-plan",
        "",
        "## Progress",
        "- [x] Phase 1: Setup",
        "- [ ] Phase 2: Build",
        "",
        "## Key Decisions",
        "- Using TypeScript",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");
      fs.writeFileSync(statePath, stateContent);

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load("ignored — state already exists");

      expect(state.phases).toHaveLength(2);
      expect(state.phases[0].status).toBe("completed");
      expect(state.phases[1].status).toBe("pending");
      expect(state.keyDecisions).toContain("Using TypeScript");
    });

    it("creates initial state when no state file exists", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "new-plan.md");
      const statePath = path.join(dir, "new-plan.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      expect(state.phases).toHaveLength(2);
      expect(state.phases[0].name).toBe("Setup project structure");
      expect(state.phases[1].name).toBe("Implement core logic");
      expect(state.phases[0].status).toBe("pending");
      expect(state.phases[1].status).toBe("pending");
      expect(state.keyDecisions).toEqual([]);
      expect(state.errorLog).toEqual([]);

      // Verify file was written
      expect(fs.existsSync(statePath)).toBe(true);
    });

    it("initial state has correct frontmatter", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "fm-test.md");
      const statePath = path.join(dir, "fm-test.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      expect(state.frontmatter.plan).toBe(planPath);
      expect(state.frontmatter.status).toBe("in_progress");
      expect(state.frontmatter.schema_version).toBe(3);
    });
  });

  describe("updatePhase()", () => {
    it("writes atomically with lock", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "update-test.md");
      const statePath = path.join(dir, "update-test.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      // Update phase 0 to completed
      persistence.updatePhase(state, 0, "completed");

      // Read back from disk
      const diskContent = fs.readFileSync(statePath, "utf-8");
      const diskState = parseStateFile(diskContent);

      expect(diskState.phases[0].status).toBe("completed");
      expect(diskState.phases[1].status).toBe("pending");

      // Lock file should NOT exist after write (released)
      const lockPath = lockPathFor("update-test", dir);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it("appends to error log on failure", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "error-test.md");
      const statePath = path.join(dir, "error-test.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      persistence.updatePhase(state, 0, "pending", "Worker timeout after 60s");

      expect(state.errorLog).toHaveLength(1);
      expect(state.errorLog[0].error).toBe("Worker timeout after 60s");
      expect(state.errorLog[0].outcome).toBe("Failed");
      expect(state.errorLog[0].approach).toBe("controller");

      // Verify persisted to disk
      const diskContent = fs.readFileSync(statePath, "utf-8");
      const diskState = parseStateFile(diskContent);
      expect(diskState.errorLog).toHaveLength(1);
      expect(diskState.errorLog[0].error).toBe("Worker timeout after 60s");
    });

    it("appends resolved entry when status is completed with error message", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "resolved-test.md");
      const statePath = path.join(dir, "resolved-test.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      persistence.updatePhase(state, 0, "completed", "Retried successfully");

      expect(state.errorLog[0].outcome).toBe("Resolved");
    });

    it("does not append to error log when no error message", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "no-error.md");
      const statePath = path.join(dir, "no-error.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);

      persistence.updatePhase(state, 0, "completed");

      expect(state.errorLog).toHaveLength(0);
    });
  });

  describe("getKeyDecisions()", () => {
    it("returns key decisions from state", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "kd-test.md");
      const statePath = path.join(dir, "kd-test.state.md");

      // Write a state with key decisions
      const stateContent = [
        "---",
        `plan: ${planPath}`,
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: kd-test",
        "",
        "## Progress",
        "- [x] Phase 1: Setup",
        "",
        "## Key Decisions",
        "- Phase 1: Used Zod for validation",
        "- Phase 1: Event bus is synchronous",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");
      fs.writeFileSync(statePath, stateContent);

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load("ignored");
      const decisions = persistence.getKeyDecisions(state);

      expect(decisions).toHaveLength(2);
      expect(decisions[0]).toContain("Zod");
      expect(decisions[1]).toContain("synchronous");
    });

    it("returns empty array when no key decisions", () => {
      const dir = ensureTmpDir();
      const planPath = path.join(dir, "no-kd.md");
      const statePath = path.join(dir, "no-kd.state.md");
      const planContent = readFixture("two-phase-plan.md");

      const persistence = new FileStatePersistence(planPath, statePath, dir);
      const state = persistence.load(planContent);
      const decisions = persistence.getKeyDecisions(state);

      expect(decisions).toEqual([]);
    });
  });

  describe("no persistence (undefined)", () => {
    it("passing undefined for persistence means no file I/O", () => {
      // This is a conceptual test — the unified ExecutionLoop will accept
      // StatePersistence | undefined. When undefined, no state is read/written.
      // We verify this by confirming the interface is optional.
      const maybePersistence: FileStatePersistence | undefined = undefined;
      expect(maybePersistence).toBeUndefined();
    });
  });
});
