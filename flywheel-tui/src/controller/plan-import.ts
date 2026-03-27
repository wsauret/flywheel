/**
 * Plan import service.
 *
 * Orchestrates plan ingestion from either a file path or pasted text.
 * Supports both JSON (.plan.json) and legacy markdown plan formats.
 *
 * For JSON plans: validates via PlanJsonSchema, maps steps to PlanImportStep[].
 * For markdown plans: uses the legacy parsePlan() / validatePlan() path.
 *
 * The content hash (SHA-256) can be stored in session JSON for plan
 * change detection between sessions.
 */

import * as fs from "node:fs";
import * as crypto from "node:crypto";
import {
  validatePlan,
  hasAcceptanceCriteria,
  type PlanPhase,
} from "./plan-parser";
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
  /** @deprecated Use `steps` for JSON plans. Kept for markdown plan compat. */
  phases: PlanPhase[];
  /** Structured steps from JSON plan (empty for markdown plans). */
  steps: PlanImportStep[];
  /** Behavioral contract assertions from JSON plan. */
  behavioralContract: BehavioralAssertion[];
  /** Architectural decisions from JSON plan. */
  decisions: string[];
  /** Identified risks from JSON plan. */
  risks: string[];
  issues: string[];
  summary: {
    phaseCount: number;
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
 * Detects JSON plans by file extension (.plan.json) or content (starts with '{').
 *
 * @param source - Raw plan text (string) or `{ filePath: string }` to read from disk
 * @returns PlanImportResult with status, steps/phases, issues, and summary
 */
export async function importPlan(
  source: string | { filePath: string },
): Promise<PlanImportResult> {
  const rawContent = await resolveContent(source);
  const filePath = typeof source === "object" ? source.filePath : undefined;

  // Detect JSON plan
  const isJson = isJsonPlanContent(rawContent, filePath);

  if (isJson) {
    return importJsonPlan(rawContent);
  }

  return importMarkdownPlan(rawContent);
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
      phases: [],
      steps: [],
      behavioralContract: [],
      decisions: [],
      risks: [],
      issues: [`JSON plan validation failed: ${result.error}`],
      summary: {
        phaseCount: 0,
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
    phases: [], // Empty for JSON plans — use steps instead
    steps,
    behavioralContract: plan.behavioralContract,
    decisions: plan.decisions,
    risks: plan.risks,
    issues: [],
    summary: {
      phaseCount: steps.length,
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
// Markdown plan import (legacy)
// ---------------------------------------------------------------------------

function importMarkdownPlan(rawContent: string): PlanImportResult {
  const content = rawContent.replace(/\r\n/g, "\n");
  const validation = validatePlan(content);

  const contentHash = crypto
    .createHash("sha256")
    .update(content)
    .digest("hex");

  const totalSteps = validation.phases.reduce(
    (sum, phase) => sum + phase.steps.length,
    0,
  );

  const summary = {
    phaseCount: validation.phases.length,
    totalSteps,
    hasAcceptanceCriteria: hasAcceptanceCriteria(content),
    contentHash,
  };

  if (validation.ok) {
    return {
      status: "ready",
      phases: validation.phases,
      steps: [],
      behavioralContract: [],
      decisions: [],
      risks: [],
      issues: [],
      summary,
      isJsonPlan: false,
    };
  }

  return {
    status: "needs-fix",
    phases: validation.phases,
    steps: [],
    behavioralContract: [],
    decisions: [],
    risks: [],
    issues: validation.issues,
    summary,
    isJsonPlan: false,
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
 * Detect if content is a JSON plan by file extension or content inspection.
 */
function isJsonPlanContent(content: string, filePath?: string): boolean {
  if (filePath && filePath.endsWith(".plan.json")) return true;
  const trimmed = content.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}");
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
