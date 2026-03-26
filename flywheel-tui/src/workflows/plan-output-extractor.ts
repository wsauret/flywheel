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

/** Legacy hook type retained for backward compatibility. */
type OnStepCompleteHook = (
  stepIndex: number,
  result: WorkerResult,
  accumulatedExtra: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

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

/** File suffixes to exclude from scan results (metadata companions, not actual plans). */
export const EXCLUDED_SUFFIXES = [
  ".context.md",
  ".state.md",
  ".baseline.md",
  ".validation-contract.md",
];

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
    // Unexpected error — don't abort pipeline
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
        // Outer catch: unexpected errors don't abort the pipeline
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
          // Verify file exists on disk (handoff data is LLM-produced, may be wrong)
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

    // Fallback: scan .flywheel/plans/ for recently-modified plan files.
    // Only consider files modified within the last 5 minutes to avoid picking
    // up stale plans from prior sessions.
    const RECENCY_THRESHOLD_MS = 5 * 60 * 1000;
    try {
      const plansDir = path.join(projectCwd, ".flywheel", "plans");
      const entries = await fs.readdir(plansDir).catch(() => [] as string[]);
      const planCandidates = entries.filter(
        (f) =>
          f.endsWith(".md") &&
          !EXCLUDED_SUFFIXES.some((suffix) => f.endsWith(suffix)),
      );

      if (planCandidates.length > 0) {
        // Pick the most recently modified plan file, but only if recent
        const now = Date.now();
        let bestFile: string | null = null;
        let bestMtime = 0;
        for (const f of planCandidates) {
          const stat = await fs.stat(path.join(plansDir, f)).catch(() => null);
          if (stat && stat.mtimeMs > bestMtime && now - stat.mtimeMs < RECENCY_THRESHOLD_MS) {
            bestMtime = stat.mtimeMs;
            bestFile = f;
          }
        }
        if (bestFile) {
          const resolvedPath = path.join(plansDir, bestFile);
          log.info("found plan file via directory scan fallback", { planFilePath: resolvedPath });
          return { planFilePath: resolvedPath, planFileName: bestFile };
        }
      }
    } catch {
      // Scan failed — continue to warning
    }

    // Also scan project root for plan files (worker might write there)
    try {
      const rootEntries = await fs.readdir(projectCwd);
      const rootPlanFiles = rootEntries.filter(
        (f) =>
          f.endsWith(".plan.md") ||
          (f.endsWith(".md") &&
            f.startsWith("plan") &&
            !EXCLUDED_SUFFIXES.some((suffix) => f.endsWith(suffix))),
      );
      if (rootPlanFiles.length > 0) {
        const resolvedPath = path.join(projectCwd, rootPlanFiles[0]);
        log.info("found plan file in project root via fallback scan", { planFilePath: resolvedPath });
        return { planFilePath: resolvedPath, planFileName: rootPlanFiles[0] };
      }
    } catch {
      // Scan failed — continue to warning
    }

    // No plan file found — warn but don't halt the pipeline
    return { planFileWarning: "Could not locate plan file on disk after consolidation" };
  };
}
