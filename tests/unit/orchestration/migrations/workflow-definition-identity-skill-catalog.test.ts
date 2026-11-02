import { afterEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { migrateDefinitionIdentitySkillCatalog } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-skill-catalog.js"
import { migrateWorkflowDefinitionIdentityContext } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity.js"
import { applyLegacyStepOverrides, parseLegacyStepRecord, type LegacyStepRecord } from "../../../../src/workflows/legacy-step-migration.js"
import {
  DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID,
  definitionIdentityMismatches,
} from "../../../../src/workflows/vm/definition-identity.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { workflowAggregateId } from "../../../../src/workflows/vm/session-facts.js"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store.js"
import type { WorkflowView } from "../../../../src/workflows/view/types.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import {
  SPEC_CREATE_SKILL_ID,
  STEP_IDS,
  WORKFLOW_ID,
  aggregateFacts,
  boundSkills,
  legacyBindings,
  legacyIdentity,
  legacyRecordOf,
  preCutoverIdentity,
  processDirectories,
  processRoot,
  readRows,
  recordedPositionIds,
  seedLegacyAggregate,
  writeProjectWorkflowStepOneSkillTwice,
} from "./_legacy-workflow-aggregate.js"
import { stagedControl } from "./_pre-phase-control.js"
import { testDirectories } from "../../../helpers/directories.js"
import { userSkillStoreDir } from "../../../../src/workflows/skills.js"

const tmpRoot = path.join(os.tmpdir(), `flywheel-catalog-identity-${process.pid}-${Date.now()}`)
const MIGRATED_TYPE = "workflow.definition_identity.migrated"

interface JsonObject {
  [key: string]: unknown
}

interface RecordedIdentityMembers {
  readonly bindingIds: readonly string[] | undefined
  readonly hasStepDefinitions: boolean
}

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe("reconstructLegacyStepRecord", () => {
  it("maps the step content and the binding it replaced onto the frozen legacy step record", () => {
    const bound = legacyBindings(processRoot, WORKFLOW_ID).get("spec-create")
    if (!bound) throw new Error(`Test fixture needs bound skill ${SPEC_CREATE_SKILL_ID}`)
    // The historical policy predates scratch-write access in the live binding.
    const legacyRecord = legacyRecordOf({ ...bound, binding: {
      ...bound.binding,
      toolScoping: {
        read: true,
        bash: true,
        search: true,
        list: true,
        write: false,
        edit: false,
        subagent: true,
      },
    } })
    const { promptBody, ...record }: LegacyStepRecord = legacyRecord

    expect(record).toEqual({
      id: SPEC_CREATE_SKILL_ID,
      name: "Create Spec",
      description: "Turn a settled design into an implementation-ready spec - exact files, concrete changes, test scenarios, and per-milestone verification - grounded in codebase research.",
      handoff: "spec-handoff",
      writes: [{ id: "plan", lifetime: "durable", supersedes: [] }],
      settings: {
        toolScoping: {
          read: true,
          bash: true,
          search: true,
          list: true,
          write: false,
          edit: false,
          subagent: true,
        },
      },
      agents: ["explorer", "advisor"],
      requiredSkills: ["fly.implementation-spec"],
      // A former step skill is step content now: it is neither user- nor
      // model-invocable and declares no direct result.
      "user-invocable": false,
      "disable-model-invocation": true,
    })
    expect<string | undefined>(promptBody).toBe(boundSkills(processRoot, WORKFLOW_ID).get("spec-create")?.body)
  })

  it("reads a recorded snapshot that granted the retired ask_user scope as the record a current binding reconstructs", () => {
    const bound = legacyBindings(processRoot, WORKFLOW_ID).get("spec-create")
    if (!bound) throw new Error(`Test fixture needs bound skill ${SPEC_CREATE_SKILL_ID}`)
    const reconstructed = legacyRecordOf(bound)
    const scope = reconstructed.settings?.toolScoping
    if (!scope) throw new Error("Test fixture needs a binding with a tool scope")
    const recorded = { ...reconstructed, settings: { ...reconstructed.settings, toolScoping: { ...scope, ask_user: true } } }

    expect(parseLegacyStepRecord(recorded)).toEqual(reconstructed)
    expect(applyLegacyStepOverrides(reconstructed, { toolScoping: { ...scope, ask_user: false } })).toEqual(reconstructed)
  })
})

