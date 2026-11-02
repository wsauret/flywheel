import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { hashContent } from "../../../../src/workflows/definition-hash.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildDefinitionDriftRejectedFact, buildWorkflowCompilationFacts } from "../../../../src/workflows/definition-provenance-fact-writers.js"
import { parseDefinitionProvenanceFact } from "../../../../src/workflows/definition-provenance-facts.js"
import { loadDefinitionLineageFromEvents, workflowLaunchOf } from "../../../../src/workflows/definition-provenance-projection.js"
import type { AttemptRow } from "../../../../src/workflows/view/types.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { recordedWorkflow } from "../../../../src/workflows/loader.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { testSkill } from "../../../helpers/skill-fixtures.js"

function makeWriter(sessionId: string, baseDir: string) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
  return {
    writer,
    loadLineage() {
      return loadDefinitionLineageFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    },
    dispose() {
      writer.dispose()
      store.close()
    },
  }
}

const planning = testSkill("planning")
const implementation = testSkill("implementation")

/** The resolved steps of one fixture definition. */
function resolvedAgents(workflow: WorkflowDefinition) {
  return [...resolveWorkflowAgents(workflow).values()]
}

describe("definition provenance facts", () => {
  it("records definitions, content hashes, and compiled workflow shape", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-lineage-"))
    try {
      const handle = makeWriter("session-1", projectRoot)
      const workflow = workflowDefinition("/defs/workflow.yaml")
      for (const fact of buildWorkflowCompilationFacts({
        workflow,
        agents: resolvedAgents(workflow),
        skills: [planning, implementation],
        attempts: [attempt("runtime-plan", "plan", "wf.plan"), attempt("runtime-implement", "implement", "wf.implement")],
        userRequestSha256: hashContent("Build the feature").sha256,
        worstCaseAttempts: 2,
        verification: null,
        warnings: [],
      })) {
        if (fact.type === "definition.loaded") {
          expect(fact.version).toBe(9)
          if (fact.payload.kind === "workflow") {
            for (const key of ["use_when", "confirmation_template", "requires_description", "user-invocable", "disable-model-invocation"]) {
              expect(fact.payload.definition).not.toHaveProperty(key)
            }
          }
        }
        await handle.writer.record(fact)
      }

      const lineage = handle.loadLineage()
      expect(lineage.definitionOrder).toEqual([
        "workflow:wf",
        "agent:plan",
        "agent:implement",
        "skill:planning",
        "skill:implementation",
      ])
      expect(lineage.definitions["workflow:wf"]?.provenance?.filePath).toBe("/defs/workflow.yaml")
      // An inline brief is authored inside the workflow file, so its agent
      // carries the workflow's provenance and never one of its own.
      expect(lineage.definitions["agent:plan"]?.provenance?.filePath).toBe("/defs/workflow.yaml")
      expect(lineage.definitions["agent:plan"]?.definition).toMatchObject({
        definitionId: "plan", briefId: "wf.plan", policy: { name: "Plan" },
        output: { summary: "The plan." },
      })
      expect(lineage.definitions["skill:planning"]?.provenance).toBeUndefined()
      expect(lineage.hashes["workflow:wf"]?.sha256).toHaveLength(64)
      expect(lineage.hashes["agent:implement"]?.format).toBe("canonical-json-v1")
      expect(lineage.hashes["skill:implementation"]?.sha256).toHaveLength(64)
      expect(lineage.compiledWorkflow?.workflowDefinitionId).toBe("wf")
      const compiled = lineage.compiledWorkflow
      if (!compiled || !("definitionIds" in compiled)) throw new Error("expected a current compilation row")
      expect(compiled.definitionIds).toEqual(["plan", "implement"])
      expect(compiled.skillIds).toEqual(["planning", "implementation"])
      expect(compiled.attempts.map((row) => row.id)).toEqual(["runtime-plan", "runtime-implement"])
      expect(compiled.attempts.map((row) => row.briefId)).toEqual(["wf.plan", "wf.implement"])
      expect(compiled).not.toHaveProperty("userDescription")
      expect(compiled.userRequestSha256).toBe(hashContent("Build the feature").sha256)
      // A registered launch ran no verifier, so its launch names the layer and
      // the worst case alone.
      expect(compiled).toMatchObject({ worstCaseAttempts: 2, verification: null })
      expect(workflowLaunchOf(lineage)).toEqual({ source: { kind: "registered", layer: "project" }, worstCaseAttempts: 2 })
      handle.dispose()

      const reopened = makeWriter("session-1", projectRoot)
      expect(reopened.loadLineage().compiledWorkflow).toMatchObject({
        userRequestArtifactId: "user-request",
        userRequestSha256: hashContent("Build the feature").sha256,
      })
      reopened.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // Remove after 2027-04-30 with the frozen v8 decoder.
  it("reads a stored v8 file run with catalog keys and rebuilds it without them", () => {
    const provenance = { layer: "session" as const, filePath: "/session/scratch/workflows/wf.workflow.yaml", id: "wf" }
    const { provenance: _provenance, ...definition } = workflowDefinition(provenance.filePath)
    const retired = {
      use_when: "Investigate a problem.", confirmation_template: "debug",
      requires_description: false, "user-invocable": false, "disable-model-invocation": true,
    }
    const fact = parseDefinitionProvenanceFact({
      type: "definition.loaded", version: 8, actor: "flywheel",
      payload: { kind: "workflow", id: "wf", definition: { ...definition, ...retired }, provenance },
    })
    if (fact.type !== "definition.loaded" || fact.payload.kind !== "workflow") throw new Error("expected a workflow record")
    expect(fact.payload.definition).toMatchObject(retired)
    const rebuilt = recordedWorkflow(fact.payload.definition, undefined, provenance)
    expect(rebuilt.phases).toEqual(definition.phases)
    for (const key of Object.keys(retired)) expect(rebuilt).not.toHaveProperty(key)
  })

  // Remove after 2027-04-30 with the frozen v8 decoder.
  it("reads the skill-backed agent policy that v8 recorded", () => {
    const definition = {
      definitionId: "work", briefId: "acme.work", source: "skill",
      policy: {
        definitionId: "work", name: "Work", runs: "skill:acme.work", persona: "implementer",
        writes: [], reads: ["plan"], arguments: ["{plan.path}"],
        redirect: { from: "result.json", to: "reports/result.json" }, child_skills: ["acme.child"],
      },
      output: { fields: { path: { type: "string" } } },
    }
    const fact = parseDefinitionProvenanceFact({
      type: "definition.loaded", version: 8, actor: "flywheel",
      payload: { kind: "agent", id: "work", definition },
    })
    expect(fact.payload).toEqual({ kind: "agent", id: "work", definition })
  })

  it("records the module bundle a workflow was loaded from", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-lineage-"))
    try {
      const handle = makeWriter("session-1", projectRoot)
      const workflow = { ...workflowDefinition("/bundle/workflows/wf.yaml"), provenance: { layer: "bundled" as const, filePath: "/bundle/workflows/wf.yaml", id: "wf", bundle: "development" } }
      for (const fact of buildWorkflowCompilationFacts({
        workflow,
        agents: resolvedAgents(workflow),
        skills: [planning, implementation],
        attempts: [attempt("runtime-plan", "plan", "wf.plan"), attempt("runtime-implement", "implement", "wf.implement")],
        userRequestSha256: hashContent("Build the feature").sha256,
        worstCaseAttempts: 2,
        verification: null,
        warnings: [],
      })) {
        await handle.writer.record(fact)
      }

      expect(handle.loadLineage().definitions["workflow:wf"]?.provenance?.bundle).toBe("development")
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("reads a workflow file's launch: its path in the session directory, its verifier result, its worst case, and its warnings", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-launch-"))
    try {
      const handle = makeWriter("session-1", projectRoot)
      // The project sits in another session's scratch, as a UAT fixture
      // project does, so the file's own session directory is the last one in
      // its path.
      const filePath = "/repo/.flywheel/sessions/outer/scratch/fixture/.flywheel/sessions/chat-1/scratch/workflows/review.workflow.yaml"
      const workflow = { ...workflowDefinition(filePath), provenance: { layer: "session" as const, filePath, id: "wf" } }
      for (const fact of buildWorkflowCompilationFacts({
        workflow,
        agents: resolvedAgents(workflow),
        skills: [planning, implementation],
        attempts: [attempt("runtime-plan", "plan", "wf.plan")],
        userRequestSha256: hashContent("Review the files").sha256,
        worstCaseAttempts: 14,
        verification: "invalid",
        warnings: ["Step 0, flow.0: unreachable_work: the node cannot run."],
      })) {
        await handle.writer.record(fact)
      }

      expect(workflowLaunchOf(handle.loadLineage())).toEqual({
        source: { kind: "file", path: "scratch/workflows/review.workflow.yaml" },
        verification: "invalid",
        worstCaseAttempts: 14,
        warnings: ["Step 0, flow.0: unreachable_work: the node cannot run."],
      })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // A launch from before v9 recorded neither its worst case nor a verifier
  // result, and neither can be derived again from the row. Its run reads as
  // a launch that recorded only its source. Remove after 2027-04-30 with the
  // v8 reader.
  it("reads a v8 compilation as a launch that recorded no worst case and no verifier result", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-v8-"))
    try {
      const handle = makeWriter("v8", projectRoot)
      const filePath = "/project/.flywheel/sessions/chat-1/scratch/workflows/survey.workflow.yaml"
      const { provenance: _provenance, ...definition } = workflowDefinition(filePath)
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.loaded", version: 7, actor: "flywheel",
        payload: { kind: "workflow", id: "wf", definition, provenance: { layer: "session", filePath, id: "wf" } },
      }))
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "workflow.compiled", version: 8, actor: "flywheel",
        payload: {
          workflowDefinitionId: "wf", workflowName: "Workflow", userRequestArtifactId: "user-request", userRequestSha256: hashContent("Old task").sha256,
          stepIds: ["plan"], skillIds: [], steps: [historicalStep("runtime-plan", "plan", "wf.plan")],
        },
      }))

      const lineage = handle.loadLineage()
      const compiled = lineage.compiledWorkflow
      if (!compiled || !("stepIds" in compiled)) throw new Error("expected a compilation row that names step ids")
      expect(compiled.stepIds).toEqual(["plan"])
      expect(workflowLaunchOf(lineage)).toEqual({ source: { kind: "file", path: "scratch/workflows/survey.workflow.yaml" } })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // A launch from before v10 could not warn: it refused each file that a
  // warning now names. Its run reads as a launch without a warning. Remove
  // after 2027-04-30 with the v9 reader.
  it("reads a v9 compilation as a launch without a warning", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-v9-"))
    try {
      const handle = makeWriter("v9", projectRoot)
      const filePath = "/project/.flywheel/sessions/chat-1/scratch/workflows/survey.workflow.yaml"
      const { provenance: _provenance, ...definition } = workflowDefinition(filePath)
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.loaded", version: 7, actor: "flywheel",
        payload: { kind: "workflow", id: "wf", definition, provenance: { layer: "session", filePath, id: "wf" } },
      }))
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "workflow.compiled", version: 9, actor: "flywheel",
        payload: {
          workflowDefinitionId: "wf", workflowName: "Workflow", userRequestArtifactId: "user-request", userRequestSha256: hashContent("Old task").sha256,
          stepIds: ["plan"], skillIds: [], steps: [historicalStep("runtime-plan", "plan", "wf.plan")], worstCaseAttempts: 4, verification: "partially_proved",
        },
      }))

      expect(workflowLaunchOf(handle.loadLineage())).toEqual({
        source: { kind: "file", path: "scratch/workflows/survey.workflow.yaml" },
        verification: "partially_proved",
        worstCaseAttempts: 4,
      })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // A launch before the agent lexicon named the step ids of its agents and
  // embedded its step rows. Its run reads its launch as it did before.
  // Remove after 2027-04-30 with the v10 reader.
  it("reads a v10 compilation that names step ids as the same launch", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-v10-"))
    try {
      const handle = makeWriter("v10", projectRoot)
      const filePath = "/project/.flywheel/sessions/chat-1/scratch/workflows/survey.workflow.yaml"
      const { provenance: _provenance, ...definition } = workflowDefinition(filePath)
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.loaded", version: 7, actor: "flywheel",
        payload: { kind: "workflow", id: "wf", definition, provenance: { layer: "session", filePath, id: "wf" } },
      }))
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "workflow.compiled", version: 10, actor: "flywheel",
        payload: {
          workflowDefinitionId: "wf", workflowName: "Workflow", userRequestArtifactId: "user-request", userRequestSha256: hashContent("Old task").sha256,
          stepIds: ["plan"], skillIds: [], steps: [historicalStep("runtime-plan", "plan", "wf.plan")], worstCaseAttempts: 3, verification: "invalid",
          warnings: ["Step 0, flow.0: unreachable_work: the node cannot run."],
        },
      }))

      const lineage = handle.loadLineage()
      expect(lineage.compiledWorkflow).toMatchObject({ stepIds: ["plan"] })
      expect(workflowLaunchOf(lineage)).toEqual({
        source: { kind: "file", path: "scratch/workflows/survey.workflow.yaml" },
        verification: "invalid",
        worstCaseAttempts: 3,
        warnings: ["Step 0, flow.0: unreachable_work: the node cannot run."],
      })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // Builds from 2026-10-11 to 2026-10-13 recorded a step's prompt profile as
  // `kind` and `toolScoping`. A run that a workflow file started rebuilds its
  // definition from this record at Resume, so the record must still decode.
  // Remove after 2027-04-13 with the retired step keys.
  it("reads a v7 workflow snapshot whose step names the retired kind and tool scope", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-step-kind-"))
    try {
      const handle = makeWriter("step-kind", projectRoot)
      const filePath = "/project/.flywheel/sessions/chat-1/scratch/workflows/review.workflow.yaml"
      const toolScoping = { read: true, bash: false, search: true, list: true, write: false, edit: false, subagent: false }
      const definition = {
        id: "wf", name: "Workflow",
        steps: {
          plan: { instructions: "Plan the work.", name: "Plan", writes: [], kind: "check", toolScoping },
          implement: { instructions: "Implement the plan.", name: "Implement", writes: [] },
        },
        flow: [{ step: "plan" }, { step: "implement" }],
      }
      const provenance = { layer: "session" as const, filePath, id: "wf" }
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.loaded", version: 7, actor: "flywheel",
        payload: { kind: "workflow", id: "wf", definition, provenance },
      }))

      const recorded = handle.loadLineage().definitions["workflow:wf"]?.definition
      expect(recorded).toMatchObject({ steps: { plan: { kind: "check", toolScoping } } })
      // Resume converts the step-grammar record of a file-launched run to
      // phases and decodes the result strictly.
      expect(recordedWorkflow(recorded, undefined, provenance).phases.map((element) => "phase" in element ? element.phase : null)).toEqual(["plan", "implement"])
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("hashes semantic definition content, not mutable provenance paths", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-hash-"))
    try {
      const first = makeWriter("first", projectRoot)
      for (const fact of buildWorkflowCompilationFacts({
        workflow: workflowDefinition("/defs/one.yaml"),
        agents: resolvedAgents(workflowDefinition("/defs/one.yaml")),
        skills: [planning, implementation],
        attempts: [attempt("runtime-plan", "plan", "wf.plan")],
        userRequestSha256: hashContent("Same task").sha256,
        worstCaseAttempts: 2,
        verification: null,
        warnings: [],
      })) {
        await first.writer.record(fact)
      }
      const firstLineage = first.loadLineage()
      const firstStepHash = firstLineage.hashes["agent:plan"]?.sha256
      const firstSkillHash = firstLineage.hashes["skill:planning"]?.sha256
      first.dispose()

      const second = makeWriter("second", projectRoot)
      for (const fact of buildWorkflowCompilationFacts({
        workflow: workflowDefinition("/defs/two.yaml"),
        agents: resolvedAgents(workflowDefinition("/defs/two.yaml")),
        skills: [planning, implementation],
        attempts: [attempt("runtime-plan", "plan", "wf.plan")],
        userRequestSha256: hashContent("Same task").sha256,
        worstCaseAttempts: 2,
        verification: null,
        warnings: [],
      })) {
        await second.writer.record(fact)
      }
      const secondLineage = second.loadLineage()
      expect(secondLineage.hashes["agent:plan"]?.sha256).toBe(firstStepHash)
      expect(secondLineage.hashes["skill:planning"]?.sha256).toBe(firstSkillHash)
      second.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // A pre-unification workspace recorded step definitions and step definition
  // ids. Those rows stay readable history: the projection folds them, and a
  // reader that needs current steps asks first.
  it("projects the pre-unification step rows as history", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-legacy-"))
    try {
      const handle = makeWriter("legacy", projectRoot)
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.loaded",
        version: 3,
        actor: "flywheel",
        payload: {
          kind: "step",
          id: "plan",
          definition: { id: "plan", name: "Plan", promptBody: "Plan the work." },
          provenance: { layer: "project", filePath: "/defs/plan.md", id: "plan" },
        },
      }))
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "definition.hash_recorded",
        version: 1,
        actor: "flywheel",
        payload: { kind: "step", id: "plan", sha256: "a".repeat(64), bytes: 12, format: "canonical-json-v1" },
      }))
      await handle.writer.record(parseDefinitionProvenanceFact({
        type: "workflow.compiled",
        version: 2,
        actor: "flywheel",
        payload: {
          workflowDefinitionId: "wf",
          workflowName: "Workflow",
          userRequestArtifactId: "user-request",
          userRequestSha256: hashContent("Legacy task").sha256,
          stepDefinitionIds: ["plan"],
          steps: [{ id: "runtime-plan", definitionId: "plan" }],
        },
      }))

      const lineage = handle.loadLineage()
      expect(lineage.definitionOrder).toEqual(["step:plan"])
      expect(lineage.definitions["step:plan"]?.provenance?.filePath).toBe("/defs/plan.md")
      expect(lineage.hashes["step:plan"]?.sha256).toBe("a".repeat(64))
      const compiled = lineage.compiledWorkflow
      if (!compiled) throw new Error("expected a recorded compilation row")
      expect(compiled).not.toHaveProperty("stepIds")
      expect(compiled).toMatchObject({ stepDefinitionIds: ["plan"] })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  // A workspace from before the step-content cutover recorded bindings, v1
  // binding hashes, and compilations that named binding ids. Those rows stay
  // readable history. Remove after 2027-04-30 together with the binding
  // history.
  it("projects the pre-step-content binding rows as history", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-bindings-"))
    try {
      const handle = makeWriter("bindings", projectRoot)
      const provenance = { layer: "project" as const, filePath: "/defs/wf.yaml", id: "wf" }
      for (const fact of [
        {
          type: "definition.loaded", version: 6,
          payload: { kind: "workflow", id: "wf", definition: { id: "wf", name: "Workflow", bindings: { plan: { skill: "planning", handoff: "spec-handoff", writes: [] } }, steps: [{ step: "plan" }] }, provenance },
        },
        {
          type: "definition.loaded", version: 6,
          payload: { kind: "binding", id: "plan", definition: { bindingId: "plan", skill: "planning", handoff: "spec-handoff", writes: [] }, provenance },
        },
        { type: "definition.hash_recorded", version: 1, payload: { kind: "binding", id: "plan", sha256: "b".repeat(64), bytes: 40, format: "canonical-json-v1" } },
        { type: "definition.hash_recorded", version: 1, payload: { kind: "step", id: "plan", sha256: "c".repeat(64), bytes: 40, format: "canonical-json-v1" } },
        {
          type: "workflow.compiled", version: 5,
          payload: {
            workflowDefinitionId: "wf", workflowName: "Workflow", userRequestArtifactId: "user-request", userRequestSha256: hashContent("Old task").sha256,
            bindingIds: ["plan"], skillIds: ["planning"], steps: [{ id: "runtime-plan", definitionId: "plan", skillId: "planning", handoffType: "spec-handoff" }],
          },
        },
      ]) {
        await handle.writer.record(parseDefinitionProvenanceFact({ ...fact, actor: "flywheel" }))
      }

      const lineage = handle.loadLineage()
      expect(lineage.definitionOrder).toEqual(["workflow:wf", "binding:plan"])
      expect(lineage.definitions["binding:plan"]?.definition).toMatchObject({ skill: "planning", handoff: "spec-handoff" })
      expect(lineage.hashes["binding:plan"]?.sha256).toBe("b".repeat(64))
      expect(lineage.hashes["step:plan"]?.sha256).toBe("c".repeat(64))
      const compiled = lineage.compiledWorkflow
      if (!compiled) throw new Error("expected a recorded compilation row")
      expect(compiled).not.toHaveProperty("stepIds")
      expect(compiled).toMatchObject({ bindingIds: ["plan"] })
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("strictly records and projects definition drift rejection", async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-definition-drift-"))
    try {
      const handle = makeWriter("drift", projectRoot)
      await handle.writer.record(buildDefinitionDriftRejectedFact({
        workflowId: "wf",
        changes: [{
          component: "agent",
          definitionId: "plan",
          aspect: "policy",
          recorded: "a".repeat(64),
          current: "b".repeat(64),
        }],
        latestSeq: 7,
      }))
      expect(handle.loadLineage().driftRejections).toEqual([{
        workflowId: "wf",
        changes: [{
          component: "agent",
          definitionId: "plan",
          aspect: "policy",
          recorded: "a".repeat(64),
          current: "b".repeat(64),
        }],
        latestSeq: 7,
      }])
      handle.dispose()
    } finally {
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("reads the step evidence that a build before the agent lexicon recorded as agent evidence", () => {
    const stored = { recorded: "a".repeat(64), current: "b".repeat(64) }
    const fact = parseDefinitionProvenanceFact({
      type: "definition.drift_rejected",
      version: 1,
      actor: "flywheel",
      payload: { workflowId: "wf", changes: [{ component: "step", stepId: "plan", aspect: "policy", ...stored }], latestSeq: 7 },
    })
    expect(fact.type === "definition.drift_rejected" && fact.payload.changes).toEqual([{ component: "agent", definitionId: "plan", aspect: "policy", ...stored }])
  })

  it("rejects drift facts without mismatches", () => {
    expect(() => parseDefinitionProvenanceFact({
      type: "definition.drift_rejected",
      version: 1,
      actor: "flywheel",
      payload: { workflowId: "wf", changes: [], latestSeq: 7 },
    })).toThrow()
  })
})

function workflowDefinition(filePath: string): WorkflowDefinition {
  return {
    id: "wf",
    name: "Workflow",
    phases: [{ phase: "plan", brief: "Plan the work.", name: "Plan", dependencies: [planning.id], output: { summary: "The plan." }, writes: [] }, { phase: "implement", brief: "Implement the plan.", name: "Implement", dependencies: [implementation.id], writes: [] }],
    provenance: { layer: "project", filePath, id: "wf" },
  }
}

function attempt(id: string, definitionId: string, briefId: string): AttemptRow {
  return {
    id,
    definitionId,
    briefId,
    workflowDefinitionId: "wf",
    name: definitionId,
    status: "pending",
    writes: [],
    resumeRevertCount: 0,
  }
}

/** A step row as a `workflow.compiled` row before version 11 embedded it. */
function historicalStep(id: string, definitionId: string, contentId: string) {
  const { briefId: _briefId, ...row } = attempt(id, definitionId, contentId)
  return { ...row, contentId }
}
