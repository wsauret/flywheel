/**
 * PlanOutputExtractor — extracts plan file paths and open questions from
 * worker handoff data.
 *
 * Handoff is the ONLY path. No fallback parsing of stdout.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkerResult } from "../schemas/worker";
import { Log } from "../utils/log";
import type { OnStepCompleteHook } from "./types";

const log = Log.create({ service: "plan-hook" });
import {
  QuestionRejectedError,
  type QuestionService,
  type OpenQuestion,
  type ResolvedQuestion,
} from "../controller/question-service";
import { readHandoff } from "../handoff/reader";
import { WorkerHandoffSchema } from "../schemas/handoff";
import type { OpenQuestion as HandoffOpenQuestion } from "../schemas/handoff";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Directive sent to consolidation when open questions are forwarded unresolved. */
export const PLAN_QUESTION_DIRECTIVE = "resolve-best-judgment" as const;

/** File extension for JSON-native plan files (ADR-004 Decision 5). */
export const JSON_PLAN_EXTENSION = ".plan.json";

// ---------------------------------------------------------------------------
// Hook factory
// ---------------------------------------------------------------------------

/** The review step index in the plan workflow (0-based). */
const REVIEW_STEP_INDEX = 2;

/** The consolidation step index in the plan workflow (0-based). */
const CONSOLIDATION_STEP_INDEX = 3;

/** Options for the plan onStepComplete hook factory. */
export interface PlanHookOptions {
  /** QuestionService instance for interactive question flow. */
  questionService?: QuestionService;
  /** When true, questions are presented to the user via QuestionService. */
  interactive?: boolean;
}

/**
 * Map handoff OpenQuestion (from schema) to local OpenQuestion.
 * Handoff has: { question, options: string[], header? }
 * Local has: { question, header, options: QuestionOption[] }
 */
function mapHandoffQuestions(handoffQuestions: HandoffOpenQuestion[]): OpenQuestion[] {
  return handoffQuestions.map((hq) => ({
    question: hq.question,
    header: hq.header ?? hq.question.slice(0, 30),
    options: hq.options.map((opt) => ({ label: opt, description: "" })),
  }));
}

/**
 * Handle open questions from the review step.
 *
 * Three modes:
 *   1. interactive + questionService → ask user, return resolvedQuestions with source: "user"
 *   2. interactive + user dismisses (QuestionRejectedError) → return unresolvedQuestions + directive
 *   3. non-interactive (no questionService or interactive=false) → return unresolvedQuestions + directive
 *
 * Reads from worker handoff only. No fallback to stdout parsing.
 * Returns empty object when handoff has no questions or read fails.
 */
async function handleReviewQuestions(
  result: WorkerResult,
  options: PlanHookOptions,
): Promise<Record<string, unknown>> {
  let openQuestions: OpenQuestion[] = [];

  if (result.handoffPath) {
    try {
      const handoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
      if (handoff.open_questions && handoff.open_questions.length > 0) {
        openQuestions = mapHandoffQuestions(handoff.open_questions);
        log.info("read open_questions from handoff", { count: openQuestions.length });
      }
    } catch (err) {
      log.warn("handoff read failed for open_questions, returning empty", {
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  // No questions → nothing to do
  if (openQuestions.length === 0) {
    return {};
  }

  const { questionService, interactive } = options;

  // Non-interactive path: forward questions as unresolved with directive
  if (!interactive || !questionService) {
    return {
      unresolvedQuestions: openQuestions,
      questionDirective: PLAN_QUESTION_DIRECTIVE,
    };
  }

  // Interactive path: ask the user
  try {
    const answers = await questionService.ask(
      openQuestions.map((q) => ({ ...q, custom: true })),
    );
    // Map answers to ResolvedQuestion[] with source: "user"
    const resolvedQuestions: ResolvedQuestion[] = openQuestions.map((q, i) => ({
      question: q.question,
      answers: answers[i] ?? [],
      source: "user" as const,
    }));
    return { resolvedQuestions };
  } catch (err) {
    if (err instanceof QuestionRejectedError) {
      // User dismissed — forward as unresolved
      return {
        unresolvedQuestions: openQuestions,
        questionDirective: PLAN_QUESTION_DIRECTIVE,
      };
    }
    // Unexpected error — don't abort queue
    throw err;
  }
}

/**
 * Create an `onStepComplete` hook for the plan workflow.
 *
 * After the review step (step 2), handles open questions from handoff.
 * After the consolidation step (step 3), reads plan_file_path from handoff.
 *
 * Handoff is the only path. No fallback parsing of stdout.
 *
 * @param projectCwd - The project root directory (for disk verification)
 * @param options - Optional question service and interactive flag.
 * @returns An OnStepCompleteHook for step completion handling
 */
export function createPlanOnStepComplete(
  projectCwd: string,
  options?: PlanHookOptions,
): OnStepCompleteHook {
  const hookOptions: PlanHookOptions = options ?? {};

   return async (
    stepIndex: number,
    result: WorkerResult,
    _accumulatedExtra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    // After the review step: handle open questions
    if (stepIndex === REVIEW_STEP_INDEX) {
      try {
        return await handleReviewQuestions(result, hookOptions);
      } catch (err) {
        log.error("unexpected error handling review questions", { error: err instanceof Error ? err : String(err) });
        return {};
      }
    }

    // Only extract plan file on the consolidation step
    if (stepIndex !== CONSOLIDATION_STEP_INDEX) {
      return {};
    }

    // Read plan_file_path from handoff
    if (result.handoffPath) {
      try {
        const handoff = await readHandoff(result.handoffPath, WorkerHandoffSchema);
        if (handoff.plan_file_path) {
          // Resolve relative paths against projectCwd
          const resolvedPath = path.isAbsolute(handoff.plan_file_path)
            ? handoff.plan_file_path
            : path.join(projectCwd, handoff.plan_file_path);
          try {
            await fs.access(resolvedPath);
            const planFileName = path.basename(resolvedPath);
            log.info("read plan_file_path from handoff", { planFilePath: resolvedPath });
            return { planFilePath: resolvedPath, planFileName };
          } catch {
            log.warn("handoff plan_file_path does not exist on disk", {
              path: resolvedPath,
            });
          }
        }
      } catch (err) {
        log.warn("handoff read failed for plan_file_path", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { planFileWarning: "Could not locate plan file on disk after consolidation" };
  };
}
