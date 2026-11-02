import { describe, expect, it } from "bun:test"
import { FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish.js"
import { makeWorkflowDeps } from "./_workflow-controller-fixtures.js"
import { WorkflowStructureRejectedError } from "../../../../src/workflows/vm/structural-admission.js"
import { nonEmpty } from "../../../helpers/non-empty.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema, type WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"

const LINEAR_WORKFLOW = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "linear-guardrails",
  name: "Linear guardrails",
  phases: ["prepare", "work", "review"].map((phase) => ({ phase, brief: `Do the ${phase} task.`, writes: [] })),
})

/** Never created: persona resolution under it sees no `.flywheel/agents`. */
const PROJECT_CWD = join(tmpdir(), "flywheel-launch-guardrails-none")

async function launchGuardrails(
  workflow: string | WorkflowDefinition,
  deps: ReturnType<typeof makeWorkflowDeps> = makeWorkflowDeps(),
): Promise<{ maxAttempts: number; maxMutationsPerAttempt: number; maxInserts: number }> {
  return (await prepareLaunch(workflow, deps)).guardrails
}

async function prepareLaunch(workflow: string | WorkflowDefinition, deps: ReturnType<typeof makeWorkflowDeps>) {
  const prepared = await prepareWorkflowLaunch({
    authProfileId: "default",
    workflow: typeof workflow === "string" ? workflowIn(deps.definitions.captureRevision(), workflow) : workflow,
    description: "guardrail resolution",
    deps,
    projectRoot: PROJECT_CWD,
    definitionRevision: deps.definitions.captureRevision(),
  })
  const initialized = prepared.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
  if (initialized?.type !== "workflow.control.initialized") throw new Error("launch published no control fact")
  const { guardrails } = initialized.payload.control
  if (!("maxAttempts" in guardrails)) throw new Error("launch published control of a version before phases")
  return { guardrails, worstCaseAttempts: prepared.worstCaseAttempts }
}

describe("workflow launch guardrails", () => {

  it("compiles declared guardrails into the committed control", async () => {
    const deps = makeWorkflowDeps()
    const base = LINEAR_WORKFLOW
    const declared = {
      ...base,
      id: "declared-guardrails",
      name: "Declared guardrails",
      guardrails: { max_attempts: 200, max_inserts: 120 },
    }
    expect(await launchGuardrails(declared, deps)).toMatchObject({
      maxAttempts: 200,
      maxMutationsPerAttempt: 3,
      maxInserts: 120,
    })
  })

  it("falls back to config and launch defaults when the definition declares none", async () => {
    expect(await launchGuardrails(FIXTURE_WORKFLOW_ID)).toMatchObject({
      maxAttempts: 50,
      maxMutationsPerAttempt: 3,
      maxInserts: 20,
    })
  })

  it("records a worst case that the queue length of a registered launch caps", async () => {
    const deps = makeWorkflowDeps()
    const base = LINEAR_WORKFLOW
    // Three phases, and four more tries of the last: seven attempts at most.
    const last = base.phases.at(-1)
    if (last === undefined || "repeat" in last) throw new Error("linear workflow does not end with a phase")
    const retried = { ...base, id: "retried", name: "Retried", phases: nonEmpty([...base.phases.slice(0, -1), { ...last, retry: { max: 5, stuck: false } }]) }
    const capped = { ...retried, id: "capped", name: "Capped", guardrails: { max_attempts: 4 } }
    expect(await prepareLaunch(retried, deps)).toMatchObject({ guardrails: { maxAttempts: 50 }, worstCaseAttempts: 7 })
    expect(await prepareLaunch(capped, deps)).toMatchObject({ guardrails: { maxAttempts: 4 }, worstCaseAttempts: 4 })
  })

  it("refuses a workflow past its declared attempt limit before writing any fact", async () => {
    const deps = makeWorkflowDeps()
    const base = LINEAR_WORKFLOW
    const wide = { ...base, id: "wide", name: "Wide", guardrails: { max_attempts: 1 } } as const
    const refusal = async (workflow: WorkflowDefinition): Promise<WorkflowStructureRejectedError> => {
      try {
        await launchGuardrails(workflow, deps)
      } catch (error) {
        if (error instanceof WorkflowStructureRejectedError) return error
        throw error
      }
      throw new Error(`launch of ${workflow.id} was not refused`)
    }

    expect((await refusal(wide)).findings.map(({ name }) => name)).toEqual(["attempt_limit_overrun"])
  })
})
