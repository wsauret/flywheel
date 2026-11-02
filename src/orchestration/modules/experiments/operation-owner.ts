import type { InFlightRecord, InFlightWrite } from "../../../infra/event-store-types.js"

export const EXPERIMENT_OPERATION_KIND = "experiment.operation"
export const EXPERIMENT_GIT_SETTLEMENT_KIND = "experiment.git_settlement"
const EXPERIMENT_OPERATION_KEY = "run"

export const experimentInterruptionMessage = "Experiment work was interrupted with an unresolved operation. Inspect the experiment worktree and in-flight checkpoint manually. The runtime will not rerun, revert, commit, or discard it automatically."

interface ExperimentOperationOwnerDependencies {
  readonly listInFlight: (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>
  readonly putInFlight: (kind: string, key: string, payload: unknown) => Promise<void>
}

export interface ExperimentOperationOwner {
  blocker(): Promise<string | undefined>
  begin(command: string, cwd: string): Promise<void>
  interrupt(): void
  retirement(): readonly InFlightWrite[]
  complete(): void
}

/** Owns the one durable record-before-command marker for a live experiment run. */
export function createExperimentOperationOwner(deps: ExperimentOperationOwnerDependencies): ExperimentOperationOwner {
  // Read on first use, so a runner that never runs an experiment reads
  // nothing, and every rejection reaches the tool call that awaits it. Every
  // tool asks before this owner writes its own row, so the first read still
  // sees only what the runner opened with. A failed read is retried at the
  // next use, so one refused read does not block experiments for the runner.
  let atOpen: Promise<boolean> | undefined
  const interruptedAtOpen = (): Promise<boolean> => {
    atOpen ??= deps.listInFlight([
      EXPERIMENT_OPERATION_KIND,
      EXPERIMENT_GIT_SETTLEMENT_KIND,
    ]).then((rows) => rows.length > 0, (error: unknown) => {
      atOpen = undefined
      throw error
    })
    return atOpen
  }
  let active = false
  let interrupted = false

  return {
    blocker: async () => interrupted || await interruptedAtOpen() ? experimentInterruptionMessage : undefined,
    async begin(command, cwd) {
      const blocked = interrupted || await interruptedAtOpen()
      if (blocked || active) throw new Error(blocked ? experimentInterruptionMessage : "Experiment execution is not idle.")
      await deps.putInFlight(EXPERIMENT_OPERATION_KIND, EXPERIMENT_OPERATION_KEY, {
        state: "running",
        command,
        cwd,
      })
      active = true
    },
    interrupt() {
      if (active) interrupted = true
    },
    retirement: () => active
      ? [{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: EXPERIMENT_OPERATION_KEY }]
      : [],
    complete() {
      active = false
      interrupted = false
    },
  }
}

/** Reports unresolved experiment work without mutating or interpreting it. */
export function findExperimentInterruption(
  listInFlight: (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>,
): Promise<string | undefined> {
  return listInFlight([EXPERIMENT_OPERATION_KIND, EXPERIMENT_GIT_SETTLEMENT_KIND]).then((rows) => rows.length > 0
    ? experimentInterruptionMessage
    : undefined)
}
