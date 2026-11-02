import { describe, expect, it } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { loadPathWorkflow, sessionWorkflowsDir } from "../../../src/orchestration/workflow-host/path-workflow.js"
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js"
import { createContextAccumulator } from "../../../src/workflows/context-bundle/context.js"
import { loadWorkflowDefinitions } from "../../helpers/workflow-files.js"
import { compileWorkflowControl } from "../../../src/workflows/vm/compile.js"
import { verifyAuthoredWorkflow } from "../../../src/workflows/vm/verify.js"
import type { WorkflowDefinition } from "../../../src/workflows/workflow-schema.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { fullAuthority } from "../../helpers/launch-authority.js"
import { repoDefinitions } from "../../helpers/project-definitions.js"
import { testSkill, testSkillRevision } from "../../helpers/skill-fixtures.js"
import { makeEntry } from "../../unit/workflows/queue/_context-accumulator-fixtures.js"
import { RETIRED_FLOW_CASES, SOURCE, listed, step, stepFile } from "../../helpers/retired-step-cases.js"

// A saved file of the step grammar launches converted to phases, with one
// warning that names each change. Remove after 2027-04-30 with the
// conversion.

const temporary = temporaryDirectories()
const revision = repoDefinitions().captureRevision()
const FIXTURES = join(import.meta.dir, "../../fixtures/retired-workflows")
const GSD_SKILLS = ["gsd.spec-create", "gsd.spec-review", "gsd.implement", "gsd.reassess", "gsd.verify-acceptance"]

/** Launch a session file as the workflow tool does, then compile its
 *  control, which a launch records first. Returns the definition and the
 *  warnings of the launch. */
async function launch(content: string) {
  const sessionDir = realpathSync(temporary("flywheel-retired-steps-"))
  mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true })
  const result = await loadPathWorkflow({ path: "scratch/workflows/converted.workflow.yaml", savedContent: content, sessionDir, revision, authority: fullAuthority() })
  if (!result.ok) throw new Error(`the file was refused: ${result.reason}: ${JSON.stringify(result.diagnostics)}`)
  expect(result.verification.result).not.toBe("invalid")
  compile(result.workflow, revision.skills)
  return { workflow: result.workflow, warnings: result.warnings }
}

function compile(workflow: WorkflowDefinition, skills: typeof revision.skills) {
  return compileWorkflowControl(workflow, resolveWorkflowAgents(workflow), { skills })
}

/** The one conversion warning, which sits at the file root, as the text
 *  that the given notes give it. */
function conversionWarning(warnings: readonly { readonly keyPath?: string; readonly message: string }[]): string {
  const conversion = warnings.filter(({ message }) => message.startsWith("This file uses the retired step grammar"))
  expect(conversion).toHaveLength(1)
  if (conversion[0]?.keyPath !== undefined) expect(conversion[0].keyPath).toBe("(root)")
  return conversion[0]?.message ?? ""
}

const warningOf = (notes: readonly string[]): string =>
  `This file uses the retired step grammar, which Flywheel converted when it read it: ${notes.join("; ")}. Rewrite it in the phase grammar; load the workflow-authoring skill.`

/** Load a step-grammar file of a project's workflow folder, verify it, and
 *  compile its control, as a named workflow's recorded launch did. */
function launchProject(content: string) {
  const dir = temporary("flywheel-retired-steps-project-")
  writeFileSync(join(dir, "converted.yaml"), content)
  const { results, errors, warnings } = loadWorkflowDefinitions(dir, "project", undefined, undefined, revision.skills)
  expect(errors).toEqual([])
  const workflow = results.get("converted")
  if (!workflow) throw new Error("the file did not load")
  expect(verifyAuthoredWorkflow(workflow, resolveWorkflowAgents(workflow), { skills: revision.skills }).result).not.toBe("invalid")
  return { workflow, warnings, control: compile(workflow, revision.skills) }
}

describe("a saved file of the retired step grammar, by flow entry kind", () => {
  it.each(RETIRED_FLOW_CASES)("launches a $kind", async ({ steps, flow, notes: expected }) => {
    const { warnings } = await launch(stepFile(steps, flow))
    expect(conversionWarning(warnings)).toBe(warningOf(expected))
  })
})

