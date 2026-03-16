#!/usr/bin/env bun
/**
 * Resume integration test.
 * Proves the controller correctly resumes from partial state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { WorkController } from "../../src/controller/work";
import { BunProcessSpawner } from "../../src/worker/bun-spawner";
import { MockAdapter } from "../../src/tui/adapters/mock";
import { loadConfig } from "../../src/config/loader";
import { parseStateFile } from "../../src/state/reader";
import { writeStateFileAtomic } from "../../src/state/writer";

const FIXTURES_DIR = path.join(import.meta.dir, "..", "fixtures");
const PLAN_PATH = path.join(FIXTURES_DIR, "two-phase-plan.md");
const STATE_PATH = path.join(FIXTURES_DIR, "two-phase-plan.state.md");
const MOCK_WORKER = path.join(import.meta.dir, "mock-worker.ts");

// Clean up
try { fs.unlinkSync(STATE_PATH); } catch {}

console.log("=== Resume Test: Create partial state, then resume ===\n");

// Create a state file with Phase 1 already completed
const partialState = {
  frontmatter: { plan: PLAN_PATH, status: "in_progress", schema_version: 3 },
  title: "Two Phase Test",
  phases: [
    { name: "Setup project structure", status: "completed" as const, annotations: {} },
    { name: "Implement core logic", status: "pending" as const, annotations: {} },
  ],
  keyDecisions: ["Phase 1: Used mock worker pattern"],
  errorLog: [],
};
writeStateFileAtomic(STATE_PATH, partialState);
console.log("Created partial state with Phase 1 completed, Phase 2 pending.\n");

// Now run the controller -- should skip Phase 1 and only execute Phase 2
const { config } = loadConfig();
const adapter = new MockAdapter();

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

try {
  const result = await controller.run(PLAN_PATH);

  console.log("\n=== Results ===");
  console.log(`Completed: ${result.completed}`);
  console.log(`Phases: ${result.phasesCompleted}/${result.phasesTotal}`);

  // Show state file
  const state = parseStateFile(fs.readFileSync(STATE_PATH, "utf-8"));
  console.log("\n=== State File ===");
  for (const phase of state.phases) {
    const marker = phase.status === "completed" ? "[x]" : phase.status === "in_progress" ? "[~]" : "[ ]";
    console.log(`  ${marker} ${phase.name}`);
  }

  // Show events -- should only have Phase 2 events
  console.log(`\n=== Events (${adapter.events.length} total) ===`);
  for (const event of adapter.events) {
    console.log(`  ${event.type}`);
  }

  // Verify: only 1 phase:started (Phase 2), not 2
  const phaseStarts = adapter.events.filter(e => e.type === "phase:started").length;
  console.log(`\nPhase starts: ${phaseStarts} (expected: 1 -- Phase 1 was skipped)`);

  if (phaseStarts === 1 && result.completed) {
    console.log("\n=== PASS: Resume correctly skipped Phase 1 ===");
  } else {
    console.log("\n=== FAIL ===");
    process.exit(1);
  }
} finally {
  await controller.shutdown();
  try { fs.unlinkSync(STATE_PATH); } catch {}
}
