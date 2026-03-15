#!/usr/bin/env bun
/**
 * E2E smoke test runner.
 *
 * Runs `flywheel work` against plan.md using a real worker (claude or opencode),
 * then scores the results. Use this to iterate on prompt templates.
 *
 * Usage:
 *   bun run tests/e2e/run.ts                    # uses claude (default)
 *   FLYWHEEL_ENGINE=opencode bun run tests/e2e/run.ts
 *   FLYWHEEL_ENGINE=opencode FLYWHEEL_MODEL=anthropic/claude-sonnet-4-6 bun run tests/e2e/run.ts
 *
 * Outputs:
 *   - workspace/hello.txt and workspace/goodbye.txt (created by worker)
 *   - results.json (structured score + timing + event log)
 *
 * Scoring:
 *   - Phase completion: did the controller complete both phases?
 *   - File creation: do the expected files exist?
 *   - Content accuracy: does file content match expected?
 *   - Event correctness: were the right events emitted in order?
 *   - Timing: how long did each phase take?
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WorkController } from "../../src/controller/work";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { loadConfig, resolveModels } from "../../src/config/loader";
import { getEngine } from "../../src/engines/core/registry";
import { parseStateFile } from "../../src/state/reader";
import type { FlywheelEvent } from "../../src/events/types";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const E2E_DIR = import.meta.dir;
const PLAN_PATH = path.join(E2E_DIR, "plan.md");
const WORKSPACE = path.join(E2E_DIR, "workspace");
const STATE_PATH = path.join(E2E_DIR, "plan.state.md");
const RESULTS_PATH = path.join(E2E_DIR, "results.json");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// Clean workspace
if (fs.existsSync(WORKSPACE)) {
  for (const f of fs.readdirSync(WORKSPACE)) {
    if (f === ".gitkeep") continue;
    fs.unlinkSync(path.join(WORKSPACE, f));
  }
}
fs.mkdirSync(WORKSPACE, { recursive: true });

// Clean previous state
try { fs.unlinkSync(STATE_PATH); } catch {}

// Clean lock files
const flywheelLockDir = path.join(E2E_DIR, ".flywheel");
if (fs.existsSync(flywheelLockDir)) {
  for (const f of fs.readdirSync(flywheelLockDir)) {
    if (f.endsWith(".write.lock")) {
      fs.unlinkSync(path.join(flywheelLockDir, f));
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const { config, warnings } = loadConfig(undefined, {
  ...process.env as Record<string, string>,
  FLYWHEEL_PROJECT_CWD: WORKSPACE,
  FLYWHEEL_MAX_RETRIES: "1",
  FLYWHEEL_TIMEOUT_MINUTES: "5",
});
for (const w of warnings) console.warn(w);

const engine = getEngine(config.engine);

console.log("=== Flywheel CLI E2E Smoke Test ===\n");
console.log(`Plan:      ${PLAN_PATH}`);
console.log(`Workspace: ${WORKSPACE}`);
console.log(`Engine:    ${engine.metadata.name} (${engine.metadata.id})`);
const models = resolveModels(config);
console.log(`Model:     ${models.workerModel ?? engine.metadata.defaultModel + " (default)"}`);
console.log("");

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const adapter = new MockAdapter();
const spawner = new BunProcessSpawner({ timeoutMinutes: 5 });

const controller = new WorkController({
  config,
  spawner,
  engine,
  ui: adapter,
  baseDir: E2E_DIR,
});

const startTime = Date.now();
let result: Awaited<ReturnType<typeof controller.run>>;

try {
  result = await controller.run(PLAN_PATH);
} catch (err) {
  console.error("FATAL:", err);
  process.exit(1);
} finally {
  await controller.shutdown();
}

const totalMs = Date.now() - startTime;

// ---------------------------------------------------------------------------
// Score
// ---------------------------------------------------------------------------

interface PhaseScore {
  phase: number;
  completed: boolean;
  fileExists: boolean;
  contentMatch: boolean;
  actualContent: string | null;
  expectedContent: string;
}

interface Score {
  timestamp: string;
  engine: string;
  model: string;
  totalMs: number;
  phasesCompleted: number;
  phasesTotal: number;
  allPhasesCompleted: boolean;
  phases: PhaseScore[];
  eventSequence: string[];
  eventCount: number;
  correctEventSequence: boolean;
  overallScore: number; // 0-100
  reason?: string;
}

const expectedFiles: { file: string; content: string }[] = [
  { file: "hello.txt", content: "Hello from Phase 1" },
  { file: "goodbye.txt", content: "Goodbye from Phase 2" },
];

const phases: PhaseScore[] = expectedFiles.map((expected, i) => {
  const filePath = path.join(WORKSPACE, expected.file);
  const exists = fs.existsSync(filePath);
  const actual = exists ? fs.readFileSync(filePath, "utf-8").trim() : null;
  const match = actual === expected.content;

  return {
    phase: i + 1,
    completed: i < result.phasesCompleted,
    fileExists: exists,
    contentMatch: match,
    actualContent: actual,
    expectedContent: expected.content,
  };
});

const eventSequence = adapter.events.map((e: FlywheelEvent) => e.type);

// Expected event pattern for 2 successful phases
const expectedPattern = [
  "workflow:started",
  "phase:started", "worker:spawned", "worker:completed", "phase:completed",
  "phase:started", "worker:spawned", "worker:completed", "phase:completed",
  "workflow:completed",
];

const correctEventSequence =
  eventSequence.length === expectedPattern.length &&
  eventSequence.every((e: string, i: number) => e === expectedPattern[i]);

// Calculate score (0-100)
let score = 0;
// 20 points: all phases completed
if (result.completed) score += 20;
// 30 points per phase: file exists (10) + content matches (20)
for (const p of phases) {
  if (p.fileExists) score += 10;
  if (p.contentMatch) score += 20;
}
// 20 points: correct event sequence
if (correctEventSequence) score += 20;

const scoreResult: Score = {
  timestamp: new Date().toISOString(),
  engine: engine.metadata.id,
  model: models.workerModel ?? engine.metadata.defaultModel,
  totalMs,
  phasesCompleted: result.phasesCompleted,
  phasesTotal: result.phasesTotal,
  allPhasesCompleted: result.completed,
  phases,
  eventSequence,
  eventCount: adapter.events.length,
  correctEventSequence,
  overallScore: score,
  reason: result.reason,
};

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

fs.writeFileSync(RESULTS_PATH, JSON.stringify(scoreResult, null, 2));

console.log("\n=== Results ===");
console.log(`Completed:     ${result.completed ? "YES" : "NO"}`);
console.log(`Phases:        ${result.phasesCompleted}/${result.phasesTotal}`);
console.log(`Time:          ${(totalMs / 1000).toFixed(1)}s`);
if (result.reason) console.log(`Reason:        ${result.reason}`);

console.log("\n=== Phase Scores ===");
for (const p of phases) {
  const status = p.contentMatch ? "PASS" : p.fileExists ? "WRONG CONTENT" : p.completed ? "FILE MISSING" : "NOT COMPLETED";
  console.log(`  Phase ${p.phase}: ${status}`);
  if (p.fileExists && !p.contentMatch) {
    console.log(`    Expected: "${p.expectedContent}"`);
    console.log(`    Actual:   "${p.actualContent}"`);
  }
}

console.log("\n=== Events ===");
for (const e of eventSequence) {
  console.log(`  ${e}`);
}
console.log(`  (${correctEventSequence ? "correct sequence" : "UNEXPECTED sequence"})`);

console.log(`\n=== Overall Score: ${score}/100 ===`);
console.log(`Results saved to: ${RESULTS_PATH}`);
