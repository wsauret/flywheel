import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createQueue } from "../workflows/queue/queue.js";
import type { Queue, Step } from "../workflows/queue/types.js";
import { ensureSessionDir, resolveSessionFile } from "../infra/paths.js";
import { Log } from "../infra/log.js";
import { errorMessage } from "../infra/error-message.js";

const log = Log.create({ service: "test-step" });

interface TestStepDef {
  label: string;
  id: string;
  type: Step["type"];
  title: string;
  dispatcherHint?: string;
  evaluationCriteria?: string;
  toolScoping?: Step["toolScoping"];
  fixtureDir: string;
  needsPlan: boolean;
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

interface FixtureSetupResult {
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
      } catch (err) {
        log.warn("invalid fixture handoff JSON", { path: fixtureHandoff, error: errorMessage(err) })
      }
    }
  }

  return { planPath, handoffData };
}

export function buildTestQueue(
  stepDef: TestStepDef,
  fixture: FixtureSetupResult,
): Queue {
  const steps: Step[] = [];

  if (fixture.handoffData) {
    steps.push({
      id: randomUUID(),
      type: "work",
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

interface TestWorkdir {
  path: string;
  cleanup: () => void;
}

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
      } catch (err) {
        log.warn("failed to clean up test workdir", { path: dir, error: errorMessage(err) });
      }
    },
  };
}
