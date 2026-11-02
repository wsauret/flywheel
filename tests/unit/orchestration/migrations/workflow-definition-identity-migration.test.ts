import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { migrateWorkflowDefinitionIdentityContext } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity.js"
import { migrateWorkflowDefinitionIdentityGraph } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-graph.js"

import { createProjectDefinitionRegistry } from "../../../../src/workflows/definition-registry.js"
import { resolveWorkflowAgents } from "../../../../src/workflows/agent-resolution.js"
import { retiredStepIdentity, retiredStepView } from "../../../../src/workflows/vm/retired-step-identity.js"
import type { StepGrammarWorkflow } from "../../../../src/workflows/retired-step-grammar/schema.js"
import { prePhaseControl } from "./_pre-phase-control.js"
import {
  DefinitionIdentitySchema,
  definitionIdentityMismatches,
  isLegacyDefinitionIdentity,
  type DefinitionIdentity,
  type LegacyDefinitionIdentity,
} from "../../../../src/workflows/vm/definition-identity.js"
import { legacyCaptureOf, legacyIdentityOf } from "../../../../src/orchestration/modules/workflows/migrations/legacy-identity-view.js"
import { LEGACY_HANDOFF_CONTRACTS } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-step-content-pins.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { testDirectories } from "../../../helpers/directories.js"
import { Schema } from "effect"
import { hashDefinition } from "../../../../src/workflows/definition-hash.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { retiredFixtureWorkflow } from "../../../helpers/retired-fixture-briefs.js"

import { installedPersonaToolEntries } from "../../../../src/orchestration/tool-catalog.js"
import { installedDefinitionBundles } from "../../../../src/orchestration/module-catalog.js"
import { DEVELOPMENT_MODULES } from "../../../../src/orchestration/development-modules.js"
import { retainedProject } from "../../../fixtures/retired-workflows/retained-project.js"
const tmpRoot = path.join(os.tmpdir(), `flywheel-identity-migration-${process.pid}-${Date.now()}`)
const WORKFLOW_ID = "debug"
/** A workflow that reaches no persona, so its recorded skills are the complete
 * context identity after normalization. */
const PERSONA_FREE_WORKFLOW_ID = "raindrop-audit"
const MIGRATED_TYPE = "workflow.definition_identity.migrated"

interface JsonObject {
  [key: string]: unknown
}

