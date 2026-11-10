import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { agentPersonaRun } from "../../../../src/orchestration/workflow-host/agent-persona.js"
import { agentPersonas, frontendAttempts } from "../../../../src/orchestration/workflow-host/frontend-attempts.js"
import { parentRoleId } from "../../../../src/orchestration/config/roles.js"
import type { DefinitionLineageView } from "../../../../src/workflows/definition-provenance-projection.js"
import type { AttemptRow } from "../../../../src/workflows/view/types.js"
import { prepareSubagentTools } from "../../../../src/orchestration/modules/subagents/execution/dispatch-preparation.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { WorkflowDefinitionSchema } from "../../../../src/workflows/workflow-schema.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { composeFirstPartyModules, type ModuleId } from "../../../../src/orchestration/modules.js"
import { definitionAvailabilityOf } from "../../../../src/orchestration/app-service/definition-availability.js"
import { agentCapabilityCheck } from "../../../../src/orchestration/agent-runtime/capability-checks.js"
import { makeContext, makeDeps } from "../agent-runtime/subagent/_fixtures.js"

// A workflow agent whose record names a persona gets what a dispatch of
// that persona as a subagent gets: the persona's instructions with the
// context of its required skills, its tools and their rules, its read-only
// shell, its turn limit, and its role (docs/terminology.md "persona"). Only the brief,
// the item, and the subagent's own closure and handoff sections differ.

const revision = repoDefinitions().captureRevision()

/** The sections of one task, split at each heading. */
const sections = (text: string): readonly string[] => text.split(/\n\n(?=#{1,2} )/)

/** The sections of a subagent task that only a subagent reads: the closure
 *  of a delegated subtask and the handoff to its parent. A workflow agent's
 *  brief and output contract take their place. */
const SUBAGENT_ONLY = ["# Delegated Subtask", "## Closure", "## Turn Economy", "## Handoff"]

async function subagentRun(name: string) {
  const persona = revision.personas.get(name)
  if (persona === undefined) throw new Error(`persona ${name} is not installed`)
  const deps = makeDeps({ agentRegistry: revision.personas, skills: revision.skills })
  const prepared = await prepareSubagentTools({ agent: persona, context: makeContext(), deps, childDepth: 1 })
  if (!prepared.ok) throw new Error(prepared.error.content)
  return { persona, ...prepared }
}

function workflowRun(name: string, disabledModuleIds: readonly ModuleId[] = [], planRuns: (tool: string) => boolean = () => true, disabledTypes: readonly string[] = [], subagents: readonly string[] = []) {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "review", name: "Review",
    phases: [{ phase: "review", persona: name, brief: "Review the change.", name: "Review", writes: [], ...subagents.length > 0 ? { subagents } : {} }],
  })
  const agent = resolveWorkflowAgents(workflow).get("review")
  if (agent === undefined) throw new Error("the review agent did not resolve")
  const modules = composeFirstPartyModules(undefined, disabledModuleIds)
  const availability = definitionAvailabilityOf(revision, modules.enabledModuleIds, disabledTypes)
  const run = agentPersonaRun({ agent, availability, skills: revision.skills, sessionMessaging: false, modules })
  if (run === undefined) throw new Error("the review agent runs no persona")
  // The check of an agent that can call each tool of its grant that its run's plan runs (`planRuns`).
  return { ...run, instructions: run.instructions(agentCapabilityCheck(new Set(run.toolGrant.filter(planRuns)), availability, run.allowedSubagentTypes)) }
}

