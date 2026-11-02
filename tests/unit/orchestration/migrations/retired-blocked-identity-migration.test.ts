import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { join } from "node:path"
import type { EventPayload } from "../../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { personaToolEntries } from "../../../../src/orchestration/agent-runtime/tools/tool-registry.js"
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js"
import { HANDOFF_REVISION_MIGRATIONS, migrateHandoffRevisions } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-handoff-revisions.js"
import { migrateWorkflowDefinitionIdentityPersonaShell } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-persona-shell.js"
import { migrateWorkflowDefinitionIdentityRetiredBlocked } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-retired-blocked.js"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import { definitionIdentityMismatches } from "../../../../src/workflows/vm/definition-identity.js"
import { withoutRecordedTurnCaps, withoutRetiredPromptSwitches, withoutRetiredToolSteering } from "../../../../src/workflows/vm/persona-identity-proofs.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { buildWorkflowControlInitializedFact, workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { createToolRegistry } from "../../../../src/orchestration/tool-catalog.js"
import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import { temporaryDirectories, testDirectories } from "../../../helpers/directories.js"
import { repoDefinitions, repoModules } from "../../../helpers/project-definitions.js"
import { testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { beforeBudgetCut } from "./_persona-budget.js"
import { compilePreCutover } from "./_pre-cutover-control.js"

const temporary = temporaryDirectories()
const SESSION = "paused-session"

/** The identity hashes the build before the retirement recorded for the two
 *  handoff revisions that could stop blocked. */
const RECORDED_HANDOFFS = new Map([
  ["work-handoff", {
    contractRevision: 3,
    fieldsSha256: "5a666ad8743f6eb7eed5db975eecec7031ab6904fd22ba4346f1c0fedc8c667b",
    rulesSha256: "0e6eda0ae2f4641a27b53f81321802072b6d51dd96cb311d43482ceb058afc34",
  }],
  ["spec-handoff", {
    contractRevision: 6,
    fieldsSha256: "48df21b9fb7401a3210dcef8faa320e97bb56d2f6c61fb9b6ab08943f675946b",
    rulesSha256: "6059a436d21ab5b1fa4d51b6304371c0fab64cec848f0175e2e7fd9b51b12605",
  }],
])

/** The closing instructions of the implementer body: the current text, and
 *  the text the build before the retirement shipped in its place. */
const IMPLEMENTER_CLOSING = {
  current: [
    "When evidence contradicts the Design intent, or an explicit prohibition of the person or a missing external prerequisite prevents every viable next action, message your parent with message_session and wait for its reply. Never hand off unfinished work as complete.",
    "",
    "When finished, submit your structured result using the completion tool provided by your environment. Include these fields:",
    "- summary: outcomes, material plan deviations with evidence and rationale, any work that is not done, and any remaining follow-ups for parent review",
    "- files_modified: files created or changed",
    "- commands_run: commands executed with exit codes and the result each proved",
  ].join("\n"),
  recorded: [
    "When finished, submit your structured result using the completion tool provided by your environment. Include these fields:",
    "- summary: outcomes, material plan deviations with evidence and rationale, and any remaining follow-ups for parent review",
    "- files_modified: files created or changed",
    "- commands_run: commands executed with exit codes and the result each proved",
    "- blockers: anything that prevented completion",
  ].join("\n"),
}

/** The personas of the release realm, which the test catalog installs. */
const personas = repoDefinitions().captureRevision().personas
/** The personas of a source run, whose development module adds tools to the
 *  baseline personas, so the same body hashes differently there. */
const sourcePersonas = createProjectDefinitionRegistry({
  ...testDirectories(process.cwd()),
  skillRoots: [],
  bundles: installedDefinitionBundles(repoModules),
  personaToolEntries: personaToolEntries(createToolRegistry(repoModules)),
}).captureRevision().personas

describe("migrateWorkflowDefinitionIdentityRetiredBlocked", () => {
  it("lets a paused workflow with the old handoff revisions and the old implementer resume with no drift, and keeps real drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ driftedOn: "follow" })

    expect(migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })
    // The later passes in the chain restore the shell the retiring build
    // lacked and adopt the work handoff revision that cites commands.
    migrateWorkflowDefinitionIdentityPersonaShell(dbFile)
    for (const migration of HANDOFF_REVISION_MIGRATIONS) migrateHandoffRevisions(dbFile, migration)

    const changes = definitionIdentityMismatches(resumed(dbFile), compiled.definitionIdentity)
    expect(changes.map((change) => change.component === "binding" ? change.bindingId : change.component)).toEqual(["follow"])
    expect(migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)).toEqual({ adopted: [] })
  })

  it("adopts the old implementer that a source run recorded when a release build opens the store", () => {
    expect(hashDefinition(sourcePersonas.get("implementer")).sha256).not.toBe(hashDefinition(personas.get("implementer")).sha256)
    const { dbFile, compiled } = seedPausedWorkflow({ personas: sourcePersonas })

    expect(migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)).toEqual({ adopted: [workflowAggregateId(SESSION)] })
    migrateWorkflowDefinitionIdentityPersonaShell(dbFile)
    for (const migration of HANDOFF_REVISION_MIGRATIONS) migrateHandoffRevisions(dbFile, migration)

    expect(definitionIdentityMismatches(resumed(dbFile, sourcePersonas), compiled.definitionIdentity)).toEqual([])
  })

  it("adopts nothing for a workflow recorded after the retirement", () => {
    const { dbFile } = seedPausedWorkflow({ current: true })

    expect(migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)).toEqual({ adopted: [] })
    expect(readTypes(dbFile)).not.toContain("workflow.definition_identity.migrated")
  })

  it("keeps a persona that differs by more than its retired body as drift", () => {
    const { dbFile, compiled } = seedPausedWorkflow({ personaDrift: true })

    migrateWorkflowDefinitionIdentityRetiredBlocked(dbFile)
    for (const migration of HANDOFF_REVISION_MIGRATIONS) migrateHandoffRevisions(dbFile, migration)

    const changes = definitionIdentityMismatches(resumed(dbFile), compiled.definitionIdentity)
    expect(changes.map((change) => change.component)).toEqual(["persona"])
  })
})