interface EventRow {
  position: number
  id: string
  aggregateId: string
  seq: number
  type: string
  version: number
  payload: string
}

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("migrateWorkflowDefinitionIdentityContext", () => {
  it("normalizes absent context identity members without appending facts", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    seedNonTargets(dbFile)
    const staged = controlRow(dbFile, "legacy-session")
    const nonTargetsBefore = nonTargetRows(dbFile)
    const rowCountBefore = readRows(dbFile).length

    const result = migrate(dbFile)

    expect(result).toEqual({ repaired: [workflowAggregateId("legacy-session")] })
    expect(nonTargetRows(dbFile)).toEqual(nonTargetsBefore)
    expect(withoutPayload(controlRow(dbFile, "legacy-session"))).toEqual(withoutPayload(staged))
    expect(controlIdentity(dbFile, "legacy-session")).toEqual({ ...legacyCurrentIdentity(WORKFLOW_ID), skills: [], personas: [] })
    expect(readRows(dbFile)).toHaveLength(rowCountBefore)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("preserves legacy-missing handoff revisions while normalizing context members", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-handoff-session", WORKFLOW_ID, WORKFLOW_ID, undefined, false, true)

    migrate(dbFile)

    const identity = controlIdentity(dbFile, "legacy-handoff-session")
    expect(identity.skills).toEqual([])
    expect(identity.personas).toEqual([])
    expect(identity.handoffRegistry.every(({ contractRevision }) => contractRevision === 0)).toBe(true)
    const replayed = replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("legacy-handoff-session")))
    expect(replayed.definitionIdentity).toEqual(identity)
    expect(definitionIdentityMismatches(replayed.definitionIdentity, currentIdentity(WORKFLOW_ID)).some((change) =>
      change.component === "registry" && change.recorded.startsWith("0:"))).toBe(true)
  })

  it("keeps the persona identity the initialized event already recorded", () => {
    const dbFile = makeDbFile()
    const personas = [{ personaName: "explorer", sha256: "d".repeat(64) }]
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID, WORKFLOW_ID, personas)

    migrate(dbFile)

    expect(controlIdentity(dbFile, "legacy-session")).toMatchObject({ personas, skills: [] })
    expect(readRows(dbFile).filter((row) => row.type === MIGRATED_TYPE)).toEqual([])
  })

  it("preserves recorded skills when only personas is absent", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID, WORKFLOW_ID, undefined, true)
    const skills = currentIdentity(WORKFLOW_ID).skills

    migrate(dbFile)

    expect(controlIdentity(dbFile, "legacy-session")).toEqual({
      ...legacyCurrentIdentity(WORKFLOW_ID),
      skills,
      personas: [],
    })
    expect(readRows(dbFile).filter((row) => row.type === MIGRATED_TYPE)).toEqual([])
  })

  it("makes legacy history replayable after in-place normalization", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)

    expect(() => replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("legacy-session")))).toThrow()

    migrate(dbFile)

    const migrated = replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("legacy-session")))
    expect(migrated.definitionIdentity).toEqual({ ...legacyCurrentIdentity(WORKFLOW_ID), skills: [], personas: [] })
    expect(readRows(dbFile).filter((row) => row.type === MIGRATED_TYPE)).toEqual([])
  })

  it("does nothing on a second run", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    migrate(dbFile)
    const afterFirst = readRows(dbFile)

    const second = migrate(dbFile)

    expect(second.repaired).toEqual([])
    expect(readRows(dbFile)).toEqual(afterFirst)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("repairs a late candidate without recording a durable pass marker", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    migrate(dbFile)
    seedLegacyWorkflowControl(dbFile, "late-session", WORKFLOW_ID)

    expect(migrate(dbFile).repaired).toEqual([workflowAggregateId("late-session")])
    expect(replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("late-session"))).definitionIdentity)
      .toEqual({ ...legacyCurrentIdentity(WORKFLOW_ID), skills: [], personas: [] })
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("rejects a candidate whose aggregate sequence row is missing", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "valid-session", WORKFLOW_ID)
    seedLegacyWorkflowControl(dbFile, "missing-sequence", WORKFLOW_ID)
    deleteAggregateSequence(dbFile, workflowAggregateId("missing-sequence"))
    const before = readRows(dbFile)

    expect(() => migrate(dbFile)).toThrow(/sequence/i)
    expect(readRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("rejects a workspace with more candidates than one pass may repair", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    seedBareCandidates(dbFile, 1001)
    const before = readRows(dbFile)

    expect(() => migrate(dbFile)).toThrow(/1000/)
    expect(readRows(dbFile)).toEqual(before)
  })

  it("does not depend on the durable migration-fact append path", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    rejectMigrationFactInserts(dbFile)
    const rowCountBefore = readRows(dbFile).length

    expect(migrate(dbFile)).toEqual({ repaired: [workflowAggregateId("legacy-session")] })
    expect(readRows(dbFile)).toHaveLength(rowCountBefore)
  })

  it.each(["debug", "workflow-that-was-deleted"])("normalizes retired or absent workflow %s without replacing its recorded identity", (recordedAs) => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID, recordedAs)
    const recorded = JSON.parse(controlRow(dbFile, "legacy-session").payload).control.definitionIdentity

    expect(migrate(dbFile)).toEqual({ repaired: [workflowAggregateId("legacy-session")] })
    const normalized = controlIdentity(dbFile, "legacy-session")
    expect(normalized).toEqual({
      ...recorded,
      workflowDefinitionId: recordedAs,
      skills: [],
      personas: [],
    })
    expect(readRows(dbFile).filter(({ type }) => type === MIGRATED_TYPE)).toEqual([])
    expect(() => replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("legacy-session")))).not.toThrow()
  })

  it("does not adopt current context for a workflow that reaches no persona", () => {
    const dbFile = makeDbFile()
    expect(currentIdentity(PERSONA_FREE_WORKFLOW_ID).personas).toEqual([])
    seedLegacyWorkflowControl(dbFile, "legacy-session", PERSONA_FREE_WORKFLOW_ID, PERSONA_FREE_WORKFLOW_ID, undefined, true)

    const result = migrate(dbFile)

    expect(result.repaired).toEqual([workflowAggregateId("legacy-session")])
    expect(controlIdentity(dbFile, "legacy-session")).toEqual({ ...legacyCurrentIdentity(PERSONA_FREE_WORKFLOW_ID), personas: [] })
    expect(readRows(dbFile).filter((row) => row.type === MIGRATED_TYPE)).toEqual([])
  })

  it("repairs readable candidates and leaves an unreadable candidate byte-identical", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    seedIdentitylessCandidate(dbFile, "malformed-session")
    const malformedBefore = controlRow(dbFile, "malformed-session")

    expect(migrate(dbFile)).toEqual({ repaired: [workflowAggregateId("legacy-session")] })
    expect(controlRow(dbFile, "malformed-session")).toEqual(malformedBefore)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  /** A complete but malformed identity is no candidate of this pass: it owns
   *  absent members only. The chain post-condition is what refuses the row, so
   *  no reader ever opens the store with it. */
  it("leaves malformed context identity members to the chain post-condition", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    setContextIdentityMembers(dbFile, "legacy-session", "null", "[]")
    const before = readRows(dbFile)

    expect(migrate(dbFile)).toEqual({ repaired: [] })
    expect(readRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("leaves malformed context identity array entries to the chain post-condition", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)
    setContextIdentityMembers(dbFile, "legacy-session", '[{"skillId":42}]', "[]")
    const before = readRows(dbFile)

    expect(migrate(dbFile)).toEqual({ repaired: [] })
    expect(readRows(dbFile)).toEqual(before)
    expect(migrationFacts(dbFile)).toEqual([])
  })

  it("does not adopt definitions from the selected workspace", () => {
    const dbFile = makeDbFile()
    const projectRoot = path.dirname(dbFile)
    writeProjectDebugWorkflow(projectRoot)
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID)

    migrateWorkflowDefinitionIdentityContext(dbFile, testDirectories(projectRoot))

    expect("workflowSha256" in controlIdentity(dbFile, "legacy-session")).toBe(true)
    expect(readRows(dbFile).filter(({ type }) => type === MIGRATED_TYPE)).toEqual([])
  })

  it("ignores a workspace with no event table", () => {
    const dbFile = makeDbFile()
    const db = new Database(dbFile, { create: true })
    db.close()

    expect(migrate(dbFile)).toEqual({ repaired: [] })
  })
})

