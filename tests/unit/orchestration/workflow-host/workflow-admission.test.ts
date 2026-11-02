import { describe, expect, test } from "bun:test"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import type { ModuleId } from "../../../../src/orchestration/modules.js"
import { createDefinitionAvailability } from "../../../../src/orchestration/app-service/definition-availability.js"
import type { CapabilityAdmission, CapabilityRequest } from "../../../../src/orchestration/config/module-policy.js"
import { admitWorkflowOperation } from "../../../../src/orchestration/workflow-host/workflow-admission.js"
import { runDefinition } from "../../../../src/orchestration/workflow-host/definition-source.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { readRunDefinitionLineage } from "../../../../src/workflows/definition-provenance-projection.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import prePhaseLineage from "./golden/pre-phase-lineage.json"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { moduleDisabledReason } from "../../../../src/protocol/module-ids"

const reviewer: AgentDefinition = {
  kind: "persona",
  name: "reviewer",
  description: "Reviews diffs.",
  systemPrompt: "Review.",
  tools: ["read", "search"],
  role: "reviewer",
  maxTurns: 20,
}

/** One workflow whose step composes a skill with an agent slot, so its
 *  requirement closure is wider than the workflow transport itself. */
const revision = testSkillRevision([testSkill("delegating", { agents: ["reviewer"] })])
const workflows = new Map<string, WorkflowDefinition>([
  ["delegating-flow", {
    id: "delegating-flow",
    name: "delegating-flow",
    description: "delegating-flow",
    phases: [{ phase: "delegating", brief: "Do the delegating work.", name: "delegating", dependencies: ["delegating"], writes: [] }],
  }],
])

/** The admission boundary over a selection a case can change, plus the record
 *  of every request it was asked to admit. `onMinted` runs after the grant is
 *  minted, which is where a settings write that races the launch lands. */
async function harness(
  selected: readonly ModuleId[],
  onMinted?: (change: (next: readonly ModuleId[]) => void) => void,
) {
  let live = [...selected]
  const requests: CapabilityRequest[] = []
  const capabilities = {
    admit: async (request: CapabilityRequest): Promise<CapabilityAdmission> => {
      requests.push(request)
      const missing = request.required.filter((capability) => !live.includes(capability))
      if (missing.length > 0) {
        return { ok: false, missing, reason: `${request.operation} is unavailable: ${moduleDisabledReason(missing)}` }
      }
      const grant = {
        operation: request.operation,
        required: request.required,
        capabilities: [...live],
        moduleIds: [...live],
        requireWorkflowConfirmation: true,
        workflowsMode: "ask" as const,
        identity: live.join("+"),
      }
      onMinted?.((next) => { live = [...next] })
      return { ok: true, grant }
    },
  }
  const personas = { revision: "reviewer", personas: new Map([["reviewer", reviewer]]), resolutions: [] }
  const definitionRevision = {
    ...repoDefinitions().captureRevision(),
    skills: revision,
    personaRevision: personas,
    personas: personas.personas,
  }
  const availability = await createDefinitionAvailability({
    definitions: { captureRevision: () => definitionRevision },
    modules: repoModules,
    capabilities: { state: () => ({ capabilities: live, moduleIds: live, requireWorkflowConfirmation: true, workflowsMode: "ask", identity: live.join("+") }) },
  })
  return { capabilities, availability, requests }
}

const FULL: readonly ModuleId[] = ["workflows", "skills", "subagents"]