describe("migrateDefinitionIdentitySkillCatalog", () => {
  it("normalizes member names without adopting an identity from a retained workflow file", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "legacy-session")

    const result = migrate(dbFile)

    expect(result).toEqual({
      normalized: [workflowAggregateId("legacy-session")],
      adopted: [],
    })
    expect(recordedIdentityMembers(dbFile, "legacy-session")).toEqual({
      bindingIds: [...STEP_IDS],
      hasStepDefinitions: false,
    })
    const adoptions = adoptionPayloads(dbFile, "legacy-session")
    expect(adoptions).toEqual([])
    expect(legacyIdentity(replay(dbFile, "legacy-session").definitionIdentity).bindings.map(({ bindingId }) => bindingId)).toEqual([...STEP_IDS])
  })

  it("preserves a legacy-missing handoff contract through representation normalization", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "legacy-handoff-contract", { omitHandoffContractRevision: true })

    expect(migrate(dbFile).adopted).toEqual([])

    const adopted = legacyIdentity(replay(dbFile, "legacy-handoff-contract").definitionIdentity)
    expect(adopted.handoffRegistry.every(({ contractRevision }) => contractRevision === 0)).toBe(true)
    expect(definitionIdentityMismatches(adopted, preCutoverIdentity(WORKFLOW_ID)).some(({ component }) => component === "registry")).toBe(true)
  })

  it("removes retired graph policy while keeping the recorded identity", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "legacy-overrides", {
      legacyControlIds: true,
      legacyOverrides: true,
      rewriteSnapshot: (record, stepId) => stepId === "fly.implement"
        ? { ...record, settings: { ...record.settings, selfReview: false } }
        : record,
    })

    expect(migrate(dbFile)).toEqual({ normalized: [workflowAggregateId("legacy-overrides")], adopted: [] })
    expect(() => replay(dbFile, "legacy-overrides")).not.toThrow()
    expect(readRows(dbFile)
      .find(({ aggregateId, type }) => aggregateId === workflowAggregateId("legacy-overrides") && type === "workflow.control.initialized")
      ?.payload.includes("overrides")).toBe(false)
  })

  it("reads a paused aggregate from the same attempt under its recorded identity", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "paused-session", { status: "paused" })
    const staged = replayStaged(dbFile, "paused-session")

    expect(migrate(dbFile).adopted).toEqual([])

    const resumed = replay(dbFile, "paused-session")
    expect(resumed.status).toBe("paused")
    expect(legacyIdentity(resumed.definitionIdentity).bindings.map(({ bindingId }) => bindingId)).toEqual([...STEP_IDS])
    expect(resumed.attempts).toEqual(staged.attempts)
    expect(resumed.frontier).toEqual(staged.frontier)
  })

  it("keeps the recorded step ids of a named run and its companion facts", async () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "companion-session", { companions: true })

    expect(migrate(dbFile).adopted).toEqual([])

    const queue = await foldedQueue(dbFile, "companion-session")
    expect(queue.attempts.map(({ definitionId }) => definitionId)).toEqual([...STEP_IDS])
    expect(queue.attempts.map(({ briefId }) => briefId)).toEqual([...STEP_IDS])
    expect(contextEntries(dbFile, "companion-session").map(({ definitionId }) => definitionId)).toEqual([SPEC_CREATE_SKILL_ID])
  })

  it("keeps the recorded step ids of an aggregate that does not adopt", async () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "drifted-companions", {
      companions: true,
      rewriteSnapshot: (record, stepId) =>
        stepId === SPEC_CREATE_SKILL_ID ? { ...record, promptBody: `${record.promptBody} ` } : record,
    })

    expect(migrate(dbFile).adopted).toEqual([])

    const queue = await foldedQueue(dbFile, "drifted-companions")
    expect(queue.attempts.map(({ definitionId }) => definitionId)).toEqual([...STEP_IDS])
    expect(contextEntries(dbFile, "drifted-companions").map(({ definitionId }) => definitionId))
      .toEqual([SPEC_CREATE_SKILL_ID])
  })

  it("reads a legacy run whose control facts named graph positions by step id", () => {
    const dbFile = makeDbFile()
    const staged = seedLegacyAggregate(dbFile, "control-history", {
      legacyControlIds: true,
      authoredFollowUp: true,
      controlHistory: true,
    })
    if (!staged) throw new Error("Test fixture needs a driven control history")
    expect(recordedPositionIds(dbFile, "control-history")).toEqual([...STEP_IDS].sort())

    expect(migrate(dbFile).adopted).toEqual([])

    expect(recordedPositionIds(dbFile, "control-history")).toEqual([...STEP_IDS].sort())
    const resumed = replay(dbFile, "control-history")
    expect(resumed.attempts).toEqual(staged.attempts)
    expect(resumed.frontier).toEqual(staged.frontier)
  })

  it("keeps the recorded control ids of an aggregate that does not adopt", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "drifted-control", {
      legacyControlIds: true,
      authoredFollowUp: true,
      controlHistory: true,
      rewriteSnapshot: (record, stepId) =>
        stepId === SPEC_CREATE_SKILL_ID ? { ...record, promptBody: `${record.promptBody} ` } : record,
    })

    expect(migrate(dbFile).adopted).toEqual([])

    expect(recordedPositionIds(dbFile, "drifted-control")).toEqual([...STEP_IDS].sort())
    // Ordinary definition drift, which the resume path surfaces before it starts
    // a worker.
    expect(() => flattenWorkflowView(replay(dbFile, "drifted-control"), boundSkills(processRoot, WORKFLOW_ID)))
      .toThrow(/unknown agent/)
  })

  it("reads mixed history after context repair and member normalization", async () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "mixed-session", {
      companions: true,
      legacyControlIds: true,
      settledFirstAttempt: true,
      omitContextMembers: true,
    })
    const staged = replayStaged(dbFile, "mixed-session")

    migrateWorkflowDefinitionIdentityContext(dbFile, processDirectories)
    expect(migrate(dbFile).adopted).toEqual([])

    expect(adoptionPayloads(dbFile, "mixed-session").map(({ migrationId }) => migrationId))
      .toEqual([])
    const resumed = replay(dbFile, "mixed-session")
    expect(resumed.status).toBe("paused")
    expect(legacyIdentity(resumed.definitionIdentity).bindings.map(({ bindingId }) => bindingId)).toEqual([...STEP_IDS])
    expect(resumed.attempts).toEqual(staged.attempts)
    expect(resumed.frontier).toEqual(staged.frontier)
    const queue = await foldedQueue(dbFile, "mixed-session")
    expect(queue.attempts.map(({ definitionId }) => definitionId)).toEqual([...STEP_IDS])
    expect(queue.attempts.map(({ status }) => status)).toEqual(["completed", "pending", "pending"])
  })

  it("does nothing on a second run", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "legacy-session")
    migrate(dbFile)
    const afterFirst = readRows(dbFile)

    expect(migrate(dbFile)).toEqual({ normalized: [], adopted: [] })
    expect(readRows(dbFile)).toEqual(afterFirst)
    expect(migrationFacts(dbFile).map(({ migrationId }) => migrationId))
      .toEqual([DEFINITION_IDENTITY_UNIFIED_CATALOG_MIGRATION_ID])
  })

  it("chains after the earlier pass repairs context in place", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "oldest-session", { omitContextMembers: true })

    migrateWorkflowDefinitionIdentityContext(dbFile, processDirectories)
    expect(migrate(dbFile).adopted).toEqual([])

    expect(adoptionPayloads(dbFile, "oldest-session").map(({ migrationId }) => migrationId))
      .toEqual([])
    expect(legacyIdentity(replay(dbFile, "oldest-session").definitionIdentity).bindings.map(({ bindingId }) => bindingId)).toEqual([...STEP_IDS])
  })

  it("normalizes the shape but appends no adoption when a recorded snapshot differs", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "drifted-session", {
      rewriteSnapshot: (record, stepId) =>
        stepId === SPEC_CREATE_SKILL_ID ? { ...record, promptBody: `${record.promptBody} ` } : record,
    })

    expect(migrate(dbFile)).toEqual({ normalized: [workflowAggregateId("drifted-session")], adopted: [] })
    expect(adoptionPayloads(dbFile, "drifted-session")).toEqual([])
    expect(legacyIdentity(replay(dbFile, "drifted-session").definitionIdentity).bindings.map(({ bindingId }) => bindingId))
      .toEqual([...STEP_IDS])
  })

  it("appends no adoption when an identity hash names no recorded snapshot", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "hash-mismatch", {
      rewriteIdentityHash: (sha256, stepId) => stepId === SPEC_CREATE_SKILL_ID ? "0".repeat(64) : sha256,
    })

    expect(migrate(dbFile).adopted).toEqual([])
    expect(adoptionPayloads(dbFile, "hash-mismatch")).toEqual([])
  })

  it("appends no adoption when the recorded step snapshots are gone", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "snapshotless-session", { omitSnapshots: true })

    expect(migrate(dbFile)).toEqual({ normalized: [workflowAggregateId("snapshotless-session")], adopted: [] })
    expect(adoptionPayloads(dbFile, "snapshotless-session")).toEqual([])
  })

  it("keeps the recorded implement identity and ids when the project did not retain the workflow", async () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "orphan-session", { companions: true })
    const positions = recordedPositionIds(dbFile, "orphan-session")
    const companionRows = () => readRows(dbFile).filter(({ aggregateId, type }) =>
      aggregateId === workflowAggregateId("orphan-session") && type !== "workflow.control.initialized")
    const companions = companionRows()

    expect(migrateDefinitionIdentitySkillCatalog(dbFile, testDirectories(path.dirname(dbFile))))
      .toEqual({ normalized: [workflowAggregateId("orphan-session")], adopted: [] })
    expect(adoptionPayloads(dbFile, "orphan-session")).toEqual([])
    expect(recordedIdentity(dbFile, "orphan-session")).toMatchObject({ workflowDefinitionId: "implement" })
    expect(recordedIdentityMembers(dbFile, "orphan-session")).toEqual({ bindingIds: [...STEP_IDS], hasStepDefinitions: false })
    expect(recordedPositionIds(dbFile, "orphan-session")).toEqual(positions)
    expect(companionRows()).toEqual(companions)
    expect((await foldedQueue(dbFile, "orphan-session")).attempts.map(({ definitionId }) => definitionId)).toEqual([...STEP_IDS])
  })

  it("appends no adoption when the workflow binds the recorded skill more than once", () => {
    const dbFile = makeDbFile()
    const projectRoot = path.dirname(dbFile)
    writeProjectWorkflowStepOneSkillTwice(projectRoot)
    seedLegacyAggregate(dbFile, "ambiguous-session", { projectRoot, workflowId: "dual-bind" })

    const result = migrateDefinitionIdentitySkillCatalog(dbFile, testDirectories(projectRoot))

    expect(result).toEqual({ normalized: [workflowAggregateId("ambiguous-session")], adopted: [] })
    expect(adoptionPayloads(dbFile, "ambiguous-session")).toEqual([])
  })

  it("migrates healthy candidates while leaving invalid JSON byte-identical", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "malformed-session")
    seedLegacyAggregate(dbFile, "healthy-session")
    const malformedPayload = "{{{not-json"
    const db = new Database(dbFile)
    db.run(
      "update event set payload = ? where aggregate_id = ? and type = 'workflow.control.initialized'",
      [malformedPayload, workflowAggregateId("malformed-session")],
    )
    db.close()

    expect(migrate(dbFile)).toEqual({
      normalized: [workflowAggregateId("healthy-session")],
      adopted: [],
    })
    const verification = new Database(dbFile)
    const row = verification.query<{ payload: string }, [string]>(
      "select payload from event where aggregate_id = ? and type = 'workflow.control.initialized'",
    ).get(workflowAggregateId("malformed-session"))
    verification.close()
    expect(row?.payload).toBe(malformedPayload)
  })

  it("keeps an unreadable snapshot byte for byte while normalizing its control", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "malformed-session", {
      rewriteSnapshot: (record) => ({ ...record, handoffFilename: "spec.json" }),
    })
    seedLegacyAggregate(dbFile, "healthy-session")
    const malformedBefore = readRows(dbFile).filter(({ aggregateId, type }) => aggregateId === workflowAggregateId("malformed-session") && type === "definition.loaded")

    expect(migrate(dbFile)).toEqual({
      normalized: [workflowAggregateId("malformed-session"), workflowAggregateId("healthy-session")],
      adopted: [],
    })
    expect(readRows(dbFile).filter(({ aggregateId, type }) => aggregateId === workflowAggregateId("malformed-session") && type === "definition.loaded")).toEqual(malformedBefore)
  })

  it("ignores a workspace with no event table", () => {
    const dbFile = makeDbFile()
    const db = new Database(dbFile, { create: true })
    db.close()

    expect(migrate(dbFile)).toEqual({ normalized: [], adopted: [] })
  })
})