describe("migrateWorkflowDefinitionIdentityGraph", () => {
  it("derives graph identity from the recorded snapshot and is idempotent", () => {
    const dbFile = makeDbFile()
    const current = currentIdentity(WORKFLOW_ID)
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID, WORKFLOW_ID, current.personas, true)

    expect(migrateWorkflowDefinitionIdentityGraph(dbFile, repoDirectories)).toEqual({
      adopted: [workflowAggregateId("legacy-session")],
    })
    const replayed = replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId("legacy-session")))
    expect(replayed.definitionIdentity).toEqual(current)
    const rows = readRows(dbFile)
    expect(migrateWorkflowDefinitionIdentityGraph(dbFile, repoDirectories)).toEqual({ adopted: [] })
    expect(readRows(dbFile)).toEqual(rows)
  })

  it("skips an aggregate without a recorded workflow snapshot", () => {
    const dbFile = makeDbFile()
    seedLegacyWorkflowControl(dbFile, "legacy-session", WORKFLOW_ID, WORKFLOW_ID, undefined, false, false, false)
    const before = readRows(dbFile)

    expect(migrateWorkflowDefinitionIdentityGraph(dbFile, repoDirectories)).toEqual({ adopted: [] })
    expect(readRows(dbFile)).toEqual(before)
  })
})

