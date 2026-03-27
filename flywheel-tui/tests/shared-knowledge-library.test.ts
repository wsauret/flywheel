/**
 * Tests for the shared knowledge library feature.
 *
 * Covers:
 * - LIBRARY_DIR constant in config/paths.ts
 * - Library directory creation during pipeline initialization
 * - Work prompt template references to .flywheel/library/
 * - Idempotent directory creation (no failure if already exists)
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { LIBRARY_DIR, FLYWHEEL_DIR } from "../src/config/paths";
import { buildWorkStepPrompt } from "../src/prompts/work/step-prompt";
import type { WorkflowStepContext } from "../src/prompts/index";

// ---------------------------------------------------------------------------
// LIBRARY_DIR constant
// ---------------------------------------------------------------------------

describe("LIBRARY_DIR constant", () => {
  test("is defined and equals .flywheel/library", () => {
    expect(LIBRARY_DIR).toBe(`${FLYWHEEL_DIR}/library`);
  });

  test("starts with FLYWHEEL_DIR prefix", () => {
    expect(LIBRARY_DIR.startsWith(FLYWHEEL_DIR)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Work prompt template — library references
// ---------------------------------------------------------------------------

describe("Work prompt library references", () => {
  const baseCtx: WorkflowStepContext = {
    planContent: "Implement a hello world endpoint",
    keyDecisions: ["Use Express for routing"],
    fileReferences: ["src/app.ts"],
    projectCwd: "/tmp/test-project",
  };

  test("prompt includes reference to .flywheel/library/", () => {
    const prompt = buildWorkStepPrompt(baseCtx);
    expect(prompt).toContain(".flywheel/library/");
  });

  test("prompt includes instruction to read from library before starting", () => {
    const prompt = buildWorkStepPrompt(baseCtx);
    // Must tell workers to read the library BEFORE starting
    expect(prompt).toMatch(/read.*library|library.*read/i);
  });

  test("prompt includes instruction to write discoveries to library before completing", () => {
    const prompt = buildWorkStepPrompt(baseCtx);
    // Must tell workers to write critical context to the library
    expect(prompt).toMatch(/write.*library|library.*write/i);
  });

  test("prompt references specific filenames: environment.md, architecture.md", () => {
    const prompt = buildWorkStepPrompt(baseCtx);
    expect(prompt).toContain("environment.md");
    expect(prompt).toContain("architecture.md");
  });

  test("prompt contains a Knowledge Library section header", () => {
    const prompt = buildWorkStepPrompt(baseCtx);
    expect(prompt).toMatch(/knowledge library/i);
  });

  test("prompt with minimal context still includes library reference", () => {
    const minimalCtx: WorkflowStepContext = {
      planContent: "Do something",
      keyDecisions: [],
      fileReferences: [],
    };
    const prompt = buildWorkStepPrompt(minimalCtx);
    expect(prompt).toContain(".flywheel/library/");
  });
});

// ---------------------------------------------------------------------------
// Library directory creation during pipeline initialization
// ---------------------------------------------------------------------------

describe("Library directory creation in ExecutionLoop", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-library-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test(".flywheel/library/ is created if it does not exist", async () => {
    // Import ensureLibraryDir from paths module
    const { ensureLibraryDir } = await import("../src/config/paths");
    const libraryPath = path.resolve(tmpDir, LIBRARY_DIR);

    expect(fs.existsSync(libraryPath)).toBe(false);
    ensureLibraryDir(tmpDir);
    expect(fs.existsSync(libraryPath)).toBe(true);
    expect(fs.statSync(libraryPath).isDirectory()).toBe(true);
  });

  test("does not fail if library directory already exists", async () => {
    const { ensureLibraryDir } = await import("../src/config/paths");
    const libraryPath = path.resolve(tmpDir, LIBRARY_DIR);

    // Create it first
    fs.mkdirSync(libraryPath, { recursive: true });
    expect(fs.existsSync(libraryPath)).toBe(true);

    // Should not throw
    expect(() => ensureLibraryDir(tmpDir)).not.toThrow();
    expect(fs.existsSync(libraryPath)).toBe(true);
  });

  test("creates parent .flywheel/ directory if needed", async () => {
    const { ensureLibraryDir } = await import("../src/config/paths");
    const flywheelPath = path.resolve(tmpDir, FLYWHEEL_DIR);
    const libraryPath = path.resolve(tmpDir, LIBRARY_DIR);

    expect(fs.existsSync(flywheelPath)).toBe(false);
    ensureLibraryDir(tmpDir);
    expect(fs.existsSync(flywheelPath)).toBe(true);
    expect(fs.existsSync(libraryPath)).toBe(true);
  });
});
