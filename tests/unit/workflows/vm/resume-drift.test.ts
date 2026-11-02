import { afterEach, describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { createWorkflowVmHost } from "../../../../src/workflows/vm/host.js"
import type { WorkflowVmHostDeps, WorkflowVmStartMode } from "../../../../src/workflows/vm/host-types.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { parseWorkflowSessionFact } from "../../../../src/workflows/vm/session-facts.js"
import { pruneSupersededWorkflowViewFacts } from "../../../../src/workflows/view/view-store.js"
import { Schema } from "effect"
import { acceptanceWorkflow, SqliteVmDriver } from "./_sqlite-vm-driver.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { nonEmpty } from "../../../helpers/non-empty.js"

const drivers: SqliteVmDriver[] = []

afterEach(() => {
  for (const driver of drivers.splice(0)) driver.close()
})

/** The acceptance workflow with a work phase that composes the `work`
 *  package, so a published revision of that package reaches the step. */
const composingWorkflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  ...acceptanceWorkflow,
  phases: acceptanceWorkflow.phases.map((phase) => "phase" in phase && phase.phase === "work" ? { ...phase, dependencies: ["work"] } : phase),
})

function host(
  vm: SqliteVmDriver,
  startMode: WorkflowVmStartMode,
  run: WorkflowVmHostDeps["attemptRunner"]["run"],
  definitionRevision = vm.definitionRevision,
  writer: AsyncEventWriter = asAsyncEventWriter(vm.store),
  preAttemptPolicy?: WorkflowVmHostDeps["preAttemptPolicy"],
  workflow = vm.workflow,
  servedConversations: WorkflowVmHostDeps["servedConversations"] = async () => new Set(),
) {
  return createWorkflowVmHost({
    requestAddenda: async () => [],
    startMode,
    sessionId: vm.sessionId,
    reader: asAsyncEventReadSurface(vm.store),
    writer,
    ...vm.workflowStores(),
    definitionRevision,
    workflow,
    conversationId: () => "conversation-recovery",
    attemptRunner: { run },
    emit: () => {},
    ...(preAttemptPolicy ? { preAttemptPolicy } : {}),
    servedConversations,
  })
}

