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

function subagentRun(name: string) {
  const persona = revision.personas.get(name)
  if (persona === undefined) throw new Error(`persona ${name} is not installed`)
  const deps = makeDeps({ agentRegistry: revision.personas, skills: revision.skills })
  const prepared = prepareSubagentTools({ agent: persona, context: makeContext(), deps, childDepth: 1 })
  if (!prepared.ok) throw new Error(prepared.error.content)
  return { persona, ...prepared }
}

function workflowRun(name: string) {
  const workflow = Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
    id: "review", name: "Review",
    phases: [{ phase: "review", persona: name, brief: "Review the change.", name: "Review", writes: [] }],
  })
  const agent = resolveWorkflowAgents(workflow).get("review")
  if (agent === undefined) throw new Error("the review agent did not resolve")
  const run = agentPersonaRun({ agent, personas: revision.personas, skills: revision.skills, sessionMessaging: false })
  if (run === undefined) throw new Error("the review agent runs no persona")
  return run
}

describe("a workflow agent that runs as a persona", () => {
  it.each(["reviewer-code-security", "reviewer-code-elegance", "implementer"].filter((name) => revision.personas.get(name)?.kind === "persona"))(
    "gets the instructions, tools, tool rules, shell, turn limit, and role of a %s subagent",
    (name) => {
      const subagent = subagentRun(name)
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

  it("does not get the advisor default when it runs as the advisor, so the advisor stays a leaf", () => {
    const run = workflowRun("advisor")
    expect([...run.allowedSubagentTypes]).toEqual([])
    expect(run.toolGrant).toEqual(subagentRun("advisor").toolNames)
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
