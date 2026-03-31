import {
  sessionDir,
  resolveSessionFile,
  buildWorkerHandoffPath,
} from "../../config/paths";

export interface StepPaths {
  /** Relative session-scoped path to plan.json (for scaffolding prompts). */
  readonly planPath: string;
  /** Relative session-scoped path to research.md. */
  readonly researchPath: string;
  /** Relative session-scoped path to review.md. */
  readonly reviewPath: string;
  /** Resolve an absolute handoff path for a step. */
  handoffPath(stepType: string, stepId: string): string;
  /** Resolve absolute path to plan.json. */
  readonly absolutePlanPath: string;
  /** The session ID these paths are scoped to. */
  readonly sessionId: string;
  /** The project base directory. */
  readonly baseDir: string;
}

export function createStepPaths(sessionId: string, baseDir: string): StepPaths {
  const sessDir = sessionDir(sessionId);

  return {
    sessionId,
    baseDir,
    planPath: `${sessDir}/plan.json`,
    researchPath: `${sessDir}/research.md`,
    reviewPath: `${sessDir}/review.md`,
    absolutePlanPath: resolveSessionFile(sessionId, "plan", baseDir),
    handoffPath(stepType: string, stepId: string): string {
      return buildWorkerHandoffPath(sessionId, stepType, stepId, baseDir);
    },
  };
}
