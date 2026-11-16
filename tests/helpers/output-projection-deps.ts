import type { OutputProjectionDeps } from "../../src/orchestration/app-service/output-projection.js"

/** The output projection's collaborators that a test does not exercise, each
 *  quiet: a block projects to itself, no fact is stored, no continuation
 *  retires, and no kept command streams. A test spreads this first and states
 *  the collaborators it asserts on after it. */
export function quietOutputCollaborators(): Pick<OutputProjectionDeps, "projectBlock" | "onStored" | "onContinuationRetired" | "keptOutput"> {
  return {
    projectBlock: async (_sessionId, block) => block,
    onStored: () => () => {},
    onContinuationRetired: () => () => {},
    keptOutput: { liveOutput: () => ({}) },
  }
}
