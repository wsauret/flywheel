import { beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import type { AccumulatedContext } from "../../../../src/workflows/context-bundle/context.js"
import { resolveWorkflowAgents, type ResolvedAgent } from "../../../../src/workflows/agent-resolution.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { createAttemptExecutor } from "../../../../src/workflows/vm/attempt-runner.js"
import { createMemoryStore, initialFacts, testHost } from "./host-test-support.js"
import { testDirectories, fileTemporaryDirectory } from "../../../helpers/directories.js"

// Fixture packages live under a temp root this suite's own definition owner
// reads, so a hot reload can be simulated without touching the developer's
// install.
const ROOT = fileTemporaryDirectory("flywheel-skill-revision-pinning-test-")
const SKILL_ROOT = join(ROOT, "skills")
const PROJECT_ROOT = join(ROOT, "project")

let definitions: ProjectDefinitionRegistry | undefined

function owner(): ProjectDefinitionRegistry {
  definitions ??= createProjectDefinitionRegistry({ bundles: [],
    skillRoots: [{ dir: SKILL_ROOT, owned: true, reach: "global" }],
    ...testDirectories(PROJECT_ROOT),
  })
  return definitions
}

function installSkill(body: string, dependencies: readonly string[] = []): void {
  const dir = join(SKILL_ROOT, "alpha")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: Use when the task is about alpha.\ndependencies: ${JSON.stringify(dependencies)}\n---\n${body}`)
}

/** One step that composes the installed `alpha` package. The launch pins the
 *  revision the step composes, so a mid-run publication cannot reach it. */
const workflow: WorkflowDefinition = {
  id: "host-test",
  name: "Host test",
  phases: [{ phase: "work", brief: "Follow the alpha method.", name: "Work", dependencies: ["alpha"], writes: [] }],
}

function boundWork(): ResolvedAgent {
  const step = resolveWorkflowAgents(workflow).get("work")
  if (!step) throw new Error("fixture step work did not resolve")
  return step
}
function definitionRevision(skills: SkillRegistryRevision) {
  const revision = owner().captureRevision()
  return Object.freeze({ ...revision, skills, personas: new Map() })
}

const context: AccumulatedContext = { request: { original: "seeded", addenda: [] }, priorHandoff: null, reads: [], earlierRounds: [], artifacts: [], exclusions: [] }

function capturingAttemptExecutor(skills: SkillRegistryRevision) {
  const instructions: string[] = []
  const runner = createAttemptExecutor({
    earlierCheckpoint: async () => null,
    resolvedAgents: new Map([["work", boundWork()]]),
    context: { getContext: async () => context },
    skills,
    worker: async (_step, _userPrompt, task) => {
      instructions.push(task)
      return { output: "completed", handoffContent: { summary: "done" }, durationMs: 1 }
    },
    recordInvocation: async () => {},
  })
  return { runner, instructions }
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
  installSkill("Alpha procedure.")
  mkdirSync(PROJECT_ROOT, { recursive: true })
  owner()
})

describe("workflow skill revision pinning", () => {
  it("runs an attempt against the revision the launch pinned, not one published mid-run", async () => {
    const launchRevision = owner().skills()
    const store = createMemoryStore(initialFacts(workflow, launchRevision))
    const { runner, instructions } = capturingAttemptExecutor(launchRevision)

    installSkill("Alpha procedure, revised.")
    owner().reload()
    expect(owner().skills().revision).toBeGreaterThan(launchRevision.revision)

    const host = testHost(store, {
      workflow,
      skills: launchRevision,
      definitionRevision: definitionRevision(launchRevision),
      attemptRunner: runner,
    })
    const result = await host.run()
    await host.dispose()

    expect(result.kind).toBe("completed")
    expect(instructions[0]).toContain("Alpha procedure.")
    expect(instructions[0]).not.toContain("Alpha procedure, revised.")
  })

  it("starts no worker when resume changes the composed skill membership", async () => {
    const store = createMemoryStore(initialFacts(workflow, owner().skills()))

    const dependency = join(SKILL_ROOT, "beta")
    mkdirSync(dependency, { recursive: true })
    writeFileSync(join(dependency, "SKILL.md"), "---\ndescription: Use for the new beta dependency.\n---\nBeta procedure.")
    installSkill("Alpha procedure, revised again.", ["beta"])
    owner().reload()

    let workers = 0
    const host = testHost(store, {
      startMode: "operator_resume",
      workflow,
      skills: owner().skills(),
      definitionRevision: definitionRevision(owner().skills()),
      attemptRunner: { run: async () => { workers += 1; throw new Error("unexpected worker") } },
    })
    const result = await host.run()
    await host.dispose()

    expect(result.kind).toBe("failed")
    expect(result.kind === "failed" && result.failure.kind).toBe("definition_drift")
    expect(store.events.some(({ type }) => type === "definition.drift_rejected")).toBe(true)
    expect(workers).toBe(0)
  })
})
