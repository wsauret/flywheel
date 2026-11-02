import { afterEach, describe, expect, it } from "bun:test"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { Schema } from "effect"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createWorkflowContextStore } from "../../../../src/workflows/context-bundle/context-store.js"
import { createWorkflowViewStore } from "../../../../src/workflows/view/view-store.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import type { WorkflowVmHostDeps, WorkflowVmStartMode } from "../../../../src/workflows/vm/host-types.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { SqliteVmDriver } from "./_sqlite-vm-driver.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import arms from "./golden/committed-v10-history-arms.json"
import { commitWorkflowRecovery } from "../../../../src/orchestration/workflow-host/recovery-commit.js"
import { readWorkflowQueuedUserInputs } from "../../../../src/orchestration/session/conversation/queued-user-inputs.js"

const drivers: SqliteVmDriver[] = []
const closers: Array<() => void> = []

afterEach(() => {
  for (const close of closers.splice(0)) close()
  for (const driver of drivers.splice(0)) driver.close()
})

const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "blocked-recovery",
  name: "Blocked recovery",
  phases: [
    { phase: "source", brief: "Do the source work.", name: "source", output: { summary: "The plan.", fields: { phases: { type: "list", description: "The phases.", max: 3, unique: "id", of: phaseItem() } } }, writes: [] },
    {
      repeat: { each: "source.phases", reassess: "reassess" },
      phases: [
        {
          phase: "implement",
          brief: "Do the implement work.",
          name: "implement",
          output: { summary: "What the phase changed.", fields: { artifacts: { type: "object", description: "What the phase touched.", fields: { files_modified: { type: "list", description: "Modified files.", of: { type: "string" } } } } } },
          writes: [],
        },
        { phase: "reassess", brief: "Do the reassess work.", name: "reassess", writes: [] },
      ],
    },
    { phase: "tail", brief: "Do the tail work.", name: "tail", writes: [] },
  ],
})

/** The control that a build before phases launched for this workflow: a
 *  `for` node runs each phase and its reassessment, which the history arm
 *  still runs. The stored chain below exists only in such a run. */
function launchedBeforePhases(compiled: CommittedWorkflowControl): CommittedWorkflowControl {
  return { ...replayWorkflowControl([parseWorkflowSessionFact(arms.blockedFor.root)]), definitionIdentity: compiled.definitionIdentity, aggregateSeq: compiled.aggregateSeq }
}

const skills = testSkillRevision(["source", "implement", "reassess", "tail"].map((id) => testSkill(id)))

const blocker = {
  reason: "The phase packet names src/missing.ts, which the repository does not contain",
  evidence: "list src/ reports no missing.ts",
}

const blockedHandoff = {
  outcome: { state: "blocked", ...blocker },
  summary: "Stopped before editing: the file the phase names is absent from the repository.",
}

/** A workflow that a build before blocked retirement ran into a block and
 *  paused before the corrective reassessment: the implement attempt is
 *  blocked, its report is addressed to the pending reassessment, and control
 *  is paused. The current build writes none of this; it must only resume it. */
async function seedPausedCorrectiveChain(vm: SqliteVmDriver, reason: string) {
  await vm.initialize()
  await vm.startAttempt("after", "conversation-source")
  const prepared = await vm.completeAttempt("after", { phases: [phase("phase-1")] })
  if (prepared.command.kind !== "prepare_attempt") throw new Error("The source must prepare the phase")
  const implement = prepared.command.attempt.attemptId
  await vm.drive({ type: "ATTEMPT_STARTED", attemptId: implement, conversationId: `conversation-${implement}` })
  await vm.seedStoredBlock(blockedHandoff, "reassess")
  await vm.drive({ type: "PAUSE", reason })
  const control = replayWorkflowControl(vm.events())
  const corrective = control.attempts.find(({ definitionId }) => definitionId === "reassess")
  if (!corrective || control.status !== "paused") throw new Error("The stored chain must pause before its reassessment")
  return { control, blockedAttemptId: implement, corrective }
}