/** Every migration in this suite reads definitions from the process project root. */
function migrate(dbFile: string) {
  return migrateWorkflowDefinitionIdentityContext(dbFile, repoDirectories)
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

/** The owner the migration itself builds: same project root, so the recomposed
 *  identities are the ones it adopts. */
const repoRoot = retainedProject({ legacyDebug: true, legacyRaindropAudit: true })
const repoDirectories = testDirectories(repoRoot)
const definitions = createProjectDefinitionRegistry({
  ...repoDirectories,
  bundles: installedDefinitionBundles(DEVELOPMENT_MODULES),
  personaToolEntries: installedPersonaToolEntries(),
})

/** Historical fixtures are read explicitly, not installed as named workflows.
 *  Remove after 2027-04-30 with the identity migration chain. */
function fixtureWorkflow(workflowId: string): WorkflowDefinition {
  return retiredFixtureWorkflow(definitions.captureRevision(), workflowId, repoRoot)
}

/** Composed exactly the way the migration composes it: the same skill revision
 *  and the same persona registry. */
function identityOptions() {
  const revision = definitions.captureRevision()
  return { skills: revision.skills, personas: revision.personas }
}

/** The identity the context pass adopts: the current definition in the shape
 *  the last pre-cutover build recorded. The handoff contracts carry their last
 *  pre-cutover revisions. A run recorded before the context members holds no
 *  hash for a former step skill, and that package left the catalog, so its
 *  hash is unknown. */
function currentIdentity(workflowId: string): LegacyDefinitionIdentity {
  const workflow = fixtureWorkflow(workflowId)
  const view = stepGrammarView(workflow)
  const capture = legacyCaptureOf(view)
  if (!capture) throw new Error(`Test fixture needs a pre-cutover view of workflow ${workflowId}`)
  const compiled = retiredStepIdentity(view, workflow, resolveWorkflowAgents(workflow), identityOptions())
  const evidence: LegacyDefinitionIdentity = {
    workflowDefinitionId: workflowId,
    graphSha256: capture.graphSha256,
    vmVersion: compiled.vmVersion,
    bindings: [],
    handoffRegistry: LEGACY_HANDOFF_CONTRACTS.map((pin) => ({ ...pin })),
    skills: [],
    personas: [],
  }
  return legacyIdentityOf(compiled, capture, evidence, definitions.skills())
}

/** The workflow record a pre-cutover build snapshotted: its bindings, and its
 *  graph as an array `steps` with each `reassess: X` slot written as
 *  `then: X`. */
function preCutoverRecord(workflow: WorkflowDefinition) {
  const view = stepGrammarView(workflow)
  const capture = legacyCaptureOf(view)
  if (!capture) throw new Error(`Test fixture needs a pre-cutover view of workflow ${workflow.id}`)
  const steps = view.flow.map((node) => {
    if (!("for" in node) || node.reassess === undefined) return node
    const { reassess, ...rest } = node
    return { ...rest, then: reassess }
  })
  return { id: view.id, name: view.name, bindings: Object.fromEntries(capture.bindings), steps }
}

/** The step-grammar view of a shipped workflow: what a build before phases
 *  loaded for it. */
function stepGrammarView(workflow: WorkflowDefinition): StepGrammarWorkflow {
  const view = retiredStepView(workflow)
  if (!view) throw new Error(`Test fixture needs a step-grammar view of workflow ${workflow.id}`)
  return view
}

function legacyCurrentIdentity(workflowId: string): LegacyDefinitionIdentity {
  const workflow = fixtureWorkflow(workflowId)
  const current = currentIdentity(workflowId)
  if (!("graphSha256" in current)) throw new Error("Current identity must use graph hash")
  const { graphSha256: _graphSha256, ...rest } = current
  return { ...rest, workflowSha256: hashDefinition(preCutoverRecord(workflow)).sha256 }
}

/** Workflow control as it was staged before definition identity covered
 *  composed skills and reachable personas. */
function seedLegacyWorkflowControl(
  dbFile: string,
  sessionId: string,
  workflowId: string,
  recordedAs = workflowId,
  personas?: DefinitionIdentity["personas"],
  preserveSkills = false,
  omitContractRevision = false,
  includeSnapshot = true,
): void {
  const workflow = fixtureWorkflow(workflowId)
  const control = prePhaseControl(workflowId, currentIdentity(workflowId))
  if (!isLegacyDefinitionIdentity(control.definitionIdentity) || !("graphSha256" in control.definitionIdentity)) {
    throw new Error("The fixture records the pre-cutover graph identity")
  }
  const { skills, personas: _noPersonas, graphSha256: _graphSha256, ...baseIdentity } = control.definitionIdentity
  const handoffRegistry = omitContractRevision
    ? baseIdentity.handoffRegistry.map((handoff) => ({
        name: handoff.name,
        fieldsSha256: handoff.fieldsSha256,
        rulesSha256: handoff.rulesSha256,
        artifactPathFieldsSha256: handoff.artifactPathFieldsSha256,
      }))
    : baseIdentity.handoffRegistry
  const identity = {
    ...baseIdentity,
    workflowSha256: hashDefinition(preCutoverRecord(workflow)).sha256,
    workflowDefinitionId: recordedAs,
    handoffRegistry,
    ...(preserveSkills ? { skills } : {}),
    ...(personas === undefined ? {} : { personas }),
  }
  const store = createSqliteEventStore(dbFile)
  try {
    if (includeSnapshot) {
      store.append({
        aggregateId: workflowAggregateId(sessionId),
        type: "definition.loaded",
        version: 6,
        timestamp: 1,
        actor: "flywheel",
        sessionId,
        payload: { kind: "workflow", id: workflow.id, definition: preCutoverRecord(workflow) },
      })
    }
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 2,
      actor: "flywheel",
      sessionId,
      // The root's builder counted the root itself.
      payload: { control: { ...control, issues: [], seals: [], aggregateSeq: control.aggregateSeq + 1 + (includeSnapshot ? 1 : 0), definitionIdentity: identity } },
    })
  } finally {
    store.close()
  }
}

