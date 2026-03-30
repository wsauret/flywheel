// ---------------------------------------------------------------------------
// Test Step — run a single step type in isolation with fixture data
// ---------------------------------------------------------------------------
//
// Provides:
//   - TEST_STEPS: all available step types with metadata
//   - buildTestQueue(): creates a 1-step queue with seeded predecessor
//   - setupTestFixture(): copies plan/handoff files to .flywheel/
//
// Used by the /test command to iterate on individual step types without
// waiting for a full pipeline to reach that step.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { createQueue } from "../../queue/queue";
import type { Queue, Step } from "../../queue/types";
import { ensureSessionDir, resolveSessionFile } from "../../config/paths";

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
  // ── Plan sub-steps ──
  {
    label: "Plan: Research codebase",
    id: "plan-research",
    type: "plan",
    title: "Research codebase",
    dispatcherHint: "research",
    evaluationCriteria: "Produces a .context.md with file references and architectural summary",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "plan-research",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Plan: Draft implementation plan",
    id: "plan-draft",
    type: "plan",
    title: "Draft implementation plan",
    dispatcherHint: "draft",
    evaluationCriteria: "Produces a structured JSON plan with steps, behavioralContract, decisions, and risks",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "plan-draft",
    needsPlan: false,
    needsHandoff: true,
  },
  {
    label: "Plan: Review plan",
    id: "plan-review",
    type: "plan",
    title: "Review plan",
    dispatcherHint: "review",
    evaluationCriteria: "Produces annotated JSON with review findings and open questions without modifying draft fields",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "plan-review",
    needsPlan: true,
    needsHandoff: true,
  },
  {
    label: "Plan: Consolidate findings",
    id: "plan-consolidate",
    type: "plan",
    title: "Consolidate findings",
    dispatcherHint: "consolidate",
    evaluationCriteria: "Produces clean JSON plan with findings incorporated and review annotations stripped",
    fixtureDir: "plan-consolidate",
    needsPlan: true,
    needsHandoff: true,
  },
  // ── Work ──
  {
    label: "Work: Execute step",
    id: "work",
    type: "work",
    title: "Execute work",
    fixtureDir: "work",
    needsPlan: true,
    needsHandoff: true,
  },
  // ── Review sub-steps ──
  {
    label: "Review: Multi-agent code review",
    id: "review-dispatch",
    type: "review",
    title: "Multi-agent code review",
    dispatcherHint: "dispatch-reviewers",
    evaluationCriteria: "Dispatches multiple review agents and produces a consolidated review document",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "review-dispatch",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Review: Consolidate findings",
    id: "review-consolidate",
    type: "review",
    title: "Consolidate review findings",
    dispatcherHint: "consolidate-review",
    evaluationCriteria: "Produces a prioritized list of findings with severity levels",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "review-consolidate",
    needsPlan: false,
    needsHandoff: true,
  },
  // ── Ship sub-steps ──
  {
    label: "Ship: Stage changes",
    id: "ship-stage",
    type: "ship",
    title: "Stage changes",
    dispatcherHint: "stage",
    evaluationCriteria: "All relevant changes staged for commit",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "ship-stage",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Ship: Create commit",
    id: "ship-commit",
    type: "ship",
    title: "Create commit",
    dispatcherHint: "commit",
    evaluationCriteria: "Commit created with descriptive message",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "ship-commit",
    needsPlan: false,
    needsHandoff: true,
  },
  {
    label: "Ship: Open pull request",
    id: "ship-pr",
    type: "ship",
    title: "Open pull request",
    dispatcherHint: "pr",
    evaluationCriteria: "Pull request opened with description and linked issues",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "ship-pr",
    needsPlan: false,
    needsHandoff: true,
  },
  {
    label: "Ship: Extract learnings",
    id: "ship-learnings",
    type: "ship",
    title: "Extract learnings",
    dispatcherHint: "learnings",
    evaluationCriteria: "Learnings extracted and saved to docs/solutions/",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "ship-learnings",
    needsPlan: false,
    needsHandoff: true,
  },
  // ── Debug sub-steps ──
  {
    label: "Debug: Investigate",
    id: "debug-investigate",
    type: "debug",
    title: "Investigate: gather context, form hypothesis",
    dispatcherHint: "investigate",
    evaluationCriteria: "Root cause hypothesis formed with evidence from error output and codebase analysis",
    fixtureDir: "debug-investigate",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Debug: Fix",
    id: "debug-fix",
    type: "debug",
    title: "Fix: apply minimum change to address root cause",
    dispatcherHint: "fix",
    evaluationCriteria: "Smallest possible fix applied based on hypothesis — one logical change only",
    fixtureDir: "debug-fix",
    needsPlan: false,
    needsHandoff: true,
  },
  {
    label: "Debug: Verify",
    id: "debug-verify",
    type: "debug",
    title: "Verify: run verification command, confirm fix",
    dispatcherHint: "verify",
    evaluationCriteria: "Verification command passes, confirming the fix resolves the issue",
    fixtureDir: "debug-verify",
    needsPlan: false,
    needsHandoff: true,
  },
  // ── Research sub-steps ──
  {
    label: "Research: Locate sources",
    id: "research-locate",
    type: "research",
    title: "Locate relevant sources",
    dispatcherHint: "locate",
    evaluationCriteria: "Relevant files, documentation, and references identified for the research topic",
    fixtureDir: "research-locate",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Research: Analyze sources",
    id: "research-analyze",
    type: "research",
    title: "Analyze located sources for key findings",
    dispatcherHint: "analyze",
    evaluationCriteria: "Patterns, implementation details, and insights extracted from located sources",
    fixtureDir: "research-analyze",
    needsPlan: false,
    needsHandoff: true,
  },
  {
    label: "Research: Persist document",
    id: "research-persist",
    type: "research",
    title: "Persist structured research document",
    dispatcherHint: "persist",
    evaluationCriteria: "Structured research document with YAML frontmatter compiled from findings",
    fixtureDir: "research-persist",
    needsPlan: false,
    needsHandoff: true,
  },
  // ── Sprint ──
  {
    label: "Sprint: Work iteration",
    id: "sprint-work",
    type: "work",
    title: "Sprint work",
    evaluationCriteria: "Implementation complete, ready for verification",
    toolScoping: { read: true, bash: true, write: true, edit: true, task: true },
    fixtureDir: "sprint-work",
    needsPlan: false,
    needsHandoff: false,
  },
  {
    label: "Sprint: Verify changes",
    id: "sprint-verify",
    type: "verify",
    title: "Verify changes",
    evaluationCriteria: "Verification script passes (exit code 0)",
    toolScoping: { read: true, bash: true, write: true, edit: false, task: true },
    fixtureDir: "sprint-verify",
    needsPlan: false,
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

/**
 * Set up fixture files for a test step.
 *
 * - If the step needs a plan, copies plan.json to the session directory
 * - If the step needs a handoff, reads handoff.json from the fixture
 * - Returns paths and data for queue construction
 */
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

  // Copy plan file if needed
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

  // Read handoff fixture if needed
  if (stepDef.needsHandoff) {
    const fixtureHandoff = path.join(fixtureBase, "handoff.json");
    if (fs.existsSync(fixtureHandoff)) {
      try {
        handoffData = JSON.parse(fs.readFileSync(fixtureHandoff, "utf-8"));
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

/**
 * Build a queue for testing a single step type.
 *
 * If the step needs a predecessor (handoff data), a "completed" placeholder
 * step is prepended so the executor sees a natural "previous step".
 */
export function buildTestQueue(
  stepDef: TestStepDef,
  fixture: FixtureSetupResult,
): Queue {
  const steps: Step[] = [];

  // If the step has a predecessor handoff, add a completed placeholder
  if (fixture.handoffData) {
    steps.push({
      id: randomUUID(),
      type: "plan",
      title: "(fixture) Previous step",
      status: "completed",
      // The handoff data is carried via the accumulator, seeded separately
    });
  }

  // The actual step to test
  const testStep: Step = {
    id: randomUUID(),
    type: stepDef.type,
    title: stepDef.title,
    status: "pending",
    dispatcherHint: stepDef.dispatcherHint,
    evaluationCriteria: stepDef.evaluationCriteria,
    toolScoping: stepDef.toolScoping,
  };

  // Add file references from the plan path if available
  if (fixture.planPath) {
    testStep.fileReferences = [fixture.planPath];
  }

  steps.push(testStep);

  const queue = createQueue(steps);

  // If there's a completed predecessor, advance cursor past it
  if (fixture.handoffData) {
    queue.cursor = 1;
  }

  return queue;
}
