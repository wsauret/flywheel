import type { InFlightWrite, StoredFact } from "../../../infra/event-store-types.js"
import type { ExperimentFact, ExperimentRunRecordedFact } from "./facts.js"
import type { ExperimentKeepResult } from "./git-operations.js"
import { EXPERIMENT_OPERATION_RETIREMENT } from "./operation-owner.js"

interface ExperimentGitSettlementDependencies {
  /** The runner's `SessionFactWriter.record`: `null` means nothing was written. */
  readonly record: (fact: ExperimentFact, inFlight?: readonly InFlightWrite[]) => Promise<StoredFact | null>
  readonly transaction?: (publish: () => void) => Promise<void>
  readonly keep: (input: {
    readonly cwd: string
    readonly description: string
    readonly result: ExperimentKeepResult
    readonly measuredTree: string
  }) => Promise<string>
  readonly revert: (cwd: string) => Promise<void>
  readonly head: (cwd: string) => Promise<string>
}

export interface ExperimentGitSettlement {
  /** Keeps or reverts the candidate, then records its run fact with the
   *  retirement of the operation hold. Rejects when Git or the record fails. */
  settle(cwd: string, fact: ExperimentRunRecordedFact, deactivate: boolean, measuredTree: string): Promise<void>
}

/** Settles a run under the operation hold that was durable before
 *  measurement. It runs only inside the operation's settlement, where that
 *  hold is always durable. */
export function createExperimentGitSettlement(
  deps: ExperimentGitSettlementDependencies,
): ExperimentGitSettlement {
  const publishRun = async (fact: ExperimentRunRecordedFact, commit: string): Promise<void> => {
    const stored = await deps.record({
      ...fact,
      payload: { ...fact.payload, commit },
    }, EXPERIMENT_OPERATION_RETIREMENT)
    if (!stored) throw new Error("Experiment run could not be recorded.")
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
    // Inside a transaction `record` queues the fact for the batch and
    // resolves without a stored fact, so its result is not an acknowledgment.
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
      }, EXPERIMENT_OPERATION_RETIREMENT)
    })
  }

  return {
    async settle(cwd, fact, shouldDeactivate, measuredTree) {
      const head = await deps.head(cwd)
      if (fact.payload.status === "keep") {
        const { commit: _, ...result } = fact.payload
        const commit = await deps.keep({
          cwd,
          description: fact.payload.description,
          result,
          measuredTree,
        })
        await publishRunAndDeactivate(fact, commit, shouldDeactivate)
        return
      }
      await deps.revert(cwd)
      await publishRunAndDeactivate(fact, head, shouldDeactivate)
    },
  }
}