describe("a saved file of the retired step grammar, by conversion rule", () => {
  it("runs the plain steps of one after layer as the named agents of one phase", async () => {
    const { workflow, warnings } = await launch(stepFile({ ...SOURCE, a: step("a"), b: step("b"), c: step("c") }, [{ step: "source", id: "s" }, { step: "a", after: ["s"] }, { step: "b", after: ["s"] }, { step: "c", after: ["a", "b"] }]))
    expect(workflow.phases).toMatchObject([{ phase: "source" }, { phase: "parallel-1", agents: [{ agent: "a" }, { agent: "b" }] }, { phase: "c" }])
    expect(conversionWarning(warnings)).toBe(warningOf([
      "steps and flow became phases",
      "the after order of the top-level flow became phases in order of their longest path",
      'steps "a", "b" became the named agents of phase "parallel-1"',
    ]))
  })

  // A map ran beside a step under `after`. A phase runs one construct, so
  // the two run in sequence, and the warning says that the overlap is gone.
  it("runs a layer that holds a map in sequence, and names the lost overlap", async () => {
    const { workflow, warnings } = await launch(stepFile({ ...SOURCE, a: step("a"), each: step("each") }, [{ step: "source" }, { step: "a", after: ["source"] }, { map: "source.items", id: "eaches", do: "each", after: ["source"], join: { reducer: "collect" } }]))
    expect(workflow.phases.map((phase) => "phase" in phase ? phase.phase : "repeat")).toEqual(["source", "a", "each"])
    expect(conversionWarning(warnings)).toContain("2 entries that ran at the same time now run one after another")
  })

  it("keeps the step record key of an entry whose id differs, names the entry by its id, and rewrites a read of that id", async () => {
    const { workflow, warnings } = await launch(stepFile({ y: step("y"), z: step("z", { reads: ["x"] }) }, [{ step: "y", id: "x" }, { step: "z" }]))
    expect(workflow.phases).toMatchObject([{ phase: "y", name: "y", brief: "Do y." }, { phase: "z", reads: ["y"] }])
    expect(conversionWarning(warnings)).toBe(warningOf(["steps and flow became phases"]))
  })

  it("gives an agent of a run paused before phases the join that it reads, where the step grammar put it", async () => {
    // The base build recorded each join under the map's node and the map's
    // id. The conversion moves the maps after the then chain one node down,
    // so the converted read's own node holds the other map's join.
    const shifted = await launch(stepFile(
      { s: listed("s"), f: step("f"), r: step("r"), r2: step("r2"), x: step("x", { reads: ["reviews"] }) },
      [
        { step: "s", then: { step: "f" } },
        { map: "s.findings", id: "reviews", do: "r", join: { reducer: "collect", write: "reviews" } },
        { map: "s.findings", id: "others", do: "r2", join: { reducer: "collect", write: "others" } },
        { step: "x" },
      ],
    ))
    const accumulator = createContextAccumulator()
    accumulator.seedInput({ workflowDefinitionId: "converted", userRequest: "Review.", timestamp: 1 })
    const joinEntry = (nodeId: string, mapId: string) => makeEntry({ entryId: `${nodeId}:join`, agentName: mapId, definitionId: mapId, workflowDefinitionId: "converted", writes: [{ id: mapId, lifetime: "transient" }], handoff: { map: mapId } })
    accumulator.accumulate(joinEntry("converted:node:2", "reviews"))
    accumulator.accumulate(joinEntry("converted:node:3", "others"))
    const reads = (workflow: WorkflowDefinition, definitionId: string) => resolveWorkflowAgents(workflow).get(definitionId)?.reads ?? []
    const shiftedReader = accumulator.getContext({ attemptId: "converted:node:4:attempt:1", nodeId: "converted:node:4", scope: { _tag: "workflow" }, reads: reads(shifted.workflow, "x") })
    expect(shiftedReader.reads.map(({ id, entry }) => [id, entry.entryId])).toEqual([["r", "converted:node:2:join"]])

    // A read of a loop over a map read the loop's entry of every round.
    const looped = await launch(stepFile(
      { s: listed("s"), hunt: listed("hunt", "site"), report: step("report", { reads: ["finds"] }) },
      [
        { step: "s" },
        { while: "finds.kept", maxIterations: 3, do: { map: "s.findings", id: "finds", do: "hunt", join: { reducer: "dedupe", with: { items: "findings", by: "site" } } } },
        { step: "report" },
      ],
    ))
    const rounds = createContextAccumulator()
    rounds.seedInput({ workflowDefinitionId: "converted", userRequest: "Hunt.", timestamp: 1 })
    rounds.accumulate(joinEntry("converted:node:2", "finds"))
    const loopReader = rounds.getContext({ attemptId: "converted:node:3:attempt:1", nodeId: "converted:node:3", scope: { _tag: "workflow" }, reads: reads(looped.workflow, "report") })
    expect(loopReader.reads.map(({ id, entry }) => [id, entry.entryId])).toEqual([["hunt", "converted:node:2:join"]])
  })

  it("runs a step at a second place by name, under a fresh record key", async () => {
    const { workflow } = await launch(stepFile({ a: step("a"), b: step("b") }, [{ step: "a" }, { step: "b" }, { step: "a" }]))
    expect(workflow.phases).toEqual([{ phase: "a", name: "a", brief: "Do a." }, { phase: "b", name: "b", brief: "Do b." }, { phase: "a-2", name: "a", runs: "a" }])
  })

  it("keeps the model and effort of each step of a session file", async () => {
    const { workflow } = await launch(stepFile({ a: step("a", { model: "mid", effort: "low" }) }, [{ step: "a" }]))
    expect(workflow.phases).toEqual([{ phase: "a", name: "a", brief: "Do a.", model: "mid", effort: "low" }])
  })

  it.each([
    [{ file: "briefs/fixture.work.md" }, 'runs brief "work", which this file does not hold'],
    [{ name: "Work", external: { skill: "fixture.root", arguments: ["old"], allowedChildSkills: [], artifactRedirect: { fromPath: "old.md", toDir: "result" } }, output: { summary: "Done." } }, "a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [fixture.root]"],
  ])("refuses a saved step that runs content outside the file", async (record, refusal) => {
    const sessionDir = realpathSync(temporary("flywheel-retired-content-"))
    mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true })
    const result = await loadPathWorkflow({ path: "scratch/workflows/converted.workflow.yaml", savedContent: stepFile({ work: record }, [{ step: "work" }]), sessionDir, revision, authority: fullAuthority() })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("retired content launched")
    expect(result.diagnostics?.map(({ message }) => message).join("\n")).toContain(refusal)
  })

  it("drops a retired toolScoping key of a step with a warning at its step key path", async () => {
    const { workflow, warnings } = await launch(stepFile({ a: step("a", { toolScoping: { read: true } }) }, [{ step: "a" }]))
    expect(workflow.phases).toEqual([{ phase: "a", name: "a", brief: "Do a." }])
    expect(warnings.map(({ keyPath }) => keyPath)).toEqual(["(root)", "steps.a.toolScoping"])
  })

  it("renames the retired guardrail keys", async () => {
    const { workflow, warnings } = await launch(stepFile({ a: step("a") }, [{ step: "a" }], { guardrails: { max_queue_length: 40, max_session_inserts: 10 } }))
    expect(workflow.guardrails).toMatchObject({ max_attempts: 40, max_inserts: 10 })
    expect(conversionWarning(warnings)).toBe(warningOf(["steps and flow became phases", "guardrails.max_queue_length became max_attempts", "guardrails.max_session_inserts became max_inserts"]))
  })

  // The shipped plan contract renamed its list from phases to milestones, so
  // a loop over the plan reads the list by its current name. The plan's list
  // declares no max, which a `for` never needed, so the repeat holds as many
  // items as the plan has when it opens, within the attempt limit.
  it("reads the plan list of the shipped plan contract as milestones, and repeats over it without a declared max", () => {
    const { workflow, warnings, control } = launchProject(stepFile({ plan: step("plan", { output: "bundled:contracts/implementation-plan.json" }), work: step("work") }, [{ step: "plan" }, { for: "plan.phases", do: "work" }]))
    expect(workflow.phases[1]).toMatchObject({ repeat: { each: "plan.milestones" } })
    expect(conversionWarning(warnings)).toBe(warningOf(["steps and flow became phases", '"plan.phases" became "plan.milestones", the list of the shipped plan contract']))
    expect(control.graph.nodes.find(({ kind }) => kind === "repeat")).toMatchObject({ loop: { _tag: "each", source: { field: "milestones" }, width: null } })
  })

  it("drops a step that no flow entry runs, and names it", async () => {
    const { workflow, warnings } = await launch(stepFile({ a: step("a"), spare: step("spare") }, [{ step: "a" }]))
    expect(workflow.phases).toEqual([{ phase: "a", name: "a", brief: "Do a." }])
    expect(conversionWarning(warnings)).toBe(warningOf(["steps and flow became phases", 'unused step "spare" dropped']))
  })

  it("launches the stream-review session file of a build before phases", async () => {
    const { workflow, warnings } = await launch(readFileSync(join(FIXTURES, "step-grammar/stream-review.workflow.yaml"), "utf8"))
    expect(workflow.phases.map((phase) => "phase" in phase ? [phase.phase, phase.over ?? null, phase.if ?? null] : [])).toEqual([
      ["scope", null, null], ["review", "input.files", null], ["check", "review", null], ["confirm", "check.kept", null], ["report", null, null], ["follow", null, "report.follow_up"],
    ])
    expect(conversionWarning(warnings)).toBe(warningOf([
      "steps and flow became phases",
      'map "confirms": join: { reducer: collect } was dropped, because collect is the default',
      'then "follow" became phase "follow" with if: report.follow_up',
    ]))
    // Its phase-grammar twin is the workflow that the conversion gives.
    const twin = await launch(readFileSync(join(FIXTURES, "../authored-workflows/phase-grammar/stream-review.workflow.yaml"), "utf8"))
    expect(twin.warnings).toEqual([])
    expect(twin.workflow.phases).toEqual(workflow.phases)
  })

  // A bindings file converts twice in one pass, bindings to steps and steps
  // to phases, and each conversion names its changes in its own warning.
  it("launches retained project bindings after two conversions and refuses retired shipped briefs", () => {
    const withGsd = testSkillRevision([...revision.skills.skills.values(), ...GSD_SKILLS.map((id) => testSkill(id, { body: `Body of ${id}.` }))])
    const { results, errors, decoded } = loadWorkflowDefinitions(FIXTURES, "project", undefined, undefined, withGsd)
    expect(errors.map(({ message }) => message)).toEqual(['step "spec-create" names the former step skill "fly.spec-create", which Flywheel no longer ships'])
    expect([...results.keys()]).toEqual(["get-stuff-done"])
    for (const workflow of results.values()) {
      expect(verifyAuthoredWorkflow(workflow, resolveWorkflowAgents(workflow), { skills: withGsd }).result).not.toBe("invalid")
      compile(workflow, withGsd)
      expect(decoded.get(workflow.id)?.stepGrammar?.view.workflow.retiredBindings?.size).toBeGreaterThan(0)
      expect(decoded.get(workflow.id)?.stepGrammar).toBeDefined()
    }
  })

  it.each(["debug.fix", "debug.investigate", "debug.verify", "fly.implement", "fly.raindrop-audit", "fly.spec-create", "fly.spec-review", "qa.review-fixes", "qa.surface-map", "qa.test-fix-surface"])("names the retired brief %s in phase and step file refusals", (id) => {
    for (const content of [
      JSON.stringify({ id: "converted", name: "Converted", phases: [{ phase: "work", runs: id }] }),
      stepFile({ work: { file: `bundled:steps/${id}.md` } }, [{ step: "work" }]),
    ]) {
      const dir = temporary("flywheel-retired-brief-")
      writeFileSync(join(dir, "converted.yaml"), content)
      const result = loadWorkflowDefinitions(dir, "project", undefined, undefined, revision.skills)
      expect(result.results.size).toBe(0)
      expect(result.errors.map(({ message }) => message)).toEqual([`Workflow "converted" agent "work": runs brief "${id}", which Flywheel no longer ships; write the brief inline`])
    }
    // A kept copy of the retired workflow names each brief by its phase.
    const [workflowId, phase] = id.split(/\.(.*)/)
    const dir = temporary("flywheel-retired-brief-")
    writeFileSync(join(dir, `${workflowId}.yaml`), JSON.stringify({ id: workflowId, name: "Kept", phases: [{ phase }] }))
    const kept = loadWorkflowDefinitions(dir, "project", undefined, undefined, revision.skills)
    expect(kept.errors.map(({ message }) => message)).toEqual([`Workflow "${workflowId}" agent "${phase}": runs brief "${id}", which Flywheel no longer ships; write the brief inline`])
  })
})
