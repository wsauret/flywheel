#!/usr/bin/env bun
/**
 * Failure handling test.
 * Proves the controller correctly handles worker failures, retries, and stops.
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
const MOCK_WORKER_FAIL = path.join(import.meta.dir, "mock-worker-fail.ts");

// Clean up
try { fs.unlinkSync(STATE_PATH); } catch {}

console.log("=== Failure Handling Test ===\n");

// Config with max_retries=0 to see immediate failure
const { config, warnings } = loadConfig(undefined, {
  FLYWHEEL_MAX_RETRIES: "0",
});
for (const w of warnings) console.warn(`  ${w}`);

const adapter = new MockAdapter();

const mockSpawner = {
  async spawn(command: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }) {
    console.log(`  [spawn] ${command} -> routing to mock-worker-fail.ts`);
    const realSpawner = new BunProcessSpawner({ timeoutMinutes: 1 });
    return realSpawner.spawn("bun", ["run", MOCK_WORKER_FAIL, ...args], options);
  },
};

const controller = new WorkController({
  config,
  spawner: mockSpawner,
  ui: adapter,
  baseDir: FIXTURES_DIR,
});

try {
  const result = await controller.run(PLAN_PATH);

  console.log("\n=== Results ===");
  console.log(`Completed: ${result.completed}`);
  console.log(`Phases: ${result.phasesCompleted}/${result.phasesTotal}`);
  console.log(`Reason: ${result.reason}`);

  // Show state file
  if (fs.existsSync(STATE_PATH)) {
    const state = parseStateFile(fs.readFileSync(STATE_PATH, "utf-8"));
    console.log("\n=== State File ===");
    for (const phase of state.phases) {
      const marker = phase.status === "completed" ? "[x]" : phase.status === "in_progress" ? "[~]" : "[ ]";
      console.log(`  ${marker} ${phase.name}`);
    }
    if (state.errorLog.length > 0) {
      console.log("\n=== Error Log ===");
      for (const entry of state.errorLog) {
        console.log(`  Error: ${entry.error}`);
        console.log(`  Outcome: ${entry.outcome}`);
      }
    }
  }

  // Show events
  console.log(`\n=== Events (${adapter.events.length} total) ===`);
  for (const event of adapter.events) {
    console.log(`  ${event.type}`);
  }

  if (!result.completed && result.phasesCompleted === 0) {
    console.log("\n=== PASS: Controller correctly stopped on worker failure ===");
  } else {
    console.log("\n=== FAIL: Expected incomplete result ===");
    process.exit(1);
  }
} finally {
  await controller.shutdown();
  try { fs.unlinkSync(STATE_PATH); } catch {}
}
