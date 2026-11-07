import { describe, expect, it } from "bun:test"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { personaToolEntries } from "../../../../src/orchestration/agent-runtime/tools/tool-registry.js"
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js"
import { migrateWorkflowDefinitionIdentityPersonaShell } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-persona-shell.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { definitionIdentityMismatches } from "../../../../src/workflows/vm/definition-identity.js"
import { withDefaultAdvisor, withoutRecordedTurnCaps, withoutRetiredPromptSwitches, withoutRetiredToolSteering } from "../../../../src/workflows/vm/persona-identity-proofs.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { createToolRegistry } from "../../../../src/orchestration/tool-catalog.js"
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { beforeBudgetCut, beforeLexiconCut, beforePromptSwitchCut, beforeToolSteeringCut, personasAtCapabilityTextBase } from "./_persona-budget.js"
import { compilePreCutover } from "./_pre-cutover-control.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

/** The personas of the release realm, which the test catalog installs, as
 *  they read when the builds this pass proves recorded them. */
const personas = personasAtCapabilityTextBase(repoDefinitions().captureRevision().personas)
/** The personas of a source run, whose development module adds tools to the
 *  baseline personas, so the same persona hashes differently there. */
const sourcePersonas = personasAtCapabilityTextBase(createProjectDefinitionRegistry({
  ...testDirectories(process.cwd()),
  skillRoots: [],
  bundles: installedDefinitionBundles(repoModules),
  personaToolEntries: personaToolEntries(createToolRegistry(repoModules)),
}).captureRevision().personas)

describe("migrateWorkflowDefinitionIdentityPersonaShell", () => {
  it("lets a paused workflow recorded without the shell resume with no drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({})

    expect(migrateWorkflowDefinitionIdentityPersonaShell(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })

    expect(definitionIdentityMismatches(resumed(dbFile), compiled.definitionIdentity)).toEqual([])
    expect(migrateWorkflowDefinitionIdentityPersonaShell(dbFile)).toEqual({ adopted: [] })
  })

  it("adopts the personas a source run recorded when a release build opens the store", () => {
    const implementer = (registry: typeof personas) => hashDefinition(registry.get("implementer")).sha256
    expect(implementer(sourcePersonas)).not.toBe(implementer(personas))
    const { dbFile, compiled } = seedPausedWorkflow({ personas: sourcePersonas })

    expect(migrateWorkflowDefinitionIdentityPersonaShell(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })

    expect(definitionIdentityMismatches(resumed(dbFile, sourcePersonas), compiled.definitionIdentity)).toEqual([])
  })

  it("adopts nothing for a workflow recorded with the shell restored", () => {
    const { dbFile } = seedPausedWorkflow({ current: true })

    expect(migrateWorkflowDefinitionIdentityPersonaShell(dbFile)).toEqual({ adopted: [] })
  })

  it("keeps a persona that differs by more than its tool list as drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ personaDrift: true })

    migrateWorkflowDefinitionIdentityPersonaShell(dbFile)

    const changes = definitionIdentityMismatches(resumed(dbFile), compiled.definitionIdentity)
    expect(changes.map((change) => change.component === "persona" ? change.personaName : change.component)).toEqual(["implementer"])
  })
})

/** A paused workflow as a build without the shell in the persona baseline
 *  launched it: every persona it records lacks `bash` in its tool list, and
 *  it records no advisor, because that build predates the advisor default. */
function seedPausedWorkflow(options: {
  readonly current?: boolean
  readonly personaDrift?: boolean
  readonly personas?: typeof personas
}) {
  const realmPersonas = options.personas ?? personas
  const repo = repoDefinitions().captureRevision()
  const skills = testSkillRevision([...repo.skills.skills.values(), testSkill("work", { agents: ["implementer"] })])
  const compiled = compilePreCutover({ work: { skill: "work" } }, skills, realmPersonas)
  const recordedPersona = (personaName: string, sha256: string | null): string | null => {
    const persona = realmPersonas.get(personaName)
    if (options.current || persona?.kind !== "persona") return sha256
    expect(persona.tools, personaName).toContain("bash")
    const drift = options.personaDrift && personaName === "implementer" ? { description: `${persona.description} Edited.` } : {}
    return hashDefinition({ ...beforePromptSwitchCut(beforeToolSteeringCut(beforeBudgetCut(beforeLexiconCut(persona)))), tools: persona.tools.filter((tool) => tool !== "bash"), ...drift }).sha256
  }
  const control = {
    ...compiled,
    status: "paused" as const,
    // The root's builder counts itself, so this is the sequence before it.
    aggregateSeq: 0,
    definitionIdentity: {
      ...compiled.definitionIdentity,
      personas: compiled.definitionIdentity.personas
        .filter(({ personaName }) => personaName !== "advisor")
        .map((entry) => ({ ...entry, sha256: recordedPersona(entry.personaName, entry.sha256) })),
    },
  }
  expect(control.definitionIdentity.personas.map(({ personaName }) => personaName)).toContain("implementer")
  const root = buildWorkflowControlInitializedFact(control)
  const dbFile = join(temporary("flywheel-persona-shell-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({ aggregateId: workflowAggregateId(SESSION), sessionId: SESSION, type: root.type, version: root.version, timestamp: 1, actor: "flywheel", payload: root.payload })
  } finally {
    store.close()
  }
  return { dbFile, compiled }
}

function replay(dbFile: string) {
  const store = createSqliteEventStore(dbFile)
  try {
    return replayWorkflowControl(store.readTolerant({ aggregateId: workflowAggregateId(SESSION) }))
  } finally {
    store.close()
  }
}

/** The identity Resume compares: the stored identity with each persona hash
 *  the recording build took over the turn cap, the retired tool-steering
 *  clauses, or the retired prompt switches proven against the current
 *  definitions, and with the advisor default added. */
function resumed(dbFile: string, realmPersonas = personas) {
  const proven = withoutRetiredPromptSwitches(withoutRetiredToolSteering(withoutRecordedTurnCaps(replay(dbFile).definitionIdentity, realmPersonas), realmPersonas), realmPersonas)
  return withDefaultAdvisor(proven, proven.workflowDefinitionId, { skills: repoDefinitions().captureRevision().skills, personas: realmPersonas })
}
