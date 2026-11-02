import { afterEach, describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { join } from "node:path"
import { WorkflowDefinitionDriftError } from "../../../../src/workflows/vm/definition-identity.js"
import { currentDefinitionDriftRejection } from "../../../../src/workflows/vm/recovery.js"
import { WorkflowDefinitionSchema, type WorkflowDefinition, type WorkflowPhase } from "../../../../src/workflows/workflow-schema.js"
import { acceptanceWorkflow, SqliteVmDriver } from "./_sqlite-vm-driver.js"

const drivers: SqliteVmDriver[] = []
const evidenceDir = process.env.FLYWHEEL_VM_DRIFT_EVIDENCE_DIR

afterEach(() => {
  for (const vm of drivers.splice(0)) vm.close()
})

function driver(options: ConstructorParameters<typeof SqliteVmDriver>[0] = {}): SqliteVmDriver {
  const value = new SqliteVmDriver(options)
  drivers.push(value)
  return value
}

async function expectDrift(
  vm: SqliteVmDriver,
  options: Parameters<SqliteVmDriver["freshReplay"]>[1],
  component: "skill" | "version" | "agent",
): Promise<WorkflowDefinitionDriftError> {
  const attempt = vm.committed.attempts[0]
  if (!attempt) throw new Error("Fixture requires an attempt")
  const rowsBefore = vm.events().length
  try {
    await vm.freshReplay(
      { type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: "must-not-launch" },
      options,
    )
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowDefinitionDriftError)
    if (!(error instanceof WorkflowDefinitionDriftError)) throw error
    expect(error.workflowId).toBe("sqlite-acceptance")
    expect(error.latestSeq).toBe(vm.committed.aggregateSeq)
    expect(error.changes.length).toBeGreaterThan(0)
    for (const change of error.changes) {
      expect(change).toMatchObject({ component })
      expect(change.recorded).not.toBe(change.current)
    }
    const events = vm.events()
    expect(events).toHaveLength(rowsBefore + 1)
    expect(events.at(-1)).toMatchObject({
      type: "definition.drift_rejected",
      payload: {
        workflowId: "sqlite-acceptance",
        latestSeq: vm.committed.aggregateSeq,
        changes: error.changes.map(() => ({ component })),
      },
    })
    expect(events.at(-1)?.payload).toEqual(vm.lineage().driftRejections.at(-1))
    expect(events.some(({ payload }) => JSON.stringify(payload).includes("must-not-launch"))).toBe(false)
    return error
  }
  throw new Error("Expected definition drift rejection")
}

/** The acceptance workflow with its work phase changed by `revise`. */
function revisedWork(revise: (phase: WorkflowPhase) => WorkflowPhase): WorkflowDefinition {
  const encoded = Schema.encodeSync(WorkflowDefinitionSchema)(acceptanceWorkflow)
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    ...encoded,
    phases: acceptanceWorkflow.phases.map((entry) => "phase" in entry && entry.phase === "work" ? revise(entry) : entry),
  })
}

describe("SQLite workflow VM definition drift", () => {
  it("independent VM version mutation rejects before a worker-facing command and retains optional evidence", async () => {
    const vm = driver(evidenceDir ? { root: evidenceDir, retain: true } : {})
    await vm.initialize()

    const error = await expectDrift(vm, { identityVersionOverride: "3" }, "version")
    expect(error.changes[0]).toMatchObject({ component: "version", recorded: "2", current: "3" })
    if (evidenceDir) expect(vm.root).toBe(evidenceDir)
  })

  it("a drift rejection stays current until control commits past it", async () => {
    const vm = driver()
    await vm.initialize()
    expect(currentDefinitionDriftRejection(vm.events())).toBeUndefined()

    await expectDrift(vm, { identityVersionOverride: "3" }, "version")
    expect(currentDefinitionDriftRejection(vm.events())).toEqual(vm.lineage().driftRejections.at(-1))

    await vm.commitCompeting({ type: "START" })
    expect(currentDefinitionDriftRejection(vm.events())).toBeUndefined()
  })

  it("adopts a changed output description as step content, with no drift rejection", async () => {
    const vm = driver({ root: evidenceDir ? join(evidenceDir, "content-case") : undefined, retain: !!evidenceDir })
    await vm.initialize()

    const result = await vm.freshReplay({ type: "START" }, {
      workflow: revisedWork((work) => ({ ...work, output: { summary: "Changed." } })),
    })
    expect(result.command.kind).toBe("commit")
    const types = vm.events().map(({ type }) => type)
    expect(types).toContain("workflow.definition_identity.adopted")
    expect(types).not.toContain("definition.drift_rejected")
  })

  it("a changed output shape rejects as agent content and output drift", async () => {
    const vm = driver()
    await vm.initialize()
    const unchanged = await vm.freshReplay({ type: "START" }, { workflow: revisedWork((work) => work) })
    expect(unchanged.command.kind).toBe("commit")

    const error = await expectDrift(vm, {
      workflow: revisedWork((work) => ({ ...work, output: { summary: "Acceptance result.", fields: { verdict: { type: "string", description: "The verdict." } } } })),
    }, "agent")
    expect(error.changes.map((change) => change.component === "agent" ? change.aspect : change.component)).toEqual(["content", "output"])
  })

  it("a changed policy rejects as agent policy drift", async () => {
    const vm = driver()
    await vm.initialize()

    const error = await expectDrift(vm, {
      workflow: revisedWork((work) => ({ ...work, writes: [] })),
    }, "agent")
    expect(error.changes).toEqual([expect.objectContaining({ component: "agent", definitionId: "work", aspect: "policy" })])
  })
})
