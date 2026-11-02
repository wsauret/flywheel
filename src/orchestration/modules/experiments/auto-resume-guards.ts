import type { ExperimentRun } from "./types.js";

const AUTO_RESUME_TURN_LIMIT = 200;
const CONSECUTIVE_FAILURE_OVERRIDE_LIMIT = 20;

interface AutoResumeGuardState {
  results: ExperimentRun[];
  currentSegment: number;
}

interface AutoResumeGuardRuntime {
  autoResumeTurns: number;
  state: AutoResumeGuardState;
}

export function countConsecutiveDiscardOrCrashRuns(state: AutoResumeGuardState): number {
  let count = 0;
  for (const result of state.results.toReversed()) {
    if (result.segment !== state.currentSegment) break;
    if (result.status === "discard" || result.status === "crash") {
      count++;
      continue;
    }
    break;
  }
  return count;
}

export function autoResumeStopReasonFor(runtime: AutoResumeGuardRuntime): string | null {
  if (runtime.autoResumeTurns >= AUTO_RESUME_TURN_LIMIT) {
    return `Experiment auto-resume limit reached (${AUTO_RESUME_TURN_LIMIT} turns)`;
  }
  const failures = countConsecutiveDiscardOrCrashRuns(runtime.state);
  if (failures > CONSECUTIVE_FAILURE_OVERRIDE_LIMIT) {
    return `Experiment auto-resume stopped: ${failures} consecutive discards/crashes`;
  }
  return null;
}
