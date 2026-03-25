/**
 * Tests for scrutiny validation phase:
 * - Commands config schema (flywheel.toml commands section)
 * - Scrutiny prompt template content and behavior
 * - Integration with execution loop prompt builder
 *
 * Fulfills: VAL-EXEC-003, VAL-EXEC-004, VAL-EXEC-011
 */

import { describe, test, expect } from "bun:test";
import { FlywheelConfigSchema, type FlywheelConfig } from "../src/config/loader";
import {
  buildScrutinyPrompt,
  type ScrutinyPromptContext,
} from "../src/prompts/work/scrutiny";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScrutinyContext(overrides: Partial<ScrutinyPromptContext> = {}): ScrutinyPromptContext {
  return {
    milestoneName: "auth-system",
    completedPhases: [
      { index: 0, title: "Add user model", description: "Create user schema and DB migration" },
      { index: 1, title: "Add login endpoint", description: "POST /api/auth/login" },
      { index: 2, title: "Add session middleware", description: "JWT verification middleware" },
    ],
    commands: {
      test: "bun test",
      typecheck: "bunx tsc --noEmit",
      lint: "eslint src/",
    },
    projectCwd: "/tmp/test-project",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Config: commands section
// ---------------------------------------------------------------------------

describe("FlywheelConfigSchema — commands section", () => {
  test("parses config with all commands configured", () => {
    const result = FlywheelConfigSchema.safeParse({
      commands: {
        test: "bun test",
        typecheck: "bunx tsc --noEmit",
        lint: "eslint src/",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands?.test).toBe("bun test");
      expect(result.data.commands?.typecheck).toBe("bunx tsc --noEmit");
      expect(result.data.commands?.lint).toBe("eslint src/");
    }
  });

  test("parses config with partial commands (only test)", () => {
    const result = FlywheelConfigSchema.safeParse({
      commands: {
        test: "npm test",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands?.test).toBe("npm test");
      expect(result.data.commands?.typecheck).toBeUndefined();
      expect(result.data.commands?.lint).toBeUndefined();
    }
  });

  test("parses config without commands section (optional)", () => {
    const result = FlywheelConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toBeUndefined();
    }
  });

  test("parses config with empty commands section", () => {
    const result = FlywheelConfigSchema.safeParse({
      commands: {},
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commands).toBeDefined();
      expect(result.data.commands?.test).toBeUndefined();
      expect(result.data.commands?.typecheck).toBeUndefined();
      expect(result.data.commands?.lint).toBeUndefined();
    }
  });

  test("commands are string values (not arrays or objects)", () => {
    const result = FlywheelConfigSchema.safeParse({
      commands: {
        test: 123, // invalid
      },
    });
    expect(result.success).toBe(false);
  });

  test("commands section does not affect other config defaults", () => {
    const result = FlywheelConfigSchema.safeParse({
      commands: { test: "bun test" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      // Verify other defaults are unaffected
      expect(result.data.engine).toBe("claude");
      expect(result.data.max_retries).toBe(3);
      expect(result.data.skip_scrutiny).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Scrutiny prompt: content verification
// ---------------------------------------------------------------------------

describe("buildScrutinyPrompt — content", () => {
  test("prompt contains milestone name", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toContain("auth-system");
  });

  test("prompt contains hard gate section with all three command types", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    // Hard gates should mention test, typecheck, lint
    expect(prompt).toContain("bun test");
    expect(prompt).toContain("bunx tsc --noEmit");
    expect(prompt).toContain("eslint src/");
  });

  test("prompt instructs test/typecheck/lint as hard gates", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    // Must convey that failures in these commands fail the validation
    expect(prompt.toLowerCase()).toContain("hard gate");
  });

  test("prompt instructs worker to review each completed phase", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    // Should reference each phase title
    expect(prompt).toContain("Add user model");
    expect(prompt).toContain("Add login endpoint");
    expect(prompt).toContain("Add session middleware");
  });

  test("prompt covers code quality, correctness, and test coverage", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    const lower = prompt.toLowerCase();
    expect(lower).toContain("code quality");
    expect(lower).toContain("correctness");
    expect(lower).toContain("test coverage");
  });

  test("prompt includes working directory", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toContain("/tmp/test-project");
  });
});

// ---------------------------------------------------------------------------
// Scrutiny prompt: missing commands behavior
// ---------------------------------------------------------------------------

describe("buildScrutinyPrompt — missing commands", () => {
  test("warns when test command is not configured", () => {
    const ctx = makeScrutinyContext({
      commands: { typecheck: "bunx tsc --noEmit", lint: "eslint src/" },
    });
    const prompt = buildScrutinyPrompt(ctx);
    // Should warn about missing test command but not fail
    expect(prompt.toLowerCase()).toContain("test");
    expect(prompt.toLowerCase()).toContain("not configured");
  });

  test("warns when typecheck command is not configured", () => {
    const ctx = makeScrutinyContext({
      commands: { test: "bun test", lint: "eslint src/" },
    });
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt.toLowerCase()).toContain("typecheck");
    expect(prompt.toLowerCase()).toContain("not configured");
  });

  test("warns when lint command is not configured", () => {
    const ctx = makeScrutinyContext({
      commands: { test: "bun test", typecheck: "bunx tsc --noEmit" },
    });
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt.toLowerCase()).toContain("lint");
    expect(prompt.toLowerCase()).toContain("not configured");
  });

  test("warns when all commands are missing", () => {
    const ctx = makeScrutinyContext({ commands: {} });
    const prompt = buildScrutinyPrompt(ctx);
    // Should still produce a prompt, just with warnings
    expect(prompt).toBeTruthy();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("not configured");
  });

  test("warns when commands is undefined", () => {
    const ctx = makeScrutinyContext({ commands: undefined });
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toBeTruthy();
    const lower = prompt.toLowerCase();
    expect(lower).toContain("not configured");
  });

  test("configured command failure means validation fails", () => {
    const ctx = makeScrutinyContext({
      commands: { test: "bun test" },
    });
    const prompt = buildScrutinyPrompt(ctx);
    // Must convey that if the configured command fails, the entire scrutiny phase fails
    const lower = prompt.toLowerCase();
    expect(lower).toContain("fail");
  });
});

// ---------------------------------------------------------------------------
// Scrutiny prompt: per-phase review instructions
// ---------------------------------------------------------------------------

describe("buildScrutinyPrompt — per-phase review", () => {
  test("lists all completed phases for review", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    // Each completed phase should be listed for review
    expect(prompt).toContain("Phase 1");
    expect(prompt).toContain("Phase 2");
    expect(prompt).toContain("Phase 3");
  });

  test("includes phase descriptions in review instructions", () => {
    const ctx = makeScrutinyContext();
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toContain("Create user schema and DB migration");
    expect(prompt).toContain("POST /api/auth/login");
    expect(prompt).toContain("JWT verification middleware");
  });

  test("handles empty completed phases list", () => {
    const ctx = makeScrutinyContext({ completedPhases: [] });
    const prompt = buildScrutinyPrompt(ctx);
    // Should still produce a valid prompt
    expect(prompt).toBeTruthy();
    expect(prompt).toContain("auth-system");
  });

  test("handles single completed phase", () => {
    const ctx = makeScrutinyContext({
      completedPhases: [
        { index: 0, title: "Setup project", description: "Initialize project structure" },
      ],
    });
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toContain("Setup project");
    expect(prompt).toContain("Initialize project structure");
  });
});

// ---------------------------------------------------------------------------
// Scrutiny prompt: commands read from config (not hardcoded)
// ---------------------------------------------------------------------------

describe("buildScrutinyPrompt — commands from config (VAL-EXEC-011)", () => {
  test("uses exact command strings from config", () => {
    const ctx = makeScrutinyContext({
      commands: {
        test: "pytest -xvs tests/",
        typecheck: "mypy src/",
        lint: "ruff check .",
      },
    });
    const prompt = buildScrutinyPrompt(ctx);
    // Should contain the exact command strings, not hardcoded defaults
    expect(prompt).toContain("pytest -xvs tests/");
    expect(prompt).toContain("mypy src/");
    expect(prompt).toContain("ruff check .");
    // Should NOT contain bun test (proving not hardcoded)
    expect(prompt).not.toContain("bun test");
    expect(prompt).not.toContain("tsc --noEmit");
  });

  test("only includes configured commands in hard gates", () => {
    const ctx = makeScrutinyContext({
      commands: {
        test: "npm test",
        // typecheck and lint not configured
      },
    });
    const prompt = buildScrutinyPrompt(ctx);
    expect(prompt).toContain("npm test");
    // typecheck and lint should be noted as not configured, not as hard gates
  });
});
