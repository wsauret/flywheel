#!/usr/bin/env bun
/**
 * Manual integration test runner.
 * Proves the full CLI pipeline works end-to-end with real subprocesses.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WorkController } from "../../src/controller/work";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { loadConfig } from "../../src/config/loader";
import { parseStateFile } from "../../src/state/reader";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures");
const PLAN_PATH = path.join(FIXTURES_DIR, "two-phase-plan.md");
const STATE_PATH = path.join(FIXTURES_DIR, "two-phase-plan.state.md");
const MOCK_WORKER = path.join(import.meta.dir, "mock-worker.ts");

// Clean up
try { fs.unlinkSync(STATE_PATH); } catch {}

console.log("=== Flywheel CLI E2E Integration Test ===\n");
console.log(`Plan: ${PLAN_PATH}`);
console.log(`Mock worker: ${MOCK_WORKER}\n`);

const { config, warnings } = loadConfig();
for (const w of warnings) console.warn(w);

const adapter = new MockAdapter();

// Custom spawner that routes to mock worker
const mockSpawner = {
  async spawn(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) {
    console.log(`  [spawn] ${command} -> routing to mock-worker.ts`);
    const realSpawner = new BunProcessSpawner({ timeoutMinutes: 1 });
    return realSpawner.spawn("bun", ["run", MOCK_WORKER, ...args], options);
  },
};

const controller = new WorkController({
  config,
  spawner: mockSpawner,
  ui: adapter,
  baseDir: FIXTURES_DIR,
});

console.log("Starting controller loop...\n");

try {
  const result = await controller.run(PLAN_PATH);

  console.log("\n=== Results ===");
  console.log(`Completed: ${result.completed}`);
  console.log(`Phases: ${result.phasesCompleted}/${result.phasesTotal}`);
  if (result.reason) console.log(`Reason: ${result.reason}`);

  // Show state file
  if (fs.existsSync(STATE_PATH)) {
    console.log("\n=== State File ===");
    const state = parseStateFile(fs.readFileSync(STATE_PATH, "utf-8"));
    for (const phase of state.phases) {
      const marker = phase.status === "completed" ? "[x]" : phase.status === "in_progress" ? "[~]" : "[ ]";
      console.log(`  ${marker} ${phase.name}`);
    }
  }

  // Show events
  console.log(`\n=== Events (${adapter.events.length} total) ===`);
  for (const event of adapter.events) {
    console.log(`  ${event.type}`);
  }

  console.log("\n=== PASS ===");
} catch (error) {
  console.error("FATAL:", error);
  process.exit(1);
} finally {
  await controller.shutdown();
  // Clean up
  try { fs.unlinkSync(STATE_PATH); } catch {}
}
