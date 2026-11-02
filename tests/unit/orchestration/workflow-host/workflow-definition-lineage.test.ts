import { describe, expect, it } from "bun:test"
import { hashContent } from "../../../../src/workflows/definition-hash.js"
import { buildWorkflowDefinitionLineageFacts } from "../../../../src/orchestration/workflow-host/definition-lineage.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testDependencyWorkflow, withTestExternalSkills } from "../../../helpers/skill-fixtures.js"

describe("workflow definition lineage", () => {
  it("records external dependencies of a conditional inline brief", () => {
    const workflow = testDependencyWorkflow()
    const skills = withTestExternalSkills(repoDefinitions().skills(), ["fixture.root", "fixture.child"])
    const agents = resolveWorkflowAgents(workflow)

    const facts = buildWorkflowDefinitionLineageFacts({
      workflow,
      agents: [...agents.values()],
      skills,
      attempts: [],
      userRequestSha256: hashContent("Implement the task").sha256,
      worstCaseAttempts: 0,
      verification: null,
      warnings: [],
    })
    const loadedAgentIds = facts.flatMap((fact) =>
      fact.type === "definition.loaded" && fact.payload.kind === "agent" ? [fact.payload.id] : [],
    )

    expect(loadedAgentIds).toContain("follow")
    const loadedSkillIds = facts.flatMap((fact) =>
      fact.type === "definition.loaded" && fact.payload.kind === "skill" ? [fact.payload.id] : [],
    )
    expect(loadedSkillIds).toEqual(expect.arrayContaining(["fixture.root", "fixture.child"]))
  })
})
