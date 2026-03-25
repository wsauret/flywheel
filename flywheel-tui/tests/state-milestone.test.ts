import { describe, it, expect, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parseStateFile } from "../src/state/reader";
import { serializeStateFile } from "../src/state/writer";
import type { ParsedStateFile, ParsedPhase } from "../src/state/reader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_DIR = path.join(os.tmpdir(), `flywheel-milestone-state-test-${process.pid}-${Date.now()}`);

function ensureTmpDir(): string {
  const dir = path.join(TMP_DIR, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

afterEach(() => {
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true });
  } catch {
    // May not exist
  }
});

// ---------------------------------------------------------------------------
// VAL-MILE-005: State file tracks milestone per phase
// ---------------------------------------------------------------------------

describe("State file milestone annotations", () => {
  // -------------------------------------------------------------------------
  // Reading milestone annotations from state file
  // -------------------------------------------------------------------------
  describe("reading milestone annotations", () => {
    it("parses milestone annotation from phase line", () => {
      const content = [
        "---",
        "plan: test-plan.md",
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: test",
        "",
        "## Progress",
        "- [x] Phase 1: Setup (milestone: Foundation)",
        "- [ ] Phase 2: Build API (milestone: Core Features)",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");

      const state = parseStateFile(content);

      expect(state.phases).toHaveLength(2);
      expect(state.phases[0].name).toBe("Setup");
      expect(state.phases[0].status).toBe("completed");
      expect(state.phases[0].annotations.milestone).toBe("Foundation");
      expect(state.phases[1].name).toBe("Build API");
      expect(state.phases[1].status).toBe("pending");
      expect(state.phases[1].annotations.milestone).toBe("Core Features");
    });

    it("handles phases with milestone and other annotations", () => {
      const content = [
        "---",
        "plan: test-plan.md",
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: test",
        "",
        "## Progress",
        "- [x] Phase 1: Setup (milestone: Foundation, commit: abc1234)",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");

      const state = parseStateFile(content);

      expect(state.phases[0].annotations.milestone).toBe("Foundation");
      expect(state.phases[0].annotations.commit).toBe("abc1234");
    });

    it("handles phases without milestone annotation", () => {
      const content = [
        "---",
        "plan: test-plan.md",
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: test",
        "",
        "## Progress",
        "- [x] Phase 1: Setup",
        "- [ ] Phase 2: Build API (milestone: Core)",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");

      const state = parseStateFile(content);

      expect(state.phases[0].annotations.milestone).toBeUndefined();
      expect(state.phases[1].annotations.milestone).toBe("Core");
    });

    it("parses milestone with spaces in the name", () => {
      const content = [
        "---",
        "plan: test-plan.md",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: test",
        "",
        "## Progress",
        "- [ ] Phase 1: Setup (milestone: Handoff & Context Infrastructure)",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");

      const state = parseStateFile(content);

      expect(state.phases[0].annotations.milestone).toBe("Handoff & Context Infrastructure");
    });
  });

  // -------------------------------------------------------------------------
  // Writing milestone annotations to state file
  // -------------------------------------------------------------------------
  describe("writing milestone annotations", () => {
    it("serializes milestone annotation in phase line", () => {
      const state: ParsedStateFile = {
        frontmatter: { plan: "test.md", schema_version: 3 },
        title: "Test",
        phases: [
          { name: "Setup", status: "completed", annotations: { milestone: "Foundation" } },
          { name: "Build", status: "pending", annotations: { milestone: "Core" } },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const output = serializeStateFile(state);

      expect(output).toContain("- [x] Phase 1: Setup (milestone: Foundation)");
      expect(output).toContain("- [ ] Phase 2: Build (milestone: Core)");
    });

    it("serializes phases without milestone annotation", () => {
      const state: ParsedStateFile = {
        frontmatter: { plan: "test.md", schema_version: 3 },
        title: "Test",
        phases: [
          { name: "Setup", status: "completed", annotations: {} },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const output = serializeStateFile(state);

      // No parentheses when no annotations
      expect(output).toContain("- [x] Phase 1: Setup");
      expect(output).not.toContain("(");
    });

    it("serializes milestone with other annotations", () => {
      const state: ParsedStateFile = {
        frontmatter: { plan: "test.md", schema_version: 3 },
        title: "Test",
        phases: [
          {
            name: "Setup",
            status: "completed",
            annotations: { milestone: "Foundation", commit: "abc123" },
          },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      const output = serializeStateFile(state);

      // Both annotations should be present
      expect(output).toContain("milestone: Foundation");
      expect(output).toContain("commit: abc123");
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip: read → write → read preserves milestone annotations
  // -------------------------------------------------------------------------
  describe("round-trip preservation", () => {
    it("milestone annotations survive read → serialize → parse cycle", () => {
      const originalState: ParsedStateFile = {
        frontmatter: { plan: "test.md", status: "in_progress", schema_version: 3 },
        title: "Round Trip Test",
        phases: [
          { name: "Setup", status: "completed", annotations: { milestone: "Foundation" } },
          { name: "Build API", status: "pending", annotations: { milestone: "Core Features" } },
          { name: "Tests", status: "in_progress", annotations: { milestone: "Core Features", commit: "abc123" } },
          { name: "Deploy", status: "pending", annotations: {} },
        ],
        keyDecisions: ["Used Zod for schemas"],
        errorLog: [],
      };

      // Serialize → parse
      const serialized = serializeStateFile(originalState);
      const parsed = parseStateFile(serialized);

      // Verify milestone annotations preserved
      expect(parsed.phases[0].annotations.milestone).toBe("Foundation");
      expect(parsed.phases[1].annotations.milestone).toBe("Core Features");
      expect(parsed.phases[2].annotations.milestone).toBe("Core Features");
      expect(parsed.phases[2].annotations.commit).toBe("abc123");
      expect(parsed.phases[3].annotations.milestone).toBeUndefined();

      // Verify other fields preserved
      expect(parsed.phases[0].status).toBe("completed");
      expect(parsed.phases[1].status).toBe("pending");
      expect(parsed.phases[2].status).toBe("in_progress");
      expect(parsed.title).toBe("Round Trip Test");
      expect(parsed.keyDecisions).toContain("Used Zod for schemas");
    });

    it("preserves milestones through multiple read-write cycles", () => {
      let state: ParsedStateFile = {
        frontmatter: { plan: "test.md", schema_version: 3 },
        title: "Multi Cycle",
        phases: [
          { name: "A", status: "pending", annotations: { milestone: "M1" } },
          { name: "B", status: "pending", annotations: { milestone: "M2" } },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      // Three cycles
      for (let i = 0; i < 3; i++) {
        const serialized = serializeStateFile(state);
        state = parseStateFile(serialized);
      }

      expect(state.phases[0].annotations.milestone).toBe("M1");
      expect(state.phases[1].annotations.milestone).toBe("M2");
    });
  });

  // -------------------------------------------------------------------------
  // FileStatePersistence integration with milestones
  // -------------------------------------------------------------------------
  describe("milestone annotations persist to disk", () => {
    it("state file on disk preserves milestone annotations after write and re-read", () => {
      const dir = ensureTmpDir();
      const statePath = path.join(dir, "test.state.md");

      const state: ParsedStateFile = {
        frontmatter: { plan: "test.md", status: "in_progress", schema_version: 3 },
        title: "Disk Test",
        phases: [
          { name: "Setup", status: "completed", annotations: { milestone: "Foundation" } },
          { name: "Build", status: "pending", annotations: { milestone: "Core" } },
        ],
        keyDecisions: [],
        errorLog: [],
      };

      // Write to disk
      const content = serializeStateFile(state);
      fs.writeFileSync(statePath, content);

      // Read back from disk
      const diskContent = fs.readFileSync(statePath, "utf-8");
      const parsed = parseStateFile(diskContent);

      expect(parsed.phases[0].annotations.milestone).toBe("Foundation");
      expect(parsed.phases[1].annotations.milestone).toBe("Core");
    });
  });

  // -------------------------------------------------------------------------
  // Backward compatibility: existing state files without milestone annotations
  // -------------------------------------------------------------------------
  describe("backward compatibility", () => {
    it("existing state files without milestone annotations parse correctly", () => {
      const content = [
        "---",
        "plan: old-plan.md",
        "status: in_progress",
        "schema_version: 3",
        "---",
        "",
        "# Execution State: Old Plan",
        "",
        "## Progress",
        "- [x] Phase 1: Schema definitions and validation (parallel-group: 1, commit: abc1234)",
        "- [x] Phase 2: Event bus implementation (parallel-group: 1, commit: def5678)",
        "- [ ] Phase 3: State management and configuration",
        "",
        "## Error Log",
        "| Error | Attempt | Approach | Outcome |",
        "|-------|---------|----------|---------|",
      ].join("\n");

      const state = parseStateFile(content);

      expect(state.phases).toHaveLength(3);
      expect(state.phases[0].annotations["parallel-group"]).toBe("1");
      expect(state.phases[0].annotations.commit).toBe("abc1234");
      expect(state.phases[0].annotations.milestone).toBeUndefined();
      expect(state.phases[2].annotations.milestone).toBeUndefined();
    });
  });
});