describe("managed learning under the catalog pass", () => {
  it("normalizes the recorded identity without reconciling the shared global skill store", () => {
    const dbFile = makeDbFile()
    seedLegacyAggregate(dbFile, "legacy-session")
    // A malformed proposal record: managed-skill reconciliation quarantines it, so
    // its survival proves this pass mutated no global package state.
    const proposals = path.join(userSkillStoreDir(processDirectories.userDataRoot), ".operations", "proposals")
    fs.mkdirSync(proposals, { recursive: true })
    const proposal = path.join(proposals, `${"c".repeat(64)}.json`)
    fs.writeFileSync(proposal, "not a proposal record")

    expect(migrate(dbFile).adopted).toEqual([])
    expect(fs.existsSync(proposal)).toBe(true)
  })
})

/** All cases use one retained project while proving that its files no longer supply an identity. */
function migrate(dbFile: string) {
  return migrateDefinitionIdentitySkillCatalog(dbFile, processDirectories)
}

function makeDbFile(): string {
  const dir = path.join(tmpRoot, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, "flywheel.sqlite")
}

function replay(dbFile: string, sessionId: string) {
  return replayWorkflowControl(aggregateFacts(dbFile, workflowAggregateId(sessionId)))
}

/** The staged aggregate before migration, in the current shape, without the
 *  strict identity parse a replay ends with: the legacy identity shape is
 *  exactly what the pass has not normalized yet. */
