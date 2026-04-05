import type { Step, Queue } from "../types";

export interface OnStepCompletedResult {
  continueExecution: boolean;
}

export type OnStepCompletedHook = (
  step: Step,
  status: "completed" | "failed",
  queue: Queue,
  handoffData: Record<string, unknown> | null,
) => Promise<OnStepCompletedResult>;

export function createCompositeHook(
  hooks: Array<OnStepCompletedHook | null | undefined>,
): OnStepCompletedHook {
  const activeHooks = hooks.filter(
    (h): h is OnStepCompletedHook => h != null,
  );

  return async (
    step: Step,
    status: "completed" | "failed",
    queue: Queue,
    handoffData: Record<string, unknown> | null,
  ): Promise<OnStepCompletedResult> => {
    let shouldContinue = false;

    for (const hook of activeHooks) {
      const result = await hook(step, status, queue, handoffData);
      if (result.continueExecution) {
        shouldContinue = true;
      }
    }

    return { continueExecution: shouldContinue };
  };
}