/** Complete context identities and rows outside the target fact scope remain
 *  untouched. Malformed target identities are rejection fixtures below. */
function seedNonTargets(dbFile: string): void {
  const store = createSqliteEventStore(dbFile)
  try {
    const append = (aggregateId: string, type: string, version: number, definitionIdentity: unknown) => {
      store.append({
        aggregateId,
        type,
        version,
        timestamp: 1,
        actor: "flywheel",
        sessionId: "other-session",
        payload: { control: { definitionIdentity } },
      })
    }
    append(workflowAggregateId("old-version"), "workflow.control.initialized", 1, {})
    append(workflowAggregateId("other-type"), "workflow.resumed", 1, {})
    append("session:not-a-workflow", "workflow.control.initialized", 2, {})
  } finally {
    store.close()
  }
}

/** A row inside the exact repair scope whose control carries no identity at
 *  all, so no adoption can be composed for it. */
function seedIdentitylessCandidate(dbFile: string, sessionId: string): void {
  const store = createSqliteEventStore(dbFile)
  try {
    store.append({
      aggregateId: workflowAggregateId(sessionId),
      type: "workflow.control.initialized",
      version: 2,
      timestamp: 1,
      actor: "flywheel",
      sessionId,
      payload: { control: {} },
    })
  } finally {
    store.close()
  }
}

/** Cached (`db.query`) rather than raw-prepared, exactly as the event store
 *  states it: Bun finalizes a cached statement when the database closes, and a
 *  statement still open holds the file itself open on Windows, so the next
 *  teardown cannot remove the workspace. */
function seedBareCandidates(dbFile: string, count: number): void {
  const db = new Database(dbFile)
  try {
    const insertSeq = db.query("insert into event_sequence (aggregate_id, seq) values ($aggregateId, 0)")
    const insertEvent = db.query(`
      insert into event (id, aggregate_id, seq, type, version, timestamp, actor, session_id, payload)
      values ($id, $aggregateId, 0, 'workflow.control.initialized', 2, 1, 'flywheel', $sessionId, $payload)
    `)
    db.exec("BEGIN IMMEDIATE")
    for (let index = 0; index < count; index += 1) {
      const sessionId = `bulk-${index}`
      insertSeq.run({ $aggregateId: workflowAggregateId(sessionId) })
      insertEvent.run({
        $id: `bulk-event-${index}`,
        $aggregateId: workflowAggregateId(sessionId),
        $sessionId: sessionId,
        $payload: JSON.stringify({ control: { definitionIdentity: {} } }),
      })
    }
    db.exec("COMMIT")
  } finally {
    db.close()
  }
}

/** A store that refuses the appended migration fact, so the recording step
 *  fails after the repair statements have already run. */
