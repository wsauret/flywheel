// ---------------------------------------------------------------------------
// Review P3 Triage Hook — Queue Executor Hook
// ---------------------------------------------------------------------------
//
// After the review dispatch step completes, inspects handoff data for P3
// findings. When a QuestionService is available, presents them to the user
// for interactive triage. Otherwise, stores an auto-directive on the step
// for the consolidation step to consume.
//
// Wired into the composite hook in flywheel-shell.tsx alongside
// plan-integration, review-fix-injection, and sprint hooks.
// ---------------------------------------------------------------------------

import type { Step, Queue } from "../../types";
import type { OnStepCompletedHook, OnStepCompletedResult } from "../../shared/hooks";
import { Log } from "../../../utils/log";
import {
  QuestionRejectedError,
  type QuestionService,
  type QuestionInfo,
} from "../../question-service";

const log = Log.create({ service: "review-p3-triage" });

const DISPATCH_HINT = "dispatch-reviewers";
export const REVIEW_P3_DIRECTIVE = "include-non-cosmetic" as const;

interface P3Finding {
  description: string;
  location?: string;
  suggestion: string;
}

export interface ReviewP3TriageOptions {
  questionService?: QuestionService | null;
}

export function createReviewP3TriageHook(
  options: ReviewP3TriageOptions,
): OnStepCompletedHook {
  let triaged = false;

  return async (
    step: Step,
    status: "completed" | "failed",
    _queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    // Only act on completed review dispatch steps
    if (status !== "completed") return { continueExecution: false };
    if (step.type !== "review") return { continueExecution: false };
    if (step.dispatcherHint !== DISPATCH_HINT) return { continueExecution: false };
    if (triaged) return { continueExecution: false };
    if (!handoffData) return { continueExecution: false };

    // Extract P3 findings
    const p3Findings = handoffData.p3_findings as P3Finding[] | undefined;
    if (!p3Findings || !Array.isArray(p3Findings) || p3Findings.length === 0) {
      log.info("no P3 findings in handoff, skipping triage", { stepId: step.id });
      return { continueExecution: false };
    }

    triaged = true;

    const { questionService } = options;
    if (!questionService) {
      // Store auto-directive on the step's extra data
      step.p3Triage = { directive: REVIEW_P3_DIRECTIVE };
      log.info("no QuestionService, auto-triaging P3 findings", { count: p3Findings.length });
      return { continueExecution: false };
    }

    try {
      const questions: QuestionInfo[] = [{
        question: "Which P3 findings should be included in the review?",
        header: "P3 Triage",
        options: p3Findings.map((f) => ({
          label: f.description.length > 60 ? f.description.slice(0, 60).replace(/\s+\S*$/, "") : f.description,
          description: `${f.location ?? ""}: ${f.suggestion}`.replace(/^:\s*/, ""),
        })),
        multiple: true,
        custom: false,
      }];

      const answers = await questionService.ask(questions);
      const selectedLabels = new Set(answers[0] ?? []);
      const included = p3Findings.filter((f) => {
        const label = f.description.length > 60 ? f.description.slice(0, 60).replace(/\s+\S*$/, "") : f.description;
        return selectedLabels.has(label);
      });
      const excluded = p3Findings.filter((f) => !included.includes(f));

      step.p3Triage = { included, excluded, source: "user" };
      log.info("P3 triage completed by user", { included: included.length, excluded: excluded.length });
    } catch (err) {
      if (err instanceof QuestionRejectedError) {
        step.p3Triage = { directive: REVIEW_P3_DIRECTIVE };
        log.info("user dismissed P3 triage, using auto-directive");
      } else {
        log.error("unexpected error during P3 triage", { error: err instanceof Error ? err : String(err) });
      }
    }

    return { continueExecution: false };
  };
}
