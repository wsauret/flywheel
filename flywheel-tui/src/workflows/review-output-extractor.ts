/**
 * ReviewOutputExtractor — reads P3 findings from worker handoff and
 * provides an onStepComplete hook for interactive P3 triage.
 *
 * Handoff is the ONLY path. No fallback to stdout parsing.
 *
 * Three modes:
 *   1. interactive + user picks items → p3Triage: { included, excluded, source: "user" }
 *   2. interactive + user dismisses → p3Triage: { directive: REVIEW_P3_DIRECTIVE }
 *   3. non-interactive → p3Triage: { directive: REVIEW_P3_DIRECTIVE }
 *
 * Returns empty object when no P3 findings in handoff (Decision #9).
 */

import type { WorkerResult } from "../schemas/worker";
import type { OnStepCompleteHook } from "../controller/execution-loop";
import type { QuestionInfo } from "../controller/question-service";
import { Log } from "../utils/log";

const log = Log.create({ service: "review-hook" });
import {
  QuestionRejectedError,
  type QuestionService,
} from "../controller/question-service";
import { readHandoff } from "../handoff/reader";
import { WorkerHandoffSchema } from "../schemas/handoff";
import type {
  P3Finding as HandoffP3Finding,
  FindingCounts as HandoffFindingCounts,
} from "../schemas/handoff";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The multi-agent review step index in the review workflow (0-based). */
export const REVIEW_MULTI_AGENT_STEP_INDEX = 1;

/** The consolidation step index in the review workflow (0-based). */
export const REVIEW_CONSOLIDATION_STEP_INDEX = 2;

/** The fix/implementation step index in the review workflow (0-based). */
export const REVIEW_FIX_STEP_INDEX = 3;

/** Directive sent when P3 findings are auto-included (non-interactive or dismissed). */
export const REVIEW_P3_DIRECTIVE = "include-non-cosmetic" as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface P3Finding {
  title: string;
  summary: string;
  location: string;
}

export interface FindingCounts {
  p1: number;
  p2: number;
  p3: number;
}

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/** Options for the review onStepComplete hook factory. */
export interface ReviewHookOptions {
  /** QuestionService instance for interactive triage flow. */
  questionService?: QuestionService;
  /** When true, P3 triage is presented to the user via QuestionService. */
  interactive?: boolean;
}

/**
 * Map handoff P3Finding to local P3Finding.
 * Handoff has: { description, location?, suggestion }
 * Local has: { title, summary, location }
 */
function mapHandoffP3Findings(handoffFindings: HandoffP3Finding[]): P3Finding[] {
  return handoffFindings.map((hf) => ({
    title: hf.description.length > 60
      ? hf.description.slice(0, 60).replace(/\s+\S*$/, "")
      : hf.description,
    summary: hf.suggestion,
    location: hf.location ?? "",
  }));
}

/**
 * Handle P3 findings from the multi-agent review step.
 *
 * Three modes:
 *   1. interactive + questionService + user picks → p3Triage: { included, excluded, source: "user" }
 *   2. interactive + user dismisses (QuestionRejectedError) → p3Triage: { directive }
 *   3. non-interactive → p3Triage: { directive }
 *
 * Reads from worker handoff only. No fallback to stdout parsing.
 * Returns empty object when no P3 findings (Decision #9).
 */
async function handleP3Triage(
  result: WorkerResult,
  options: ReviewHookOptions,
): Promise<Record<string, unknown>> {
  let p3Findings: P3Finding[] = [];

  if (result.handoffPath) {
    try {
      const handoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
      if (handoff.p3_findings && handoff.p3_findings.length > 0) {
        p3Findings = mapHandoffP3Findings(handoff.p3_findings);
        log.info("read p3_findings from handoff", { count: p3Findings.length });
      }
    } catch (err) {
      log.warn("handoff read failed for p3_findings, returning empty", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  // No P3 findings → nothing to do (omit p3Triage key per Decision #9)
  if (p3Findings.length === 0) {
    return {};
  }

  const { questionService, interactive } = options;

  // Non-interactive path: auto-include with directive
  if (!interactive || !questionService) {
    return {
      p3Triage: { directive: REVIEW_P3_DIRECTIVE },
    };
  }

  // Interactive path: present single multi-select question
  try {
    const questions: QuestionInfo[] = [
      {
        question: "Which P3 findings should be included in the review?",
        header: "P3 Triage",
        options: p3Findings.map((f) => ({
          label: f.title,
          description: `${f.location}: ${f.summary}`.replace(/^:\s*/, ""),
        })),
        multiple: true,
        custom: false,
      },
    ];

    const answers = await questionService.ask(questions);
    const selectedLabels = new Set(answers[0] ?? []);
    const included = p3Findings.filter((f) => selectedLabels.has(f.title));
    const excluded = p3Findings.filter((f) => !selectedLabels.has(f.title));

    return {
      p3Triage: { included, excluded, source: "user" },
    };
  } catch (err) {
    if (err instanceof QuestionRejectedError) {
      // User dismissed — auto-include with directive
      return {
        p3Triage: { directive: REVIEW_P3_DIRECTIVE },
      };
    }
    // Unexpected error — re-throw to outer catch
    throw err;
  }
}

/**
 * Create an `onStepComplete` hook for the review workflow.
 *
 * After the multi-agent review step (step 1), reads P3 findings from
 * handoff and either presents them for interactive triage or auto-includes
 * them with a directive.
 *
 * After the consolidation step (step 2), reads review file path and
 * finding counts from handoff.
 *
 * Handoff is the only path. No fallback to stdout parsing.
 *
 * @param options - Question service and interactive flag
 * @returns An OnStepCompleteHook suitable for ExecutionLoop
 */
export function createReviewOnStepComplete(
  options?: ReviewHookOptions,
): OnStepCompleteHook {
  const hookOptions: ReviewHookOptions = options ?? {};

  return async (
    stepIndex: number,
    result: WorkerResult,
    _accumulatedExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    // Multi-agent review step: P3 triage
    if (stepIndex === REVIEW_MULTI_AGENT_STEP_INDEX) {
      try {
        return await handleP3Triage(result, hookOptions);
      } catch (err) {
        log.error("unexpected error handling P3 triage", { error: err instanceof Error ? err : String(err) });
        return {};
      }
    }

    // Consolidation step: extract file path and finding counts
    if (stepIndex === REVIEW_CONSOLIDATION_STEP_INDEX) {
      try {
        let reviewFilePath: string | undefined;
        let findingCounts: FindingCounts = { p1: 0, p2: 0, p3: 0 };

        // Read from handoff
        if (result.handoffPath) {
          try {
            const handoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);

            if (handoff.review_file_path) {
              reviewFilePath = handoff.review_file_path;
              log.info("read review_file_path from handoff", { reviewFilePath });
            }

            if (handoff.finding_counts) {
              findingCounts = {
                p1: handoff.finding_counts.p1_critical,
                p2: handoff.finding_counts.p2_important,
                p3: handoff.finding_counts.p3_suggestion,
              };
              log.info("read finding_counts from handoff", { findingCounts });
            }
          } catch (err) {
            log.warn("handoff read failed for consolidation, returning zeros", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        const hasActionableFindings =
          findingCounts.p1 + findingCounts.p2 > 0;

        return { reviewFilePath, findingCounts, hasActionableFindings };
      } catch (err) {
        log.error("unexpected error handling consolidation", { error: err instanceof Error ? err : String(err) });
        return {};
      }
    }

    return {};
  };
}
