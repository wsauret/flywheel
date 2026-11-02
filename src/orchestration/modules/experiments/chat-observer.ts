import { formatRuntimeNotification } from "../../agent-runtime/runtime-notifications.js"
import type { AgentStreamEvent } from "../../agent-runtime/types.js"
import type { ExperimentFact } from "./facts.js"
import type { ExperimentSnapshot } from "./projection.js"
import { autoResumeStopReasonFor } from "./auto-resume-guards.js"

const BENCHMARK_GUARDRAIL =
  "Be careful not to overfit to the benchmarks and do not cheat on the benchmarks."

const TURN_RESUME_TEXT = [
  "Run the next iteration now.",
  "Use the persisted experiment state as needed, pick the most promising hypothesis, then call run_experiment + log_experiment.",
  BENCHMARK_GUARDRAIL,
].join(" ")

const COMPACTION_RESUME_TEXT = [
  "Run the next iteration now.",
  "Pick the most promising hypothesis from the ideas backlog or the latest `next:` hints in recent runs, then call run_experiment + log_experiment.",
  "Re-read .experiment/charter.md after compaction and recover the theme ledger, ideas backlog, and prior attempts from the session checkpoint.",
  BENCHMARK_GUARDRAIL,
].join(" ")

export interface ExperimentChatObserverContext {
  readonly replay: () => Promise<ExperimentSnapshot | undefined>
  readonly record: (fact: ExperimentFact) => Promise<void>
  readonly enqueueSilentSystem: (message: string) => void
  readonly showSystemMessage: (message: string) => void
}

export interface ExperimentChatObserver {
  onEvent(event: AgentStreamEvent): void
  onTurnComplete(reason: "turn_end"): Promise<void>
  onCompactionContinuation(): Promise<void>
}

function resumeNotification(reason: "turn_end" | "compaction"): string {
  return formatRuntimeNotification({
    tag: "experiment_resume",
    handling: "Continue the active experiment loop now. Follow the experiment contract and do not ask the user for permission.",
    body: reason === "compaction" ? COMPACTION_RESUME_TEXT : TURN_RESUME_TEXT,
  })
}

function maxIterationsStopReason(snapshot: ExperimentSnapshot): string | null {
  const maximum = snapshot.configuration?.maxIterations
  if (maximum === null || maximum === undefined) return null
  const segment = snapshot.configuration?.segment
  const iterations = snapshot.runs.filter((run) => run.segment === segment).length
  return iterations >= maximum
    ? `Maximum experiments reached (${maximum}). The experiment loop is done.`
    : null
}

/** Continues an active experiment from durable state at chat lifecycle boundaries. */
export function createExperimentChatObserver(
  context: ExperimentChatObserverContext,
): ExperimentChatObserver {
  let ranExperimentThisTurn = false

  async function continueOrStop(reason: "turn_end" | "compaction"): Promise<void> {
    const snapshot = await context.replay()
    if (!snapshot?.mode.active || snapshot.configuration === null) return

    const stopReason = maxIterationsStopReason(snapshot) ?? autoResumeStopReasonFor({
      autoResumeTurns: snapshot.resumedTurns,
      state: {
        results: [...snapshot.runs],
        currentSegment: snapshot.configuration.segment,
      },
    })
    if (stopReason !== null) {
      await context.record({
        type: "experiment.mode.changed",
        version: 1,
        actor: "flywheel",
        payload: { active: false, workDir: snapshot.mode.workDir },
      })
      context.showSystemMessage(stopReason)
      return
    }

    await context.record({
      type: "experiment.resumed",
      version: 1,
      actor: "flywheel",
      payload: { turn: snapshot.resumedTurns + 1, reason },
    })
    context.enqueueSilentSystem(resumeNotification(reason))
  }

  return {
    onEvent(event): void {
      if (event.type === "tool_use" && event.toolName === "run_experiment") {
        ranExperimentThisTurn = true
      }
    },
    async onTurnComplete(reason): Promise<void> {
      const shouldContinue = ranExperimentThisTurn
      ranExperimentThisTurn = false
      if (shouldContinue) await continueOrStop(reason)
    },
    onCompactionContinuation: () => continueOrStop("compaction"),
  }
}
