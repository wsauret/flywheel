import { join } from "node:path"
import { mkdir } from "node:fs/promises"
import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import { resolveSessionDir, sessionScratchDir } from "../../../infra/paths.js"
import type { SkillRegistryRevision } from "../../../workflows/skill-schema.js"
import type { ModuleRuntimeServices } from "../../agent-runtime/module-runtime-services.js"
import { createInitExperimentTool } from "./tools/init-experiment.js"
import { createLogExperimentTool } from "./tools/log-experiment.js"
import { createRunExperimentTool } from "./tools/run-experiment.js"
import type { ExternalSkillChildGrant } from "../../agent-runtime/tools/skill.js"
import type { ExperimentGuardSnapshot, RuntimeTool } from "../../agent-runtime/tools/types.js"
import { EXPERIMENT_CHARTER_PATH } from "./charter.js"
import { ExperimentExecutionState } from "./execution-state.js"
import { createFinalizeChildGrant } from "./finalize-child-run.js"
import { captureExperimentTree, keepExperimentChanges, readExperimentHead, revertExperimentChanges } from "./git-operations.js"
import { createExperimentGitSettlement } from "./git-settlement.js"
import { createExperimentOperationOwner } from "./operation-owner.js"
import { validateExperimentWorktree } from "./git-worktree.js"
import { createExperimentProjection, type ExperimentSnapshot } from "./projection.js"

/** The experiment loop of one runner: the three loop tools, the running and
 *  pending-result owner, the finalizer grant, and the live charter policy, all
 *  reading the session's one held experiment projection. */
export interface ExperimentsRuntime {
  readonly tools: {
    readonly initExperiment: RuntimeTool
    readonly runExperiment: RuntimeTool
    readonly logExperiment: RuntimeTool
  }
  readonly execution: ExperimentExecutionState
  /** The grant is a factory over the request's admitted skill revision so the
   *  finalizer script bytes come from the same revision the skill tool loads
   *  from. It is the fallback child grant: an attempt-bounded workflow grant
   *  takes precedence when the request carries one. */
  readonly finalizeGrant: (revision: SkillRegistryRevision) => ExternalSkillChildGrant
  /** Live charter policy. The exposure gate omits tools it forbids and the
   *  execution gate vetoes calls against it. */
  readonly guard: () => Promise<ExperimentGuardSnapshot | undefined>
  readonly snapshot: () => Promise<ExperimentSnapshot | undefined>
}

export const experimentsRuntime = moduleRuntimeHandle<ExperimentsRuntime>("experiments")

/** Builds the loop for the interactive chat runner alone. Every loop step and
 *  Git settlement runs a command through the owned launcher and records
 *  through the session's durable writer, so a runner without either has no
 *  loop; a worker or subagent never has one, because the loop belongs to the
 *  session the user drives. */
export function createExperimentsRuntime(services: ModuleRuntimeServices): ExperimentsRuntime | undefined {
  const { runOwnedCommand, sessionId, projectRoot, executionCwd, projectionReader, sessionEventWriter } = services
  if (services.purpose.kind !== "interactive-chat" || !runOwnedCommand || !sessionId || !projectionReader || !sessionEventWriter) return undefined
  const putInFlight = sessionEventWriter.putInFlight
  if (!putInFlight) return undefined
  const writer = sessionEventWriter
  const projection = createExperimentProjection(projectionReader, sessionId)
  const execution = new ExperimentExecutionState()
  const operation = createExperimentOperationOwner({
    listInFlight: (kinds) => projectionReader.readInFlight(sessionId, kinds),
    putInFlight: (kind, key, payload) => putInFlight(kind, key, payload),
  })
  const scratchDir = sessionScratchDir(resolveSessionDir(sessionId, projectRoot))
  const settlement = createExperimentGitSettlement({
    record: async (fact, inFlight) => { await writer.record(fact, undefined, inFlight) },
    transaction: (publish) => writer.transaction(publish),
    retirement: () => operation.retirement(),
    complete: () => operation.complete(),
    keep: ({ cwd, description, result }) => {
      const pending = execution.pending()
      if (!pending) throw new Error("Experiment keep requires its pending measured tree.")
      return keepExperimentChanges({ cwd, scratchDir, description, result, measuredTree: pending.measuredTree, run: runOwnedCommand })
    },
    revert: (cwd) => revertExperimentChanges({ cwd, run: runOwnedCommand }),
    head: (cwd) => readExperimentHead(cwd, runOwnedCommand),
  })
  const snapshot = (): Promise<ExperimentSnapshot | undefined> => projection.replay()
  const guard = async (): Promise<ExperimentGuardSnapshot | undefined> => {
    const current = await snapshot()
    if (!current) return undefined
    return {
      active: current.mode.active,
      initialized: current.configuration !== null,
      workDir: current.mode.workDir ?? executionCwd,
      protectedPaths: current.protectedPaths,
      sealedPaths: current.sealedPaths,
    }
  }
  return {
    execution,
    tools: {
      initExperiment: createInitExperimentTool({
        snapshot: async () => (await snapshot()) ?? {
          mode: { active: false, workDir: null },
          configuration: null,
          segments: [],
          runs: [],
        },
        // The charter lives in the experiment work directory, which init
        // requires to be the session's execution directory.
        readCharter: () => Bun.file(join(executionCwd, EXPERIMENT_CHARTER_PATH)).text(),
        validateWorktree: (input) => validateExperimentWorktree({ ...input, run: runOwnedCommand }),
        record: async (fact) => { await writer.record(fact) },
        executionState: execution,
        operation,
      }),
      runExperiment: createRunExperimentTool({
        replay: snapshot,
        executionState: execution,
        operation,
        run: runOwnedCommand,
        platform: process.platform,
        scratchDir,
        prepareScratch: async () => { await mkdir(scratchDir, { recursive: true }) },
      }),
      logExperiment: createLogExperimentTool({
        replay: snapshot,
        executionState: execution,
        operation,
        captureTree: () => captureExperimentTree({ cwd: executionCwd, scratchDir, run: runOwnedCommand }),
        settle: (cwd, fact, deactivate) => settlement.settle(cwd, fact, deactivate),
      }),
    },
    // Finalization runs after the loop is off, so the grant does not depend
    // on experiment mode being active.
    finalizeGrant: (revision) => createFinalizeChildGrant({
      resolveSkill: (id) => revision.skills.get(id),
      scratchDir,
      workDir: executionCwd,
      runOwnedCommand,
    }),
    guard,
    snapshot,
  }
}