describe("workflow admission", () => {
  test("admits the definition's complete transitive requirement set in one request", async () => {
    const wired = await harness(FULL)

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the delegating-flow workflow",
      resolve: () => ({ ok: true, workflow: workflows.get("delegating-flow")! }),
    })

    expect(admission.ok).toBe(true)
    expect(wired.requests).toEqual([{ operation: "the delegating-flow workflow", required: ["skills", "subagents", "workflows"] }])
    if (!admission.ok) throw new Error(admission.reason)
    expect(admission.grant.required).toEqual(["skills", "subagents", "workflows"])
  })

  test("admits the requirement closure of a definition that no registry holds", async () => {
    const wired = await harness(FULL)
    const authored = { ...workflows.get("delegating-flow")!, id: "authored-flow", name: "Authored flow" }

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the workflow file authored.workflow.yaml",
      resolve: () => ({ ok: true, workflow: authored }),
    })

    expect(wired.requests).toEqual([{ operation: "the workflow file authored.workflow.yaml", required: ["skills", "subagents", "workflows"] }])
    if (!admission.ok) throw new Error(admission.reason)
    expect(admission.workflow).toBe(authored)
  })

  test("names the operation in a definition refusal and admits nothing", async () => {
    const wired = await harness(FULL)
    const diagnostics = [{ file: "bad.workflow.yaml", keyPath: "id", message: "Expected a slug" }]

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the workflow file bad.workflow.yaml",
      resolve: () => ({ ok: false, reason: "the file is not valid", diagnostics }),
    })

    expect(admission).toEqual({ ok: false, reason: "the workflow file bad.workflow.yaml is unavailable: the file is not valid", diagnostics })
    expect(wired.requests).toEqual([])
  })

  test("derives the admitted availability from the grant, never a later live read", async () => {
    // The write lands in the window between the grant and the capture.
    const wired = await harness(FULL, (change) => { change([]) })

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the delegating-flow workflow",
      resolve: () => ({ ok: true, workflow: workflows.get("delegating-flow")! }),
    })

    expect(admission.ok).toBe(true)
    if (!admission.ok) throw new Error(admission.reason)
    expect(admission.availability.capabilities).toEqual(["skills", "subagents", "workflows"])
    expect(admission.availability.skills.get("delegating")?.available).toBe(true)
    expect([...admission.availability.availablePersonas.keys()]).toEqual(["reviewer"])
  })

  test("keeps one project revision across awaited capability admission", async () => {
    const personas = { revision: "reviewer", personas: new Map([["reviewer", reviewer]]), resolutions: [] }
    const first = {
      ...repoDefinitions().captureRevision(),
      skills: revision,
      personaRevision: personas,
      personas: personas.personas,
    }
    const second = { ...first, skills: testSkillRevision([testSkill("later")]) }
    let published = first
    const availability = await createDefinitionAvailability({
      definitions: { captureRevision: () => published },
      modules: repoModules,
      capabilities: { state: () => ({ capabilities: FULL, moduleIds: FULL, requireWorkflowConfirmation: true, workflowsMode: "ask", identity: FULL.join("+") }) },
    })
    const capabilities = {
      admit: async (request: CapabilityRequest): Promise<CapabilityAdmission> => {
        published = second
        await availability.refresh()
        return {
          ok: true,
          grant: {
            operation: request.operation,
            required: request.required,
            capabilities: FULL,
            moduleIds: FULL,
            requireWorkflowConfirmation: true,
            workflowsMode: "ask",
            identity: FULL.join("+"),
          },
        }
      },
    }

    const admission = await admitWorkflowOperation({
      capabilities,
      availability,
      operation: "the delegating-flow workflow",
      resolve: () => ({ ok: true, workflow: workflows.get("delegating-flow")! }),
    })

    expect(admission.ok).toBe(true)
    if (!admission.ok) throw new Error(admission.reason)
    expect(admission.availability.definitionRevision).toBe(first)
  })

  test("refuses when a transitive requirement of the definition is disabled", async () => {
    const wired = await harness(["workflows", "skills"])

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the delegating-flow workflow",
      resolve: () => ({ ok: true, workflow: workflows.get("delegating-flow")! }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok) throw new Error("expected a refusal")
    expect(admission.reason).toContain("subagents is turned off. Turn it on in Settings, or remove it from disabled_modules in flywheel.toml")
  })

  test("refuses an unreadable file before it admits anything", async () => {
    const wired = await harness(FULL)

    const admission = await admitWorkflowOperation({
      capabilities: wired.capabilities,
      availability: wired.availability,
      operation: "the workflow file missing.workflow.yaml",
      resolve: () => ({ ok: false, reason: "the file cannot be read" }),
    })

    expect(admission.ok).toBe(false)
    if (admission.ok) throw new Error("expected a refusal")
    expect(admission.reason).toBe("the workflow file missing.workflow.yaml is unavailable: the file cannot be read")
    expect(wired.requests).toEqual([])
  })

})

// The definition lineage that 301e51b8b recorded at launch, frozen by that
// build: version 7 definition rows of a registered implement run and of a
// session run whose file states the step grammar. Remove after 2027-04-30.
describe("the definition of a run that a build before phases launched", () => {
  const temporary = temporaryDirectories()
  async function recorded(name: keyof typeof prePhaseLineage) {
    const store = createSqliteEventStore(resolveEventStoreDbFile(temporary("flywheel-pre-phase-lineage-")))
    store.appendBatch(prePhaseLineage[name].map((fact) => ({ ...fact, aggregateId: workflowAggregateId(name), sessionId: name, timestamp: 1 })))
    return { store, reader: asAsyncEventReadSurface(store) }
  }

  test("reads every version 7 row, but refuses to resume the retired registered implement workflow", async () => {
    const { store, reader } = await recorded("implement")
    try {
      const lineage = await readRunDefinitionLineage(reader, "implement")
      expect(Object.keys(lineage.definitions)).toEqual(expect.arrayContaining(["workflow:implement", "step:spec-create", "step:spec-review", "step:implement", "skill:implementation"]))
      const current = repoDefinitions().captureRevision()
      const resolved = await runDefinition({ reader, sessionId: "implement", workflowDefinitionId: "implement" })(current)
      expect(resolved).toEqual({ ok: false, reason: "the implement workflow is retired and no longer runs; its history stays viewable" })
    } finally {
      store.close()
    }
  })

  test("rebuilds a session run from its recorded step-grammar record, with no file to read", async () => {
    const { store, reader } = await recorded("stream-review")
    try {
      const resolved = await runDefinition({ reader, sessionId: "stream-review", workflowDefinitionId: "stream-review" })(repoDefinitions().captureRevision())
      if (!resolved.ok) throw new Error(resolved.reason)
      expect(resolved.workflow.provenance).toMatchObject({ layer: "session", filePath: "/scratch/workflows/stream-review.workflow.yaml" })
      expect(resolved.workflow.phases.map((entry) => "phase" in entry ? entry.phase : "repeat")).toEqual(["scope", "review", "check", "confirm", "report", "follow"])
      expect(resolved.workflow.retiredStepGrammar?.workflow.flow).toHaveLength(4)
    } finally {
      store.close()
    }
  })
})