function rejectMigrationFactInserts(dbFile: string): void {
  const db = new Database(dbFile)
  try {
    db.exec(`
      create trigger reject_migration_fact before insert on event
      when new.type = 'workspace.facts.migrated'
      begin
        select raise(ABORT, 'migration fact rejected by test fixture');
      end
    `)
  } finally {
    db.close()
  }
}

function deleteAggregateSequence(dbFile: string, aggregateId: string): void {
  const db = new Database(dbFile)
  try {
    db.query("delete from event_sequence where aggregate_id = $aggregateId").run({ $aggregateId: aggregateId })
  } finally {
    db.close()
  }
}

function setContextIdentityMembers(dbFile: string, sessionId: string, skills: string, personas: string): void {
  const db = new Database(dbFile)
  try {
    db.query(`
      update event set payload = json_set(payload,
        '$.control.definitionIdentity.skills', json($skills),
        '$.control.definitionIdentity.personas', json($personas))
      where aggregate_id = $aggregateId and type = 'workflow.control.initialized'
    `).run({ $skills: skills, $personas: personas, $aggregateId: workflowAggregateId(sessionId) })
  } finally {
    db.close()
  }
}

function writeProjectDebugWorkflow(projectRoot: string): void {
  const workflowsDir = path.join(projectRoot, ".flywheel", "workflows")
  fs.mkdirSync(workflowsDir, { recursive: true })
  fs.writeFileSync(path.join(workflowsDir, "debug.yaml"), `id: debug
name: Project Debug
description: Project-scoped debug workflow.
use_when: Project test fixture.
requires_description: true
bindings:
  investigate:
    skill: debug.investigate
  fix:
    skill: debug.fix
  verify:
    skill: debug.verify
steps:
  - step: investigate
  - step: fix
  - step: verify
`)
}

function readRows(dbFile: string): EventRow[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<EventRow, []>(
      "select position, id, aggregate_id as aggregateId, seq, type, version, payload from event order by position",
    ).all()
  } finally {
    db.close()
  }
}

function controlRow(dbFile: string, sessionId: string): EventRow {
  const row = readRows(dbFile).find(({ aggregateId, type }) =>
    aggregateId === workflowAggregateId(sessionId) && type === "workflow.control.initialized")
  if (!row) throw new Error(`No staged control for ${sessionId}`)
  return row
}

/** Every control row this suite stages records the pre-cutover identity. */
function controlIdentity(dbFile: string, sessionId: string): LegacyDefinitionIdentity {
  const identity = Schema.decodeUnknownSync(DefinitionIdentitySchema)(JSON.parse(controlRow(dbFile, sessionId).payload).control.definitionIdentity)
  if (!isLegacyDefinitionIdentity(identity)) throw new Error("Test fixture expected a pre-cutover identity")
  return identity
}

/** The event columns the normalization must leave untouched: only the payload
 *  identity changes. */
function withoutPayload(row: EventRow): Omit<EventRow, "payload"> {
  const { payload: _payload, ...rest } = row
  return rest
}

/** Rows the pass must leave untouched: everything except the repaired aggregate
 *  and the pass's own appended workspace evidence. */
function nonTargetRows(dbFile: string): EventRow[] {
  return readRows(dbFile).filter(({ aggregateId }) =>
    aggregateId !== workflowAggregateId("legacy-session") && aggregateId !== "workspace")
}


/** The aggregate's committed history, in the envelope shape strict replay
 *  reads: stored sequence, type, version, actor, and decoded payload. */
function aggregateFacts(dbFile: string, aggregateId: string): readonly unknown[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ seq: number; type: string; version: number; actor: string; payload: string }, { $aggregateId: string }>(
      "select seq, type, version, actor, payload from event where aggregate_id = $aggregateId order by seq",
    ).all({ $aggregateId: aggregateId }).map((row) => ({
      seq: row.seq,
      type: row.type,
      version: row.version,
      actor: row.actor,
      payload: JSON.parse(row.payload),
    }))
  } finally {
    db.close()
  }
}

function migrationFacts(dbFile: string): JsonObject[] {
  const db = new Database(dbFile, { readonly: true })
  try {
    return db.query<{ payload: string }, []>(
      "select payload from event where type = 'workspace.facts.migrated' order by position",
    ).all().map(({ payload }) => JSON.parse(payload))
  } finally {
    db.close()
  }
}
