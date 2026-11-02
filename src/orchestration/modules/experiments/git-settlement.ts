import type { InFlightWrite } from "../../../infra/event-store-types.js"
import type { ExperimentFact, ExperimentRunRecordedFact } from "./facts.js"
import type { ExperimentKeepResult } from "./git-operations.js"

interface ExperimentGitSettlementDependencies {
  readonly record: (fact: ExperimentFact, inFlight?: readonly InFlightWrite[]) => Promise<void>
  readonly transaction?: (publish: () => void) => Promise<void>
  readonly retirement: () => readonly InFlightWrite[]
  readonly complete: () => void
  readonly keep: (input: {
    readonly cwd: string
    readonly description: string
    readonly result: ExperimentKeepResult
  }) => Promise<string>
  readonly revert: (cwd: string) => Promise<void>
  readonly head: (cwd: string) => Promise<string>
}

export interface ExperimentGitSettlement {
  settle(cwd: string, fact: ExperimentRunRecordedFact, deactivate?: boolean): Promise<void>
}

/** Settles a run under the operation marker that was durable before measurement. */
export function createExperimentGitSettlement(
  deps: ExperimentGitSettlementDependencies,
): ExperimentGitSettlement {
  const publishRun = async (fact: ExperimentRunRecordedFact, commit: string): Promise<void> => {
    await deps.record({
      ...fact,
      payload: { ...fact.payload, commit },
    }, deps.retirement())
  }

  const publishRunAndDeactivate = async (
    fact: ExperimentRunRecordedFact,
    commit: string,
    shouldDeactivate: boolean,
  ): Promise<void> => {
    if (!shouldDeactivate) {
      await publishRun(fact, commit)
      return
    }
    if (!deps.transaction) throw new Error("Capped experiment settlement requires transaction authority.")
    await deps.transaction(() => {
      void deps.record({
        ...fact,
        payload: { ...fact.payload, commit },
      })
      void deps.record({
        type: "experiment.mode.changed",
        version: 1,
        actor: "flywheel",
        payload: { active: false, workDir: null },
      }, deps.retirement())
    })
  }

  const act = async (cwd: string, head: string, fact: ExperimentRunRecordedFact, shouldDeactivate: boolean): Promise<void> => {
    if (fact.payload.status === "keep") {
      const { commit: _, ...result } = fact.payload
      const commit = await deps.keep({
        cwd,
        description: fact.payload.description,
        result,
      })
      await publishRunAndDeactivate(fact, commit, shouldDeactivate)
      return
    }
    await deps.revert(cwd)
    await publishRunAndDeactivate(fact, head, shouldDeactivate)
  }

  return {
    async settle(cwd, fact, shouldDeactivate = false) {
      const head = await deps.head(cwd)
      await act(cwd, head, fact, shouldDeactivate)
      deps.complete()
    },
  }
}