describe("a workflow agent that runs as a persona", () => {
  it.each(["reviewer-code-security", "reviewer-code-elegance", "implementer"].filter((name) => revision.personas.get(name)?.kind === "persona"))(
    "gets the instructions, tools, tool rules, shell, turn limit, and role of a %s subagent",
    async (name) => {
      const subagent = await subagentRun(name)
      const run = workflowRun(name)
      // The trial advisor default adds the advisor and the dispatch pair it needs.
      expect(run.allowedSubagentTypes.has("advisor")).toBe(true)
      expect(run.toolGrant).toEqual([...new Set([...subagent.toolNames, "subagent", "process"])])
      expect(run.maxTurns).toBe(subagent.maxTurns)
      expect(run.role).toBe(subagent.persona.kind === "persona" ? subagent.persona.role : "")
      expect(run.readOnly).toBe(!subagent.toolNames.some((tool) => tool === "write" || tool === "edit"))
      const [instructions = "", template = ""] = subagent.task.split("\n\n---\n\n")
      expect(sections(run.instructions)).toEqual([
        ...sections(instructions),
        ...sections(template).filter((section) => !SUBAGENT_ONLY.some((heading) => section.startsWith(`${heading}\n`))),
      ])
    },
  )

  it("does not get the advisor default when it runs as the advisor, so the advisor stays a leaf", async () => {
    const run = workflowRun("advisor")
    expect([...run.allowedSubagentTypes]).toEqual([])
    expect(run.toolGrant).toEqual((await subagentRun("advisor")).toolNames)
  })

  it("never runs as a persona whose agent type is off, and says how to turn the type on", () => {
    expect(() => workflowRun("reviewer-code-quality", [], () => true, ["reviewer"])).toThrow(
      'runs as persona "reviewer-code-quality", which cannot run: agent type reviewer is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on',
    )
    expect(workflowRun("reviewer-code-quality", [], () => true, ["explorer"]).role).toStartWith("reviewer")
  })

  it("gets no advisor default and no granted type while that type is off, and keeps the rest of its grant", () => {
    const all = workflowRun("implementer")
    expect([...all.allowedSubagentTypes].sort()).toEqual(["advisor", "explorer"])
    expect([...workflowRun("implementer", [], () => true, ["advisor"]).allowedSubagentTypes]).toEqual(["explorer"])
    const leaf = workflowRun("implementer", [], () => true, ["advisor", "explorer"])
    expect([...leaf.allowedSubagentTypes]).toEqual([])
    expect(leaf.toolGrant).not.toContain("subagent")
  })

  it("keeps an authored grant of a type that is off out of its dispatch set and tools", () => {
    expect([...workflowRun("advisor", [], () => true, [], ["explorer"]).allowedSubagentTypes]).toEqual(["explorer"])
    const off = workflowRun("advisor", [], () => true, ["explorer"], ["explorer"])
    expect([...off.allowedSubagentTypes]).toEqual([])
    expect(off.toolGrant).not.toContain("subagent")
  })

  it("runs with only the declared tools whose modules are on, and states no rule or line for a tool it lost", () => {
    const all = workflowRun("implementer")
    const withoutBash = workflowRun("implementer", ["bash"])
    expect(all.toolGrant).toContain("bash")
    expect(all.instructions).toContain("## Git Discipline")
    expect(withoutBash.toolGrant).toEqual(all.toolGrant.filter((tool) => tool !== "bash"))
    expect(withoutBash.instructions).not.toContain("## Git Discipline")
    // The Git rule follows the run's planned check, not the grant: a tree that
    // captured Bash off leaves bash in the grant and out of the plan.
    const bashUnplanned = workflowRun("implementer", [], (tool) => tool !== "bash")
    expect(bashUnplanned.toolGrant).toContain("bash")
    expect(bashUnplanned.instructions).not.toContain("## Git Discipline")
    const FILE_TOOLS_LINE = "- Use the read, file edit, and write tools for project files; shell sed, cat, and heredoc scripts are not substitutes."
    const SEARCH_LINE = "- Use the search and list tools to find project files and text; shell grep and ls are not substitutes."
    expect(all.instructions).toContain(FILE_TOOLS_LINE)
    expect(all.instructions).toContain(SEARCH_LINE)
    const withoutDiscovery = workflowRun("implementer", ["discovery"])
    expect(withoutDiscovery.toolGrant).not.toContain("search")
    expect(withoutDiscovery.instructions).toContain(FILE_TOOLS_LINE)
    expect(withoutDiscovery.instructions).not.toContain(SEARCH_LINE)
    // With File tools off and Discovery and Bash on, the implementer is not
    // told to use file tools it lacks, nor that its shell is no substitute.
    const withoutFileTools = workflowRun("implementer", ["file-tools"])
    expect(withoutFileTools.toolGrant).not.toContain("read")
    expect(withoutFileTools.toolGrant).toContain("bash")
    expect(withoutFileTools.instructions).not.toContain(FILE_TOOLS_LINE)
    expect(withoutFileTools.instructions).toContain("- Read and change project files with the tools you hold.")
    expect(withoutFileTools.instructions).toContain(SEARCH_LINE)
  })
})

describe("the attempts a client reads", () => {
  it("name the persona of each agent record with the roles whose seats the runtime reads for it, and an agent without a persona names none", () => {
    const record = (definitionId: string, persona?: string): DefinitionLineageView["definitions"][string] => ({
      kind: "agent", id: definitionId,
      definition: { definitionId, briefId: definitionId, source: "inline", policy: { definitionId, ...(persona === undefined ? {} : { persona }) }, output: {} },
    })
    const personas = agentPersonas({ definitions: { review: record("review", "reviewer-code-quality"), notes: record("notes") } })
    const quality = revision.personas.get("reviewer-code-quality")
    const role = quality?.kind === "persona" ? quality.role : undefined
    if (role === undefined) throw new Error("the reviewer-code-quality persona names no role")
    const parent = parentRoleId(role)
    expect(personas.get("review")).toEqual({ id: "reviewer-code-quality", roles: parent === undefined ? [role] : [role, parent] })
    expect(personas.has("notes")).toBe(false)
    const attempt = (definitionId: string, status: AttemptRow["status"]): AttemptRow => ({
      id: `${definitionId}:attempt:1`, definitionId, briefId: definitionId, workflowDefinitionId: "review", name: definitionId, status, writes: [], resumeRevertCount: 0,
    })
    const [review, notes] = frontendAttempts({ attempts: [attempt("review", "running"), attempt("notes", "pending")] }, personas)
    expect(review?.persona).toEqual(personas.get("review"))
    expect(notes).not.toHaveProperty("persona")
  })
})