/** One restart: projections and host are rebuilt on a new SQLite connection, so
 *  everything the resumed run reads comes from committed facts alone. */
function restarted(vm: SqliteVmDriver, startMode: WorkflowVmStartMode, worker: WorkerFake, emit: EmitFake) {
  const store = createSqliteEventStore(join(vm.root, ".flywheel", "flywheel.sqlite"))
  const reader = asAsyncEventReadSurface(store)
  const queueStore = createWorkflowViewStore({ sessionId: vm.sessionId, reader })
  const contextStore = createWorkflowContextStore({ sessionId: vm.sessionId, reader })
  const close = () => {
    queueStore.dispose()
    contextStore.dispose()
    store.close()
  }
  closers.push(close)
  const host = createWorkflowVmHost({
    servedConversations: async () => new Set(),
    requestAddenda: async () => [],
    startMode,
    sessionId: vm.sessionId,
    reader,
    writer: asAsyncEventWriter(store),
    queueStore,
    contextStore,
    definitionRevision: vm.definitionRevision,
    workflow,
    conversationId: (input) => `conversation-${input?.attemptId ?? "follow-up"}`,
    attemptRunner: createAttemptExecutor({
      earlierCheckpoint: async () => null,
      resolvedAgents: vm.bindings,
      skills: vm.skills,
      context: contextStore,
      worker,
      recordInvocation: async () => {},
    }),
    emit,
  })
  return { host, contextStore, close }
}

