import { describe, expect, it } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js"
import { eligibleLearnedSkills } from "../../../src/orchestration/modules/learning/learned-skill-eligibility.js"
import { LEGACY_WORKFLOW_BINDINGS } from "../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-step-content-pins.js"
import { installedPersonaToolEntries } from "../../../src/orchestration/tool-catalog.js"
import { createProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js"
import { loadWorkflowDefinitions } from "../../helpers/workflow-files.js"
import { retiredHandoffContract } from "../../../src/workflows/retired-handoff-contracts.js"
import { decodeRetiredBinding, formerStepSkillWarnings, retiredBindingSha256 } from "../../../src/workflows/retired-bindings.js"
import { workflowBriefs } from "../../../src/workflows/brief.js"
import { agentRecords, type WorkflowDefinition } from "../../../src/workflows/workflow-schema.js"
import type { StepGrammarWorkflow } from "../../../src/workflows/retired-step-grammar/schema.js"
import { temporaryDirectories, testDirectories } from "../../helpers/directories.js"
import { repoDefinitions, repoModules } from "../../helpers/project-definitions.js"
import { testSkill, testSkillRevision, withTestExternalSkills } from "../../helpers/skill-fixtures.js"

/** Two saved files in the retired bindings form, as the last pre-cutover
 *  build read them: the shipped implement workflow, and the retired GSD
 *  workflow, whose steps name custom skills and whose phase loop ran a
 *  reassessment after each phase. */
const FIXTURES = join(import.meta.dir, "../../fixtures/retired-workflows")
const GSD_SKILLS = ["gsd.spec-create", "gsd.spec-review", "gsd.implement", "gsd.reassess", "gsd.verify-acceptance"]
const temporary = temporaryDirectories()

function loadFixtures() {
  const skills = testSkillRevision(GSD_SKILLS.map((id) => testSkill(id, { body: `Body of ${id}.` })))
  return loadWorkflowDefinitions(FIXTURES, "project", undefined, undefined, skills)
}

function loaded(id: string): WorkflowDefinition {
  const workflow = loadFixtures().results.get(id)
  if (!workflow) throw new Error(`fixture ${id} did not load`)
  return workflow
}

/** The step-grammar record that the bindings conversion wrote, which the
 *  definition keeps for the identity proofs of a paused run. */
function stepView(workflow: WorkflowDefinition | undefined): StepGrammarWorkflow {
  const view = workflow?.retiredStepGrammar?.workflow
  if (!view) throw new Error("a converted file keeps its step-grammar record")
  return view
}

describe("a saved workflow file in the retired bindings form", () => {
  // A bindings file converts twice in one pass: its bindings to the step
  // grammar, and the step grammar to phases. Each conversion names what it
  // changed in its own warning.
  it("records each conversion of retained bindings and refuses the retired implement fixture", () => {
    const { errors, decoded } = loadFixtures()
    expect(errors.map(({ message }) => message)).toEqual(['step "spec-create" names the former step skill "fly.spec-create", which Flywheel no longer ships'])
    expect(decoded.get("get-stuff-done")?.stepGrammar?.view.workflow.retiredBindings?.size).toBeGreaterThan(0)
    expect(decoded.get("get-stuff-done")?.stepGrammar?.notes).toContain("steps and flow became phases")
  })

  it("keeps each original custom binding and its pinned hash", () => {
    const bindings = LEGACY_WORKFLOW_BINDINGS.debug.map((pin) => ({
      ...pin, skillId: `custom.${pin.bindingId}`,
    }))
    const skills = testSkillRevision(bindings.map(({ skillId }) => testSkill(skillId)))
    const result = loadSaved([
      "bindings:",
      ...bindings.map((pin) => `  ${pin.bindingId}: ${JSON.stringify({
        skill: pin.skillId, handoff: pin.handoff, toolScoping: pin.toolScoping,
        writes: [{ id: pin.bindingId, lifetime: "durable", supersedes: [] }],
      })}`),
      "steps:", ...bindings.map(({ bindingId }) => `  - step: ${bindingId}`),
    ], skills)
    expect(result.errors).toEqual([])
    expect(result.decoded.get("custom-flow")?.stepGrammar?.view.workflow.retiredBindings?.size).toBeGreaterThan(0)
    expect(result.decoded.get("custom-flow")?.stepGrammar).toBeDefined()
    const retired = stepView(result.results.get("custom-flow")).retiredBindings
    if (!retired) throw new Error("a converted file keeps its bindings")
    const hashes = [...retired].sort(([left], [right]) => left.localeCompare(right))
      .map(([bindingId, binding]) => ({ bindingId, skillId: binding.skill, handoff: binding.handoff, toolScoping: binding.toolScoping, sha256: retiredBindingSha256(bindingId, binding) }))
    const customPins = [
      "d9b492e9d2c52a52495dbbf393276359b9edc87c853180b24c003412743a5328",
      "a55f25456bee8caad9c87ca4d19934ffa4773447220f305c94419d385a6d5c39",
      "c628b04d173495242ddb98acd1eacc5c031b4b6cdfd718904af8d235af2b5030",
    ]
    expect<unknown>(hashes).toEqual(bindings.map((binding, index) => ({
      ...binding,
      sha256: customPins[index],
    })))
    // The retired debug bindings keep the hashes that builds before the
    // retirement recorded, even though those bindings can no longer launch.
    const pins = [
      "ddf945b1f9a31de927b9cefbe24d791abdd63c5a8d10cb4629de0baa3d7249a0",
      "04bf8cc748033bebd4be6d10467081edaf344e9696f7f3601a4159d18a59ae03",
      "8fb7f1638a41f1144e7d38b5499b0874069b74dd39957a30786540a01f7b5d2e",
    ]
    expect(LEGACY_WORKFLOW_BINDINGS.debug.map((binding) => retiredBindingSha256(binding.bindingId, decodeRetiredBinding({
      skill: binding.skillId, handoff: binding.handoff, toolScoping: binding.toolScoping,
      writes: [{ id: binding.bindingId, lifetime: "durable", supersedes: [] }],
    })))).toEqual(pins)
  })

  it.each(["debug.fix", "debug.investigate", "debug.verify", "fly.implement", "fly.raindrop-audit", "fly.spec-create", "fly.spec-review", "qa.review-fixes", "qa.surface-map", "qa.test-fix-surface"])("refuses the retired binding %s by name", (id) => {
    const result = loadSaved(["bindings:", `  work: { skill: ${id} }`, "steps:", "  - step: work"])
    expect(result.results.size).toBe(0)
    expect(result.errors.map(({ message }) => message)).toEqual([`step "work" names the former step skill "${id}", which Flywheel no longer ships`])
  })

  // The shipped plan contract renamed its list from phases to milestones, so
  // the repeat over the plan reads the list by its current name.
  it("inlines a custom skill's body, keeps the skill id as the seat, and turns then into a reassess phase", () => {
    const workflow = loaded("get-stuff-done")
    const records = agentRecords(workflow)
    expect(records.get("implement")?.keys).toMatchObject({ brief: "Body of gsd.implement.", name: "gsd.implement", output: retiredHandoffContract("work-handoff") })
    expect(records.get("spec-create")?.keys).toMatchObject({ output: "bundled:contracts/implementation-plan.json" })
    expect(records.get("reassess")?.keys).not.toHaveProperty("output")
    expect(Object.values(stepView(workflow).steps).some((step) => "selfReview" in step)).toBe(false)
    expect(workflow.phases).toContainEqual(expect.objectContaining({ repeat: { each: "spec-review.milestones", reassess: "reassess" } }))
    expect(workflowBriefs(workflow).get("reassess")?.reassesses).toBe(true)
    expect(workflowBriefs(workflow).get("implement")?.briefId).toBe("gsd.implement")
  })

  it("refuses a retained external binding with the inline-brief alternative", () => {
    const dir = temporary("flywheel-retired-external-")
    writeFileSync(join(dir, "audit.yaml"), [
      "id: audit", "name: Audit", "confirmation_template: spec-and-implement",
      "bindings:", "  review:", "    skill: acme.audit", "    handoff: review-handoff", "    external: true", "    allowedChildSkills: [acme.child]",
      "steps:", "  - step: review",
    ].join("\n"))
    const result = loadWorkflowDefinitions(dir, "project")
    expect(result.results.size).toBe(0)
    expect(result.errors[0]?.message).toContain("a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [acme.audit]")
  })

  it("reports a load error that names the binding when its skill is not installed", () => {
    const dir = temporary("flywheel-retired-missing-")
    writeFileSync(join(dir, "lost.yaml"), ["id: lost", "name: Lost", "confirmation_template: spec-and-implement", "bindings:", "  work:", "    skill: acme.gone", "steps:", "  - step: work"].join("\n"))
    const result = loadWorkflowDefinitions(dir, "project")
    expect(result.results.size).toBe(0)
    expect(result.errors.map(({ message }) => message)).toEqual([`step "work" names skill "acme.gone", which is not installed`])
  })
})

/** Write one saved file in the bindings form and load it with these project
 *  skills installed. */
function loadSaved(lines: readonly string[], skills = testSkillRevision([testSkill("my.plan"), testSkill("my.fix")])) {
  const dir = temporary("flywheel-retired-saved-")
  writeFileSync(join(dir, "custom-flow.yaml"), ["id: custom-flow", "name: Custom", ...lines].join("\n"))
  return loadWorkflowDefinitions(dir, "project", undefined, undefined, skills)
}

describe("a saved file in a shape the last pre-cutover build loaded", () => {
  it("refuses an external binding in a for then slot with the inline-brief alternative", () => {
    const result = loadSaved([
      "bindings:",
      "  plan: { skill: my.plan, handoff: spec-handoff, writes: [plan-doc] }",
      "  work: { skill: my.fix, handoff: work-handoff, writes: [impl] }",
      "  ext: { skill: ce.upstream, external: true, handoff: reassessment-handoff, writes: [reassessment] }",
      "steps:", "  - step: plan", "  - for: plan.phases", "    do: work", "    then: ext",
    ])
    expect(result.results.size).toBe(0)
    expect(result.errors[0]?.message).toContain("a workflow no longer runs a skill as a brief; write the brief inline and add dependencies: [ce.upstream]")
  })

  it("reads an empty binding name as no name, as the step then takes its content's name", () => {
    const result = loadSaved([
      "bindings:",
      "  plan: { skill: my.plan, name: \"\" }",
      "  work: { skill: my.fix, name: \"\" }",
      "steps:", "  - step: plan", "  - step: work",
    ], testSkillRevision([testSkill("my.plan"), testSkill("my.fix", { name: "Fix" })]))
    expect(result.errors).toEqual([])
    const workflow = result.results.get("custom-flow")
    if (!workflow) throw new Error("custom-flow did not load")
    const contents = workflowBriefs(workflow)
    expect(stepView(workflow).retiredBindings?.get("plan")).toMatchObject({ name: "" })
    expect(contents.get("plan")).toMatchObject({ procedure: { name: "my.plan" } })
    expect(contents.get("work")).toMatchObject({ procedure: { name: "Fix" } })
  })

  it("keeps a bound skill with an empty body, whose step then has no instruction text", () => {
    const result = loadSaved(["bindings:", "  plan: { skill: my.plan }", "steps:", "  - step: plan"], testSkillRevision([testSkill("my.plan", { body: "" })]))
    expect(result.errors).toEqual([])
    const workflow = result.results.get("custom-flow")
    if (!workflow) throw new Error("custom-flow did not load")
    expect(agentRecords(workflow).get("plan")?.keys).toMatchObject({ brief: "" })
    expect(workflowBriefs(workflow).get("plan")).toMatchObject({ procedure: { body: "" } })
  })

  it("keeps a bound skill body verbatim, with a reference marker that names no shared reference", () => {
    const body = "Fill the {{ref:changelog}} section of the release notes."
    const result = loadSaved(["bindings:", "  plan: { skill: my.plan }", "steps:", "  - step: plan"], testSkillRevision([testSkill("my.plan", { body })]))
    expect(result.errors).toEqual([])
    const workflow = result.results.get("custom-flow")
    expect(workflow && workflowBriefs(workflow).get("plan")).toMatchObject({ procedure: { body } })
  })

  it("expands a reference marker that names a shared reference, as the last pre-cutover build did at prompt time", () => {
    const result = loadSaved(["bindings:", "  plan: { skill: my.plan }", "steps:", "  - step: plan"], testSkillRevision([testSkill("my.plan", { body: "Review.\n\n{{ref:reviewer-protocol}}" })]))
    expect(result.errors).toEqual([])
    const workflow = result.results.get("custom-flow")
    const content = workflow && workflowBriefs(workflow).get("plan")
    const body = content?.procedure.body ?? ""
    expect(body.startsWith("Review.\n\n")).toBe(true)
    expect(body).not.toContain("{{ref:")
  })
})

describe("learned skill maintenance", () => {
  it("can maintain a managed project skill named in a retained bindings file", () => {
    const root = temporary("flywheel-retired-learned-")
    mkdirSync(join(root, ".flywheel", "workflows"), { recursive: true })
    mkdirSync(join(root, "skills", "my.plan"), { recursive: true })
    writeFileSync(join(root, "skills", "my.plan", "SKILL.md"), ["---", "name: my.plan", "description: Plan the work.", "managed: flywheel", "---", "", "Plan the work carefully."].join("\n"))
    writeFileSync(join(root, ".flywheel", "workflows", "custom-flow.yaml"), [
      "id: custom-flow", "name: Custom", "bindings:", "  plan: { skill: my.plan, handoff: spec-handoff }", "steps:", "  - step: plan",
    ].join("\n"))
    const definitions = createProjectDefinitionRegistry({
      ...testDirectories(root),
      skillRoots: [{ dir: join(root, "skills"), owned: true, reach: "project" }],
      bundles: installedDefinitionBundles(repoModules),
      personaToolEntries: installedPersonaToolEntries(),
    })
    const revision = definitions.captureRevision()
    expect(revision.skills.skills.get("my.plan")?.managed).toBe("flywheel")
    const eligible = eligibleLearnedSkills({ revision: revision.skills, projectRoot: root, reach: "project" })
    expect(eligible.map(({ definition }) => definition.id)).toEqual(["my.plan"])
  })
})

describe("formerStepSkillWarnings", () => {
  it("warns for each installed skill with a former step id", () => {
    const skills = withTestExternalSkills(testSkillRevision([]), ["fly.implement", "debug.fix", "qa.surface-map", "fly.raindrop-audit", "acme.other"])
    const warnings = formerStepSkillWarnings(skills)
    expect(warnings).toHaveLength(4)
    expect(warnings[0]).toContain(`Skill "fly.implement"`)
    expect(warnings[0]).toContain("Flywheel no longer ships this brief.")
    expect(warnings[1]).toContain('Skill "debug.fix"')
    expect(warnings[1]).toContain("Flywheel no longer ships this brief.")
    expect(warnings[2]).toContain('Skill "qa.surface-map"')
    expect(warnings[2]).toContain("Flywheel no longer ships this brief.")
    expect(warnings[3]).toContain('Skill "fly.raindrop-audit"')
    expect(formerStepSkillWarnings(repoDefinitions().captureRevision().skills)).toEqual([])
  })
})