/** A paused workflow as the build before the retirement launched it: its
 *  identity records the work handoff at revision 3, the spec handoff at
 *  revision 6, and the implementer persona with the body that reported
 *  blockers. `driftedOn` carries an unrelated binding change. */
function seedPausedWorkflow(options: {
  readonly driftedOn?: string
  readonly current?: boolean
  readonly personaDrift?: boolean
  readonly personas?: typeof personas
}) {
  const realmPersonas = options.personas ?? personas
  const repo = repoDefinitions().captureRevision()
  const skills = testSkillRevision([
    ...repo.skills.skills.values(),
    testSkill("spec", { agents: ["implementer"] }),
    testSkill("work", { agents: ["implementer"] }),
    testSkill("follow"),
  ])
  const compiled = compilePreCutover({
    spec: { skill: "spec", handoff: "spec-handoff" },
    work: { skill: "work", handoff: "work-handoff" },
    follow: { skill: "follow" },
  }, skills, realmPersonas)
  const recordedPersona = (personaName: string, sha256: string | null): string | null => {
    const persona = realmPersonas.get(personaName)
    if (options.current || persona?.kind !== "persona" || personaName !== "implementer") return sha256
    expect(persona.systemPrompt).toEndWith(IMPLEMENTER_CLOSING.current)
    const body = persona.systemPrompt.replace(IMPLEMENTER_CLOSING.current, IMPLEMENTER_CLOSING.recorded)
    // The retiring build also lacked the shell in the persona baseline.
    const tools = persona.tools.filter((tool) => tool !== "bash")
    return hashDefinition({ ...beforeBudgetCut(persona), tools, systemPrompt: body, ...(options.personaDrift ? { description: `${persona.description} Edited.` } : {}) }).sha256
  }
  const control = {
    ...compiled,
    status: "paused" as const,
    // The root's builder counts itself, so this is the sequence before it.
    aggregateSeq: 0,
    definitionIdentity: {
      ...compiled.definitionIdentity,
      bindings: compiled.definitionIdentity.bindings.map((binding) => binding.bindingId === options.driftedOn
        ? { ...binding, sha256: hashDefinition({ renamed: binding.bindingId }).sha256 }
        : binding),
      handoffRegistry: compiled.definitionIdentity.handoffRegistry.map((entry) => {
        const recorded = RECORDED_HANDOFFS.get(entry.name)
        return options.current || !recorded ? entry : { ...entry, ...recorded }
      }),
      personas: compiled.definitionIdentity.personas.map((entry) => ({ ...entry, sha256: recordedPersona(entry.personaName, entry.sha256) })),
    },
  }
  expect(control.definitionIdentity.personas.map(({ personaName }) => personaName)).toContain("implementer")
  const root = buildWorkflowControlInitializedFact(control)
  const dbFile = seed([{ type: root.type, version: root.version, payload: root.payload }])
  return { dbFile, compiled }
}

interface SeededRow {
  readonly type: string
  readonly version: number
  readonly payload: EventPayload
}

function seed(rows: readonly SeededRow[]): string {
  const dbFile = join(temporary("flywheel-retired-blocked-"), "flywheel.sqlite")
  const store = createSqliteEventStore(dbFile)
  try {
    for (const [index, row] of rows.entries()) {
      store.append({
        aggregateId: workflowAggregateId(SESSION),
        sessionId: SESSION,
        type: row.type,
        version: row.version,
        timestamp: index + 1,
        actor: "flywheel",
        payload: row.payload,
      })
    }
  } finally {
    store.close()
  }
  return dbFile
}

function replay(dbFile: string) {
  const store = createSqliteEventStore(dbFile)
  try {
    return replayWorkflowControl(store.readTolerant({ aggregateId: workflowAggregateId(SESSION) }))
  } finally {
    store.close()
  }
}

function readTypes(dbFile: string): readonly string[] {
  const db = new Database(dbFile)
  try {
    return db.query<{ type: string }, []>("select type from event where aggregate_id != 'workspace' order by position").all().map(({ type }) => type)
  } finally {
    db.close()
  }
}

/** The identity Resume compares: the stored identity with each persona hash
 *  the recording build took over the turn cap or the retired tool-steering
 *  clauses proven against the current definitions. */
function resumed(dbFile: string, realmPersonas = personas) {
  return withoutRetiredPromptSwitches(withoutRetiredToolSteering(withoutRecordedTurnCaps(replay(dbFile).definitionIdentity, realmPersonas), realmPersonas), realmPersonas)
}
