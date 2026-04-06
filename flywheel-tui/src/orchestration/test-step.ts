// ---------------------------------------------------------------------------
// Test Step — run a single step type in isolation with fixture data
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createQueue } from "../workflows/queue/queue.js";
import type { Queue, Step } from "../workflows/queue/types.js";
import { ensureSessionDir, resolveSessionFile } from "../infra/paths.js";
import { Log } from "../infra/log.js";

const log = Log.create({ service: "test-step" });

// ---------------------------------------------------------------------------
// Test step definitions
// ---------------------------------------------------------------------------

export interface TestStepDef {
  /** Display name for the picker */
  label: string;
  /** Short identifier (matches fixture directory name) */
  id: string;
  /** Queue step type */
  type: Step["type"];
  /** Step title (matches what the template would produce) */
  title: string;
  /** Dispatcher hint for plan sub-roles */
  dispatcherHint?: string;
  /** Evaluation criteria */
  evaluationCriteria?: string;
  /** Tool scoping overrides */
  toolScoping?: Step["toolScoping"];
  /** Fixture directory relative to tests/fixtures/steps/ */
  fixtureDir: string;
  /** Whether this step needs a plan file seeded */
  needsPlan: boolean;
  /** Whether this step needs a handoff from a predecessor */
  needsHandoff: boolean;
}

export const TEST_STEPS: TestStepDef[] = [
  {
    label: "Work: Execute step",
    id: "work",
    type: "work",
    title: "Execute work",
    fixtureDir: "work",
    needsPlan: true,
    needsHandoff: true,
  },
];

// ---------------------------------------------------------------------------
// Fixture setup — copy plan/handoff files to .flywheel/
// ---------------------------------------------------------------------------

export interface FixtureSetupResult {
  planPath: string | null;
  handoffData: Record<string, unknown> | null;
}

export function setupTestFixture(
  stepDef: TestStepDef,
  projectCwd: string,
  sessionId?: string,
): FixtureSetupResult {
  const fixtureBase = path.join(
    projectCwd,
    "tests",
    "fixtures",
    "steps",
    stepDef.fixtureDir,
  );

  let planPath: string | null = null;
  let handoffData: Record<string, unknown> | null = null;

  if (stepDef.needsPlan) {
    const fixturePlan = path.join(fixtureBase, "plan.json");
    if (fs.existsSync(fixturePlan)) {
      const testSessionId = sessionId ?? "test-fixture";
      ensureSessionDir(testSessionId, projectCwd);
      const destFile = resolveSessionFile(testSessionId, "plan", projectCwd);
      fs.copyFileSync(fixturePlan, destFile);
      planPath = destFile;
    }
  }

  if (stepDef.needsHandoff) {
    const fixtureHandoff = path.join(fixtureBase, "handoff.json");
    if (fs.existsSync(fixtureHandoff)) {
      try {
        handoffData = JSON.parse(fs.readFileSync(fixtureHandoff, "utf-8")) as Record<string, unknown>;
      } catch {
        // Invalid JSON — skip
      }
    }
  }

  return { planPath, handoffData };
}

// ---------------------------------------------------------------------------
// Queue construction — single step with optional seeded predecessor
// ---------------------------------------------------------------------------

export function buildTestQueue(
  stepDef: TestStepDef,
  fixture: FixtureSetupResult,
): Queue {
  const steps: Step[] = [];

  if (fixture.handoffData) {
    steps.push({
      id: randomUUID(),
      type: "plan",
      title: "(fixture) Previous step",
      status: "completed",
    });
  }

  const testStep: Step = {
    id: randomUUID(),
    type: stepDef.type,
    title: stepDef.title,
    status: "pending",
    dispatcherHint: stepDef.dispatcherHint,
    evaluationCriteria: stepDef.evaluationCriteria,
    toolScoping: stepDef.toolScoping,
  };

  if (fixture.planPath) {
    testStep.fileReferences = [fixture.planPath];
  }

  steps.push(testStep);

  const queue = createQueue(steps);

  if (fixture.handoffData) {
    queue.cursor = 1;
  }

  return queue;
}

// ---------------------------------------------------------------------------
// Test workdir — isolate test step execution from the project directory
// ---------------------------------------------------------------------------

export interface TestWorkdir {
  /** Absolute path to the temp working directory. */
  path: string;
  /** Remove the temp directory and all its contents. */
  cleanup: () => void;
}

/**
 * Create a temp working directory for test step execution.
 *
 * Copies `flywheel.toml` from the project root so the worker has config,
 * but any files created by the worker land in the temp dir instead of
 * polluting the real project.
 */
export function createTestWorkdir(projectCwd: string): TestWorkdir {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "flywheel-test-"));
  const configSrc = path.join(projectCwd, "flywheel.toml");
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, path.join(dir, "flywheel.toml"));
  }
  log.info("created test workdir", { path: dir });
  return {
    path: dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        log.info("cleaned up test workdir", { path: dir });
      } catch {
        log.warn("failed to clean up test workdir", { path: dir });
      }
    },
  };
}