describe("workflow VM resume and drift preflight", () => {
  it("rejects definition edits and non-executable sessions before worker acquisition", async () => {
    const driftVm = new SqliteVmDriver()
    drivers.push(driftVm)
    await driftVm.initialize()
    let workers = 0
    const editedWorkflow: WorkflowDefinition = { ...driftVm.workflow, phases: nonEmpty(driftVm.workflow.phases.filter((entry) => "phase" in entry && entry.phase === "review")) }
    const editedRevision = Object.freeze({
      ...driftVm.definitionRevision,
    })
    const drift = await host(
      driftVm,
      "operator_resume",
      async () => { workers += 1; throw new Error("worker must not start") },
      editedRevision,
      undefined,
      undefined,
      editedWorkflow,
    ).run()

    expect(drift).toMatchObject({ kind: "failed", failure: {
      kind: "definition_drift",
      message: "The sqlite-acceptance workflow cannot continue because its definition changed after it started. These parts changed: the order of its phases; the settings of agent work; the instructions of agent work; the output of agent work. "
        + "Restore them, then press Resume, or start a new workflow.",
    } })
    expect(driftVm.events().at(-1)?.type).toBe("definition.drift_rejected")
    expect(workers).toBe(0)

    const legacyVm = new SqliteVmDriver()
    drivers.push(legacyVm)
    await legacyVm.initializeLegacy()
    const preCutover = await host(legacyVm, "operator_resume", async () => {
      workers += 1
      throw new Error("worker must not start")
    }).run()
    expect(legacyVm.events()).toHaveLength(0)
    expect(legacyVm.store.read({ aggregateId: legacyVm.sessionAggregateId }).some(({ type }) => type === "queue.created")).toBe(true)
    expect(preCutover).toMatchObject({
      kind: "failed",
      failure: { kind: "malformed_state", message: expect.stringContaining("missing_root") },
    })
    expect(workers).toBe(0)
  })

  it("adopts changed skill content before resuming workers", async () => {
    const vm = new SqliteVmDriver({ workflow: composingWorkflow })
    drivers.push(vm)
    await vm.initialize()
    const changedSkills = testSkillRevision([
      testSkill("work", { name: "Work", body: "Changed procedure." }),
      testSkill("review", { name: "Review" }),
    ])
    const revision = Object.freeze({ ...vm.definitionRevision, skills: changedSkills })
    const result = await host(vm, "operator_resume", async (input, active) => ({
      kind: "success",
      attemptId: input.attemptId,
      conversationId: active.conversationId,
      handoff: { summary: "resumed" },
      reassessment: null,
    }), revision).run()

    if (result.kind === "failed") throw new Error(JSON.stringify(result.failure))
    expect(result.kind).toBe("completed")
    const adoptionEvent = vm.events().find(({ type }) => type === "workflow.definition_identity.adopted")
    expect(adoptionEvent).toBeDefined()
    if (!adoptionEvent) throw new Error("Resume did not record identity adoption")
    const adoption = parseWorkflowSessionFact({
      type: adoptionEvent.type,
      version: adoptionEvent.version,
      actor: adoptionEvent.actor,
      payload: adoptionEvent.payload,
    })
    if (adoption.type !== "workflow.definition_identity.adopted") throw new Error("Wrong adoption fact")
    expect(adoption.payload.evidence).toEqual([
      expect.objectContaining({ component: "skill", skillId: "work" }),
    ])
    const firstStart = vm.events().find(({ type }) => type === "attempt.started")
    expect(firstStart?.seq).toBeGreaterThan(adoptionEvent.seq)
    expect(replayWorkflowControl(vm.events()).definitionIdentity.skills).toEqual(
      adoption.payload.adopted.skills,
    )
  })

  it("reconstructs a paused workflow from facts before resumed workers start", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    let workers = 0
    // The pre-attempt policy is the one production path that pauses a
    // workflow before its worker starts.
    const pausedHost = host(vm, "launch", async () => {
      workers += 1
      throw new Error("paused worker must not start")
    }, undefined, undefined, () => "operator pause")

    expect(await pausedHost.run()).toMatchObject({ kind: "paused", reason: "operator pause" })
    expect(workers).toBe(0)

    const resumedDefinitions: string[] = []
    const resumed = await host(vm, "operator_resume", async (input, active) => {
      workers += 1
      resumedDefinitions.push(input.definitionId)
      return {
        kind: "success",
        attemptId: input.attemptId,
        conversationId: active.conversationId,
        handoff: { summary: `${input.definitionId} resumed` },
        reassessment: null,
      }
    }).run()

    if (resumed.kind === "failed") throw new Error(JSON.stringify(resumed.failure))
    expect(resumedDefinitions).toEqual(["work", "review"])
    expect(workers).toBe(2)
  })
  it("resumes after close pruning removes superseded workflow-view rows", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()

    const stopped = host(vm, "launch", async (_input, active) => {
      queueMicrotask(() => { void stopped.abort("Runtime shutdown") })
      await new Promise<void>((resolve) => { active.signal.addEventListener("abort", () => resolve(), { once: true }) })
      throw active.signal.reason
    })
    const paused = await stopped.run()
    expect(paused).toMatchObject({ kind: "paused" })

    const pruned = await pruneSupersededWorkflowViewFacts(asAsyncEventReadSurface(vm.store), asAsyncEventWriter(vm.store), vm.sessionId)
    expect(pruned).toBeGreaterThan(0)
    expect(vm.events().some((event, index, events) => {
      const next = events[index + 1]
      return next !== undefined && next.seq > event.seq + 1
    })).toBe(true)

    let resumedWorkers = 0
    const resumed = await host(vm, "operator_resume", async (input, active) => {
      resumedWorkers += 1
      return {
        kind: "success",
        attemptId: input.attemptId,
        conversationId: active.conversationId,
        handoff: { summary: `${input.definitionId} resumed` },
        reassessment: null,
      }
    }).run()

    if (resumed.kind === "failed") throw new Error(JSON.stringify(resumed.failure))
    expect(resumedWorkers).toBe(2)
  })
  it("reports drift-evidence persistence failure without starting a worker", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const base = asAsyncEventWriter(vm.store)
    const writer: AsyncEventWriter = {
      ...base,
      append: async () => { throw new Error("evidence writer unavailable") },
    }
    let workers = 0

    const editedWorkflow: WorkflowDefinition = { ...vm.workflow, phases: nonEmpty(vm.workflow.phases.filter((entry) => "phase" in entry && entry.phase === "review")) }
    const editedRevision = Object.freeze({
      ...vm.definitionRevision,
    })
    const result = await host(vm, "operator_resume", async () => {
      workers += 1
      throw new Error("worker must not start")
    }, editedRevision, writer, undefined, editedWorkflow).run()

    expect(result).toMatchObject({ kind: "failed", failure: { kind: "drift_evidence_persistence" } })
    expect(workers).toBe(0)
  })

  it("restarts a crash-looping attempt without a pause while its conversation records a served response before each crash", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    const crash = async () => { throw new Error("simulated crash") }
    const reads: (readonly (readonly [string, number])[])[] = []
    const served: WorkflowVmHostDeps["servedConversations"] = async (since) => {
      reads.push([...since])
      return new Set(since.keys())
    }

    expect(await host(vm, "launch", crash).run()).toMatchObject({ kind: "failed", failure: { kind: "worker" } })
    for (let recovery = 1; recovery <= 5; recovery += 1) {
      expect(await host(vm, "operator_resume", crash, undefined, undefined, undefined, undefined, served).run()).toMatchObject({ kind: "failed", failure: { kind: "worker" } })
      expect(replayWorkflowControl(vm.events()).attempts[0]?.resumeRevertCount).toBe(1)
    }

    expect(vm.events().some(({ type }) => type === "attempt.resume_cap_exceeded")).toBe(false)
    // Each recovery reads once, from the position of the attempt's latest start.
    const starts = vm.events().filter(({ type }) => type === "attempt.started").map(({ position }) => position)
    expect(reads).toEqual(starts.slice(0, 5).map((position) => [["conversation-recovery", position]]))
  })

  it("resume-revert cap pauses a crash-looping workflow and a further resume can still complete", async () => {
    const vm = new SqliteVmDriver()
    drivers.push(vm)
    await vm.initialize()
    let workers = 0
    const crash = async () => {
      workers += 1
      throw new Error("simulated crash")
    }

    expect(await host(vm, "launch", crash).run()).toMatchObject({ kind: "failed", failure: { kind: "worker" } })
    for (let recovery = 1; recovery <= 3; recovery += 1) {
      expect(await host(vm, "operator_resume", crash).run()).toMatchObject({ kind: "failed", failure: { kind: "worker" } })
      expect(replayWorkflowControl(vm.events()).attempts[0]?.resumeRevertCount).toBe(recovery)
    }
    const workersBeforeCap = workers
    const capped = await host(vm, "operator_resume", crash).run()

    expect(capped).toMatchObject({ kind: "paused" })
    expect(workers).toBe(workersBeforeCap)
    expect(replayWorkflowControl(vm.events())).toMatchObject({ status: "paused", attempts: [{ state: { _tag: "pending" } }, { state: { _tag: "pending" } }] })
    expect(vm.events().filter(({ type }) => type === "attempt.resume_cap_exceeded")).toHaveLength(1)

    const resumedDefinitions: string[] = []
    const resumed = await host(vm, "operator_resume", async (input, active) => {
      workers += 1
      resumedDefinitions.push(input.definitionId)
      return {
        kind: "success",
        attemptId: input.attemptId,
        conversationId: active.conversationId,
        handoff: { summary: "completed after explicit resume" },
        reassessment: null,
      }
    }).run()
    expect(resumed.kind).toBe("completed")
    expect(resumedDefinitions).toEqual(["work", "review"])
    expect(replayWorkflowControl(vm.events()).attempts.every(({ state }) => state._tag === "completed")).toBe(true)
    expect(vm.events().some(({ type }) => type === "workflow.failed")).toBe(false)
  })
})
