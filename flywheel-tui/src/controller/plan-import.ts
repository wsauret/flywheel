/**
 * Plan import service.
 *
 * Orchestrates plan ingestion from a file path or pasted text.
 * Validates via PlanJsonSchema and maps steps to PlanImportStep[].
 *
 * The content hash (SHA-256) can be stored in session JSON for plan
 * change detection between sessions.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  parseJsonPlan,
  type PlanJson,
  type PlanStep,
  type BehavioralAssertion,
} from "./plan-json-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A step in an imported plan, mapped from either JSON or markdown format. */
export interface PlanImportStep {
  /** Short action title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Testable pass/fail criteria. */
  acceptanceCriteria: string[];
  /** Files to create or modify. */
  fileReferences?: string[];
  /** Feature grouping. */
  feature?: string;
  /** Behavioral contract assertion IDs. */
  fulfills?: string[];
  /** Milestone grouping. */
  milestone?: string;
  /** Estimated complexity. */
  estimatedComplexity?: string;
}

export interface PlanImportResult {
  status: "ready" | "needs-fix";
  /** Structured steps from JSON plan. */
  steps: PlanImportStep[];
  /** Behavioral contract assertions from JSON plan. */
  behavioralContract: BehavioralAssertion[];
  /** Architectural decisions from JSON plan. */
  decisions: string[];
  /** Identified risks from JSON plan. */
  risks: string[];
  issues: string[];
  summary: {
    stepCount: number;
    totalSteps: number;
    hasAcceptanceCriteria: boolean;
    contentHash: string;
  };
  /** Whether this was imported from a JSON plan. */
  isJsonPlan: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Import a plan from either a file path or raw text content.
 *
 * @param source - Raw plan text (string) or `{ filePath: string }` to read from disk
 * @returns PlanImportResult with status, steps, issues, and summary
 */
export async function importPlan(
  source: string | { filePath: string },
): Promise<PlanImportResult> {
  const rawContent = await resolveContent(source);
  return importJsonPlan(rawContent);
}

// ---------------------------------------------------------------------------
// JSON plan import
// ---------------------------------------------------------------------------

function importJsonPlan(rawContent: string): PlanImportResult {
  const contentHash = crypto
    .createHash("sha256")
    .update(rawContent)
    .digest("hex");

  const result = parseJsonPlan(rawContent);

  if (!result.ok) {
    return {
      status: "needs-fix",
      steps: [],
      behavioralContract: [],
      decisions: [],
      risks: [],
      issues: [`JSON plan validation failed: ${result.error}`],
      summary: {
        stepCount: 0,
        totalSteps: 0,
        hasAcceptanceCriteria: false,
        contentHash,
      },
      isJsonPlan: true,
    };
  }

  const plan = result.plan;
  const steps = mapJsonSteps(plan);

  return {
    status: "ready",
    steps,
    behavioralContract: plan.behavioralContract,
    decisions: plan.decisions,
    risks: plan.risks,
    issues: [],
    summary: {
      stepCount: steps.length,
      totalSteps: steps.reduce(
        (sum, s) => sum + s.acceptanceCriteria.length,
        0,
      ),
      hasAcceptanceCriteria: steps.every(
        (s) => s.acceptanceCriteria.length > 0,
      ),
      contentHash,
    },
    isJsonPlan: true,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveContent(
  source: string | { filePath: string },
): Promise<string> {
  if (typeof source === "string") {
    return source;
  }
  return fs.readFileSync(source.filePath, "utf-8");
}

/**
 * Map JSON PlanStep[] to PlanImportStep[].
 */
function mapJsonSteps(plan: PlanJson): PlanImportStep[] {
  return plan.steps.map((step) => ({
    title: step.title,
    description: step.description,
    acceptanceCriteria: step.acceptanceCriteria,
    fileReferences: step.fileReferences,
    feature: step.feature,
    fulfills: step.fulfills,
    milestone: step.milestone,
    estimatedComplexity: step.estimatedComplexity,
  }));
}