describe("blocked work survives a restart", () => {
  it("repairs a damaged valid prefix without losing the addressed blocker or canonical task", async () => {
    const vm = new SqliteVmDriver({ workflow, skills, control: launchedBeforePhases })
    drivers.push(vm)
    const { control: before, corrective } = await seedPausedCorrectiveChain(vm, "stop before reassessment")
    const entries = vm.context()!.entries
    vm.store.append({ aggregateId: vm.aggregateId, sessionId: vm.sessionId, timestamp: 999, type: "queue.created", version: 9, actor: "flywheel", payload: {} })
    const repaired = await commitWorkflowRecovery({
      sessionId: vm.sessionId, reader: asAsyncEventReadSurface(vm.store), writer: asAsyncEventWriter(vm.store),
      timestamp: new Date().toISOString(),
      runtimeIdentity: async () => ({ version: "test", buildId: "test" }),
      prepare: async (basis) => {
        expect(basis).toEqual({ ...before, aggregateSeq: before.aggregateSeq + 1 })
        if (!basis) throw new Error("Current valid prefix must survive")
        return { control: basis, resolvedAgents: vm.bindings }
      },
    })
    expect(repaired).toEqual({ kind: "committed" })
    if (repaired.kind !== "committed") throw new Error("Recovery must commit")
    let acquired = 0
    const resumed = restarted(vm, "operator_resume", async (step, prompt, _task, _signal, conversationId) => {
      acquired += 1
      expect(step.id).toBe(corrective.id)
      expect(conversationId).toBe(`conversation-${corrective.id}`)
      expect(prompt).toContain("SQLite VM acceptance")
      expect(prompt).toContain(blocker.reason)
      expect(prompt).toContain(blocker.evidence)
      expect(vm.events().some((fact) => fact.type === "attempt.started" && fact.payload.attemptId === corrective.id)).toBe(true)
      return { output: "context_overflow", handoffContent: null, durationMs: 1 }
    }, () => {})
    expect((await resumed.contextStore.loadState())!.entries).toEqual(entries)
    const count = vm.events().length
    expect(await resumed.host.preflight()).toBeNull()
    expect(acquired).toBe(0)
    expect(vm.events()).toHaveLength(count)
    // The corrective step fails on the overflow, and the work after it needs
    // it, so the run fails.
    expect((await resumed.host.run()).kind).toBe("failed")
    expect(acquired).toBe(1)
    expect(await readWorkflowQueuedUserInputs(asAsyncEventReadSurface(vm.store), vm.sessionId)).toEqual([])
    expect(vm.store.read().filter(({ type }) => type.startsWith("chat."))).toEqual([])
    await resumed.host.dispose()
  })

  it("resumes a stored corrective chain and completes it through its reassessment step", async () => {
    const vm = new SqliteVmDriver({ workflow, skills, control: launchedBeforePhases })
    drivers.push(vm)
    const { blockedAttemptId } = await seedPausedCorrectiveChain(vm, "operator pause")

    const prompts = new Map<string, string[]>()
    const resumedEvents: Parameters<EmitFake>[0][] = []
    const afterRestart = restarted(vm, "operator_resume", async (step, userPrompt) => {
      const seen = prompts.get(step.definitionId) ?? []
      prompts.set(step.definitionId, [...seen, userPrompt])
      if (step.definitionId === "reassess") {
        return {
          output: "completed",
          handoffContent: seen.length === 0
            ? {
                summary: "Re-spec phase 1 around the file that exists.",
                changes: [{ action: "replace", phase_id: "phase-1", phase: phase("phase-1-revised") }],
              }
            : { summary: "The remaining work is correct.", changes: [] },
          durationMs: 1,
        }
      }
      if (step.definitionId === "implement") {
        return {
          output: "completed",
          handoffContent: {
            summary: "Implemented the corrected phase against the file that exists.",
            artifacts: { files_modified: ["src/x.ts"] },
          },
          durationMs: 1,
        }
      }
      return { output: "completed", handoffContent: { summary: "done" }, durationMs: 1 }
    }, (event) => { resumedEvents.push(event) })

    const resumed = await afterRestart.host.run()

    expect(resumed.kind, resumed.kind === "failed" ? resumed.failure.message : "").toBe("completed")
    expect(prompts.get("reassess")?.[0]).toContain(blocker.reason)
    expect(prompts.get("reassess")?.[0]).toContain(blocker.evidence)
    expect(prompts.get("implement")?.[0]).not.toContain(blocker.reason)
    expect(prompts.get("reassess")?.[1]).not.toContain(blocker.reason)

    const settled = replayWorkflowControl(vm.events())
    expect(settled.attempts.find(({ id }) => id === blockedAttemptId)?.state._tag).toBe("blocked")
    expect(settled.attempts.filter(({ provenance }) => provenance._tag === "reassessment")).toMatchObject([
      { parentAttemptId: blockedAttemptId, state: { _tag: "completed" } },
    ])
    expect(vm.events().filter(({ type }) => type === "attempt.blocked")).toHaveLength(1)
    expect(vm.events()
      .filter(({ type }) => type === "attempt.succeeded")
      .map(({ payload }) => "attemptId" in payload ? payload.attemptId : undefined)).not.toContain(blockedAttemptId)
    expect(resumedEvents.map(({ type }) => type)).toContain("workflow.run.completed")
  })
})

type WorkerFake = Parameters<typeof createAttemptExecutor>[0]["worker"]
type EmitFake = WorkflowVmHostDeps["emit"]

function phase(id: string) {
  return {
    id,
    goal: `Implement ${id}`,
    files: ["src/x.ts"],
    tasks: [{ id: `${id}-task`, description: `Implement ${id}`, files: ["src/x.ts"], test_scenarios: ["works"] }],
    verification: "bun run test",
  }
}

/** The item type of the source step's phases, the shape `phase` builds. */
function phaseItem() {
  const text = (description: string) => ({ type: "string", description }) as const
  const texts = (description: string) => ({ type: "list", description, of: { type: "string" } }) as const
  return {
    type: "object",
    fields: {
      id: text("The phase id."),
      goal: text("What the phase delivers."),
      files: texts("Files the phase touches."),
      tasks: {
        type: "list",
        description: "The changes of the phase.",
        of: { type: "object", fields: { id: text("The task id."), description: text("The change."), files: texts("Files the task touches."), test_scenarios: texts("What proves the task.") } },
      },
      verification: text("How the phase is verified."),
    },
  } as const
}
