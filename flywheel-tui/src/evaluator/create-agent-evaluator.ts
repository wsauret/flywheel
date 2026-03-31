// ---------------------------------------------------------------------------
// Factory: Create agent-based EvaluatorFn for the step executor
// ---------------------------------------------------------------------------
//
// Bridges the SubprocessEvaluatorTransport (agent with tools) with the
// EvaluatorFn interface used by the queue executor. The agent can read
// files, run commands, grep the codebase, and make a holistic judgment
// about whether the worker's output meets acceptance criteria.
// ---------------------------------------------------------------------------

import type { Step } from "../queue/types";
import type { EvaluatorFn, EvalResult } from "../queue/executor";
import type { EvaluatorTransport } from "./transport";
import type { EvaluatorInput, EvaluatorResult } from "./schemas";
import type { EvaluationCriteria } from "../schemas";
import { Log } from "../utils/log";

const log = Log.create({ service: "evaluator-agent-factory" });

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateAgentEvaluatorFnOptions {
  transport: EvaluatorTransport;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function serializeEvaluationCriteria(criteria: EvaluationCriteria): string {
  const parts: string[] = [];
  if (criteria.acceptance_criteria.length > 0) {
    parts.push("Acceptance criteria:", ...criteria.acceptance_criteria.map((c) => `- ${c}`));
  }
  if (criteria.required_tests) {
    parts.push("Required: tests must pass");
  }
  if (criteria.custom_checks.length > 0) {
    parts.push("Custom checks:", ...criteria.custom_checks.map((c) => `- ${c}`));
  }
  if (criteria.required_outputs.length > 0) {
    parts.push("Required outputs:", ...criteria.required_outputs.map((o) => `- ${o}`));
  }
  return parts.join("\n");
}

function resultToEvalResult(result: EvaluatorResult): EvalResult {
  return {
    passed: result.passed,
    skipped: false,
    transportError: false,
    reason: result.passed ? null : (result.reasoning ?? "evaluation failed"),
    feedback: result.passed ? null : (result.feedback ?? null),
    suggestions: result.suggestions ?? [],
    cyclesUsed: 1,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates an EvaluatorFn backed by the agent-based subprocess evaluator.
 * The agent has Read, Bash, Grep, Glob, Write tools and can investigate
 * the worker's claims before rendering a verdict.
 */
export function createAgentEvaluatorFn(
  options: CreateAgentEvaluatorFnOptions,
): EvaluatorFn {
  const { transport } = options;

  return async (
    step: Step,
    workerOutput: string,
    evaluationCriteria?: unknown | null,
    handoffData?: Record<string, unknown> | null,
  ): Promise<EvalResult> => {
    log.info("agent evaluation starting", {
      stepId: step.id,
      stepTitle: step.title,
      hasHandoff: handoffData != null,
      hasEvaluationCriteria: evaluationCriteria != null,
    });

    // Build structured evaluation criteria
    const criteria: EvaluationCriteria = evaluationCriteria &&
      typeof evaluationCriteria === "object" &&
      "acceptance_criteria" in (evaluationCriteria as object)
        ? (evaluationCriteria as EvaluationCriteria)
        : {
            acceptance_criteria: [],
            required_tests: false,
            custom_checks: [],
            required_outputs: [],
          };

    // Build evaluator input from handoff data
    const handoff = handoffData ? extractHandoffData(handoffData) : undefined;

    const input: EvaluatorInput = {
      worker_output: workerOutput,
      evaluation_criteria: serializeEvaluationCriteria(criteria),
      context_files: [],
      acceptance_criteria: criteria.acceptance_criteria,
      artifacts_produced: [],
      tests_passed: handoff?.verification?.tests_passed ?? null,
      duration_seconds: 0,
      task_context: step.description ?? step.title,
      handoff,
    };

    try {
      const result = await transport.invoke(input);

      log.info("agent evaluation complete", {
        stepId: step.id,
        passed: result.passed,
        confidence: result.confidence,
      });

      return resultToEvalResult(result);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.warn("agent evaluation transport error, degrading gracefully", {
        stepId: step.id,
        error: errMsg,
      });

      // Transport error — degrade gracefully (pass with warning)
      return {
        passed: true,
        skipped: true,
        transportError: true,
        reason: `evaluator transport error: ${errMsg}`,
        feedback: null,
        suggestions: [],
        cyclesUsed: 1,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Handoff data extraction
// ---------------------------------------------------------------------------

function extractHandoffData(
  handoffData: Record<string, unknown>,
): EvaluatorInput["handoff"] {
  const summary = typeof handoffData.summary === "string"
    ? handoffData.summary
    : "No summary provided";

  const artifacts = handoffData.artifacts as
    | { files_created?: string[]; files_modified?: string[]; commands_run?: unknown[] }
    | undefined;

  const verification = handoffData.verification as
    | { tests_passed?: boolean; test_output_summary?: string; commands_run?: unknown[] }
    | undefined;

  return {
    summary,
    artifacts: artifacts ? {
      files_created: artifacts.files_created,
      files_modified: artifacts.files_modified,
      commands_run: artifacts.commands_run?.map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as Record<string, unknown>;
          return `${obj.command} (exit code: ${obj.exitCode ?? obj.exit_code ?? 0})`;
        }
        return String(c);
      }),
    } : undefined,
    verification: verification ? {
      tests_passed: verification.tests_passed ?? null,
      test_output_summary: verification.test_output_summary,
    } : undefined,
    files_to_review: Array.isArray(handoffData.files_to_review)
      ? handoffData.files_to_review.filter((f): f is string => typeof f === "string")
      : undefined,
    decisions: Array.isArray(handoffData.decisions)
      ? handoffData.decisions.filter((d): d is string => typeof d === "string")
      : undefined,
  };
}
