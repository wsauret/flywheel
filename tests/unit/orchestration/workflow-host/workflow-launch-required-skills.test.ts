import { describe, expect, it } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prepareWorkflowLaunch, WorkflowRequiredSkillsMissingError } from "../../../../src/orchestration/workflow-host/publish.js"
import { hashContent } from "../../../../src/workflows/definition-hash.js"
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../../helpers/project-definitions.js"
import { renderSkillContext } from "../../../../src/workflows/skill-context.js"
import { publishSkillRevision } from "../../../../src/workflows/skill-schema.js"
import { makeWorkflowDeps } from "./_workflow-controller-fixtures.js"
import { testDependencyWorkflow, withTestExternalSkills } from "../../../helpers/skill-fixtures.js"

/** The fixture workflow's briefs compose these packages into the launch. */
const REQUIRED = ["root-cause-analysis", "test-driven-development"] as const

/** Never created: persona resolution under it sees no `.flywheel/agents`, so
 *  the launch check under test is the skill-closure one, not a persona surprise. */
const PROJECT_CWD = join(tmpdir(), "flywheel-launch-required-skills-none")

function revisionWithout(...removed: readonly string[]): ReturnType<typeof publishSkillRevision> {
  const published = fixtureDefinitions().skills()
  const skills = new Map(published.skills)
  for (const id of removed) skills.delete(id)
  return publishSkillRevision(published.revision + 1, skills)
}

function definitionRevision(skills: ReturnType<typeof publishSkillRevision>) {
  return { ...fixtureDefinitions().captureRevision(), skills }
}

const EXTERNAL_IDS = ["fixture.root", "fixture.child"] as const
const EXTERNAL_WORKFLOW = testDependencyWorkflow()
const externalRevision = (skills: ReturnType<typeof publishSkillRevision>) => ({
  ...definitionRevision(skills),
})

describe("workflow launch required skills", () => {
  // No persona requires root-cause-analysis, so the brief closure check owns this refusal.
  it("refuses to publish when the captured revision no longer installs a required package", async () => {
    const launch = prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: workflowIn(definitionRevision(revisionWithout("root-cause-analysis")), FIXTURE_WORKFLOW_ID),
      description: "launch without the root-cause-analysis package",
      deps: makeWorkflowDeps(),
      projectRoot: PROJECT_CWD,
      definitionRevision: definitionRevision(revisionWithout("root-cause-analysis")),
    })

    await expect(launch).rejects.toBeInstanceOf(WorkflowRequiredSkillsMissingError)
    await expect(launch).rejects.toThrow(
      'Workflow "repair" agent "investigate" requires skill "root-cause-analysis", which is not installed',
    )
  })

  it("pins the rendered context of every required package from the revision it validated", async () => {
    const skills = fixtureDefinitions().skills()

    const prepared = await prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: workflowIn(definitionRevision(skills), FIXTURE_WORKFLOW_ID),
      description: "launch with every package installed",
      deps: makeWorkflowDeps(),
      projectRoot: PROJECT_CWD,
      definitionRevision: definitionRevision(skills),
    })

    const initialized = prepared.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
    if (initialized?.type !== "workflow.control.initialized") throw new Error("launch published no control fact")
    const pinned = new Map(initialized.payload.control.definitionIdentity.skills.map(({ skillId, sha256 }) => [skillId, sha256]))
    for (const id of REQUIRED) {
      const skill = skills.skills.get(id)
      if (!skill) throw new Error(`bundled package not installed: ${id}`)
      expect(pinned.get(id)).toBe(hashContent(renderSkillContext(skill)).sha256)
    }
  })

  it("refuses a missing external dependency before publication", async () => {
    await expect(prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: EXTERNAL_WORKFLOW,
      description: "external launch",
      deps: makeWorkflowDeps(),
      projectRoot: PROJECT_CWD,
      definitionRevision: externalRevision(fixtureDefinitions().skills()),
    })).rejects.toThrow('Workflow "external-fixture" agent "follow" requires skill "fixture.root", which is not installed')
  })

  it("checks every external dependency before publication", async () => {
    const skills = withTestExternalSkills(fixtureDefinitions().skills(), ["fixture.root"])
    await expect(prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: EXTERNAL_WORKFLOW,
      description: "external launch",
      deps: makeWorkflowDeps(),
      projectRoot: PROJECT_CWD,
      definitionRevision: externalRevision(skills),
    })).rejects.toThrow('Workflow "external-fixture" agent "follow" requires skill "fixture.child", which is not installed')
  })

  it("pins external dependency package bytes", async () => {
    const skills = withTestExternalSkills(fixtureDefinitions().skills(), EXTERNAL_IDS)
    const prepared = await prepareWorkflowLaunch({
      authProfileId: "default",
      workflow: EXTERNAL_WORKFLOW,
      description: "external launch",
      deps: makeWorkflowDeps(),
      projectRoot: PROJECT_CWD,
      definitionRevision: externalRevision(skills),
    })
    const initialized = prepared.workflowFacts.find(({ type }) => type === "workflow.control.initialized")
    if (initialized?.type !== "workflow.control.initialized") throw new Error("launch published no control fact")
    const pinned = new Map(initialized.payload.control.definitionIdentity.skills.map(({ skillId, sha256 }) => [skillId, sha256]))
    for (const id of EXTERNAL_IDS) {
      const skill = skills.skills.get(id)
      if (!skill) throw new Error(`synthetic package not installed: ${id}`)
      expect(pinned.get(id)).toBe(hashContent(renderSkillContext(skill)).sha256)
    }
    const loadedSkillIds = prepared.workflowFacts.flatMap((fact) =>
      fact.type === "definition.loaded" && fact.payload.kind === "skill" ? [fact.payload.id] : [],
    )
    expect(loadedSkillIds).toEqual(expect.arrayContaining(EXTERNAL_IDS))
  })

})
