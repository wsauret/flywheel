import type { Step } from "../queue/types.js";
import type { EvaluatorFn, EvalResult } from "../queue/executor-types.js";
import type { EvaluatorTransport } from "./transport.js";
import type { EvaluatorInput } from "./schemas.js";
import type { EvaluatorResult } from "../../infra/workflow-types.js";
import type { EvaluationCriteria } from "../../infra/workflow-types.js";
import { serializeEvaluationCriteria } from "../schemas.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";
import { parseRawHandoff } from "../queue/shared/handoff-parse.js";

const log = Log.create({ service: "evaluator-agent-factory" });

// Options

interface CreateAgentEvaluatorFnOptions {
  transport: EvaluatorTransport;
}

// Helpers

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

// Factory

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
    taskContent?: string,
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

    // When handoff exists, skip raw worker output — the structured handoff
    // (summary, artifacts, verification) is sufficient and avoids flooding
    // the evaluator with tens of thousands of tokens of raw NDJSON.
    const input: EvaluatorInput = {
      worker_output: handoff ? "" : workerOutput,
      evaluation_criteria: serializeEvaluationCriteria(criteria),
      acceptance_criteria: criteria.acceptance_criteria,
      tests_passed: handoff?.verification?.tests_passed ?? null,
      task_context: taskContent ?? step.description ?? step.title,
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
      const errMsg = errorMessage(error);
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

// Handoff data extraction — delegates to shared parser

function extractHandoffData(
  handoffData: Record<string, unknown>,
): EvaluatorInput["handoff"] {
  const parsed = parseRawHandoff(handoffData);

  return {
    summary: parsed.summary || "No summary provided",
    artifacts: (parsed.filesCreated.length > 0 || parsed.filesModified.length > 0 || parsed.commandsRun.length > 0) ? {
      files_created: parsed.filesCreated.length > 0 ? parsed.filesCreated : undefined,
      files_modified: parsed.filesModified.length > 0 ? parsed.filesModified : undefined,
      commands_run: parsed.commandsRun.length > 0 ? parsed.commandsRun.map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as Record<string, unknown>;
          return `${obj.command} (exit code: ${obj.exitCode ?? obj.exit_code ?? 0})`;
        }
        return String(c);
      }) : undefined,
    } : undefined,
    verification: parsed.testsPassed !== null || parsed.testOutputSummary ? {
      tests_passed: parsed.testsPassed,
      test_output_summary: parsed.testOutputSummary,
    } : undefined,
    files_to_review: parsed.filesToReview.length > 0 ? parsed.filesToReview : undefined,
    decisions: parsed.decisions.length > 0 ? parsed.decisions : undefined,
  };
}