function replayStaged(dbFile: string, sessionId: string) {
  const initialized = readRows(dbFile).find(({ aggregateId, type }) =>
    aggregateId === workflowAggregateId(sessionId) && type === "workflow.control.initialized")
  if (!initialized) throw new Error(`No staged control for ${sessionId}`)
  return stagedControl(JSON.parse(initialized.payload).control, preCutoverIdentity(WORKFLOW_ID))
}

/** Members the normalized initialized row records, which is the shape strict
 *  replay reads. */
function recordedIdentityMembers(dbFile: string, sessionId: string): RecordedIdentityMembers {
  const identity = recordedIdentity(dbFile, sessionId)
  return {
    bindingIds: identity.bindings?.map(({ bindingId }) => bindingId),
    hasStepDefinitions: "stepDefinitions" in identity,
  }
}

function recordedIdentity(
  dbFile: string,
  sessionId: string,
): { bindings?: readonly { bindingId: string }[]; [key: string]: unknown } {
  const raw = readRows(dbFile).find(({ aggregateId, type }) =>
    aggregateId === workflowAggregateId(sessionId) && type === "workflow.control.initialized")
  if (!raw) throw new Error(`No staged control for ${sessionId}`)
  return JSON.parse(raw.payload).control.definitionIdentity
}

function adoptionPayloads(dbFile: string, sessionId: string): JsonObject[] {
  return readRows(dbFile)
    .filter(({ aggregateId, type }) => aggregateId === workflowAggregateId(sessionId) && type === MIGRATED_TYPE)
    .map(({ payload }) => JSON.parse(payload))
}

/** The queue the projection folds from the aggregate's recorded facts: the read
 *  path a resumed run opens the store with. */
async function foldedQueue(dbFile: string, sessionId: string): Promise<WorkflowView> {
  const store = createSqliteEventStore(dbFile)
  try {
    const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), sessionId)
    if (!queue) throw new Error(`No recorded queue for ${sessionId}`)
    return queue
  } finally {
    store.close()
  }
}

/** Recorded context entries of one aggregate, read as the accumulator reads them. */
function contextEntries(dbFile: string, sessionId: string): { definitionId: string }[] {
  return readRows(dbFile)
    .filter(({ aggregateId, type }) => aggregateId === workflowAggregateId(sessionId) && type === "context.accumulated")
    .map(({ payload }) => JSON.parse(payload).entry)
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
